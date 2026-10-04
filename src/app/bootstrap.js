import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { acquireInstanceLock } from "../fs/instance_lock.js";
import { ensurePrivateDirectory } from "../fs/private.js";

export async function bootstrapBot({
  bot,
  config,
  ensureDirectory,
  registerTelegramCommands,
  startCleanupScheduler,
  startPersistedQueues,
  startStateSnapshotScheduler,
  startRecoveryScheduler = null,
  startWorkspaceServices = null,
  handleSignal = null,
  processRef = process,
  logger = console
}) {
  const lockRoot = path.join(os.homedir(), process.platform === "darwin" ? "Library/Application Support/CodexTelegram/locks" : ".local/state/codex-telegram/locks");
  await ensurePrivateDirectory(lockRoot);
  const identity = createHash("sha256").update(config.telegramBotToken).digest("hex").slice(0, 24);
  const releaseLock = await acquireInstanceLock(path.join(lockRoot, `${identity}.lock`));
  let stopping = false;
  let launched = false;
  let cancelQueueStartup = () => {};
  const stopForSignal = (signal) => {
    stopping = true;
    cancelQueueStartup();
    if (handleSignal) {
      Promise.resolve(handleSignal(signal)).catch((error) => {
        logger.warn("Signal handler failed:", error instanceof Error ? error.message : String(error));
        bot.stop(signal);
      });
      return;
    }
    bot.stop(signal);
  };
  processRef.once("SIGINT", () => stopForSignal("SIGINT"));
  processRef.once("SIGTERM", () => stopForSignal("SIGTERM"));
  processRef.once("SIGUSR2", () => stopForSignal("SIGUSR2"));

  try {
    await ensureDirectory(config.codexWorkdir, "CODEX_WORKDIR");
    await ensurePrivateDirectory(config.uploadDir);
    await ensurePrivateDirectory(config.cleanupQuarantineDir);
    await ensurePrivateDirectory(config.backupDir);
    if (config.botRecoveryDir) await ensurePrivateDirectory(config.botRecoveryDir);
    startCleanupScheduler();
    startStateSnapshotScheduler();
    registerTelegramCommands().catch((error) => {
      logger.warn("Telegram command menu registration failed:", error instanceof Error ? error.message : String(error));
    });
    if (startRecoveryScheduler) await startRecoveryScheduler();
    if (startWorkspaceServices) startWorkspaceServices();
    // Telegraf's launch promise lives for the whole polling loop. Its callback
    // runs after getMe, when the API identity is ready for queued work.
    await bot.launch(() => {
      if (stopping || launched) return;
      launched = true;
      logger.log("codex-telegram-bot started");
      const cancel = startPersistedQueues();
      if (typeof cancel === "function") cancelQueueStartup = cancel;
    });
  } finally {
    stopping = true;
    cancelQueueStartup();
    await releaseLock();
  }
}
