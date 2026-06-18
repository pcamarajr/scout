import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModelV3Content, LanguageModelV3FinishReason } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { ScoutConfig } from "../src/config.js";
import { createScoutTools } from "../src/runner/agent-tools.js";
import { AiSdkEngine } from "../src/runner/engines/ai-sdk.js";
import type { BrowserSession } from "../src/runner/browser.js";
import type { Step, Target, Verdict } from "../src/types.js";

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

/** Builds one scripted model turn: optional assistant text + optional tool call. */
function turn(opts: {
  text?: string;
  toolName?: string;
  input?: unknown;
  finishReason?: LanguageModelV3FinishReason["unified"];
}) {
  const content: LanguageModelV3Content[] = [];
  if (opts.text) content.push({ type: "text", text: opts.text });
  if (opts.toolName) {
    content.push({
      type: "tool-call",
      toolCallId: `call-${Math.random().toString(36).slice(2)}`,
      toolName: opts.toolName,
      input: JSON.stringify(opts.input ?? {}),
    });
  }
  const unified = opts.finishReason ?? (opts.toolName ? "tool-calls" : "stop");
  return {
    content,
    finishReason: { unified, raw: unified },
    usage: ZERO_USAGE,
    warnings: [],
  };
}

/** A model that replays a fixed sequence of turns, one per generateText step. */
function scriptedModel(turns: ReturnType<typeof turn>[]): MockLanguageModelV3 {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const t = turns[Math.min(i, turns.length - 1)];
      i += 1;
      return t;
    },
  });
}

function fakeSession(): { session: BrowserSession; calls: string[] } {
  const calls: string[] = [];
  const target = (description: string): Target => ({ role: "button", name: description, description });
  const session = {
    snapshot: async () => ({ url: "http://localhost:3000/login", title: "Login", text: "form", elements: [] }),
    formatSnapshot: () => "URL: http://localhost:3000/login",
    navigate: async (url: string) => void calls.push(`navigate:${url}`),
    click: async (ref: number) => {
      calls.push(`click:${ref}`);
      return target("Entrar");
    },
    fill: async (ref: number, value: string) => {
      calls.push(`fill:${ref}:${value}`);
      return target("Email");
    },
    waitForText: async () => {},
    assertVisible: async (text: string) => void calls.push(`assertVisible:${text}`),
    screenshot: async (label: string) => `/runs/${label}.png`,
  } as unknown as BrowserSession;
  return { session, calls };
}

const config = { baseUrl: "http://localhost:3000", profiles: {}, maxTurns: 40 } as unknown as ScoutConfig;

function buildRun(turns: ReturnType<typeof turn>[], maxTurns = 40) {
  const steps: Step[] = [];
  let verdict: { verdict: Verdict; reason: string } | undefined;
  const { session, calls } = fakeSession();
  const tools = createScoutTools({
    session,
    config,
    record: (s) => steps.push(s),
    setVerdict: (v) => (verdict = v),
  });
  const engine = new AiSdkEngine({ model: scriptedModel(turns) });
  return {
    steps,
    calls,
    tools,
    getVerdict: () => verdict,
    run: () =>
      engine.run({
        model: "claude-sonnet-4-6",
        systemPrompt: "sys",
        userPrompt: "verify this",
        tools,
        maxTurns,
      }),
  };
}

// --- happy path: navigate → click → assert → scout_verdict ---

test("ai-sdk engine drives the full tool sequence and captures the verdict", async () => {
  const h = buildRun([
    turn({ text: "vou navegar", toolName: "browser_navigate", input: { url: "/login" } }),
    turn({ toolName: "browser_click", input: { ref: 1 } }),
    turn({ toolName: "browser_assert", input: { visibleText: "Bem-vindo" } }),
    turn({ text: "tudo certo", toolName: "scout_verdict", input: { verdict: "verified", reason: "ok" } }),
    turn({ text: "feito", finishReason: "stop" }),
  ]);

  const session = await h.run();

  // Steps recorded deterministically, in order, as side effects of the tools.
  assert.deepEqual(
    h.steps.map((s) => s.kind),
    ["navigate", "click", "assertVisible"]
  );
  assert.equal((h.steps[0] as { url: string }).url, "/login");
  // Verdict captured through the engine-neutral sink.
  assert.deepEqual(h.getVerdict(), { verdict: "verified", reason: "ok" });
  // Browser was actually driven.
  assert.deepEqual(h.calls, ["navigate:/login", "click:1", "assertVisible:Bem-vindo"]);
  // Assistant text collected into the transcript.
  assert.ok(session.transcript.includes("vou navegar"));
  assert.equal(session.end.subtype, "success");
});

// --- no-verdict rescue: the script omits scout_verdict the first pass ---

test("ai-sdk engine: resume() runs the forced-verdict rescue and lets a partial verdict be captured", async () => {
  // First pass keeps issuing tool calls and never calls scout_verdict; with a
  // budget of 2 steps the loop is cut off mid-flight (finishReason tool-calls →
  // error_max_turns). The rescue pass then calls scout_verdict(partial).
  const h = buildRun(
    [
      turn({ toolName: "browser_navigate", input: { url: "/login" } }),
      turn({ toolName: "browser_click", input: { ref: 1 } }),
      // Rescue turn (reached only via resume()):
      turn({ toolName: "scout_verdict", input: { verdict: "partial", reason: "ran out" } }),
      turn({ text: "done", finishReason: "stop" }),
    ],
    2 // tiny budget so the first pass dies without a verdict
  );

  const session = await h.run();
  assert.equal(h.getVerdict(), undefined, "no verdict on the first pass");

  // The orchestrator detects this via end.subtype and would call resume().
  assert.equal(session.end.subtype, "error_max_turns");

  const rescue = await session.resume("call scout_verdict now", 4);
  assert.deepEqual(h.getVerdict(), { verdict: "partial", reason: "ran out" });
  assert.equal(rescue.end.subtype, "success");
});

// --- finishReason mapping is observable end-to-end ---

test("ai-sdk engine maps a clean stop with no tool call to success", async () => {
  const h = buildRun([turn({ text: "nothing to do", finishReason: "stop" })]);
  const session = await h.run();
  assert.equal(session.end.subtype, "success");
  assert.equal(h.getVerdict(), undefined);
});

test("ai-sdk engine maps an error finishReason to error_during_execution", async () => {
  const h = buildRun([turn({ text: "boom", finishReason: "error" })]);
  const session = await h.run();
  assert.equal(session.end.subtype, "error_during_execution");
});
