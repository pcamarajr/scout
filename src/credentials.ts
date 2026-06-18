import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * AI/model providers Scout can run against. Only `anthropic` is wired up today;
 * `google`/`openai` are part of the seam for the upcoming AI SDK engine
 * (`SCOUT_ENGINE=ai-sdk`) and intentionally fail closed for now.
 */
export type AiProvider = "anthropic" | "google" | "openai";

export interface CredentialStatus {
  /** Whether usable AI credentials were found for the provider. */
  ok: boolean;
  provider: AiProvider;
  /** Which signal matched (env var name or credential path). Only set when ok. */
  source?: string;
  /** Copy-pasteable, English remediation. Only set when !ok. */
  remediation?: string;
}

export interface DetectOptions {
  /**
   * Test seam: override the macOS keychain probe. Production code leaves this
   * unset and the real `security` probe runs; tests inject a stub so results
   * are deterministic regardless of the host machine's Claude Code session.
   */
  hasKeychainSession?: () => boolean;
  /**
   * Which engine the run will use. The AI SDK engine authenticates with a real
   * ANTHROPIC_API_KEY only — it cannot reuse the Claude Code keychain/OAuth
   * session the way the default Agent SDK engine does. When set to `ai-sdk`,
   * detection that would otherwise pass on a keychain-only session fails closed
   * with engine-specific remediation. Unset/`agent-sdk` keeps PR1 behavior.
   */
  engine?: "agent-sdk" | "ai-sdk";
}

/**
 * Infers the AI provider from a model id. Case-insensitive.
 * Unknown/empty ids fall back to `anthropic` to preserve the historical
 * default (Scout shipped Anthropic-only).
 */
export function inferProvider(model: string): AiProvider {
  const id = (model ?? "").trim().toLowerCase();
  if (!id) return "anthropic";
  if (id.startsWith("claude")) return "anthropic";
  if (id.startsWith("gemini") || id.startsWith("google")) return "google";
  if (id.startsWith("gpt") || id === "o1" || id === "o3" || id.startsWith("o4")) {
    return "openai";
  }
  return "anthropic";
}

const ANTHROPIC_REMEDIATION = [
  "No usable AI credentials found for Anthropic. Do one of:",
  "  • Install Claude Code (https://claude.com/claude-code) and run `claude` to sign in — Scout reuses that session automatically.",
  "  • Or export an API key:  export ANTHROPIC_API_KEY=sk-ant-...",
  "Run `scout doctor` to re-check.",
].join("\n");

/**
 * The AI SDK engine cannot use the keychain/OAuth Claude Code session — it
 * needs a real ANTHROPIC_API_KEY. Emitted only when the AI SDK engine is
 * selected and the sole credential source is the macOS keychain.
 */
const AI_SDK_KEYCHAIN_ONLY_REMEDIATION = [
  "The AI SDK engine needs ANTHROPIC_API_KEY; the Claude Code keychain session only works with the default engine (unset SCOUT_ENGINE or set SCOUT_ENGINE=agent-sdk).",
  "  • Export an API key:  export ANTHROPIC_API_KEY=sk-ant-...",
  "  • Or switch back to the default engine:  unset SCOUT_ENGINE  (or SCOUT_ENGINE=agent-sdk)",
  "Run `scout doctor` to re-check.",
].join("\n");

function notYetSupportedRemediation(provider: AiProvider): string {
  const name = provider === "google" ? "Google" : "OpenAI";
  return [
    `${name} models are not wired up yet. Support is coming via the AI SDK engine (set SCOUT_ENGINE=ai-sdk in a later release).`,
    "For now, use an Anthropic model (e.g. SCOUT_MODEL=claude-sonnet-4-6) and provide Anthropic credentials.",
    "Run `scout doctor` to re-check.",
  ].join("\n");
}

/** Resolves the home directory the same way the legacy heuristic did, with an os fallback. */
function homeDir(): string {
  return process.env.HOME || os.homedir() || "";
}

/**
 * On Linux the Claude Code OAuth token lives in this file. On macOS the token
 * lives in the login keychain instead (see {@link hasMacKeychainSession}), so
 * this file is often absent even when you are signed in — the keychain probe
 * covers that case.
 */
export function claudeCredentialsPath(): string {
  return path.join(homeDir(), ".claude", ".credentials.json");
}

/** Keychain service name Claude Code uses for its OAuth token on macOS. */
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * Detects a Claude Code session stored in the macOS login keychain.
 *
 * We probe only for the *existence* of the entry (`security
 * find-generic-password -s ...` with NO `-w`), so it never reads the secret
 * and never triggers a keychain-unlock prompt. This is what lets a developer
 * who signed in via Claude Code — and therefore has no ANTHROPIC_API_KEY and
 * no ~/.claude/.credentials.json — still pass the preflight. Returns false on
 * non-macOS platforms and on any error (missing `security`, item not found).
 */
function hasMacKeychainSession(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("security", ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE], {
      stdio: "ignore",
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

function detectAnthropic(opts: DetectOptions = {}): CredentialStatus {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && apiKey.trim()) {
    return { ok: true, provider: "anthropic", source: "ANTHROPIC_API_KEY" };
  }
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauth && oauth.trim()) {
    return { ok: true, provider: "anthropic", source: "CLAUDE_CODE_OAUTH_TOKEN" };
  }
  const credsPath = claudeCredentialsPath();
  if (fs.existsSync(credsPath)) {
    return { ok: true, provider: "anthropic", source: credsPath };
  }
  const hasKeychain = opts.hasKeychainSession ?? hasMacKeychainSession;
  if (hasKeychain()) {
    // The keychain session works only for the default Agent SDK engine. The AI
    // SDK engine needs a real ANTHROPIC_API_KEY, so under it this source does
    // NOT count — fail closed with engine-specific remediation.
    if (opts.engine === "ai-sdk") {
      return { ok: false, provider: "anthropic", remediation: AI_SDK_KEYCHAIN_ONLY_REMEDIATION };
    }
    return { ok: true, provider: "anthropic", source: "macOS keychain (Claude Code session)" };
  }
  return { ok: false, provider: "anthropic", remediation: ANTHROPIC_REMEDIATION };
}

/**
 * Fast, network-free detection of usable AI credentials for a provider.
 *
 * anthropic ladder (first match wins): ANTHROPIC_API_KEY env →
 * CLAUDE_CODE_OAUTH_TOKEN env → a real Claude Code credential file at
 * ~/.claude/.credentials.json (NOT mere directory existence) → a Claude Code
 * session in the macOS login keychain. The keychain step is what keeps the
 * zero-config Claude Code happy path working on macOS, where the token is not
 * stored in a file.
 *
 * google/openai always return ok:false in this release (the seam for the
 * upcoming AI SDK engine).
 */
export function detectAiCredentials(
  provider: AiProvider,
  opts: DetectOptions = {}
): CredentialStatus {
  if (provider === "anthropic") return detectAnthropic(opts);
  return { ok: false, provider, remediation: notYetSupportedRemediation(provider) };
}
