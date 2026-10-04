export async function handleDirectShutdownSignal({
  signal,
  activeTurns,
  recoveryEnabled,
  recoveryDir,
  createMarker,
  hasRecoverySnapshots = null,
  stopBot,
  exit,
  logger = console
}) {
  if (signal !== "SIGTERM" && signal !== "SIGINT") return false;
  const shouldCreateRecoveryMarker = signal === "SIGTERM"
    && recoveryEnabled
    && (activeTurns.size > 0 || await hasPersistedRecoverySnapshots(hasRecoverySnapshots, logger));
  if (shouldCreateRecoveryMarker) {
    await createMarker(recoveryDir, {
      mode: "sigterm",
      requestedBy: "signal",
      reason: "external_sigterm",
      exitCode: 0
    }).catch((error) => {
      logger.warn?.("SIGTERM recovery marker write failed:", error instanceof Error ? error.message : String(error));
    });
  }
  try {
    stopBot(signal);
  } catch (error) {
    logger.warn?.("Telegram bot stop failed:", error instanceof Error ? error.message : String(error));
  }
  exit(0);
  return true;
}

async function hasPersistedRecoverySnapshots(hasRecoverySnapshots, logger) {
  if (!hasRecoverySnapshots) return false;
  try {
    return await hasRecoverySnapshots();
  } catch (error) {
    logger.warn?.("SIGTERM recovery snapshot check failed:", error instanceof Error ? error.message : String(error));
    return false;
  }
}
