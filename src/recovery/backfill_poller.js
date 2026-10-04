export function startRecoveryBackfillPoller({
  intervalMs = 30_000,
  check = async () => false,
  onRecovered = async () => {},
  onError = async () => {},
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
} = {}) {
  const interval = Number(intervalMs);
  if (!Number.isFinite(interval) || interval <= 0) {
    return noopPoller();
  }

  let stopped = false;
  let running = false;
  let timer = null;

  const stop = () => {
    stopped = true;
    if (timer) clearIntervalFn(timer);
    timer = null;
  };

  const runCheck = async (reason) => {
    if (stopped || running) return false;
    running = true;
    try {
      const recovered = await check({ reason });
      if (!recovered) return false;
      stop();
      await onRecovered({ reason });
      return true;
    } catch (error) {
      await onError(error, { reason });
      return false;
    } finally {
      running = false;
    }
  };

  timer = setIntervalFn(() => runCheck("interval").catch(() => {}), Math.max(100, interval));

  return {
    stop,
    checkNow: () => runCheck("manual")
  };
}

function noopPoller() {
  return {
    stop() {},
    async checkNow() {
      return false;
    }
  };
}
