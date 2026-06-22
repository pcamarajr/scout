import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type { ScoutTool } from "../agent-tools.js";
import type {
  AgentEngine,
  EngineResumeResult,
  EngineRunSpec,
  EngineSession,
  QueryEndInfo,
} from "./types.js";

/**
 * The original, trusted engine: runs the verification through the
 * `@anthropic-ai/claude-agent-sdk` subprocess. Behavior here is intentionally
 * IDENTICAL to the pre-refactor ai-runner: bypassPermissions, empty
 * settingSources, allowedTools scoped to the in-process MCP browser server, the
 * query()+drain() loop, and an abort-in-finally so no subprocess outlives a run.
 */
export class ClaudeAgentSdkEngine implements AgentEngine {
  async run(spec: EngineRunSpec): Promise<EngineSession> {
    const browserServer = createSdkMcpServer({
      name: "browser",
      version: "1.0.0",
      tools: spec.tools.map(toAgentSdkTool),
    });

    const baseOptions = {
      model: spec.model,
      systemPrompt: spec.systemPrompt,
      mcpServers: { browser: browserServer },
      allowedTools: ["mcp__browser__*"],
      tools: [] as [],
      settingSources: [] as [],
      permissionMode: "bypassPermissions" as const,
    };

    const transcript: string[] = [];
    let sessionId: string | undefined;
    let endInfo: QueryEndInfo | undefined;

    // Drains a query, collecting transcript/session/end info. Always aborts at
    // the end so no claude-agent-sdk subprocess outlives the run.
    const drain = async (
      q: ReturnType<typeof query>,
      controller: AbortController
    ): Promise<void> => {
      try {
        for await (const message of q) {
          if ("session_id" in message && message.session_id) sessionId = message.session_id;
          if (message.type === "assistant") {
            for (const block of message.message.content) {
              if (block.type === "text" && block.text.trim()) transcript.push(block.text.trim());
            }
          }
          if (message.type === "result") {
            endInfo = {
              subtype: message.subtype,
              numTurns: message.num_turns,
              errors: "errors" in message ? message.errors : undefined,
            };
            break;
          }
        }
      } finally {
        controller.abort();
      }
    };

    const mainController = new AbortController();
    try {
      await drain(
        query({
          prompt: spec.userPrompt,
          options: { ...baseOptions, maxTurns: spec.maxTurns, abortController: mainController },
        }),
        mainController
      );
    } catch (error) {
      endInfo = {
        subtype: "sdk_error",
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }

    const resume = async (prompt: string, maxTurns: number): Promise<EngineResumeResult> => {
      const resumeTranscript: string[] = [];
      let resumeEnd: QueryEndInfo | undefined;
      if (!sessionId) {
        return { end: { subtype: "no_session" }, transcript: resumeTranscript };
      }
      const rescueController = new AbortController();
      // Reuse drain() so transcript/session/end semantics stay identical, then
      // split off only what the rescue produced for the resume result.
      const beforeLen = transcript.length;
      try {
        await drain(
          query({
            prompt,
            options: { ...baseOptions, maxTurns, resume: sessionId, abortController: rescueController },
          }),
          rescueController
        );
        resumeEnd = endInfo;
      } catch (error) {
        resumeEnd = {
          subtype: "sdk_error",
          errors: [error instanceof Error ? error.message : String(error)],
        };
      }
      resumeTranscript.push(...transcript.slice(beforeLen));
      return { end: resumeEnd ?? { subtype: "no_session" }, transcript: resumeTranscript };
    };

    return {
      get end() {
        return endInfo ?? { subtype: "sdk_error" };
      },
      transcript,
      resume,
    };
  }
}

/**
 * Adapts an engine-neutral ScoutTool into the Agent SDK `tool()` shape. The
 * Agent SDK's tool() wants a raw Zod shape, so we hand it `schema.shape`, and we
 * map our normalized {text, isError} result back into a CallToolResult.
 */
function toAgentSdkTool(scoutTool: ScoutTool) {
  return tool(
    scoutTool.name,
    scoutTool.description,
    scoutTool.schema.shape,
    async (args: unknown) => {
      const result = await scoutTool.handler(args);
      return {
        content: [{ type: "text" as const, text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      };
    }
  );
}
