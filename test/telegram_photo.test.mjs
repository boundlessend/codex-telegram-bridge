import test from "node:test";
import assert from "node:assert/strict";
import { replyTelegramPhotos } from "../src/telegram/photo.js";

function createCtx() {
  const calls = [];
  return {
    chat: { id: -100123 },
    msg: { message_id: 77, is_topic_message: true, message_thread_id: 456 },
    async replyWithPhoto(photo, extra) {
      calls.push({ photo, extra });
      return { message_id: 1001 };
    },
    calls
  };
}

test("replyTelegramPhotos sends photo to the current topic thread", async () => {
  const ctx = createCtx();
  const sent = await replyTelegramPhotos(ctx, [{ path: "/tmp/chart.png", caption: "SPCX 차트" }]);

  assert.deepEqual(sent, [{ message_id: 1001 }]);
  assert.deepEqual(ctx.calls, [{
    photo: { source: "/tmp/chart.png", filename: "chart.png" },
    extra: { caption: "SPCX 차트", message_thread_id: 456 }
  }]);
});

test("replyTelegramPhotos delegates upload failures to onError", async () => {
  const error = new Error("upload failed");
  const handled = [];
  const ctx = {
    msg: {},
    async replyWithPhoto() {
      throw error;
    }
  };

  const sent = await replyTelegramPhotos(ctx, [{ path: "/tmp/chart.png" }], {
    onError: async (photo, caught) => handled.push({ photo, caught })
  });

  assert.deepEqual(sent, []);
  assert.equal(handled.length, 1);
  assert.deepEqual(handled[0].photo, { path: "/tmp/chart.png" });
  assert.equal(handled[0].caught, error);
});
