import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export function telegramInstanceLockPath(token, home, platform) {
  const root = platform === "darwin"
    ? "Library/Application Support/CodexTelegram/locks"
    : ".local/state/codex-telegram/locks";
  const identity = createHash("sha256").update(token).digest("hex").slice(0, 24);
  return path.join(home, root, `${identity}.lock`);
}

async function bootIdentity() {
  if (process.platform === "darwin") {
    const { stdout } = await run("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { timeout: 3000 });
    return stdout.trim();
  }
  if (process.platform === "linux") return (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  throw new Error("Instance locking supports macOS and Linux; configure a native lock for this platform.");
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function owner(file) {
  const value = JSON.parse(await fs.readFile(file, "utf8"));
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.token !== "string") {
    throw new Error("Instance lock is invalid; inspect it before restarting.");
  }
  return value;
}

export async function acquireInstanceLock(file) {
  const token = randomUUID();
  const bootId = await bootIdentity();
  const claim = async () => {
    const handle = await fs.open(file, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, bootId })); await handle.sync(); }
    finally { await handle.close(); }
  };
  try { await claim(); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const previous = await owner(file);
    if ((!previous.bootId || previous.bootId === bootId) && processAlive(previous.pid)) throw new Error("Another bridge instance is running; stop it before starting a second one.");
    const recovery = await fs.open(`${file}.reclaim`, "wx", 0o600);
    try {
      const current = await owner(file);
      if (current.token !== previous.token || ((!current.bootId || current.bootId === bootId) && processAlive(current.pid))) {
        throw new Error("Another bridge instance acquired the lock; startup cancelled.");
      }
      await fs.unlink(file);
      await claim();
    } finally {
      await recovery.close();
      await fs.unlink(`${file}.reclaim`);
    }
  }
  return async () => {
    const current = await owner(file);
    if (current.token !== token) throw new Error("Instance lock ownership changed; refusing to remove it.");
    await fs.unlink(file);
  };
}

export async function removeStaleSocket(file) {
  const live = await new Promise((resolve, reject) => {
    const socket = net.createConnection(file);
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("Worker socket probe timed out; refusing to replace it.")); });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", (error) => {
      if (["ENOENT", "ECONNREFUSED"].includes(error.code)) resolve(false);
      else reject(error);
    });
  });
  if (live) throw new Error("A worker already owns this socket; startup cancelled.");
  await fs.rm(file, { force: true });
}
