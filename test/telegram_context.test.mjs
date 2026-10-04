import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTelegramId,
  telegramChatActionExtraFromMeta,
  telegramReplyExtraFromMeta,
  telegramSyntheticMessageFromMeta
} from "../src/telegram/context.js";
import { hydratePendingQueues } from "../src/queue.js";

test("Telegram topic metadata is preserved for synthetic replies and chat actions", () => {
  const meta = {
    messageThreadId: "300",
    replyToMessageId: 20,
    originMessageId: 10
  };
  assert.deepEqual(telegramReplyExtraFromMeta(meta), {
    message_thread_id: 300,
    reply_parameters: { message_id: 20 }
  });
  assert.deepEqual(telegramChatActionExtraFromMeta(meta), {
    message_thread_id: 300
  });
  assert.deepEqual(telegramSyntheticMessageFromMeta(meta), {
    message_thread_id: 300,
    is_topic_message: true
  });
});

test("persisted pending queue metadata restores topic reply routing after restart", () => {
  const hydrated = hydratePendingQueues({
    "chat-1": [{
      inputText: "continue",
      imagePaths: [],
      messageThreadId: "300",
      replyToMessageId: "20",
      originMessageId: "10",
      enqueuedAt: "2026-06-15T00:00:00.000Z",
      expiresAt: "2026-06-15T01:00:00.000Z"
    }]
  }, {
    now: new Date("2026-06-15T00:01:00.000Z"),
    maxAgeSeconds: 3600,
    createId: () => "queued"
  });
  const turn = hydrated.pending.get("chat-1")[0];
  assert.deepEqual(telegramSyntheticMessageFromMeta(turn), {
    message_thread_id: 300,
    is_topic_message: true
  });
  assert.deepEqual(telegramReplyExtraFromMeta(turn), {
    message_thread_id: 300,
    reply_parameters: { message_id: 20 }
  });
});

test("Telegram reply metadata keeps explicit caller options", () => {
  assert.deepEqual(
    telegramReplyExtraFromMeta(
      { messageThreadId: 300, replyToMessageId: 20 },
      { message_thread_id: 301, reply_parameters: { message_id: 21 } }
    ),
    { message_thread_id: 301, reply_parameters: { message_id: 21 } }
  );
});

test("Telegram id normalization rejects non-integers", () => {
  assert.equal(normalizeTelegramId("300"), 300);
  assert.equal(normalizeTelegramId("not-id"), undefined);
  assert.equal(normalizeTelegramId(1.2), undefined);
});
