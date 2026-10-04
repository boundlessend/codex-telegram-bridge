import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

async function readJson(path) {
  return JSON.parse(await fs.readFile(new URL(`../${path}`, import.meta.url), "utf8"));
}

async function exists(path) {
  try {
    await fs.access(new URL(`../${path}`, import.meta.url));
    return true;
  } catch {
    return false;
  }
}

async function lineCount(path) {
  const text = await fs.readFile(new URL(`../${path}`, import.meta.url), "utf8");
  return text.trimEnd().split("\n").length;
}

test("independent distribution preserves attribution and excludes private screenshots", async () => {
  const pkg = await readJson("package.json");
  assert.equal(pkg.name, "codex-telegram-bridge");
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.license, "BSD-3-Clause AND MIT");
  assert.equal(pkg.private, true);
  assert.equal(pkg.repository?.url, "git+https://github.com/boundlessend/codex-telegram-bridge.git");
  assert.match(pkg.dependencies["@openai/codex-sdk"], /^\d+\.\d+\.\d+$/);
  assert.match(pkg.devDependencies["@openai/codex"], /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.devDependencies["@openai/codex"], pkg.dependencies["@openai/codex-sdk"]);
  assert.equal(pkg.files.includes("assets"), false);
  assert.ok(pkg.files.includes("LICENSES"));
  assert.ok(pkg.files.includes("NOTICE"));
  assert.ok(pkg.files.includes("LICENSE"));
  assert.ok(pkg.files.includes("SECURITY.md"));
  assert.equal(await exists("assets/readme-hero.png"), false);
  assert.equal(await exists("assets/screenshots/main-control.jpg"), false);
  assert.equal(await exists("LICENSE"), true);
  assert.equal(await exists("SECURITY.md"), true);
  assert.equal(await exists("CONTRIBUTING.md"), true);
});

test("public CI keeps baseline verification commands", async () => {
  const workflow = await fs.readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const pkg = await readJson("package.json");
  assert.match(workflow, /npm ci --ignore-scripts --audit=false/);
  assert.match(workflow, /npm run verify/);
  assert.match(workflow, /node-version: 24/);
  assert.match(workflow, /npm run audit:ci/);
  assert.match(workflow, /npm pack --dry-run --json/);
  assert.match(workflow, /os: \[ubuntu-latest, macos-latest\]/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /contents: write|pull-requests: write/);
  assert.doesNotMatch(pkg.scripts.verify, /npm audit/);
  assert.equal(pkg.scripts["audit:ci"], "node scripts/npm_audit_gate.mjs");
});

test("distribution has no automatic publishing or credential-dependent workflows", async () => {
  assert.deepEqual(await fs.readdir(new URL("../.github/workflows", import.meta.url)), ["ci.yml"]);
});

test("bot entrypoint stays thin and runtime stays packaged", async () => {
  const bot = await fs.readFile(new URL("../src/bot.js", import.meta.url), "utf8");
  const pkg = await readJson("package.json");
  assert.equal(bot.trim(), 'import "./runtime.js";');
  assert.ok(await exists("src/runtime.js"));
  assert.ok(await lineCount("src/bot.js") <= 10);
  assert.ok(pkg.files.includes("src"));
});
