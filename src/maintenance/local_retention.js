import fs from "node:fs/promises";
import path from "node:path";
import { rotateRecoveryJournal } from "../recovery/journal.js";

export async function pruneLocalHistory(config, state, activeTurns, now) {
  const cutoff = now - (config.uploadRetentionDays ?? 30) * 86_400_000;
  const protectedFiles = new Set();
  const collect = (value) => {
    if (!value || typeof value !== "object") return;
    for (const file of value.imagePaths || []) protectedFiles.add(path.resolve(file));
    if (value.lastPdfUpload?.path && Date.parse(value.lastPdfUpload.uploadedAt) >= cutoff) {
      protectedFiles.add(path.resolve(value.lastPdfUpload.path));
    }
    for (const child of Object.values(value)) if (child && typeof child === "object") collect(child);
  };
  collect(state.queues);
  collect(state.chats);
  for (const active of activeTurns.values()) collect({ imagePaths: active.currentPreparedTurn?.imagePaths || [] });
  const jobsDir = path.join(config.codexWorkerStateDir, "jobs");
  let jobs;
  try { jobs = await fs.readdir(jobsDir); }
  catch (error) { if (error.code === "ENOENT") jobs = []; else throw error; }
  for (const name of jobs.filter((file) => file.endsWith(".json"))) {
    const job = JSON.parse(await fs.readFile(path.join(jobsDir, name), "utf8"));
    const delivery = Object.values(state.worker?.deliveries || {}).find((entry) => entry.jobId === job.id);
    if (!["completed", "failed", "cancelled"].includes(job.status) || (delivery && delivery.deliveryStatus !== "delivery_sent")) collect(job);
  }
  const uploadRoot = await fs.realpath(config.uploadDir);
  for (const entry of await fs.readdir(uploadRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(uploadRoot, entry.name);
    const stat = await fs.lstat(file);
    if (stat.mtimeMs >= cutoff || protectedFiles.has(file)) continue;
    if (await fs.realpath(file) !== file) throw new Error("Upload changed to a symlink; retention stopped.");
    await fs.unlink(file);
  }
  await rotateRecoveryJournal(config.botRecoveryDir, now - 30 * 86_400_000, 64 * 1024 * 1024);
}
