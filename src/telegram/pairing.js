import { timingSafeEqual } from "node:crypto";

export function pairingOwner(update, nonce, startedAt) {
  const message = update?.message;
  if (!message || message.chat?.type !== "private" || message.from?.is_bot !== false) return null;
  if (!Number.isSafeInteger(message.from.id) || message.from.id <= 0 || message.chat.id !== message.from.id) return null;
  if (message.forward_origin || message.forward_from || message.sender_chat || message.via_bot) return null;
  if (!Number.isFinite(message.date) || message.date < Math.floor(startedAt / 1000)) return null;
  const expected = Buffer.from(`/start ${nonce}`);
  const actual = Buffer.from(typeof message.text === "string" ? message.text : "");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return String(message.from.id);
}

export async function pairTelegramOwner({ api, nonce, lifetimeMs, now, signal, onLink }) {
  const limitedSignal = globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(lifetimeMs)]);
  const me = await api("getMe", {}, limitedSignal);
  if (me.is_bot !== true || !Number.isSafeInteger(me.id) || me.id <= 0 || !/^[A-Za-z0-9_]+$/.test(me.username || "")) {
    throw new Error("Telegram did not confirm a valid bot identity.");
  }
  const webhook = await api("getWebhookInfo", {}, limitedSignal);
  if (webhook.url) throw Object.assign(new Error("Pairing requires a bot without a webhook."), { code: "PAIR_WEBHOOK" });
  const startedAt = now();
  const deadline = startedAt + lifetimeMs;
  let offset = 0;
  try {
    onLink(`https://t.me/${me.username}?start=${nonce}`);
    while (now() < deadline) {
      if (limitedSignal.aborted) throw new Error("Telegram pairing was cancelled or expired.");
      const updates = await api("getUpdates", {
        offset, limit: 100, timeout: Math.max(1, Math.min(10, Math.ceil((deadline - now()) / 1000))),
        allowed_updates: ["message"]
      }, limitedSignal);
      if (now() >= deadline) throw Object.assign(new Error("Pairing expired."), { code: "PAIR_EXPIRED" });
      if (!Array.isArray(updates)) throw new Error("Telegram returned invalid pairing updates.");
      for (const update of updates) {
        if (!Number.isSafeInteger(update.update_id)) throw new Error("Telegram returned an invalid update ID.");
        offset = Math.max(offset, update.update_id + 1);
        const userId = pairingOwner(update, nonce, startedAt);
        if (userId) {
          await api("getUpdates", { offset, limit: 1, timeout: 0, allowed_updates: ["message"] }, limitedSignal);
          return { userId, botId: String(me.id) };
        }
      }
    }
    throw Object.assign(new Error("Pairing expired."), { code: "PAIR_EXPIRED" });
  } catch (error) {
    if (limitedSignal.aborted) throw Object.assign(new Error("Pairing cancelled or expired."), { code: "PAIR_EXPIRED" });
    throw error;
  }
}
