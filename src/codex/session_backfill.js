import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_SESSION_FILES = 1000;

export async function readCodexSessionBackfill({
  sessionsDir,
  threadId,
  sinceMs = 0,
  maxFiles = DEFAULT_MAX_SESSION_FILES
} = {}) {
  const normalizedThreadId = String(threadId || "").trim();
  if (!sessionsDir || !normalizedThreadId) {
    return emptyBackfill("missing_thread");
  }

  const file = await findLatestSessionFileForThread(sessionsDir, normalizedThreadId, { maxFiles });
  if (!file) return emptyBackfill("session_not_found");

  const events = [];
  let lastActivityAt = "";
  let lastTurnId = "";
  let completedTurnId = "";
  let failedTurnId = "";
  let finalResponseSeen = false;
  const cutoff = Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs - 1000 : 0;

  for (const line of (await fs.readFile(file, "utf8")).split(/\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const timestampMs = Date.parse(event.timestamp || event.at || "");
    if (cutoff > 0 && Number.isFinite(timestampMs) && timestampMs < cutoff) continue;
    const payload = event.payload || {};
    if (event.timestamp || event.at) lastActivityAt = event.timestamp || event.at;
    if (payload.turn_id) lastTurnId = String(payload.turn_id);
    if (isAgentMessageEvent(event)) finalResponseSeen = true;
    if (event.type === "event_msg" && payload.type === "task_complete") completedTurnId = String(payload.turn_id || lastTurnId || "");
    if (event.type === "event_msg" && payload.type === "task_failed") failedTurnId = String(payload.turn_id || lastTurnId || "");
    events.push(event);
  }

  return {
    ok: true,
    file,
    events,
    lastActivityAt,
    lastTurnId,
    completedTurnId,
    failedTurnId,
    finalResponseSeen,
    complete: Boolean(completedTurnId && finalResponseSeen),
    failed: Boolean(failedTurnId)
  };
}

export async function findLatestSessionFileForThread(sessionsDir, threadId, { maxFiles = DEFAULT_MAX_SESSION_FILES } = {}) {
  const matches = [];
  await collectSessionFiles(sessionsDir, String(threadId), matches, { maxFiles }).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0]?.file || "";
}

function emptyBackfill(reason) {
  return {
    ok: false,
    reason,
    file: "",
    events: [],
    lastActivityAt: "",
    lastTurnId: "",
    completedTurnId: "",
    failedTurnId: "",
    finalResponseSeen: false,
    complete: false,
    failed: false
  };
}

async function collectSessionFiles(dir, threadId, matches, { maxFiles }) {
  if (matches.length >= maxFiles) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (matches.length >= maxFiles) return;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSessionFiles(fullPath, threadId, matches, { maxFiles });
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl") || !entry.name.includes(threadId)) continue;
    const stat = await fs.stat(fullPath);
    matches.push({ file: fullPath, mtimeMs: stat.mtimeMs });
  }
}

function isAgentMessageEvent(event) {
  const payload = event.payload || {};
  if (event.type === "event_msg" && payload.type === "agent_message") return true;
  if (event.type === "response_item" && payload.type === "message") return !payload.role || payload.role === "assistant";
  return false;
}
