import test from "node:test";
import assert from "node:assert/strict";
import {
  extractContentText,
  renderHandoffMarkdown,
  sanitizeHandoffFilename,
  sessionHighlightFromItem
} from "../src/handoff.js";

test("extractContentText joins text entries", () => {
  assert.equal(extractContentText([{ text: "one" }, { text: "two" }]), "one\ntwo");
});

test("sessionHighlightFromItem summarizes user messages and tool calls", () => {
  assert.deepEqual(sessionHighlightFromItem({
    timestamp: "2026-06-03T00:00:00Z",
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ text: "hello" }] }
  }), {
    timestamp: "2026-06-03T00:00:00Z",
    kind: "user",
    text: "hello"
  });
  assert.equal(sessionHighlightFromItem({
    type: "response_item",
    payload: { type: "function_call", name: "shell", arguments: "{\"cmd\":\"npm test\"}" }
  }).kind, "tool-call");
});

test("renderHandoffMarkdown includes session metadata and sanitized highlights", () => {
  const markdown = renderHandoffMarkdown({
    threadId: "1234567890abcdef",
    sessionFile: "/tmp/session.jsonl",
    meta: { cwd: "/repo", source: "codex", originator: "telegram" },
    generatedAt: "2026-06-03T00:00:00Z",
    highlights: [{ timestamp: "2026-06-03T00:00:01Z", kind: "assistant", text: "Use `npm test`" }]
  });
  assert.match(markdown, /# Codex Handoff 12345678/);
  assert.match(markdown, /thread_id: `1234567890abcdef`/);
  assert.match(markdown, /assistant: Use 'npm test'/);
});

test("sanitizeHandoffFilename keeps filesystem-safe names", () => {
  assert.equal(sanitizeHandoffFilename("My Repo!"), "my-repo");
});
