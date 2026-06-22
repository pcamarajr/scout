import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { resolveModel } from "../src/runner/engines/ai-sdk.js";

/**
 * Runs `fn` with the given env vars set, restoring the previous values after.
 * Used to drive resolveModel's Google sub-provider selection deterministically,
 * with no network — we only inspect the constructed LanguageModel's identity.
 */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** All google credential env vars, cleared — set the ones a test needs. */
const NO_GOOGLE = {
  GOOGLE_GENERATIVE_AI_API_KEY: undefined,
  GEMINI_API_KEY: undefined,
  GOOGLE_API_KEY: undefined,
  GOOGLE_APPLICATION_CREDENTIALS: undefined,
  GOOGLE_CLOUD_PROJECT: undefined,
} as const;

/** resolveModel returns string | LanguageModelV3; the provider paths return the object. */
function model(provider: Parameters<typeof resolveModel>[0], id: string): LanguageModelV3 {
  const m = resolveModel(provider, id);
  assert.notEqual(typeof m, "string", "expected a LanguageModel instance, not a string id");
  return m as LanguageModelV3;
}

test("resolveModel: anthropic → @ai-sdk/anthropic", () => {
  const m = model("anthropic", "claude-sonnet-4-6");
  assert.match(m.provider, /^anthropic/);
  assert.equal(m.modelId, "claude-sonnet-4-6");
});

test("resolveModel: openai → @ai-sdk/openai", () => {
  const m = model("openai", "gpt-4o");
  assert.match(m.provider, /^openai/);
  assert.equal(m.modelId, "gpt-4o");
});

test("resolveModel: google with a Gemini API key → @ai-sdk/google (Generative AI)", () => {
  withEnv({ ...NO_GOOGLE, GEMINI_API_KEY: "k" }, () => {
    const m = model("google", "gemini-2.5-pro");
    assert.match(m.provider, /google\.generative-ai/);
    assert.equal(m.modelId, "gemini-2.5-pro");
  });
});

test("resolveModel: google with no API key (ADC) → @ai-sdk/google-vertex (keyless)", () => {
  withEnv({ ...NO_GOOGLE, GOOGLE_CLOUD_PROJECT: "demo-project" }, () => {
    const m = model("google", "gemini-2.5-pro");
    assert.match(m.provider, /vertex/);
    assert.equal(m.modelId, "gemini-2.5-pro");
  });
});

test("resolveModel: google Vertex constructs with a default location (no GOOGLE_VERTEX_LOCATION)", () => {
  // The Vertex provider requires a location eagerly; resolveModel must default
  // it so the keyless path is zero-config. Constructing without throwing proves it.
  withEnv(
    { ...NO_GOOGLE, GOOGLE_CLOUD_PROJECT: "demo-project", GOOGLE_VERTEX_LOCATION: undefined },
    () => {
      assert.doesNotThrow(() => resolveModel("google", "gemini-2.5-pro"));
    }
  );
});
