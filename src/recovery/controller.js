export function createRestartController({
  activeTurns,
  createMarker,
  appendEvent,
  exit,
  sleep,
  nowMs = () => Date.now(),
  exitCode = 75,
  drainTimeoutSeconds = 900,
  delaySeconds = 3,
  pollMs = 1000,
  logger = console
}) {
  let scheduled = false;
  let scheduledMarker = null;
  let exitPromise = null;

  async function requestRestart({ mode, requestedBy, reason, notify = null } = {}) {
    if (scheduled && scheduledMarker) return scheduledMarker;
    const marker = await createMarker({
      mode,
      requestedBy,
      reason,
      exitCode,
      notify
    });
    scheduled = true;
    scheduledMarker = marker;
    exitPromise = schedulePlannedExit(marker).catch((error) => {
      logger.error?.("planned restart failed:", error instanceof Error ? error.message : String(error));
      exit(exitCode);
    });
    return marker;
  }

  async function schedulePlannedExit(marker) {
    const delayMs = Math.max(0, delaySeconds) * 1000;
    const timeoutMs = Math.max(delayMs, drainTimeoutSeconds * 1000);
    const startedAt = nowMs();
    if (delayMs > 0) await sleep(delayMs);
    while (activeTurns.size > 0 && nowMs() - startedAt < timeoutMs) {
      await sleep(pollMs);
    }
    await appendEvent({
      type: "planned_restart_exit",
      restartId: marker.restartId,
      activeTurns: activeTurns.size,
      exitCode
    });
    exit(exitCode);
  }

  return {
    requestRestart,
    isScheduled: () => scheduled,
    scheduledMarker: () => scheduledMarker,
    exitPromise: () => exitPromise
  };
}
