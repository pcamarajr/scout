import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { detectAiCredentials, inferProvider } from "../src/credentials.js";

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

/** A throwaway HOME so the ~/.claude probe never sees the real machine's creds. */
function tmpHome(withCredsFile: boolean): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scout-home-"));
  if (withCredsFile) {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), "{}");
  }
  return home;
}

// --- inferProvider: all branches + unknown/empty fallback ---

test("inferProvider maps claude* to anthropic", () => {
  assert.equal(inferProvider("claude-sonnet-4-6"), "anthropic");
  assert.equal(inferProvider("claude-opus-4-1"), "anthropic");
});

test("inferProvider maps gemini*/google* to google", () => {
  assert.equal(inferProvider("gemini-2.5-pro"), "google");
  assert.equal(inferProvider("google/gemini-flash"), "google");
});

test("inferProvider maps gpt*/o1/o3/o4* to openai", () => {
  assert.equal(inferProvider("gpt-4o"), "openai");
  assert.equal(inferProvider("o1"), "openai");
  assert.equal(inferProvider("o3"), "openai");
  assert.equal(inferProvider("o4-mini"), "openai");
});

test("inferProvider is case-insensitive", () => {
  assert.equal(inferProvider("CLAUDE-SONNET"), "anthropic");
  assert.equal(inferProvider("GPT-4O"), "openai");
  assert.equal(inferProvider("Gemini-Pro"), "google");
});

test("inferProvider falls back to anthropic for unknown/empty ids", () => {
  assert.equal(inferProvider("mistral-large"), "anthropic");
  assert.equal(inferProvider(""), "anthropic");
  assert.equal(inferProvider("   "), "anthropic");
});

// --- detectAiCredentials (anthropic ladder) ---

test("anthropic: ANTHROPIC_API_KEY wins the ladder", () => {
  withEnv(
    { ANTHROPIC_API_KEY: "sk-ant-test", CLAUDE_CODE_OAUTH_TOKEN: "tok", HOME: tmpHome(true) },
    () => {
      const status = detectAiCredentials("anthropic");
      assert.equal(status.ok, true);
      assert.equal(status.source, "ANTHROPIC_API_KEY");
      assert.equal(status.remediation, undefined);
    }
  );
});

test("anthropic: empty ANTHROPIC_API_KEY falls through to the OAuth token", () => {
  withEnv({ ANTHROPIC_API_KEY: "  ", CLAUDE_CODE_OAUTH_TOKEN: "tok", HOME: tmpHome(false) }, () => {
    const status = detectAiCredentials("anthropic");
    assert.equal(status.ok, true);
    assert.equal(status.source, "CLAUDE_CODE_OAUTH_TOKEN");
  });
});

test("anthropic: falls through to ~/.claude/.credentials.json when no env vars", () => {
  const home = tmpHome(true);
  withEnv({ ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, HOME: home }, () => {
    const status = detectAiCredentials("anthropic");
    assert.equal(status.ok, true);
    assert.equal(status.source, path.join(home, ".claude", ".credentials.json"));
  });
});

test("anthropic: a bare ~/.claude directory (no credentials file) does NOT pass", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scout-home-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true }); // dir only, no .credentials.json
  withEnv({ ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, HOME: home }, () => {
    const status = detectAiCredentials("anthropic", { hasKeychainSession: () => false });
    assert.equal(status.ok, false);
    assert.match(status.remediation ?? "", /No usable AI credentials found for Anthropic/);
    assert.match(status.remediation ?? "", /ANTHROPIC_API_KEY/);
  });
});

test("anthropic: no env and no creds file → ok:false with copy-pasteable remediation", () => {
  withEnv(
    { ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, HOME: tmpHome(false) },
    () => {
      const status = detectAiCredentials("anthropic", { hasKeychainSession: () => false });
      assert.equal(status.ok, false);
      assert.equal(status.source, undefined);
      assert.match(status.remediation ?? "", /scout doctor/);
    }
  );
});

test("anthropic: a macOS keychain Claude Code session passes when no env/file", () => {
  withEnv(
    { ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, HOME: tmpHome(false) },
    () => {
      const status = detectAiCredentials("anthropic", { hasKeychainSession: () => true });
      assert.equal(status.ok, true);
      assert.match(status.source ?? "", /keychain/);
      assert.equal(status.remediation, undefined);
    }
  );
});

// --- detectAiCredentials (google ladder) ---

/** Clears every google credential env var so each rung is tested in isolation. */
const GOOGLE_ENV_KEYS = {
  GOOGLE_GENERATIVE_AI_API_KEY: undefined,
  GEMINI_API_KEY: undefined,
  GOOGLE_API_KEY: undefined,
  GOOGLE_APPLICATION_CREDENTIALS: undefined,
  GOOGLE_CLOUD_PROJECT: undefined,
} as const;

test("google: GOOGLE_GENERATIVE_AI_API_KEY wins the ladder", () => {
  withEnv(
    {
      ...GOOGLE_ENV_KEYS,
      GOOGLE_GENERATIVE_AI_API_KEY: "k1",
      GEMINI_API_KEY: "k2",
      GOOGLE_API_KEY: "k3",
    },
    () => {
      const status = detectAiCredentials("google", { hasAdcFile: () => false });
      assert.equal(status.ok, true);
      assert.equal(status.source, "GOOGLE_GENERATIVE_AI_API_KEY");
    }
  );
});

test("google: GEMINI_API_KEY is the second rung", () => {
  withEnv({ ...GOOGLE_ENV_KEYS, GEMINI_API_KEY: "k2", GOOGLE_API_KEY: "k3" }, () => {
    const status = detectAiCredentials("google", { hasAdcFile: () => false });
    assert.equal(status.ok, true);
    assert.equal(status.source, "GEMINI_API_KEY");
  });
});

test("google: GOOGLE_API_KEY is the third rung", () => {
  withEnv({ ...GOOGLE_ENV_KEYS, GOOGLE_API_KEY: "k3" }, () => {
    const status = detectAiCredentials("google", { hasAdcFile: () => false });
    assert.equal(status.ok, true);
    assert.equal(status.source, "GOOGLE_API_KEY");
  });
});

test("google: GOOGLE_APPLICATION_CREDENTIALS passes only when the file exists", () => {
  const saFile = path.join(tmpHome(false), "sa.json");
  fs.writeFileSync(saFile, "{}");
  withEnv({ ...GOOGLE_ENV_KEYS, GOOGLE_APPLICATION_CREDENTIALS: saFile }, () => {
    const status = detectAiCredentials("google", { hasAdcFile: () => false });
    assert.equal(status.ok, true);
    assert.equal(status.source, "GOOGLE_APPLICATION_CREDENTIALS");
  });
});

test("google: GOOGLE_APPLICATION_CREDENTIALS pointing at a missing file does NOT pass", () => {
  withEnv({ ...GOOGLE_ENV_KEYS, GOOGLE_APPLICATION_CREDENTIALS: "/no/such/sa.json" }, () => {
    const status = detectAiCredentials("google", { hasAdcFile: () => false });
    assert.equal(status.ok, false);
  });
});

test("google: the gcloud ADC file is the last (keyless Vertex) rung", () => {
  withEnv({ ...GOOGLE_ENV_KEYS }, () => {
    const status = detectAiCredentials("google", { hasAdcFile: () => true });
    assert.equal(status.ok, true);
    assert.match(status.source ?? "", /ADC/);
  });
});

test("google: no key, no SA file, no ADC → ok:false with both remediation paths", () => {
  withEnv({ ...GOOGLE_ENV_KEYS }, () => {
    const status = detectAiCredentials("google", { hasAdcFile: () => false });
    assert.equal(status.ok, false);
    assert.equal(status.provider, "google");
    assert.match(status.remediation ?? "", /GEMINI_API_KEY/);
    assert.match(status.remediation ?? "", /gcloud auth application-default login/);
    assert.match(status.remediation ?? "", /GOOGLE_CLOUD_PROJECT/);
  });
});

// --- detectAiCredentials (openai ladder) ---

test("openai: OPENAI_API_KEY passes", () => {
  withEnv({ OPENAI_API_KEY: "sk-test" }, () => {
    const status = detectAiCredentials("openai");
    assert.equal(status.ok, true);
    assert.equal(status.source, "OPENAI_API_KEY");
  });
});

test("openai: empty OPENAI_API_KEY does NOT pass", () => {
  withEnv({ OPENAI_API_KEY: "   " }, () => {
    const status = detectAiCredentials("openai");
    assert.equal(status.ok, false);
  });
});

test("openai: no key → ok:false with copy-pasteable remediation", () => {
  withEnv({ OPENAI_API_KEY: undefined }, () => {
    const status = detectAiCredentials("openai");
    assert.equal(status.ok, false);
    assert.equal(status.provider, "openai");
    assert.match(status.remediation ?? "", /OPENAI_API_KEY/);
    assert.match(status.remediation ?? "", /platform\.openai\.com/);
  });
});
