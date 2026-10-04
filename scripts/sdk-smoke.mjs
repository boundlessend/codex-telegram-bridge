import assert from "node:assert/strict";
import { readConfig } from "../src/config.js";
import { createCodexThread } from "../src/codex/thread_factory.js";

const config = readConfig();
const thread = createCodexThread({
  config,
  effectiveOptions: {
    model: config.codexModel,
    workingDirectory: config.codexWorkdir,
    sandboxMode: "read-only",
    approvalPolicy: "on-request",
    skipGitRepoCheck: config.codexSkipGitRepoCheck,
    modelReasoningEffort: "low",
    webSearchMode: "disabled"
  }
});
const reply = await thread.run("Return exactly CODEX_TELEGRAM_READY. Do not use tools.");
assert.equal(reply.finalResponse.trim(), "CODEX_TELEGRAM_READY");
console.log("Codex SDK smoke passed");
