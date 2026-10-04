import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createChatOptionsController } from "../src/codex/chat_options_controller.js";
import { createFrameReader } from "../src/worker/protocol.js";
import { createWorkerServer } from "../src/worker/server.js";
import { createWorkerClient } from "../src/worker/client.js";
import { createCodexStreamWatchdog } from "../src/codex/watchdog.js";
import { createQueueRuntimeController } from "../src/queue/runtime_controller.js";
import { resolvePhotoArtifactCandidates } from "../src/telegram/attachments.js";
import { replyFormattedCodexAnswer } from "../src/telegram/codex_answer.js";
import { createWorkerDeliveryJournal } from "../src/recovery/worker_delivery_journal.js";
import { writePrivateFileAtomic } from "../src/fs/private.js";

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-hardening-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("worker protocol preserves Russian text when each byte arrives separately", () => {
  const stream = new PassThrough();
  const frames = [];
  createFrameReader(stream, (frame) => frames.push(frame));
  for (const byte of Buffer.from(JSON.stringify({ text: "Привет, мир" }) + "\n")) stream.write(Buffer.from([byte]));
  assert.deepEqual(frames, [{ text: "Привет, мир" }]);
});

test("worker admits one concurrent job per chat and refuses a second server without unlinking the socket", async (t) => {
  const root = await directory(t);
  const config = { codexWorkerStateDir: root, codexWorkerSocket: path.join(root, "worker.sock"), codexWorkerLogRetentionDays: 0 };
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const first = createWorkerServer({ config, heartbeatMs: 0, executeJob: async () => held });
  const second = createWorkerServer({ config, heartbeatMs: 0, executeJob: async () => {} });
  await first.listen();
  try {
    const client = createWorkerClient(config);
    const results = await Promise.allSettled(["one", "two"].map((id) => client.startJob({ id, chatKey: "chat", text: "probe" })));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    await assert.rejects(second.listen(), /Another bridge instance/);
    assert.equal((await client.status()).runningJobIds.length, 1);
  } finally { release(); await second.close(); await first.close(); }
});

test("queue reserves a chat before awaiting durable dequeue", async () => {
  const activeTurns = new Map();
  const pendingTurns = new Map([["chat", [{ id: "one" }, { id: "two" }]]]);
  const saves = [];
  const started = [];
  const controller = createQueueRuntimeController({
    state: { queues: {}, worker: { deliveries: {} } }, activeTurns, pendingTurns, sideTurns: new Map(),
    settings: { maxPendingAgeSeconds: () => 0 }, chats: { get: () => ({}) },
    persistence: { save: () => new Promise((resolve) => saves.push(resolve)) },
    telegram: { createSyntheticContext: () => ({}) }, turns: { runPreparedQueue: async (_key, turn) => started.push(turn.id) }, text: (key) => key
  });
  const first = controller.startQueueDrainIfIdle("chat");
  const second = controller.startQueueDrainIfIdle("chat");
  for (const release of saves) release();
  assert.deepEqual(await Promise.all([first, second]), [true, false]);
  assert.deepEqual(started, ["one"]);
  assert.equal(pendingTurns.get("chat").length, 1);
});

test("watchdog aborts even when recording a timeout fails", async () => {
  let aborted = false;
  let at = 0;
  const timed = createCodexStreamWatchdog({ noticeMs: 0, abortMs: 1, now: () => at,
    onTimeout: async () => { throw new Error("disk unavailable"); }, abort: () => { aborted = true; } });
  at = 2;
  await assert.rejects(timed.checkNow(), /disk unavailable/);
  assert.equal(aborted, true);
});

test("photo artifacts cannot escape an allowed root through a symlink", async (t) => {
  const root = await directory(t);
  const allowed = path.join(root, "outputs");
  await fs.mkdir(allowed);
  await fs.writeFile(path.join(root, "outside.png"), "fixture");
  await fs.symlink(path.join(root, "outside.png"), path.join(allowed, "link.png"));
  const result = await resolvePhotoArtifactCandidates([{ path: path.join(allowed, "link.png") }], { allowedRoots: [allowed] });
  assert.equal(result.photos.length, 0);
  assert.equal(result.rejected[0].reason, "outside_allowed_roots");
});

test("manual delivery skips parts durably confirmed before a later failure", async (t) => {
  const root = await directory(t);
  const file = path.join(root, "receipt.json");
  let state = { worker: { deliveries: {} } };
  const execution = { executionMode: "sidecar", workerJobId: "job", workerLastSeq: 1 };
  const createJournal = () => createWorkerDeliveryJournal({ settings: { enabled: false }, state,
    persistence: { save: () => writePrivateFileAtomic(file, JSON.stringify(state)) }, digestText: (text) => text });
  let journal = createJournal();
  const text = "a".repeat(1400);
  await journal.recordTelegramReplyReady("chat", execution, text);
  const sent = [];
  let fail = true;
  const replyHtml = async (_ctx, html) => {
    if (sent.length === 1 && fail) throw Object.assign(new Error("delivery unavailable"), { code: "ETIMEDOUT" });
    sent.push(html); return { message_id: sent.length };
  };
  const options = { format: "safe", maxTelegramChars: 500, replyHtml, replyLong: async () => {}, extractPhotoArtifacts: async (body) => ({ text: body, photos: [], rejected: [] }) };
  await assert.rejects(replyFormattedCodexAnswer({}, text, { ...options, delivery: journal.deliveryOptions("chat", execution) }), /delivery unavailable/);
  state = JSON.parse(await fs.readFile(file, "utf8"));
  journal = createJournal();
  fail = false;
  await replyFormattedCodexAnswer({}, text, { ...options, extractPhotoArtifacts: async () => { throw new Error("Frozen delivery must not render a different artifact plan"); }, delivery: { ...journal.deliveryOptions("chat", execution), allowUncertain: true } });
  assert.equal(sent.length, 3);
  assert.equal(Object.values(state.worker.deliveries["chat:job"].parts).filter((part) => part.status === "sent").length, 3);
});


test("local policy permits Full Access but rejects never and persisted forbidden overrides", async () => {
  const state = { chats: {} };
  const controller = createChatOptionsController({
    settings: { workingDirectory: "/workspace", approvalPolicy: "on-request", sandboxMode: "workspace-write",
      allowedSandboxModes: new Set(["read-only", "workspace-write", "danger-full-access"]),
      allowedApprovalPolicies: new Set(["on-request", "untrusted"]),
      liveProgressEnabled: () => false, additionalDirectories: [], uploadDir: "/uploads" },
    stateStore: { chats: state.chats }, threadCache: new Map(),
    validation: { validSandboxModes: new Set(["read-only", "workspace-write", "danger-full-access"]), validApprovalPolicies: new Set(["never", "on-request", "untrusted"]) }
  });
  await controller.setOption("chat", "sandboxMode", "danger-full-access");
  assert.equal(controller.getEffectiveOptions("chat").sandboxMode, "danger-full-access");
  await assert.rejects(controller.setOption("chat", "approvalPolicy", "never"), /local bridge policy/);
  assert.equal(controller.getEffectiveOptions("chat").approvalPolicy, "on-request");
  state.chats.chat.options.approvalPolicy = "never";
  assert.throws(() => controller.getEffectiveOptions("chat"), /local bridge policy/);
});
