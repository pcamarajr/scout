#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Command } from "commander";
import { chromium } from "playwright";
import { CONFIG_FILE, SCOUT_DIR, loadConfig } from "./config.js";
import { detectAiCredentials, inferProvider, type AiProvider } from "./credentials.js";
import { resolveEngineKind } from "./runner/engines/index.js";
import { runScenario } from "./engine.js";
import { runInit } from "./init.js";
import { buildReport, renderSummary, scenarioStatus } from "./report.js";
import { addScenario, selectScenarios, slugify } from "./specs.js";
import { Store } from "./store.js";

// Rejeições fora da cadeia de await (SDK/Playwright em subprocesso) não podem
// derrubar a suíte inteira — logar e deixar o cenário corrente falhar sozinho.
process.on("unhandledRejection", (reason) => {
  console.error(`\n⚠ unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const program = new Command();
program
  .name("scout")
  .description("Self-healing browser QA — natural-language scenarios, deterministic replay in CI")
  .version(pkg.version);

program
  .command("init")
  .description("Creates scout.config.json and .scout/ in the current project")
  .option("--base-url <url>", "Default target app URL (skips the prompt)")
  .option("-y, --yes", "Non-interactive: accept defaults, never prompt", false)
  .action(async (opts) => {
    await runInit({ baseUrl: opts.baseUrl, yes: opts.yes });
  });

program
  .command("create <name>")
  .description("Adds a scenario to a feature spec (.scout/specs/<feature>.scout.md)")
  .requiredOption("-f, --feature <feature>", "Feature/component — the spec file this scenario goes into")
  .requiredOption("-c, --scenario <text>", "Scenario in natural language: flow + expected behavior")
  .option("-p, --profile <profile>", "Auth profile (from scout.config.json)")
  .option("-n, --notes <notes>", "Extra notes for the agent")
  .action((name, opts) => {
    const scenario = addScenario({
      feature: opts.feature,
      name,
      scenario: opts.scenario,
      profile: opts.profile,
      notes: opts.notes,
    });
    console.log(`✓ Scenario created: ${scenario.slug} (${scenario.file})`);
  });

program
  .command("list")
  .description("Lists scenarios and status")
  .action(() => {
    const store = new Store();
    const latest = store.latestRuns();
    for (const s of store.listScenarios()) {
      const script = store.loadSteps(s.slug) ? "📜" : "  ";
      const status = scenarioStatus(s.slug, latest);
      console.log(`${script} [${status.padEnd(8)}] ${s.slug}  —  ${s.name} (${s.profile ?? "anonymous"})`);
    }
  });

program
  .command("go")
  .description("Runs scenarios: cached script replay; AI on first run or when the script breaks")
  .option("-s, --scenario <slugOrSpec>", "Run one scenario (full slug) or every scenario in a spec (file/dir slug)")
  .option("--ai", "Force AI-driven run (re-records the script)", false)
  .option("--no-heal", "Do not fall back to AI when replay fails (cheap CI)")
  .option("--headed", "Visible browser (local debug)", false)
  .option("--record-video", "Record a paced MP4 preview of each verified replay (needs ffmpeg)", false)
  .option("--base-url <url>", "Target app URL for this run (precedence: flag > SCOUT_BASE_URL > scout.config.json)")
  .action(async (opts) => {
    const store = new Store();
    const config = loadConfig(process.cwd(), { baseUrl: opts.baseUrl, recordVideo: opts.recordVideo });
    const all = store.listScenarios();
    const targets = opts.scenario ? selectScenarios(all, opts.scenario) : all;
    if (!targets.length) {
      console.error(opts.scenario ? `No scenario or spec matched "${opts.scenario}".` : "No scenarios. Use `scout create`.");
      process.exit(1);
    }

    let failed = 0;
    for (const scenario of targets) {
      process.stdout.write(`▶ ${scenario.slug} ... `);
      try {
        const result = await runScenario(store, scenario, config, {
          forceAi: opts.ai,
          heal: opts.heal,
          headed: opts.headed,
        });
        const icon = result.runnerFailure ? "💥" : result.verdict === "verified" ? "✅" : result.verdict === "partial" ? "⚠️" : "❌";
        const tag = result.runnerFailure ? " (runner failure — re-rode, não é veredito de UI)" : "";
        console.log(`${icon} ${result.verdict}${tag} [${result.mode}${result.healed ? "+heal" : ""}] ${(result.durationMs / 1000).toFixed(1)}s`);
        if (result.verdict !== "verified") {
          console.log(`   ↳ ${result.reason}`);
          failed++;
        }
        console.log(`   ↳ artifacts: ${path.relative(process.cwd(), result.runDir)}`);
        if (result.video) console.log(`   ↳ preview: ${path.relative(process.cwd(), result.video)}`);
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
    const latest = store.latestRuns();
    if (opts.json) {
      console.log(JSON.stringify(buildReport(scenarios, latest), null, 2));
    } else {
      console.log(renderSummary(scenarios, latest));
    }
    if (opts.check) {
      process.exit(scenarios.every((s) => scenarioStatus(s.slug, latest) === "verified") ? 0 : 1);
    }
  });

program
  .command("migrate")
  .description("Converts a legacy .scout/scenarios.json into .scout/specs/*.scout.md and relocates cached scripts")
  .action(() => {
    const store = new Store();
    const legacy = path.join(process.cwd(), SCOUT_DIR, "scenarios.json");
    if (!fs.existsSync(legacy)) {
      console.log("Nothing to migrate — no .scout/scenarios.json found.");
      return;
    }
    const old = JSON.parse(fs.readFileSync(legacy, "utf8")) as Array<{
      slug: string;
      name: string;
      scenario: string;
      profile?: string;
      notes?: string;
    }>;
    const existing = new Set(store.listScenarios().map((s) => s.slug));
    let created = 0;
    let scripts = 0;
    let skipped = 0;
    for (const s of old) {
      const slug = `${slugify(s.slug)}/${slugify(s.name)}`;
      if (existing.has(slug)) {
        skipped++;
        continue;
      }
      // feature = old slug keeps the spec filename == old slug, so the cached
      // script can be relocated deterministically under the new nested path.
      addScenario({ feature: s.slug, name: s.name, scenario: s.scenario, profile: s.profile, notes: s.notes });
      created++;
      const oldScript = path.join(process.cwd(), SCOUT_DIR, "scripts", `${s.slug}.json`);
      if (fs.existsSync(oldScript)) {
        const newScript = store.scriptPath(slug);
        fs.mkdirSync(path.dirname(newScript), { recursive: true });
        fs.renameSync(oldScript, newScript);
        scripts++;
      }
    }
    fs.renameSync(legacy, legacy + ".bak");
    console.log(
      `✓ Migrated ${created} scenario(s), relocated ${scripts} cached script(s)${skipped ? `, skipped ${skipped} already present` : ""}.`
    );
    console.log(
      "  Legacy file moved to .scout/scenarios.json.bak — review .scout/specs/ (and the `feature:` frontmatter) then delete the .bak."
    );
  });

program
  .command("login <profile>")
  .description(
    "Captures YOUR APP's logged-in session (storageState) via a headed browser. This is your application's auth, NOT AI credentials / model provider auth — for those, run `scout doctor`."
  )
  .option("--base-url <url>", "Target app URL (precedence: flag > SCOUT_BASE_URL > scout.config.json)")
  .action(async (profileName, opts) => {
    const config = loadConfig(process.cwd(), { baseUrl: opts.baseUrl });
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

/**
 * Cheapest correct proof that an Anthropic credential actually works: a 1-turn
 * agent query with a trivial prompt. It authenticates via the SAME path the
 * real run uses (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN / Claude Code
 * session — including the macOS keychain-backed session the file probe can't
 * see), so a green ping here means a real run will authenticate too.
 * Token cost: a one-word system prompt + a one-word reply (a handful of tokens).
 */
async function livePingAnthropic(model: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const controller = new AbortController();
    let ended: { subtype: string; errors?: string[] } | undefined;
    try {
      for await (const message of query({
        prompt: "Reply with the single word: ok",
        options: {
          model,
          systemPrompt: "You are a connectivity probe. Reply with exactly one word.",
          mcpServers: {},
          allowedTools: [] as [],
          tools: [] as [],
          settingSources: [] as [],
          permissionMode: "bypassPermissions" as const,
          maxTurns: 1,
          abortController: controller,
        },
      })) {
        if (message.type === "result") {
          ended = {
            subtype: message.subtype,
            errors: "errors" in message ? message.errors : undefined,
          };
          break;
        }
      }
    } finally {
      controller.abort();
    }
    if (ended && ended.subtype !== "success" && ended.errors?.length) {
      return { ok: false, error: ended.errors.join("; ") };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Provider-aware live ping for the AI SDK engine (google/openai). Resolves the
 * same provider model the engine would use and runs a 1-step `generateText`
 * asking for the single word "ok". Token cost: a one-word system prompt + a
 * one-word reply (a handful of tokens). Any thrown error (bad/absent key, wrong
 * project, network) is surfaced as the failure reason.
 */
async function livePingAiSdk(
  provider: AiProvider,
  model: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { generateText } = await import("ai");
    const { resolveModel } = await import("./runner/engines/ai-sdk.js");
    await generateText({
      model: resolveModel(provider, model),
      system: "You are a connectivity probe. Reply with exactly one word.",
      prompt: "Reply with the single word: ok",
      maxOutputTokens: 8,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

program
  .command("doctor")
  .description("Diagnoses AI credentials (model provider auth) for the configured model — CI-usable exit code")
  .action(async () => {
    const config = loadConfig();
    const provider = inferProvider(config.model);
    const engine = resolveEngineKind(provider, config.engine);
    const status = detectAiCredentials(provider, { engine });

    console.log(`Model:    ${config.model}`);
    console.log(`Provider: ${provider}`);
    console.log(`Engine:   ${engine}`);

    if (status.ok) {
      console.log(`Detection: ✓ matched ${status.source}`);
    } else if (provider === "anthropic") {
      // The file/env probe missed — but a macOS keychain-backed Claude Code
      // session is invisible to it, yet the SDK can still authenticate. Don't
      // give up here; let the live ping be the authority for Anthropic.
      console.log("Detection: ✗ no credential file or env var found (a macOS keychain session would not show here).");
    } else {
      // google/openai have no invisible-credential path: if detection failed,
      // there is nothing to ping. Report remediation and stop.
      console.log(`Detection: ✗ no usable ${provider} credentials found.`);
      console.log(`\n${status.remediation}`);
      process.exit(1);
    }

    process.stdout.write("Live check: pinging the model... ");
    const ping =
      provider === "anthropic"
        ? await livePingAnthropic(config.model)
        : await livePingAiSdk(provider, config.model);
    if (ping.ok) {
      console.log("✓ credentials valid");
      process.exit(0);
    }
    console.log("✗");
    console.log(`The live check failed: ${ping.error ?? "unknown error"}`);
    // When detection passed, the credentials are present but the live key was
    // rejected (invalid/expired key, wrong project, no quota) — the ping error
    // above is the actionable message. Only fall back to detection remediation
    // when detection itself had something to say.
    const remediation = status.remediation ?? detectAiCredentials(provider, { engine }).remediation;
    if (remediation) console.log(`\n${remediation}`);
    process.exit(1);
  });

program
  .command("mcp")
  .description("Starts the MCP server (stdio) — for Claude Code and cloud coding sessions")
  .action(async () => {
    const { startMcpServer } = await import("./mcp/server.js");
    await startMcpServer();
  });

program.parseAsync();
