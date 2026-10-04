import test from "node:test";
import assert from "node:assert/strict";
import { buildInput, mergeReplyContext } from "../src/codex/input.js";

test("buildInput returns plain text when there are no images", () => {
  assert.equal(buildInput("hello", []), "hello");
});

test("buildInput includes local image entries after text", () => {
  assert.deepEqual(buildInput("analyze", ["/tmp/a.png", "/tmp/b.jpg"]), [
    { type: "text", text: "analyze" },
    { type: "local_image", path: "/tmp/a.png" },
    { type: "local_image", path: "/tmp/b.jpg" }
  ]);
});

test("mergeReplyContext wraps replied message and current message", () => {
  const merged = mergeReplyContext("current", { text: "previous" });
  assert.match(merged, /<replied_message>\nprevious\n<\/replied_message>/);
  assert.match(merged, /<current_message>\ncurrent\n<\/current_message>/);
});

test("mergeReplyContext preserves current text without reply context", () => {
  assert.equal(mergeReplyContext("current", { text: "" }), "current");
});
