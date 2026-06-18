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
 * Path Scout treats as the signal of a real Claude Code session credential.
 *
 * OS caveat: on macOS the Claude Code OAuth token is stored in the login
 * keychain (service "Claude Code-credentials"), NOT in a readable file, so
 * `~/.claude/.credentials.json` may be absent even when you are signed in.
 * We deliberately do NOT shell out to `security` here (slow, may prompt,
 * fragile); instead we treat a present `~/.claude/.credentials.json` as the
 * signal and otherwise fall through to env vars. A live `scout doctor` check
 * is the reliable way to confirm a keychain-backed OAuth session works.
 */
export function claudeCredentialsPath(): string {
  return path.join(homeDir(), ".claude", ".credentials.json");
}

function detectAnthropic(): CredentialStatus {
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
  return { ok: false, provider: "anthropic", remediation: ANTHROPIC_REMEDIATION };
}

/**
 * Fast, network-free detection of usable AI credentials for a provider.
 *
 * anthropic ladder (first match wins): ANTHROPIC_API_KEY env →
 * CLAUDE_CODE_OAUTH_TOKEN env → a real Claude Code credential file at
 * ~/.claude/.credentials.json (NOT mere directory existence). See
 * {@link claudeCredentialsPath} for the macOS keychain caveat.
 *
 * google/openai always return ok:false in this release (the seam for the
 * upcoming AI SDK engine).
 */
export function detectAiCredentials(provider: AiProvider): CredentialStatus {
  if (provider === "anthropic") return detectAnthropic();
  return { ok: false, provider, remediation: notYetSupportedRemediation(provider) };
}
