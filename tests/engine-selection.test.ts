import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { detectAiCredentials } from "../src/credentials.js";
import { AiSdkEngine } from "../src/runner/engines/ai-sdk.js";
import { ClaudeAgentSdkEngine } from "../src/runner/engines/claude-agent-sdk.js";
import {
  parseEngineKind,
  resolveEngineKind,
  selectEngine,
} from "../src/runner/engines/index.js";

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

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scout-home-"));
}

// --- resolveEngineKind: the resolution table ---

test("explicit preference wins for every provider", () => {
  assert.equal(resolveEngineKind("anthropic", "ai-sdk"), "ai-sdk");
  assert.equal(resolveEngineKind("anthropic", "agent-sdk"), "agent-sdk");
  assert.equal(resolveEngineKind("google", "agent-sdk"), "agent-sdk");
  assert.equal(resolveEngineKind("openai", "ai-sdk"), "ai-sdk");
});

test("default is agent-sdk for anthropic, ai-sdk for other providers", () => {
  assert.equal(resolveEngineKind("anthropic", undefined), "agent-sdk");
  assert.equal(resolveEngineKind("google", undefined), "ai-sdk");
  assert.equal(resolveEngineKind("openai", undefined), "ai-sdk");
});

test("selectEngine instantiates the resolved engine class", () => {
  assert.ok(selectEngine("anthropic", undefined) instanceof ClaudeAgentSdkEngine);
  assert.ok(selectEngine("anthropic", "ai-sdk") instanceof AiSdkEngine);
  assert.ok(selectEngine("google", undefined) instanceof AiSdkEngine);
});

test("parseEngineKind accepts the two known values and ignores anything else", () => {
  assert.equal(parseEngineKind("agent-sdk"), "agent-sdk");
  assert.equal(parseEngineKind("ai-sdk"), "ai-sdk");
  assert.equal(parseEngineKind("bogus"), undefined);
  assert.equal(parseEngineKind(undefined), undefined);
});

// --- engine-aware credential nuance: keychain-only + ai-sdk fails closed ---

test("ai-sdk engine: a keychain-only Anthropic session does NOT pass, with engine-specific remediation", () => {
  withEnv(
    { ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, HOME: tmpHome() },
    () => {
      const status = detectAiCredentials("anthropic", {
        engine: "ai-sdk",
        hasKeychainSession: () => true,
      });
      assert.equal(status.ok, false);
      assert.match(status.remediation ?? "", /AI SDK engine needs ANTHROPIC_API_KEY/);
      assert.match(status.remediation ?? "", /SCOUT_ENGINE=agent-sdk/);
    }
  );
});

test("ai-sdk engine: a real ANTHROPIC_API_KEY still passes", () => {
  withEnv({ ANTHROPIC_API_KEY: "sk-ant-test", HOME: tmpHome() }, () => {
    const status = detectAiCredentials("anthropic", { engine: "ai-sdk" });
    assert.equal(status.ok, true);
    assert.equal(status.source, "ANTHROPIC_API_KEY");
  });
});

test("agent-sdk engine (default): keychain-only still passes — PR1 behavior unchanged", () => {
  withEnv(
    { ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, HOME: tmpHome() },
    () => {
      const asDefault = detectAiCredentials("anthropic", { hasKeychainSession: () => true });
      assert.equal(asDefault.ok, true);
      assert.match(asDefault.source ?? "", /keychain/);

      const asAgentSdk = detectAiCredentials("anthropic", {
        engine: "agent-sdk",
        hasKeychainSession: () => true,
      });
      assert.equal(asAgentSdk.ok, true);
      assert.match(asAgentSdk.source ?? "", /keychain/);
    }
  );
});
