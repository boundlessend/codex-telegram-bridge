import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function prepareSharedFile(source, config) {
  if (!config.metadataCleanerScript) throw new Error("Configure FILE_METADATA_CLEANER before sending local files.");
  if (await fs.realpath(source) !== path.resolve(source)) throw new Error("The artifact path changed to a symlink; sending refused.");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-share-"));
  const output = path.join(directory, path.basename(source));
  try {
    const { stdout } = await run(config.metadataCleanerPython || "python3", [config.metadataCleanerScript, source, "-o", output, "--json", "--no-normalize-spaces"], {
      timeout: 60_000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG }
    });
    const report = JSON.parse(stdout);
    if (report.still_has_c2pa || report.still_has_ai_metadata || report.meta?.degraded) {
      throw new Error("Metadata cleanup is incomplete; refusing to send this file.");
    }
    await fs.chmod(output, 0o600);
    const actions = report.actions || [];
    if (report.stats?.removed_count) actions.push(`Removed ${report.stats.removed_count} invisible characters`);
    return { path: output, actions, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw new Error("Cannot clean file metadata; check FILE_METADATA_CLEANER and its dependencies. File was not sent.", { cause: error });
  }
}
