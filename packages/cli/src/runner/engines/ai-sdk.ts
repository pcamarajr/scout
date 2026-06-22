import { anthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createVertex } from "@ai-sdk/google-vertex";
import { openai } from "@ai-sdk/openai";
import {
  generateText,
  stepCountIs,
  tool,
  type FinishReason,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import type { AiProvider } from "../../credentials.js";
import { detectAiCredentials } from "../../credentials.js";
import type { ScoutTool } from "../agent-tools.js";
import type {
  AgentEngine,
  EngineResumeResult,
  EngineRunSpec,
  EngineSession,
  QueryEndInfo,
} from "./types.js";

/**
 * Optional injection seam. Production leaves `model` unset and we resolve the
 * provider model from the spec's provider + model id; tests pass a
 * MockLanguageModelV3 so the tool-calling loop runs deterministically with no
 * network.
 */
export interface AiSdkEngineOptions {
  model?: LanguageModel;
}

/**
 * Maps a provider + model id onto the matching AI SDK `LanguageModel`.
 *
 *   anthropic → @ai-sdk/anthropic
 *   openai    → @ai-sdk/openai
 *   google    → @ai-sdk/google when a Gemini/Generative-AI API key is present;
 *               otherwise @ai-sdk/google-vertex (keyless, via Application Default
 *               Credentials). The split is driven by the same credential ladder
 *               `detectAiCredentials("google")` reports, so the engine and
 *               `scout doctor` agree on which sub-provider runs.
 *
 * For Vertex we pass `project` from GOOGLE_CLOUD_PROJECT when set (the provider
 * otherwise reads GOOGLE_VERTEX_PROJECT) and default `location` to
 * GOOGLE_VERTEX_LOCATION or "us-central1" — the Vertex provider requires a
 * location eagerly at model construction, so we supply a sensible default to
 * keep the keyless path zero-config. ADC itself comes from google-auth-library.
 */
export function resolveModel(provider: AiProvider, modelId: string): LanguageModel {
  switch (provider) {
    case "anthropic":
      return anthropic(modelId);
    case "openai":
      return openai(modelId);
    case "google": {
      const status = detectAiCredentials("google");
      const usesApiKey = status.ok && status.source !== undefined && /API_KEY$/.test(status.source);
      if (usesApiKey) return createGoogleGenerativeAI()(modelId);
      const project = process.env.GOOGLE_CLOUD_PROJECT?.trim();
      const location = process.env.GOOGLE_VERTEX_LOCATION?.trim() || "us-central1";
      return createVertex({ location, ...(project ? { project } : {}) })(modelId);
    }
  }
}

/**
 * Second engine, built on the Vercel AI SDK. It runs the SAME engine-neutral
 * ScoutTool set through `generateText`'s tool-calling loop, against Anthropic,
 * Google (Gemini API key or Vertex ADC) or OpenAI — selected per the spec's
 * provider via {@link resolveModel}. The shared orchestrator owns prompts,
 * verdict capture and the forced-verdict rescue — this class only drives the SDK
 * loop and maps the SDK's `finishReason` into the QueryEndInfo vocabulary the
 * rescue understands.
 */
export class AiSdkEngine implements AgentEngine {
  constructor(private readonly opts: AiSdkEngineOptions = {}) {}

  async run(spec: EngineRunSpec): Promise<EngineSession> {
    const model = this.opts.model ?? resolveModel(spec.provider, spec.model);
    const tools = buildAiSdkTools(spec.tools);

    const transcript: string[] = [];
    // Running conversation so resume() can append the rescue prompt and
    // continue from where the agent left off.
    const messages: ModelMessage[] = [{ role: "user", content: spec.userPrompt }];
    const abortController = new AbortController();

    const step = async (maxTurns: number): Promise<QueryEndInfo> => {
      try {
        const result = await generateText({
          model,
          system: spec.systemPrompt,
          messages,
          tools,
          stopWhen: stepCountIs(maxTurns),
          abortSignal: abortController.signal,
        });
        // Collect assistant text across every step in order.
        for (const s of result.steps) {
          if (s.text && s.text.trim()) transcript.push(s.text.trim());
        }
        // Persist the full assistant/tool exchange so the next step continues it.
        messages.push(...result.response.messages);
        return toEndInfo(result.finishReason, result.steps.length);
      } catch (error) {
        return {
          subtype: "error_during_execution",
          errors: [error instanceof Error ? error.message : String(error)],
        };
      }
    };

    const end = await step(spec.maxTurns);

    const resume = async (prompt: string, maxTurns: number): Promise<EngineResumeResult> => {
      const before = transcript.length;
      messages.push({ role: "user", content: prompt });
      const resumeEnd = await step(maxTurns);
      return { end: resumeEnd, transcript: transcript.slice(before) };
    };

    return { end, transcript, resume };
  }
}

/**
 * Maps the AI SDK `finishReason` onto the QueryEndInfo.subtype vocabulary that
 * {@link describeNoVerdict} and the forced-verdict rescue already speak.
 *
 *   tool-calls / length  → "error_max_turns"        (hit the step budget mid-flight)
 *   stop                 → "success"                 (model ended its turn cleanly)
 *   error / content-filter / other → "error_during_execution"
 *
 * Rationale: when the loop stops on `tool-calls` it means `stopWhen` cut it off
 * with a tool call still pending — i.e. it would have kept going, the budget ran
 * out (exactly the Agent SDK's `error_max_turns`). `length` is the token-budget
 * analog. Only a clean `stop` means the model chose to end its turn.
 */
export function toEndInfo(finishReason: FinishReason, numTurns: number): QueryEndInfo {
  switch (finishReason) {
    case "tool-calls":
    case "length":
      return { subtype: "error_max_turns", numTurns };
    case "stop":
      return { subtype: "success", numTurns };
    default:
      return { subtype: "error_during_execution", numTurns, errors: [`finishReason=${finishReason}`] };
  }
}

/**
 * Adapts the engine-neutral ScoutTool set into AI SDK tools. `execute` returns
 * the tool text; on a tool error we return the error string (prefixed "ERRO:",
 * same as the handler produces) rather than throwing. Returning a string keeps
 * the model in the loop with the failure visible — the same recovery affordance
 * the Agent SDK gives via an isError tool result — instead of aborting the run.
 */
function buildAiSdkTools(scoutTools: ScoutTool[]) {
  const entries = scoutTools.map((scoutTool) => [
    scoutTool.name,
    tool({
      description: scoutTool.description,
      inputSchema: scoutTool.schema,
      execute: async (args: unknown) => {
        const result = await scoutTool.handler(args);
        return result.text;
      },
    }),
  ]);
  return Object.fromEntries(entries);
}
