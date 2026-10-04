import path from "node:path";
import os from "node:os";

export function serviceStatusCommand(service, platform, uid, unitName) {
  if (platform === "darwin") return { command: "launchctl", args: ["print", `gui/${uid}/local.codex.telegram.bridge.${service}`] };
  return { command: "systemctl", args: ["--user", "is-active", unitName] };
}

export function recoveryServiceChecks(serviceName, platform, uid) {
  if (platform === "darwin") {
    const role = serviceName.includes("worker") ? "worker" : "bot";
    const log = path.join(os.homedir(), "Library/Application Support/CodexTelegramBridge/logs", `local.codex.telegram.bridge.${role}.stderr.log`);
    return [`launchctl print gui/${uid}/local.codex.telegram.bridge.${role}`, `tail -n 100 '${log.replaceAll("'", "'\\''")}'`];
  }
  return [`systemctl --user is-active ${serviceName}`, `journalctl --user -u ${serviceName} -n 100 --no-pager`];
}
