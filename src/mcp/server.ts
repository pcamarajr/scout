import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { runScenario } from "../engine.js";
import { renderSummary } from "../report.js";
import { Store } from "../store.js";

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
      description: "Lista os cenários de QA do projeto com status e se há script cacheado.",
      inputSchema: {},
    },
    async () => {
      const scenarios = store.listScenarios().map((s) => ({
        ...s,
        hasCachedScript: Boolean(store.loadSteps(s.slug)),
      }));
      return { content: [{ type: "text", text: JSON.stringify(scenarios, null, 2) }] };
    }
  );

  server.registerTool(
    "scout_create_scenario",
    {
      description:
        "Cria um cenário de verificação em linguagem natural. Descreva o FLUXO (passos do usuário) e o COMPORTAMENTO ESPERADO (o que deve/não deve acontecer). Não escreva seletores nem código — o runner descobre sozinho no browser.",
      inputSchema: {
        name: z.string().describe("Nome curto do cenário"),
        scenario: z.string().describe("Fluxo + expectativas em linguagem natural"),
        profile: z.string().optional().describe("Profile de auth de scout.config.json (omitir = anônimo)"),
        notes: z.string().optional().describe("Contexto extra para o runner"),
      },
    },
    async ({ name, scenario, profile, notes }) => {
      store.init();
      const created = store.addScenario({ name, scenario, profile, notes });
      return {
        content: [
          { type: "text", text: `Cenário #${created.id} (${created.slug}) criado. Rode com scout_run.` },
        ],
      };
    }
  );

  server.registerTool(
    "scout_run",
    {
      description:
        "Roda a verificação de um cenário (ou todos). Usa o script determinístico cacheado quando existe; cai pro agente AI no primeiro run ou quando o script quebra (self-healing). Retorna veredito + evidências.",
      inputSchema: {
        scenario: z.string().optional().describe("id ou slug; omitir = todos"),
        forceAi: z.boolean().optional().describe("Ignora o cache e re-grava o script via AI"),
        baseUrl: z
          .string()
          .optional()
          .describe("Override do app alvo só para esta execução (ex: server efêmero de um worktree). Precedência: param > SCOUT_BASE_URL > scout.config.json"),
      },
    },
    async ({ scenario, forceAi, baseUrl }) => {
      const config = loadConfig(process.cwd(), { baseUrl });
      const all = store.listScenarios();
      const targets = scenario
        ? all.filter((s) => s.id === Number(scenario) || s.slug === scenario)
        : all;
      if (!targets.length) {
        return { content: [{ type: "text", text: `Nenhum cenário encontrado para "${scenario}".` }], isError: true };
      }
      const results = [];
      for (const s of targets) {
        try {
          const r = await runScenario(store, s, config, { forceAi });
          results.push({
            scenario: s.name,
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
            verdict: "blocked",
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.registerTool(
    "scout_report",
    {
      description: "Resumo markdown da suíte (embedável em corpo de PR) — status por cenário + falhas.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: renderSummary(store.listScenarios(), store.latestRuns()) }],
    })
  );

  server.registerTool(
    "scout_get_run_report",
    {
      description: "Lê o report.md de um run específico (passe o runDir retornado por scout_run).",
      inputSchema: { runDir: z.string() },
    },
    async ({ runDir }) => {
      const file = path.join(runDir, "report.md");
      if (!fs.existsSync(file)) {
        return { content: [{ type: "text", text: `Sem report em ${runDir}` }], isError: true };
      }
      return { content: [{ type: "text", text: fs.readFileSync(file, "utf8") }] };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
