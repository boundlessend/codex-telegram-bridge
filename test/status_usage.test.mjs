import test from "node:test";
import assert from "node:assert/strict";
import { formatCodexUsageSummary } from "../src/status_usage.js";

const tokenCount = {
  info: {
    total_token_usage: { total_tokens: 5000 },
    model_context_window: 10000
  },
  rate_limits: {
    primary: {
      used_percent: 25,
      resets_at: Date.parse("2026-06-11T06:00:00.000Z") / 1000
    },
    secondary: {
      used_percent: 50,
      resets_at: Date.parse("2026-06-18T00:00:00.000Z") / 1000
    }
  }
};

test("usage summary shows sample age and remaining limits before reset", () => {
  const summary = formatCodexUsageSummary({
    tokenCount,
    sampledAt: "2026-06-11T00:00:00.000Z",
    sourceLabel: "usage probe",
    now: new Date("2026-06-11T03:00:00.000Z"),
    locale: "en-US",
    timeZone: "UTC"
  });

  assert.match(summary, /Source: usage probe/);
  assert.match(summary, /Sample: .*3h 0m 0s ago/);
  assert.match(summary, /Context: 50% left \(5K used \/ 10K\)/);
  assert.match(summary, /5h limit: 75% left, resets/);
  assert.match(summary, /Weekly limit: 50% left, resets/);
});

test("usage summary marks limits stale after reset instead of showing old percent", () => {
  const summary = formatCodexUsageSummary({
    tokenCount,
    sampledAt: "2026-06-11T00:00:00.000Z",
    now: new Date("2026-06-19T00:00:00.000Z"),
    locale: "en-US",
    timeZone: "UTC"
  });

  assert.match(summary, /5h limit: reset passed at/);
  assert.match(summary, /Weekly limit: reset passed at/);
  assert.doesNotMatch(summary, /Weekly limit: 50% left/);
});

test("usage summary uses last input tokens for context instead of cumulative total", () => {
  const summary = formatCodexUsageSummary({
    tokenCount: {
      info: {
        total_token_usage: { input_tokens: 526782, total_tokens: 533606 },
        last_token_usage: { input_tokens: 59073, total_tokens: 59542 },
        model_context_window: 245480
      }
    },
    sampledAt: "2026-06-15T09:45:15.000Z",
    now: new Date("2026-06-15T09:45:17.000Z"),
    locale: "en-US",
    timeZone: "UTC"
  });

  assert.match(summary, /Context: 76% left \(59\.1K used \/ 245\.5K\)/);
  assert.match(summary, /Total usage: 533\.6K this thread/);
  assert.doesNotMatch(summary, /0% left/);
});
