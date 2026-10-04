import test from "node:test";
import assert from "node:assert/strict";
import { parseCodexMaintenanceOutput } from "../src/maintenance/codex.js";

test("parseCodexMaintenanceOutput parses JSON reports", () => {
  assert.deepEqual(parseCodexMaintenanceOutput("{\"ok\":true,\"sessions\":{\"files\":1}}"), {
    ok: true,
    sessions: { files: 1 }
  });
});

test("parseCodexMaintenanceOutput reports invalid output clearly", () => {
  assert.throws(() => parseCodexMaintenanceOutput("not json"), /Codex maintenance output must be JSON/);
});
