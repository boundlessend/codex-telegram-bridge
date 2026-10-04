import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { Telegraf } from "telegraf";
import { pairingOwner, pairTelegramOwner } from "../src/telegram/pairing.js";

const start = 1_700_000_000_000;
const nonce = "bridge_fixture";
const ownerMessage = {
  update_id: 5,
  message: { from: { id: 42, is_bot: false }, chat: { id: 42, type: "private" }, date: start / 1000, text: `/start ${nonce}` }
};

test("pairing accepts only the fresh private message carrying this one-time challenge", () => {
  assert.equal(pairingOwner(ownerMessage, nonce, start), "42");
  const rejected = [
    { ...ownerMessage, message: { ...ownerMessage.message, text: "/start wrong" } },
    { ...ownerMessage, message: { ...ownerMessage.message, chat: { id: 42, type: "group" } } },
    { ...ownerMessage, message: { ...ownerMessage.message, chat: { id: 43, type: "private" } } },
    { ...ownerMessage, message: { ...ownerMessage.message, from: { id: 42, is_bot: true } } },
    { ...ownerMessage, message: { ...ownerMessage.message, date: start / 1000 - 1 } },
    { ...ownerMessage, message: { ...ownerMessage.message, forward_origin: { type: "user" } } },
    { update_id: 5, edited_message: ownerMessage.message }
  ];
  for (const update of rejected) assert.equal(pairingOwner(update, nonce, start), null);
});

async function apiFixture(t, reply) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const method = request.url.split("/").at(-1);
    const payload = JSON.parse(body);
    requests.push({ method, payload });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, result: reply(method, payload) }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const telegram = new Telegraf("123:fixture", { telegram: { apiRoot: `http://127.0.0.1:${server.address().port}` } }).telegram;
  return { requests, api: (method, payload, signal) => telegram.callApi(method, payload, { signal }) };
}

test("pairing uses real API calls and acknowledges only the accepted challenge", async (t) => {
  const fixture = await apiFixture(t, (method, payload) => {
    if (method === "getMe") return { id: 123, is_bot: true, username: "fixture_bot" };
    if (method === "getWebhookInfo") return { url: "" };
    if (payload.timeout === 0) return [];
    return [{ update_id: 4, message: { ...ownerMessage.message, text: "unrelated" } }, ownerMessage];
  });
  const links = [];
  const result = await pairTelegramOwner({
    api: fixture.api, nonce, lifetimeMs: 1000, now: () => start,
    signal: new AbortController().signal, onLink: (link) => links.push(link)
  });
  assert.deepEqual(result, { userId: "42", botId: "123" });
  assert.deepEqual(links, [`https://t.me/fixture_bot?start=${nonce}`]);
  assert.deepEqual(fixture.requests.map((request) => request.method), ["getMe", "getWebhookInfo", "getUpdates", "getUpdates"]);
  assert.equal(fixture.requests.at(-1).payload.offset, 6);
  assert.equal(fixture.requests.some((request) => request.method === "sendMessage"), false);
});

test("an existing webhook prevents polling and never gets deleted", async (t) => {
  const fixture = await apiFixture(t, (method) => {
    if (method === "getMe") return { id: 123, is_bot: true, username: "fixture_bot" };
    return { url: "https://example.invalid/webhook" };
  });
  await assert.rejects(pairTelegramOwner({
    api: fixture.api, nonce, lifetimeMs: 1000, now: () => start,
    signal: new AbortController().signal, onLink: () => assert.fail("A webhook bot must not get a pairing link")
  }), { code: "PAIR_WEBHOOK" });
  assert.deepEqual(fixture.requests.map((request) => request.method), ["getMe", "getWebhookInfo"]);
});

test("a delayed response cannot bind an expired challenge", async (t) => {
  let time = start;
  const fixture = await apiFixture(t, (method) => {
    if (method === "getMe") return { id: 123, is_bot: true, username: "fixture_bot" };
    if (method === "getWebhookInfo") return { url: "" };
    time += 1001;
    return [ownerMessage];
  });
  await assert.rejects(pairTelegramOwner({
    api: fixture.api, nonce, lifetimeMs: 1000, now: () => time,
    signal: new AbortController().signal, onLink: () => {}
  }), { code: "PAIR_EXPIRED" });
});

test("cancellation aborts an outstanding API request", async () => {
  const controller = new AbortController();
  const pending = pairTelegramOwner({
    api: async (_method, _payload, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }), nonce, lifetimeMs: 1000, now: () => start,
    signal: controller.signal, onLink: () => {}
  });
  controller.abort();
  await assert.rejects(pending);
});
