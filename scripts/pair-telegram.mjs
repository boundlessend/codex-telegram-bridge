import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Telegraf } from "telegraf";
import { acquireInstanceLock, telegramInstanceLockPath } from "../src/fs/instance_lock.js";
import { ensurePrivateDirectory } from "../src/fs/private.js";
import { createTelegramApiAgent } from "../src/telegram/api.js";
import { pairTelegramOwner } from "../src/telegram/pairing.js";

let agent;
let release;
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
const lifetime = setTimeout(() => controller.abort(), 300_000);
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 4096) throw new Error("Pairing input is too large.");
  }
  const { token } = JSON.parse(input);
  if (typeof token !== "string" || !/^[0-9]+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("Invalid token format.");
  const lock = telegramInstanceLockPath(token, os.homedir(), process.platform);
  await ensurePrivateDirectory(path.dirname(lock));
  release = await acquireInstanceLock(lock);
  agent = createTelegramApiAgent();
  const telegram = new Telegraf(token, { telegram: { agent } }).telegram;
  const result = await pairTelegramOwner({
    api: (method, payload, signal) => telegram.callApi(method, payload, { signal: globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(30_000)]) }),
    nonce: `bridge_${randomBytes(24).toString("base64url")}`,
    lifetimeMs: 300_000, now: Date.now, signal: controller.signal,
    onLink: (url) => console.log(JSON.stringify({ event: "pair_link", url }))
  });
  console.log(JSON.stringify({ event: "paired", ...result }));
} catch (error) {
  let safe = "Pairing failed. Check the token and network connection, then rerun setup.";
  if (error?.code === "PAIR_WEBHOOK") safe = "This bot has a webhook. Use a dedicated bot or ask its administrator to remove the webhook.";
  else if (error?.code === "PAIR_EXPIRED" || controller.signal.aborted) safe = "Pairing cancelled or expired. Rerun setup to get a new link.";
  else if (error?.response?.error_code === 409 || error?.message?.startsWith("Another bridge instance")) safe = "Stop the other process polling this bot before pairing.";
  console.log(JSON.stringify({ event: "error", message: safe }));
  process.exitCode = 2;
} finally {
  clearTimeout(lifetime);
  agent?.destroy();
  if (release) {
    try { await release(); }
    catch {
      console.log(JSON.stringify({ event: "error", message: "Pairing lock could not be released. Inspect the local instance lock before restarting." }));
      process.exitCode = 2;
    }
  }
}
