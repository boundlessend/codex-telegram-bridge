import "dotenv/config";

import process from "node:process";
import { readConfig } from "./config.js";
import { createWorkerServer } from "./worker/server.js";

const config = readConfig();
const worker = createWorkerServer({ config, logger: console });

await worker.listen();
console.log(`codex-telegram-worker started: ${config.codexWorkerSocket}`);

const stop = async (signal) => {
  console.log(`codex-telegram-worker stopping: ${signal}`);
  await worker.close().catch((error) => {
    console.warn("worker close failed:", error instanceof Error ? error.message : String(error));
  });
  process.exit(0);
};

process.once("SIGINT", () => { stop("SIGINT"); });
process.once("SIGTERM", () => { stop("SIGTERM"); });
