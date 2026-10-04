import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { writePrivateFileAtomic, appendPrivateFile, ensurePrivateDirectory } from "../fs/private.js";
import { recoveryPaths } from "./state.js";

const pendingJournalWrites = new Map();

async function journalWrite(file, action) {
  const previous = pendingJournalWrites.get(file) || Promise.resolve();
  const task = previous.catch(() => {}).then(action);
  pendingJournalWrites.set(file, task);
  try { return await task; }
  finally { if (pendingJournalWrites.get(file) === task) pendingJournalWrites.delete(file); }
}

export async function rotateRecoveryJournal(recoveryDir, cutoff, maxBytes) {
  const file = recoveryPaths(recoveryDir).journal;
  return journalWrite(file, async () => {
    try { await fs.access(file); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    const rows = [];
    let bytes = 0;
    const input = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of input) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      const timestamp = Date.parse(event.at);
      if (!Number.isFinite(timestamp)) throw new Error("Recovery journal timestamp is invalid; rotation refused.");
      if (timestamp < cutoff) continue;
      const row = `${line}\n`;
      const size = Buffer.byteLength(row);
      if (size > maxBytes) throw new Error("Recovery record exceeds the journal budget; rotation refused.");
      rows.push(row);
      bytes += size;
      while (bytes > maxBytes) bytes -= Buffer.byteLength(rows.shift());
    }
    await writePrivateFileAtomic(file, rows.join(""));
  });
}

export async function appendRecoveryJournal(recoveryDir, event) {
  await ensurePrivateDirectory(recoveryDir);
  const payload = {
    ...event,
    at: event.at || new Date().toISOString()
  };
  const file = recoveryPaths(recoveryDir).journal;
  await journalWrite(file, () => appendPrivateFile(file, `${JSON.stringify(payload)}\n`, "utf8"));
}

export function summarizeStreamEvent(event) {
  const item = event?.item ?? event?.payload;
  if (!item) {
    return compactObject({
      eventType: event?.type || "unknown",
      payloadType: event?.payload?.type || ""
    });
  }
  return {
    eventType: event.type,
    itemId: item.id || "",
    itemType: item.type || "",
    status: item.status || "",
    length: textLength(item.text || item.command || item.name || item.path || item.message || item.content)
  };
}

function textLength(value) {
  if (Array.isArray(value)) return value.reduce((total, entry) => total + textLength(entry), 0);
  if (value && typeof value === "object") return textLength(value.text || value.content || "");
  return String(value || "").length;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== "" && entry !== undefined));
}
