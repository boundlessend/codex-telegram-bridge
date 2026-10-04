import test from "node:test";
import assert from "node:assert/strict";
import { handleDirectShutdownSignal } from "../src/recovery/shutdown.js";

test("direct SIGTERM creates a recovery marker when active turns exist", async () => {
  const calls = [];
  await handleDirectShutdownSignal({
    signal: "SIGTERM",
    activeTurns: new Map([["chat-1", {}]]),
    recoveryEnabled: true,
    recoveryDir: "/tmp/recovery",
    createMarker: async (dir, marker) => calls.push(["marker", dir, marker]),
    stopBot: (signal) => calls.push(["stop", signal]),
    exit: (code) => calls.push(["exit", code]),
    logger: { warn: (...args) => calls.push(["warn", ...args]) }
  });

  assert.deepEqual(calls, [
    ["marker", "/tmp/recovery", {
      mode: "sigterm",
      requestedBy: "signal",
      reason: "external_sigterm",
      exitCode: 0
    }],
    ["stop", "SIGTERM"],
    ["exit", 0]
  ]);
});

test("direct SIGTERM without active turns exits like ordinary shutdown", async () => {
  const calls = [];
  await handleDirectShutdownSignal({
    signal: "SIGTERM",
    activeTurns: new Map(),
    recoveryEnabled: true,
    recoveryDir: "/tmp/recovery",
    createMarker: async () => calls.push(["marker"]),
    stopBot: (signal) => calls.push(["stop", signal]),
    exit: (code) => calls.push(["exit", code]),
    logger: { warn: (...args) => calls.push(["warn", ...args]) }
  });

  assert.deepEqual(calls, [
    ["stop", "SIGTERM"],
    ["exit", 0]
  ]);
});

test("direct SIGTERM creates a recovery marker when persisted snapshots exist", async () => {
  const calls = [];
  await handleDirectShutdownSignal({
    signal: "SIGTERM",
    activeTurns: new Map(),
    recoveryEnabled: true,
    recoveryDir: "/tmp/recovery",
    hasRecoverySnapshots: async () => true,
    createMarker: async (dir, marker) => calls.push(["marker", dir, marker]),
    stopBot: (signal) => calls.push(["stop", signal]),
    exit: (code) => calls.push(["exit", code]),
    logger: { warn: (...args) => calls.push(["warn", ...args]) }
  });

  assert.deepEqual(calls, [
    ["marker", "/tmp/recovery", {
      mode: "sigterm",
      requestedBy: "signal",
      reason: "external_sigterm",
      exitCode: 0
    }],
    ["stop", "SIGTERM"],
    ["exit", 0]
  ]);
});

test("direct SIGTERM logs marker write failures and still exits", async () => {
  const calls = [];
  await handleDirectShutdownSignal({
    signal: "SIGTERM",
    activeTurns: new Map([["chat-1", {}]]),
    recoveryEnabled: true,
    recoveryDir: "/tmp/recovery",
    createMarker: async () => {
      throw new Error("disk full");
    },
    stopBot: (signal) => calls.push(["stop", signal]),
    exit: (code) => calls.push(["exit", code]),
    logger: { warn: (...args) => calls.push(["warn", ...args]) }
  });

  assert.equal(calls[0][0], "warn");
  assert.equal(calls[0][1], "SIGTERM recovery marker write failed:");
  assert.equal(calls[0][2], "disk full");
  assert.deepEqual(calls.slice(1), [
    ["stop", "SIGTERM"],
    ["exit", 0]
  ]);
});
