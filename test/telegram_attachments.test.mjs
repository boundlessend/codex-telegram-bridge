import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  extractTelegramPhotoArtifacts,
  parseStandaloneMarkdownImage,
  parseTelegramPhotoDirective
} from "../src/telegram/attachments.js";

async function createImageFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-photo-artifacts-"));
  const filePath = path.join(root, "chart.png");
  await fs.writeFile(filePath, "png");
  return { root, filePath };
}

test("parseTelegramPhotoDirective extracts path and caption", () => {
  assert.deepEqual(
    parseTelegramPhotoDirective("[[telegram_photo:/tmp/chart.png|caption=SPCX 차트]]"),
    { path: "/tmp/chart.png", caption: "SPCX 차트" }
  );
});

test("parseStandaloneMarkdownImage extracts absolute local image path", () => {
  assert.deepEqual(
    parseStandaloneMarkdownImage("![SPCX 차트](/tmp/chart.png)"),
    { path: "/tmp/chart.png", caption: "SPCX 차트" }
  );
  assert.equal(parseStandaloneMarkdownImage("[SPCX](https://example.com/chart.png)"), undefined);
});

test("extractTelegramPhotoArtifacts removes directive and resolves allowed image", async () => {
  const { root, filePath } = await createImageFixture();
  const result = await extractTelegramPhotoArtifacts([
    "요약입니다.",
    `[[telegram_photo:${filePath}|caption=SPCX 차트]]`,
    "끝입니다."
  ].join("\n"), { allowedRoots: [root] });

  assert.equal(result.text, "요약입니다.\n끝입니다.");
  assert.deepEqual(result.photos, [{ path: filePath, caption: "SPCX 차트" }]);
  assert.deepEqual(result.rejected, []);
});

test("extractTelegramPhotoArtifacts resolves standalone Markdown image", async () => {
  const { root, filePath } = await createImageFixture();
  const result = await extractTelegramPhotoArtifacts(`![SPCX 차트](${filePath})`, { allowedRoots: [root] });

  assert.equal(result.text, "");
  assert.deepEqual(result.photos, [{ path: filePath, caption: "SPCX 차트" }]);
});

test("extractTelegramPhotoArtifacts rejects paths outside allowed roots", async () => {
  const { filePath } = await createImageFixture();
  const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-photo-allowed-"));
  const result = await extractTelegramPhotoArtifacts(`[[telegram_photo:${filePath}]]`, { allowedRoots: [allowedRoot] });

  assert.equal(result.photos.length, 0);
  assert.deepEqual(result.rejected, [{ path: filePath, caption: undefined, reason: "outside_allowed_roots" }]);
});

test("extractTelegramPhotoArtifacts ignores image syntax inside fenced code", async () => {
  const { root, filePath } = await createImageFixture();
  const source = [
    "```md",
    `[[telegram_photo:${filePath}|caption=SPCX 차트]]`,
    "```"
  ].join("\n");
  const result = await extractTelegramPhotoArtifacts(source, { allowedRoots: [root] });

  assert.equal(result.text, source);
  assert.deepEqual(result.photos, []);
  assert.deepEqual(result.rejected, []);
});
