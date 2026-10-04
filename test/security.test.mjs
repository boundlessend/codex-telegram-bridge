import test from "node:test";
import assert from "node:assert/strict";
import { authorizeTelegramUpdate } from "../src/security.js";

function config(values = {}) {
  return {
    allowedUserIds: new Set(["42"]),
    allowedChatIds: new Set(),
    allowedThreadIds: new Set(),
    ...values
  };
}

test("security guard rejects unauthorized users", () => {
  const result = authorizeTelegramUpdate({ from: { id: 7 }, chat: { id: 100 } }, config());
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unauthorized_user");
});

test("security guard rejects authorized users in disallowed chats", () => {
  const result = authorizeTelegramUpdate({ from: { id: 42 }, chat: { id: 200 } }, config({
    allowedChatIds: new Set(["100"])
  }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "disallowed_chat");
});

test("security guard accepts authorized users in allowed chats", () => {
  const result = authorizeTelegramUpdate({ from: { id: 42 }, chat: { id: 100 } }, config({
    allowedChatIds: new Set(["100"])
  }));
  assert.equal(result.ok, true);
});

test("security guard enforces allowed forum thread ids", () => {
  const allowed = authorizeTelegramUpdate({
    from: { id: 42 },
    chat: { id: 100 },
    message: { message_thread_id: 300 }
  }, config({ allowedChatIds: new Set(["100"]), allowedThreadIds: new Set(["300"]) }));
  const denied = authorizeTelegramUpdate({
    from: { id: 42 },
    chat: { id: 100 },
    message: { message_thread_id: 301 }
  }, config({ allowedChatIds: new Set(["100"]), allowedThreadIds: new Set(["300"]) }));
  assert.equal(allowed.ok, true);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "disallowed_thread");
});

test("security guard applies the same checks to callback queries", () => {
  const result = authorizeTelegramUpdate({
    from: { id: 42 },
    callbackQuery: {
      message: {
        chat: { id: 100 },
        message_thread_id: 300
      }
    }
  }, config({ allowedChatIds: new Set(["100"]), allowedThreadIds: new Set(["300"]) }));
  assert.equal(result.ok, true);
});
