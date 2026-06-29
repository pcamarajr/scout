import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { CONFIG_FILE, SCOUT_DIR } from "./config.js";
import { scaffoldAgentOnboarding } from "./scaffold.js";
import { Store } from "./store.js";

export const DEFAULT_BASE_URL = "http://localhost:3000";

export interface InitOptions {
  /** Base URL chosen on the command line (`--base-url`). Wins over any prompt. */
  baseUrl?: string;
  /** Non-interactive: never prompt, fall back to the default silently (`--yes`). */
  yes?: boolean;
}

export interface InitDeps {
  cwd?: string;
  /**
   * Resolves the default base URL when it was not passed on the CLI. Returns
   * the chosen URL (possibly the default). Injected in tests; in production it
   * prompts on a TTY or falls back to the default otherwise.
   */
  resolveBaseUrl?: (defaultUrl: string) => Promise<string>;
  /** Sink for user-facing messages (defaults to console.log). */
  log?: (message: string) => void;
}

/** Prompt for the base URL on an interactive TTY; otherwise use the default. */
async function promptBaseUrl(defaultUrl: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return defaultUrl;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`Default base URL (${defaultUrl}): `)).trim();
    return answer || defaultUrl;
  } finally {
    rl.close();
  }
}

/**
 * Bootstraps `.scout/` and `scout.config.json` in the target project.
 *
 * Base URL precedence: `--base-url` flag > interactive prompt (TTY, not `--yes`)
 * > the localhost default. An existing `scout.config.json` is never overwritten
 * (it may carry secrets), and the prompt is skipped entirely in that case.
 */
export async function runInit(opts: InitOptions = {}, deps: InitDeps = {}): Promise<void> {
  const cwd = deps.cwd ?? process.cwd();
  const log = deps.log ?? ((m: string) => console.log(m));
  const resolveBaseUrl = deps.resolveBaseUrl ?? promptBaseUrl;

  const store = new Store(cwd);
  store.init();

  const configPath = path.join(cwd, CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    let baseUrl = DEFAULT_BASE_URL;
    if (opts.baseUrl) {
      baseUrl = opts.baseUrl;
    } else if (!opts.yes) {
      baseUrl = await resolveBaseUrl(DEFAULT_BASE_URL);
    }
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          baseUrl,
          model: "claude-sonnet-4-6",
          headless: true,
          maxTurns: 40,
          locale: "pt-BR",
          // Viewports a scenario can run in. Built-ins (mobile/desktop/tablet)
          // work without listing them; add entries here to override or extend.
          defaultViewport: "mobile",
          profiles: {
            anon: { description: "Logged-out session" },
          },
        },
        null,
        2
      ) + "\n"
    );
    log(`✓ ${CONFIG_FILE} created (baseUrl: ${baseUrl}) — adjust baseUrl and profiles.`);
  }
  log(`✓ ${SCOUT_DIR}/ initialized.`);

  // Refresh agent-onboarding artifacts (AGENTS.md block, Claude skill, Cursor
  // rule). Idempotent — re-running init is the upgrade path for these files.
  scaffoldAgentOnboarding({ cwd, log });
}
