import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findLatestSessionFileForThread, readCodexSessionBackfill } from "../src/codex/session_backfill.js";

async function tmpSessionsDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "codex-session-backfill-"));
}

async function writeJsonl(file, events) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

test("session backfill finds latest rollout file by thread id", async () => {
  const dir = await tmpSessionsDir();
  const older = path.join(dir, "2026", "07", "06", "rollout-old-thread-1.jsonl");
  const newer = path.join(dir, "2026", "07", "07", "rollout-new-thread-1.jsonl");
  await writeJsonl(older, []);
  await writeJsonl(newer, []);
  await fs.utimes(older, new Date("2026-07-06T00:00:00Z"), new Date("2026-07-06T00:00:00Z"));
  await fs.utimes(newer, new Date("2026-07-07T00:00:00Z"), new Date("2026-07-07T00:00:00Z"));

  assert.equal(await findLatestSessionFileForThread(dir, "thread-1"), newer);
});

test("session backfill marks completed turns only after agent message and task_complete", async () => {
  const dir = await tmpSessionsDir();
  const file = path.join(dir, "2026", "07", "06", "rollout-2026-07-06-thread-2.jsonl");
  await writeJsonl(file, [
    {
      timestamp: "2026-07-06T00:00:00.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ text: "not final" }] }
    },
    {
      timestamp: "2026-07-06T00:00:01.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "done" }
    },
    {
      timestamp: "2026-07-06T00:00:02.000Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-1" }
    }
  ]);

  const backfill = await readCodexSessionBackfill({ sessionsDir: dir, threadId: "thread-2" });
  assert.equal(backfill.ok, true);
  assert.equal(backfill.complete, true);
  assert.equal(backfill.completedTurnId, "turn-1");
  assert.equal(backfill.finalResponseSeen, true);
  assert.equal(backfill.events.length, 3);
});

test("session backfill reports missing sessions without throwing", async () => {
  const backfill = await readCodexSessionBackfill({ sessionsDir: "/tmp/missing-codex-sessions", threadId: "thread-x" });
  assert.equal(backfill.ok, false);
  assert.equal(backfill.reason, "session_not_found");
  assert.equal(backfill.complete, false);
});
