import test from "node:test";
import assert from "node:assert/strict";
import { createRestartController } from "../src/recovery/controller.js";

function controllerFixture(overrides = {}) {
  const exits = [];
  const events = [];
  const sleeps = [];
  const markers = [];
  let now = 0;
  const activeTurns = overrides.activeTurns ?? new Map();
  const controller = createRestartController({
    activeTurns,
    exitCode: 75,
    drainTimeoutSeconds: overrides.drainTimeoutSeconds ?? 10,
    delaySeconds: 0,
    pollMs: 1,
    nowMs: () => now,
    createMarker: async (options) => {
      if (overrides.markerError) throw overrides.markerError;
      const marker = { restartId: `rst_${markers.length + 1}`, ...options };
      markers.push(marker);
      return marker;
    },
    appendEvent: async (event) => {
      events.push(event);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
      await overrides.onSleep?.({ activeTurns, sleeps, now });
    },
    exit: (code) => {
      exits.push(code);
    },
    logger: { error() {} }
  });
  return { activeTurns, controller, events, exits, markers, sleeps };
}

test("restart controller writes marker and schedules configured exit", async () => {
  const fixture = controllerFixture();
  const marker = await fixture.controller.requestRestart({
    mode: "restart",
    requestedBy: "telegram",
    reason: "self_restart"
  });
  await fixture.controller.exitPromise();
  assert.equal(marker.restartId, "rst_1");
  assert.equal(fixture.markers.length, 1);
  assert.deepEqual(fixture.events, [{
    type: "planned_restart_exit",
    restartId: "rst_1",
    activeTurns: 0,
    exitCode: 75
  }]);
  assert.deepEqual(fixture.exits, [75]);
});

test("restart controller dedupes repeated requests and keeps one exit callback", async () => {
  const fixture = controllerFixture();
  const first = await fixture.controller.requestRestart({ mode: "restart" });
  const second = await fixture.controller.requestRestart({ mode: "restart" });
  await fixture.controller.exitPromise();
  assert.equal(first, second);
  assert.equal(fixture.markers.length, 1);
  assert.deepEqual(fixture.exits, [75]);
});

test("restart controller waits for active turns to drain before exit", async () => {
  const activeTurns = new Map([["chat", {}]]);
  const fixture = controllerFixture({
    activeTurns,
    onSleep: async ({ activeTurns: turns }) => {
      turns.clear();
    }
  });
  await fixture.controller.requestRestart({ mode: "sigusr1" });
  await fixture.controller.exitPromise();
  assert.deepEqual(fixture.sleeps, [1]);
  assert.deepEqual(fixture.exits, [75]);
});

test("restart controller exits after drain deadline with best-effort marker", async () => {
  const activeTurns = new Map([["chat", {}]]);
  const fixture = controllerFixture({ activeTurns, drainTimeoutSeconds: 0 });
  await fixture.controller.requestRestart({ mode: "restart" });
  await fixture.controller.exitPromise();
  assert.deepEqual(fixture.events, [{
    type: "planned_restart_exit",
    restartId: "rst_1",
    activeTurns: 1,
    exitCode: 75
  }]);
  assert.deepEqual(fixture.exits, [75]);
});

test("restart controller does not schedule exit when marker write fails", async () => {
  const fixture = controllerFixture({ markerError: new Error("disk full") });
  await assert.rejects(
    () => fixture.controller.requestRestart({ mode: "restart" }),
    /disk full/
  );
  assert.equal(fixture.controller.isScheduled(), false);
  assert.equal(fixture.controller.exitPromise(), null);
  assert.deepEqual(fixture.exits, []);
});
