import test from "node:test";
import assert from "node:assert/strict";
import { startRecoveryBackfillPoller } from "../src/recovery/backfill_poller.js";

test("recovery backfill poller recovers and stops after a successful interval check", async () => {
  let tick = null;
  let shouldRecover = false;
  const checks = [];
  const recovered = [];
  const cleared = [];

  const poller = startRecoveryBackfillPoller({
    intervalMs: 30_000,
    setIntervalFn: (callback, intervalMs) => {
      tick = callback;
      assert.equal(intervalMs, 30_000);
      return "timer";
    },
    clearIntervalFn: (timer) => cleared.push(timer),
    check: async ({ reason }) => {
      checks.push(reason);
      return shouldRecover;
    },
    onRecovered: async ({ reason }) => recovered.push(reason)
  });

  assert.equal(await tick(), false);
  assert.deepEqual(checks, ["interval"]);
  assert.deepEqual(recovered, []);
  assert.deepEqual(cleared, []);

  shouldRecover = true;
  assert.equal(await tick(), true);
  assert.deepEqual(checks, ["interval", "interval"]);
  assert.deepEqual(recovered, ["interval"]);
  assert.deepEqual(cleared, ["timer"]);

  assert.equal(await poller.checkNow(), false);
  assert.deepEqual(checks, ["interval", "interval"]);
});

test("recovery backfill poller can be disabled with a non-positive interval", async () => {
  let scheduled = false;
  const poller = startRecoveryBackfillPoller({
    intervalMs: 0,
    setIntervalFn: () => {
      scheduled = true;
      return "timer";
    },
    check: async () => true
  });

  assert.equal(await poller.checkNow(), false);
  assert.equal(scheduled, false);
});

test("recovery backfill poller skips overlapping checks", async () => {
  let tick = null;
  let resolveCheck = null;
  let checkCount = 0;
  let blockCheck = true;

  const poller = startRecoveryBackfillPoller({
    intervalMs: 100,
    setIntervalFn: (callback) => {
      tick = callback;
      return "timer";
    },
    clearIntervalFn: () => {},
    check: async () => {
      checkCount += 1;
      if (!blockCheck) return false;
      return new Promise((resolve) => {
        resolveCheck = resolve;
      });
    }
  });

  const first = tick();
  const second = await tick();
  assert.equal(second, false);
  assert.equal(checkCount, 1);

  resolveCheck(false);
  assert.equal(await first, false);
  blockCheck = false;
  assert.equal(await poller.checkNow(), false);
  assert.equal(checkCount, 2);

  poller.stop();
});

test("recovery backfill poller reports errors without stopping future checks", async () => {
  let tick = null;
  let fail = true;
  const errors = [];
  const checks = [];

  startRecoveryBackfillPoller({
    intervalMs: 100,
    setIntervalFn: (callback) => {
      tick = callback;
      return "timer";
    },
    clearIntervalFn: () => {},
    check: async ({ reason }) => {
      checks.push(reason);
      if (fail) throw new Error("backfill failed");
      return false;
    },
    onError: async (error, { reason }) => {
      errors.push({ message: error.message, reason });
    }
  });

  assert.equal(await tick(), false);
  assert.deepEqual(errors, [{ message: "backfill failed", reason: "interval" }]);

  fail = false;
  assert.equal(await tick(), false);
  assert.deepEqual(checks, ["interval", "interval"]);
  assert.equal(errors.length, 1);
});
