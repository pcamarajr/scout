#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Command } from "commander";
import { chromium } from "playwright";
import { CONFIG_FILE, SCOUT_DIR, loadConfig } from "./config.js";
import { runScenario } from "./engine.js";
import { buildReport, renderSummary } from "./report.js";
import { Store } from "./store.js";

// Rejeições fora da cadeia de await (SDK/Playwright em subprocesso) não podem
// derrubar a suíte inteira — logar e deixar o cenário corrente falhar sozinho.
process.on("unhandledRejection", (reason) => {
  console.error(`\n⚠ unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

const program = new Command();
program
  .name("scout")
  .description("Self-healing browser QA — natural-language scenarios, deterministic replay in CI")
  .version("0.1.0");

program
  .command("init")
  .description("Creates scout.config.json and .scout/ in the current project")
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
              anon: { description: "Logged-out session" },
            },
          },
          null,
          2
        ) + "\n"
      );
      console.log(`✓ ${CONFIG_FILE} created — adjust baseUrl and profiles.`);
    }
    console.log(`✓ ${SCOUT_DIR}/ initialized.`);
  });

program
  .command("create <name>")
  .description("Creates a verification scenario")
  .requiredOption("-c, --scenario <text>", "Scenario in natural language: flow + expected behavior")
  .option("-p, --profile <profile>", "Auth profile (from scout.config.json)")
  .option("-n, --notes <notes>", "Extra notes for the agent")
  .action((name, opts) => {
    const store = new Store();
    if (!store.exists()) {
      console.error("Run `scout init` first.");
      process.exit(1);
    }
    const scenario = store.addScenario({
      name,
      scenario: opts.scenario,
      profile: opts.profile,
      notes: opts.notes,
    });
    console.log(`✓ Scenario #${scenario.id} created: ${scenario.slug}`);
  });

program
  .command("list")
  .description("Lists scenarios and status")
  .action(() => {
    const store = new Store();
    for (const s of store.listScenarios()) {
      const script = store.loadSteps(s.slug) ? "📜" : "  ";
      console.log(`#${s.id} ${script} [${s.status.padEnd(8)}] ${s.name} (${s.profile ?? "anonymous"})`);
    }
  });

program
  .command("go")
  .description("Runs scenarios: cached script replay; AI on first run or when the script breaks")
  .option("-s, --scenario <idOrSlug>", "Run a single scenario")
  .option("--ai", "Force AI-driven run (re-records the script)", false)
  .option("--no-heal", "Do not fall back to AI when replay fails (cheap CI)")
  .option("--headed", "Visible browser (local debug)", false)
  .action(async (opts) => {
    const store = new Store();
    const config = loadConfig();
    const all = store.listScenarios();
    const targets = opts.scenario
      ? all.filter((s) => s.id === Number(opts.scenario) || s.slug === opts.scenario)
      : all;
    if (!targets.length) {
      console.error(opts.scenario ? `Scenario "${opts.scenario}" not found.` : "No scenarios. Use `scout create`.");
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
        console.log(`💥 error: ${error instanceof Error ? error.message : error}`);
        failed++;
      }
    }
    process.exit(failed ? 1 : 0);
  });

program
  .command("report")
  .description("Prints the suite summary — markdown by default (embeddable in PR)")
  .option("--json", "Machine-readable output: scenarios + summary as JSON", false)
  .option("--check", "Exit 1 if any scenario is not verified (CI/PR gate)", false)
  .action((opts) => {
    const store = new Store();
    const scenarios = store.listScenarios();
    if (opts.json) {
      console.log(JSON.stringify(buildReport(scenarios), null, 2));
    } else {
      console.log(renderSummary(scenarios, store.latestRuns()));
    }
    if (opts.check) {
      process.exit(scenarios.every((s) => s.status === "verified") ? 0 : 1);
    }
  });

program
  .command("login <profile>")
  .description("Opens headed browser to capture a profile session (storageState)")
  .action(async (profileName) => {
    const config = loadConfig();
    if (!config.profiles[profileName]) {
      console.error(`Profile "${profileName}" does not exist in ${CONFIG_FILE}. Add it first.`);
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

    console.log(`\nLog in as "${profileName}" in the opened browser.`);
    await new Promise<void>((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question("Press Enter when done... ", () => {
        rl.close();
        resolve();
      });
    });

    await context.storageState({ path: statePath });
    await browser.close();
    console.log(`✓ Session saved to ${statePath} (gitignored).`);
  });

program
  .command("mcp")
  .description("Starts the MCP server (stdio) — for Claude Code and cloud coding sessions")
  .action(async () => {
    const { startMcpServer } = await import("./mcp/server.js");
    await startMcpServer();
  });

program.parseAsync();
