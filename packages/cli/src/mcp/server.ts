import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { runScenario } from "../engine.js";
import { closeBrowsers } from "../runner/browser.js";
import { renderSummary, runStatus } from "../report.js";
import { addScenario } from "../specs.js";
import { Store } from "../store.js";
import { expandScenarios, resolveViewport, runnableViewports } from "../viewports.js";

/**
 * MCP interface so coding agents (Claude Code local or cloud sessions) can
 * create scenarios and run verifications as tool calls. Mirrors the CLI.
 *
 * Register in the target project's .mcp.json:
 *   { "mcpServers": { "scout": { "command": "npx", "args": ["scout", "mcp"] } } }
 */
export async function startMcpServer(): Promise<void> {
  const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  const server = new McpServer({ name: "scout", version: pkg.version });
  const store = new Store();

  server.registerTool(
    "scout_list_scenarios",
    {
      description: "Lists the project's QA scenarios with status and whether a cached script exists.",
      inputSchema: {},
    },
    async () => {
      const config = loadConfig();
      const latest = store.latestRuns();
      const units = expandScenarios(store.listScenarios(), config).map(({ scenario: s, viewport }) => ({
        slug: s.slug,
        name: s.name,
        feature: s.feature,
        profile: s.profile ?? null,
        viewport,
        status: runStatus(s.slug, viewport, latest),
        lastRun: latest.get(`${s.slug}@${viewport}`)?.startedAt ?? null,
        hasCachedScript: Boolean(store.loadSteps(s.slug, viewport)),
      }));
      return { content: [{ type: "text", text: JSON.stringify(units, null, 2) }] };
    }
  );

  server.registerTool(
    "scout_create_scenario",
    {
      description:
        "Creates a natural-language verification scenario in a feature file (.scout/specs/<feature>.scout.md). Describe the FLOW (user steps) and the EXPECTED BEHAVIOR (what should/shouldn't happen). Don't write selectors or code — the runner figures it out in the browser.",
      inputSchema: {
        feature: z.string().describe("Feature/component — the spec file the scenario goes into (groups related scenarios)"),
        name: z.string().describe("Short scenario name (becomes the heading)"),
        scenario: z.string().describe("Flow + expectations in natural language"),
        profile: z.string().optional().describe("Auth profile from scout.config.json (omit = anonymous)"),
        notes: z.string().optional().describe("Extra context for the runner"),
      },
    },
    async ({ feature, name, scenario, profile, notes }) => {
      const created = addScenario({ feature, name, scenario, profile, notes });
      return {
        content: [
          { type: "text", text: `Scenario ${created.slug} created in ${created.file}. Run it with scout_run.` },
        ],
      };
    }
  );

  server.registerTool(
    "scout_run",
    {
      description:
        "Runs the verification of one scenario (or all). Uses the cached deterministic script when it exists; falls back to the AI agent on the first run or when the script breaks (self-healing). Returns verdict + evidence.",
      inputSchema: {
        scenario: z.string().optional().describe("scenario slug (<feature>/<scenario>); omit = all"),
        forceAi: z.boolean().optional().describe("Ignore the cache and re-record the script via AI"),
        viewport: z
          .string()
          .optional()
          .describe("Force this viewport, ad-hoc (must exist in the registry; does not persist a script). Omit = runs the viewports declared by the scenario."),
        baseUrl: z
          .string()
          .optional()
          .describe("Override the target app for this run only (e.g. an ephemeral server from a worktree). Precedence: param > SCOUT_BASE_URL > scout.config.json"),
      },
    },
    async ({ scenario, forceAi, viewport, baseUrl }) => {
      const config = loadConfig(process.cwd(), { baseUrl });
      if (viewport) {
        try {
          resolveViewport(viewport, config);
        } catch (error) {
          return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
        }
      }
      const all = store.listScenarios();
      const targets = scenario
        ? all.filter((s) => s.slug === scenario || s.name === scenario)
        : all;
      if (!targets.length) {
        return { content: [{ type: "text", text: `No scenario found for "${scenario}".` }], isError: true };
      }
      const results = [];
      for (const s of targets) {
        for (const vp of runnableViewports(s, config, viewport)) {
          try {
            const r = await runScenario(store, s, config, { forceAi, viewport: vp, ephemeral: Boolean(viewport) });
            results.push({
              scenario: s.name,
              viewport: r.viewport,
              verdict: r.verdict,
              mode: r.mode,
              healed: r.healed ?? false,
              reason: r.reason,
              runnerFailure: r.runnerFailure,
              runDir: r.runDir,
              screenshots: r.screenshots,
              trace: r.trace,
            });
          } catch (error) {
            results.push({
              scenario: s.name,
              viewport: vp,
              verdict: "blocked",
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.registerTool(
    "scout_report",
    {
      description: "Markdown summary of the suite (embeddable in a PR body) — status per scenario + failures.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: renderSummary(store.listScenarios(), store.latestRuns(), loadConfig()) }],
    })
  );

  server.registerTool(
    "scout_get_run_report",
    {
      description: "Reads the report.md of a specific run (pass the runDir returned by scout_run).",
      inputSchema: { runDir: z.string() },
    },
    async ({ runDir }) => {
      const file = path.join(runDir, "report.md");
      if (!fs.existsSync(file)) {
        return { content: [{ type: "text", text: `No report in ${runDir}` }], isError: true };
      }
      return { content: [{ type: "text", text: fs.readFileSync(file, "utf8") }] };
    }
  );

  const transport = new StdioServerTransport();
  // The warm pooled browser is kept alive BETWEEN tool calls (that reuse is the
  // point of a long-lived server). Release it when the stdio connection drops —
  // the only shutdown signal a stdio MCP server gets — so a graceful disconnect
  // doesn't leak the Chromium process before the runtime tears the child down.
  transport.onclose = () => {
    void closeBrowsers();
  };
  await server.connect(transport);
}
