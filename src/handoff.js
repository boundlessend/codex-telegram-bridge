export function sessionHighlightFromItem(item) {
  const timestamp = item?.timestamp || "";
  const payload = item?.payload || {};
  if (item?.type === "event_msg" && payload.type === "agent_message") {
    return { timestamp, kind: "assistant-comment", text: payload.message || "" };
  }
  if (item?.type !== "response_item") return null;
  if (payload.type === "message" && ["user", "assistant"].includes(payload.role)) {
    const text = extractContentText(payload.content);
    if (!text) return null;
    return { timestamp, kind: payload.role, text };
  }
  if (payload.type === "function_call") {
    return { timestamp, kind: "tool-call", text: `${payload.name || "tool"} ${truncate((payload.arguments || "").replace(/\s+/g, " "), 220)}` };
  }
  if (payload.type === "function_call_output") {
    return { timestamp, kind: "tool-output", text: truncate(String(payload.output || "").replace(/\s+/g, " "), 260) };
  }
  return null;
}

export function extractContentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) => entry?.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function renderHandoffMarkdown({ threadId, sessionFile, meta, highlights, generatedAt }) {
  const title = `Codex Handoff ${threadId.slice(0, 8)}`;
  const lines = [
    `# ${title}`,
    "",
    "## Reactivation Prompt",
    "",
    "We are continuing from this handoff. Read this document first, inspect the current repo state, verify what still applies, and continue from the next steps without assuming the old chat context is available.",
    "",
    "## Session",
    "",
    `- thread_id: \`${threadId}\``,
    `- generated_at: \`${generatedAt}\``,
    `- cwd: \`${meta?.cwd || "unknown"}\``,
    `- source: \`${meta?.source || "unknown"}\``,
    `- originator: \`${meta?.originator || "unknown"}\``,
    `- session_file: \`${sessionFile}\``,
    "",
    "## Current State",
    "",
    "- This is an automatic handoff draft generated from local Codex session metadata.",
    "- Review the current git status and project instructions before continuing.",
    "- Treat the recent highlights below as a navigation aid, not as a complete transcript.",
    "",
    "## Recent Highlights",
    ""
  ];
  if (highlights.length === 0) {
    lines.push("- No readable recent highlights were found.");
  } else {
    for (const item of highlights) {
      lines.push(`- ${item.timestamp ? `\`${item.timestamp}\` ` : ""}${item.kind}: ${truncateMarkdownLine(item.text, 320)}`);
    }
  }
  lines.push(
    "",
    "## Next Steps",
    "",
    "1. Read project-local `AGENTS.md` or equivalent instructions.",
    "2. Check `git status --short --branch` in the repo.",
    "3. Re-open the files mentioned in the recent highlights.",
    "4. Continue from the latest user request, keeping changes scoped and verified.",
    ""
  );
  return `${lines.join("\n")}`;
}

export function sanitizeHandoffFilename(value) {
  return String(value || "codex")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "codex";
}

function truncateMarkdownLine(value, max) {
  return truncate(String(value || "").replace(/\s+/g, " ").replaceAll("`", "'"), max);
}

function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}
