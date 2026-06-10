#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Command } from "commander";
import { chromium } from "playwright";
import { CONFIG_FILE, SCOUT_DIR, loadConfig } from "./config.js";
import { runScenario } from "./engine.js";
import { renderSummary } from "./report.js";
import { Store } from "./store.js";

const program = new Command();
program
  .name("scout")
  .description("Self-healing browser QA — cenários em linguagem natural, replay determinístico em CI")
  .version("0.1.0");

program
  .command("init")
  .description("Cria scout.config.json e .scout/ no projeto atual")
  .action(() => {
    const store = new Store();
    store.init();
    const configPath = path.join(process.cwd(), CONFIG_FILE);
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(
        configPath,
        JSON.stringify(
          {
            baseUrl: "http://localhost:3000",
            model: "claude-sonnet-4-6",
            headless: true,
            maxTurns: 40,
            locale: "pt-BR",
            profiles: {
              anon: { description: "Sessão logged-out" },
            },
          },
          null,
          2
        ) + "\n"
      );
      console.log(`✓ ${CONFIG_FILE} criado — ajuste baseUrl e profiles.`);
    }
    console.log(`✓ ${SCOUT_DIR}/ inicializado.`);
  });

program
  .command("create <name>")
  .description("Cria um cenário de verificação")
  .requiredOption("-c, --scenario <text>", "Cenário em linguagem natural: fluxo + comportamento esperado")
  .option("-p, --profile <profile>", "Profile de auth (de scout.config.json)")
  .option("-n, --notes <notes>", "Notas extras para o agente")
  .action((name, opts) => {
    const store = new Store();
    if (!store.exists()) {
      console.error("Rode `scout init` primeiro.");
      process.exit(1);
    }
    const scenario = store.addScenario({
      name,
      scenario: opts.scenario,
      profile: opts.profile,
      notes: opts.notes,
    });
    console.log(`✓ Cenário #${scenario.id} criado: ${scenario.slug}`);
  });

program
  .command("list")
  .description("Lista cenários e status")
  .action(() => {
    const store = new Store();
    for (const s of store.listScenarios()) {
      const script = store.loadSteps(s.slug) ? "📜" : "  ";
      console.log(`#${s.id} ${script} [${s.status.padEnd(8)}] ${s.name} (${s.profile ?? "anônimo"})`);
    }
  });

program
  .command("go")
  .description("Roda cenários: replay do script cacheado; AI no primeiro run ou quando o script quebra")
  .option("-s, --scenario <idOrSlug>", "Rodar só um cenário")
  .option("--ai", "Forçar run AI-driven (re-grava o script)", false)
  .option("--no-heal", "Não cair pro AI quando o replay falhar (CI barato)")
  .option("--headed", "Browser visível (debug local)", false)
  .action(async (opts) => {
    const store = new Store();
    const config = loadConfig();
    const all = store.listScenarios();
    const targets = opts.scenario
      ? all.filter((s) => s.id === Number(opts.scenario) || s.slug === opts.scenario)
      : all;
    if (!targets.length) {
      console.error(opts.scenario ? `Cenário "${opts.scenario}" não encontrado.` : "Nenhum cenário. Use `scout create`.");
      process.exit(1);
    }

    let failed = 0;
    for (const scenario of targets) {
      process.stdout.write(`▶ #${scenario.id} ${scenario.name} ... `);
      try {
        const result = await runScenario(store, scenario, config, {
          forceAi: opts.ai,
          heal: opts.heal,
          headed: opts.headed,
        });
        const icon = result.verdict === "verified" ? "✅" : result.verdict === "partial" ? "⚠️" : "❌";
        console.log(`${icon} ${result.verdict} [${result.mode}${result.healed ? "+heal" : ""}] ${(result.durationMs / 1000).toFixed(1)}s`);
        if (result.verdict !== "verified") {
          console.log(`   ↳ ${result.reason}`);
          failed++;
        }
        console.log(`   ↳ artifacts: ${path.relative(process.cwd(), result.runDir)}`);
      } catch (error) {
        console.log(`💥 erro: ${error instanceof Error ? error.message : error}`);
        failed++;
      }
    }
    process.exit(failed ? 1 : 0);
  });

program
  .command("report")
  .description("Imprime o resumo da suíte em markdown (embedável em PR)")
  .action(() => {
    const store = new Store();
    console.log(renderSummary(store.listScenarios(), store.latestRuns()));
  });

program
  .command("login <profile>")
  .description("Abre browser headed para capturar a sessão de um profile (storageState)")
  .action(async (profileName) => {
    const config = loadConfig();
    if (!config.profiles[profileName]) {
      console.error(`Profile "${profileName}" não existe no ${CONFIG_FILE}. Adicione-o primeiro.`);
      process.exit(1);
    }
    const statePath = path.resolve(
      config.profiles[profileName].storageState ?? path.join(SCOUT_DIR, "state", `${profileName}.json`)
    );
    fs.mkdirSync(path.dirname(statePath), { recursive: true });

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ locale: config.locale ?? "pt-BR" });
    const page = await context.newPage();
    await page.goto(config.baseUrl);

    console.log(`\nFaça login como "${profileName}" no browser aberto.`);
    await new Promise<void>((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question("Pressione Enter quando terminar... ", () => {
        rl.close();
        resolve();
      });
    });

    await context.storageState({ path: statePath });
    await browser.close();
    console.log(`✓ Sessão salva em ${statePath} (gitignored).`);
  });

program
  .command("mcp")
  .description("Inicia o MCP server (stdio) — para Claude Code e cloud coding sessions")
  .action(async () => {
    const { startMcpServer } = await import("./mcp/server.js");
    await startMcpServer();
  });

program.parseAsync();
