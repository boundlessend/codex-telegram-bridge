export function parseCodexMaintenanceOutput(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Codex maintenance output must be JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
