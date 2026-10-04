import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

async function read(path) {
  return fs.readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("release and rollback runbooks cover required gates and smoke checks", async () => {
  const release = await read("docs/release-checklist.md");
  for (const text of [
    "npm ci",
    "npm run verify",
    "npm run audit:ci",
    "npm pack --dry-run --json",
    "/health",
    "/whoami",
    "/settings",
    "/cleanup_uploads"
  ]) {
    assert.match(release, new RegExp(escapeRegExp(text)));
  }
  assert.match(release, /npm run verify/);
  assert.match(release, /Confirm upload cleanup/);

  const rollback = await read("docs/rollback.md");
  for (const text of ["previous", ".env", "state", "runtime/manage.py", "systemctl --user", "npm ci"]) {
    assert.match(rollback, new RegExp(escapeRegExp(text)));
  }
});

test("README files link release and rollback docs", async () => {
  assert.match(await read("README.md"), /docs\/release-checklist\.md/);
  assert.match(await read("README.md"), /docs\/rollback\.md/);
});

test("README files document local verification", async () => {
  assert.match(await read("README.md"), /npm run verify/);
});

test("service units and install docs require private runtime permissions", async () => {
  assert.match(await read("systemd/codex-telegram-bot.service"), /^UMask=0077$/m);
  assert.match(await read("systemd/codex-telegram-worker.service"), /^UMask=0077$/m);
  assert.match(await read("README.md"), /chmod 600 \.env/);
});

test("README and security docs document upload cleanup confirmation button", async () => {
  assert.match(await read("README.md"), /Confirm upload cleanup/);
  assert.match(await read("docs/security-model.md"), /Confirm upload cleanup/);
  assert.match(await read("docs/security-model.md"), /does not delete files/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
