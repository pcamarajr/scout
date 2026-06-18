import type { AiProvider } from "../../credentials.js";
import { AiSdkEngine } from "./ai-sdk.js";
import { ClaudeAgentSdkEngine } from "./claude-agent-sdk.js";
import type { AgentEngine } from "./types.js";

/** The two engines Scout can run an AI verification through. */
export type EngineKind = "agent-sdk" | "ai-sdk";

/**
 * Resolves which engine to use. Explicit preference (SCOUT_ENGINE / config
 * `engine`) wins. Otherwise the default is forward-looking: the trusted Agent
 * SDK for Anthropic, the AI SDK for non-Anthropic providers (which is the only
 * engine that can reach them — still gated by credential detection until those
 * providers are wired up).
 */
export function resolveEngineKind(
  provider: AiProvider,
  enginePref: EngineKind | undefined
): EngineKind {
  if (enginePref) return enginePref;
  return provider === "anthropic" ? "agent-sdk" : "ai-sdk";
}

/** Instantiates the engine for a provider + explicit preference. */
export function selectEngine(
  provider: AiProvider,
  enginePref: EngineKind | undefined
): AgentEngine {
  return resolveEngineKind(provider, enginePref) === "ai-sdk"
    ? new AiSdkEngine()
    : new ClaudeAgentSdkEngine();
}

/** Parses a raw SCOUT_ENGINE / config value, ignoring unknown strings. */
export function parseEngineKind(value: string | undefined): EngineKind | undefined {
  if (value === "agent-sdk" || value === "ai-sdk") return value;
  return undefined;
}

export { AiSdkEngine, ClaudeAgentSdkEngine };
export type { AgentEngine };
