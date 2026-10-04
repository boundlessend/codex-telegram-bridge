import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readConfig } from "../src/config.js";
import { prepareSharedFile } from "../src/telegram/file_hygiene.js";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const cleaner = path.join(root, "scripts/clean-metadata.py");
const createFixtures = `
from pathlib import Path
import struct
import sys
import zlib
import zipfile
root = Path(sys.argv[1])
def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
png = bytes.fromhex('89504e470d0a1a0a')
png += chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(bytes([0, 255, 255, 255])))
png += chunk(b'IEND', b'')
(root / 'fixture.png').write_bytes(png)
objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>', b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>']
pdf = b'%PDF-1.4\\n'
offsets = [0]
for number, value in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf += str(number).encode() + b' 0 obj\\n' + value + b'\\nendobj\\n'
xref = len(pdf)
pdf += b'xref\\n0 4\\n0000000000 65535 f \\n'
for offset in offsets[1:]:
    pdf += ('%010d 00000 n \\n' % offset).encode()
pdf += b'trailer\\n<< /Size 4 /Root 1 0 R >>\\nstartxref\\n' + str(xref).encode() + b'\\n%%EOF\\n'
(root / 'fixture.pdf').write_bytes(pdf)
with zipfile.ZipFile(root / 'fixture.docx', 'w') as archive:
    archive.writestr('docProps/core.xml', '<metadata>fixture author</metadata>')
    archive.writestr('word/document.xml', '<document>fixture content</document>')
    archive.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>')
    archive.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/docProps/core.xml" ContentType="application/xml"/></Types>')
`;

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-portability-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("portable state root applies to worker, uploads and persistence", () => {
  const config = readConfig({ TELEGRAM_BOT_TOKEN: "123:fixture", ALLOWED_USER_IDS: "42", CODEX_TELEGRAM_STATE_DIR: "/external/bridge-state" });
  assert.equal(config.stateFile, "/external/bridge-state/threads.json");
  assert.equal(config.codexWorkerStateDir, "/external/bridge-state/worker");
  assert.equal(config.uploadDir, "/external/bridge-state/uploads");
  assert.equal(config.codexApprovalPolicy, "on-request");
  assert.deepEqual([...config.codexAllowedApprovalPolicies], ["on-request", "untrusted"]);
});

test("cleaning preserves source bytes and nonbreaking spaces while removing invisible markers", async (t) => {
  const directory = await fixture(t);
  const source = path.join(directory, "report.md");
  const original = "a\u200bb\u00a0c\u2060d";
  await fs.writeFile(source, original);
  const prepared = await prepareSharedFile(source, { metadataCleanerPython: "python3", metadataCleanerScript: cleaner });
  try {
    assert.equal(await fs.readFile(source, "utf8"), original);
    assert.equal(await fs.readFile(prepared.path, "utf8"), "ab\u00a0cd");
    assert.ok(prepared.actions.some((action) => action.includes("2 invisible")));
    assert.equal((await fs.stat(prepared.path)).mode & 0o777, 0o600);
  } finally {
    await prepared.cleanup();
  }
});

test("unsupported files cannot pass outgoing metadata cleaning", async (t) => {
  const directory = await fixture(t);
  const source = path.join(directory, "unknown.bin");
  await fs.writeFile(source, "fixture");
  await assert.rejects(prepareSharedFile(source, { metadataCleanerScript: cleaner }), /File was not sent/);
});

test("PNG metadata is removed by the real exiftool and source stays unchanged", async (t) => {
  const directory = await fixture(t);
  const source = path.join(directory, "fixture.png");
  await run("python3", ["-c", createFixtures, directory]);
  await run("exiftool", ["-overwrite_original", "-Comment=fixture metadata", source]);
  const before = await fs.readFile(source);
  const prepared = await prepareSharedFile(source, { metadataCleanerScript: cleaner });
  try {
    const { stdout } = await run("exiftool", ["-j", prepared.path]);
    assert.equal(JSON.parse(stdout)[0].Comment, undefined);
    assert.deepEqual(await fs.readFile(source), before);
  } finally {
    await prepared.cleanup();
  }
});

test("PDF cleaning rewrites incremental metadata and validates with real qpdf", async (t) => {
  const directory = await fixture(t);
  const source = path.join(directory, "fixture.pdf");
  await run("python3", ["-c", createFixtures, directory]);
  await run("exiftool", ["-overwrite_original", "-Author=fixture author", source]);
  const prepared = await prepareSharedFile(source, { metadataCleanerScript: cleaner });
  try {
    await run("qpdf", ["--check", prepared.path]);
    assert.equal((await fs.readFile(prepared.path)).includes(Buffer.from("fixture author")), false);
  } finally {
    await prepared.cleanup();
  }
});

test("Office cleaning removes document properties and their references while preserving content", async (t) => {
  const directory = await fixture(t);
  await run("python3", ["-c", createFixtures, directory]);
  const prepared = await prepareSharedFile(path.join(directory, "fixture.docx"), { metadataCleanerScript: cleaner });
  try {
    await run("python3", ["-c", `
import sys
import zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    assert 'docProps/core.xml' not in archive.namelist()
    assert archive.read('word/document.xml') == b'<document>fixture content</document>'
    assert b'docProps' not in archive.read('_rels/.rels')
    assert b'docProps' not in archive.read('[Content_Types].xml')
    assert all(entry.date_time == (1980, 1, 1, 0, 0, 0) for entry in archive.infolist())
`, prepared.path]);
  } finally {
    await prepared.cleanup();
  }
});

test("macOS doctor checks a clean home without reading credentials or starting services", async (t) => {
  const directory = await fixture(t);
  await assert.rejects(run("python3", [path.join(root, "runtime/manage.py"), "doctor"], {
    env: { ...process.env, HOME: directory }
  }), (error) => {
    assert.equal(error.code, 1);
    const report = JSON.parse(error.stdout);
    assert.equal(report.settings_ready, false);
    assert.equal(report.credentials_checked, false);
    assert.equal(report.dependencies_installed, true);
    return true;
  });
  assert.deepEqual(await fs.readdir(directory), []);
});
