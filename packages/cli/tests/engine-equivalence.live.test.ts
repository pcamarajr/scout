import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { BrowserSession } from "../src/runner/browser.js";
import { runWithAgent } from "../src/runner/ai-runner.js";
import type { Scenario, Verdict } from "../src/types.js";

/**
 * Live cross-engine equivalence harness.
 *
 * This is the REAL apples-to-apples check between the trusted Agent SDK engine
 * and the new AI SDK engine: it runs the SAME tiny scenario through both, with
 * real Anthropic credentials, against a real public page, and asserts they reach
 * the same verdict. It is OPT-IN and auto-skips so CI stays green without creds:
 *
 *   SCOUT_LIVE_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... npm test
 *
 * Why this can't run as a pure-CI in-process mock: the Agent SDK runs a real
 * claude-agent-sdk subprocess. Mocking it in-process would mean no longer
 * testing the real engine — so genuine equivalence requires the network. The
 * deterministic adapter + orchestration proof lives in engine-ai-sdk.test.ts.
 */

const LIVE = process.env.SCOUT_LIVE_TESTS === "1" && Boolean(process.env.ANTHROPIC_API_KEY);
const SKIP_REASON = "set SCOUT_LIVE_TESTS=1 and ANTHROPIC_API_KEY to run the live cross-engine check";

const scenario: Scenario = {
  slug: "live/example-loads",
  name: "example.com loads",
  scenario:
    "Navigate to https://example.com and confirm that the title 'Example Domain' is visible. Then call scout_verdict.",
  feature: "live",
  file: "(live harness)",
};

async function runOnEngine(
  engine: "agent-sdk" | "ai-sdk",
  model?: string
): Promise<Verdict> {
  const config = {
    ...loadConfig(),
    engine,
    baseUrl: "https://example.com",
    maxTurns: 12,
    ...(model ? { model } : {}),
  };
  const session = await BrowserSession.launch({
    baseUrl: config.baseUrl,
    headless: true,
    locale: config.locale,
    runDir: process.cwd(),
  });
  try {
    const outcome = await runWithAgent(session, scenario, config);
    return outcome.verdict;
  } finally {
    await session.close().catch(() => {});
  }
}

test(
  "both engines reach the same verdict on a tiny live scenario",
  { skip: LIVE ? false : SKIP_REASON },
  async () => {
    const agentVerdict = await runOnEngine("agent-sdk");
    const aiSdkVerdict = await runOnEngine("ai-sdk");
    assert.equal(
      aiSdkVerdict,
      agentVerdict,
      `engines disagreed: agent-sdk=${agentVerdict} ai-sdk=${aiSdkVerdict}`
    );
    assert.equal(agentVerdict, "verified");
  }
);

/**
 * Optional live Gemini check on the AI SDK engine — the multi-provider proof on
 * a real model. Auto-skips unless explicitly opted in (so CI stays green):
 *
 *   SCOUT_LIVE_TESTS=1 GEMINI_API_KEY=... npm test
 */
const LIVE_GEMINI = process.env.SCOUT_LIVE_TESTS === "1" && Boolean(process.env.GEMINI_API_KEY);
const GEMINI_SKIP = "set SCOUT_LIVE_TESTS=1 and GEMINI_API_KEY to run the live Gemini check";

test(
  "ai-sdk engine verifies the tiny live scenario on Gemini",
  { skip: LIVE_GEMINI ? false : GEMINI_SKIP },
  async () => {
    const verdict = await runOnEngine("ai-sdk", "gemini-2.5-pro");
    assert.equal(verdict, "verified", `Gemini verdict was ${verdict}`);
  }
);
