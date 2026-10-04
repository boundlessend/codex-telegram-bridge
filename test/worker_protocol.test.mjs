import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createFrameReader, encodeFrame, errorResponse, okResponse } from "../src/worker/protocol.js";

test("worker protocol encodes one JSON frame per line", () => {
  assert.equal(encodeFrame({ id: "1", method: "ping" }), "{\"id\":\"1\",\"method\":\"ping\"}\n");
  assert.deepEqual(okResponse("1", { status: "ok" }), { id: "1", ok: true, result: { status: "ok" } });
  assert.deepEqual(errorResponse("1", new Error("bad")), { id: "1", ok: false, error: { message: "bad" } });
});

test("worker protocol reader parses complete and split frames", () => {
  const stream = new PassThrough();
  const frames = [];
  const errors = [];
  createFrameReader(stream, (frame) => frames.push(frame), { onError: (error) => errors.push(error) });
  stream.write("{\"id\":\"1\"");
  stream.write(",\"method\":\"a\"}\n");
  stream.write("not-json\n");
  stream.write("{\"id\":\"2\",\"method\":\"b\"}\n");
  assert.deepEqual(frames, [
    { id: "1", method: "a" },
    { id: "2", method: "b" }
  ]);
  assert.equal(errors.length, 1);
});
