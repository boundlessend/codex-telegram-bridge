import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createWorkerClient } from "../src/worker/client.js";
import { createWorkerServer } from "../src/worker/server.js";
import { createWorkerStore } from "../src/worker/store.js";

function mode(stat) {
  return stat.mode & 0o777;
}

test("scheduled maintenance does not overlap and shutdown waits for its filesystem work", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "worker-maintenance-"));
  const config = {
    codexWorkerStateDir: directory,
    codexWorkerSocket: path.join(directory, "worker.sock"),
    codexWorkerLogRetentionDays: 30,
    stateFile: path.join(directory, "bot-state.json"),
    botRecoveryDir: path.join(directory, "recovery")
  };
  await fs.writeFile(config.stateFile, "{}");
  const store = createWorkerStore(config);
  await store.ensure();
  await store.writeJobState({ id: "old-failed", status: "failed", completedAt: "2020-01-01T00:00:00Z" });
  let releaseWork;
  let enteredWork;
  const gate = new Promise((resolve) => { releaseWork = resolve; });
  const entered = new Promise((resolve) => { enteredWork = resolve; });
  let visits = 0;
  const lock = store.withJobLock;
  store.withJobLock = async (id, action) => {
    visits += 1;
    enteredWork();
    await gate;
    return lock(id, action);
  };
  let initialTick;
  let repeatTick;
  const timeout = globalThis.setTimeout;
  const interval = globalThis.setInterval;
  t.mock.method(globalThis, "setTimeout", (callback, milliseconds, ...args) => {
    if (milliseconds === 60_000) {
      initialTick = callback;
      return timeout(() => {}, 2_000_000_000);
    }
    return timeout(callback, milliseconds, ...args);
  });
  t.mock.method(globalThis, "setInterval", (callback, milliseconds, ...args) => {
    if (milliseconds === 3_600_000) {
      repeatTick = callback;
      return interval(() => {}, 2_000_000_000);
    }
    return interval(callback, milliseconds, ...args);
  });
  const worker = createWorkerServer({ config, store, logger: { warn() {} } });
  t.after(async () => {
    releaseWork();
    await worker.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await worker.listen();
  assert.equal(typeof initialTick, "function");
  assert.equal(typeof repeatTick, "function");
  initialTick();
  await entered;
  repeatTick();
  await delay(50);
  assert.equal(visits, 1);
  const closing = worker.close();
  await delay(20);
  assert.equal(worker.server.listening, true);
  releaseWork();
  await closing;
  assert.equal(worker.server.listening, false);
  assert.equal(await store.readJobState("old-failed"), null);
});

async function startServer(executeJob, options = {}) {
  const { prepareStore, ...serverOptions } = options;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-worker-server-"));
  const config = {
    codexWorkerStateDir: dir,
    codexWorkerSocket: path.join(dir, "worker.sock"),
    codexWorkerConnectTimeoutMs: 5000,
    codexTransport: "sdk"
  };
  const store = createWorkerStore(config);
  await prepareStore?.(store);
  const worker = createWorkerServer({ config, store, executeJob, logger: { warn() {} }, ...serverOptions });
  await worker.listen();
  return { config, worker, client: createWorkerClient(config), store };
}

test("worker server reports status", async () => {
  const { config, worker, client } = await startServer(async () => {});
  try {
  assert.deepEqual(await client.status(), { status: "ok", capabilities: ["accounts-v1", "log-archive-v1"], activeJobs: [], runningJobIds: [] });
    assert.equal(mode(await fs.stat(config.codexWorkerSocket)), 0o600);
  } finally {
    await worker.close();
  }
});

test("worker blocks new jobs during a host update without affecting status queries", async () => {
  let starts = 0;
  const { config, worker, client } = await startServer(async () => { starts += 1; });
  config.codexUpdateDir = path.join(config.codexWorkerStateDir, "codex-update");
  try {
    await fs.mkdir(config.codexUpdateDir);
    await fs.writeFile(path.join(config.codexUpdateDir, "status.json"), JSON.stringify({ phase: "waiting_idle" }));
    await assert.rejects(client.startJob({ id: "blocked", chatKey: "chat" }), /new jobs are paused/);
    assert.equal(starts, 0);
    assert.equal((await client.status()).activeJobs.length, 0);
    await fs.writeFile(path.join(config.codexUpdateDir, "status.json"), JSON.stringify({ phase: "succeeded" }));
    await client.startJob({ id: "allowed", chatKey: "chat" });
    assert.equal(starts, 1);
  } finally { await worker.close(); }
});

test("worker server writes heartbeat events for running jobs", async () => {
  const executeJob = async ({ signal }) => {
    if (!signal.aborted) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    }
  };
  const { worker, client } = await startServer(executeJob, { heartbeatMs: 20 });
  try {
    await client.startJob({ id: "job-heartbeat", chatKey: "chat-heartbeat", inputText: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const events = await client.readJobEvents("job-heartbeat", 0);
    assert.equal(events.events.some((event) => event.type === "worker.heartbeat"), true);
    await client.cancelJob("job-heartbeat");
  } finally {
    await worker.close();
  }
});

test("worker server survives socket errors and a client disconnect before a response is ready", async (t) => {
  let releaseRead;
  const readGate = new Promise((resolve) => {
    releaseRead = resolve;
  });
  t.after(() => releaseRead());
  const { config, worker, client } = await startServer(async () => {}, {
    prepareStore: async (store) => {
      const readJobEvents = store.readJobEvents;
      store.readJobEvents = async (...args) => {
        await readGate;
        return readJobEvents(...args);
      };
    }
  });
  try {
    const socketErrorResult = new Promise((resolve) => {
      worker.server.once("connection", (socket) => {
        try {
          socket.emit("error", Object.assign(new Error("injected reset"), { code: "ECONNRESET" }));
          resolve(null);
        } catch (error) {
          resolve(error);
        }
      });
    });
    const impatientClient = createWorkerClient({
      ...config,
      codexWorkerConnectTimeoutMs: 5
    });
    await assert.rejects(
      () => impatientClient.readJobEvents("job-disconnected", 0),
      /worker request timed out/
    );
    assert.equal(await socketErrorResult, null);
    releaseRead();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await client.status()).status, "ok");
  } finally {
    await worker.close();
  }
});

test("worker server records shutdown for active jobs", async () => {
  const executeJob = async ({ signal }) => {
    if (!signal.aborted) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    }
  };
  const { worker, client, store } = await startServer(executeJob);
  await client.startJob({ id: "job-shutdown", chatKey: "chat-shutdown", inputText: "hi" });
  await worker.close();
  const events = await store.readJobEvents("job-shutdown", { afterSeq: 0 });
  assert.equal(events.some((event) => event.type === "worker.shutdown"), true);
});

test("worker close waits for active job cleanup", async (t) => {
  let releaseCleanup;
  let markCleanupStarted;
  const cleanupGate = new Promise((resolve) => {
    releaseCleanup = resolve;
  });
  const cleanupStarted = new Promise((resolve) => {
    markCleanupStarted = resolve;
  });
  t.after(() => releaseCleanup());

  const executeJob = async ({ job, store, signal }) => {
    if (!signal.aborted) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    }
    markCleanupStarted();
    await cleanupGate;
    await store.appendJobEvent(job.id, {
      type: "worker.job.cancelled",
      status: "cancelled",
      chatKey: job.chatKey
    });
  };
  const { worker, client, store } = await startServer(executeJob);
  await client.startJob({ id: "job-close", chatKey: "chat-close", inputText: "hi" });

  const closing = worker.close();
  await cleanupStarted;
  const closeState = await Promise.race([
    closing.then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("waiting"), 50))
  ]);
  assert.equal(closeState, "waiting");

  releaseCleanup();
  await closing;
  assert.equal((await store.readActiveJobs()).jobs["job-close"], undefined);
  assert.equal((await store.readJobState("job-close")).status, "cancelled");
});

test("worker startup marks persisted orphaned jobs failed", async () => {
  const { worker, client, store } = await startServer(async () => {}, {
    prepareStore: async (preparedStore) => {
      await preparedStore.writeJobState({ id: "job-orphan", chatKey: "chat-orphan", status: "running" });
      await preparedStore.upsertActiveJob({ id: "job-orphan", chatKey: "chat-orphan", status: "running" });
    }
  });
  try {
  assert.deepEqual(await client.status(), { status: "ok", capabilities: ["accounts-v1", "log-archive-v1"], activeJobs: [], runningJobIds: [] });
    assert.equal((await store.readJobState("job-orphan")).status, "failed");
    assert.equal((await store.readJobState("job-orphan")).failureReason, "worker_restart");
    assert.equal(
      (await store.readJobState("job-orphan")).error,
      "worker restarted before job completed"
    );
    const events = await store.readJobEvents("job-orphan", { afterSeq: 0 });
    assert.equal(events.at(-1).type, "worker.job.failed");
    assert.equal(events.at(-1).reason, "worker_restart");
  } finally {
    await worker.close();
  }
});

test("worker cancel finalizes a persisted orphan without a controller", async () => {
  const { worker, client, store } = await startServer(async () => {});
  try {
    await store.writeJobState({ id: "job-orphan", chatKey: "chat-orphan", status: "running" });
    await store.upsertActiveJob({ id: "job-orphan", chatKey: "chat-orphan", status: "running" });

    assert.deepEqual(await client.cancelJob("job-orphan"), {
      jobId: "job-orphan",
      cancelled: true,
      orphaned: true
    });
    assert.deepEqual((await client.status()).activeJobs, []);
    assert.equal((await store.readJobState("job-orphan")).status, "cancelled");
    const events = await store.readJobEvents("job-orphan", { afterSeq: 0 });
    assert.equal(events.at(-1).type, "worker.job.cancelled");
  } finally {
    await worker.close();
  }
});

test("worker server starts, rejects duplicate chat jobs, and cancels", async () => {
  const executeJob = async ({ job, store, signal }) => {
    await store.appendJobEvent(job.id, { type: "worker.job.started", status: "running", chatKey: job.chatKey });
    if (!signal.aborted) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    }
    await store.appendJobEvent(job.id, { type: "worker.job.cancelled", status: "cancelled", chatKey: job.chatKey });
  };
  const { worker, client } = await startServer(executeJob);
  try {
    assert.deepEqual(await client.startJob({ id: "job-1", chatKey: "chat-1", inputText: "hi" }), {
      jobId: "job-1",
      status: "accepted"
    });
    await assert.rejects(
      () => client.startJob({ id: "job-2", chatKey: "chat-1", inputText: "hi again" }),
      /Active worker job already exists/
    );
    assert.equal((await client.status()).activeJobs.length, 1);
    assert.deepEqual(await client.cancelJob("job-1"), { jobId: "job-1", cancelled: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const events = await client.readJobEvents("job-1", 0);
    assert.equal(events.events.some((event) => event.type === "worker.job.cancelled"), true);
  } finally {
    await worker.close();
  }
});
