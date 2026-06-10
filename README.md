# 🔭 Scout

Self-healing browser QA. Scenarios written in **natural language**, verified by an **AI agent** in a real browser (Playwright), and recorded as a **deterministic script** that runs cheaply and quickly in CI — AI only kicks in when the script breaks.

> Status: functional POC.

## Why not just Playwright? Why not just AI?

| | Pure Playwright | Pure AI | Scout (hybrid) |
|---|---|---|---|
| Authoring | expensive (code + selectors) | cheap (1 sentence) | cheap (1 sentence) |
| Cost per CI run | ~zero | $$ + slow | ~zero (replay) |
| Resilience to UI changes | breaks | adapts | breaks → AI re-verifies and re-records |
| Judges behavior ("paywall MUST NOT appear") | only what was coded | yes | yes |

**Scenario lifecycle:**

```
scout create "Paywall free" -c "Open ep 3 of series X without login; paywall should appear with signup CTA"
        │
        ▼
scout go  ──── 1st run: AI agent runs in browser, judges (verified/failed/partial/blocked)
        │       and records .scout/scripts/paywall-free.json (deterministic steps + assertions)
        ▼
CI / subsequent runs: pure Playwright replay, no LLM, seconds per scenario
        │
        ▼
UI changed and replay broke? ── AI re-runs, re-judges, re-records the script (self-healing)
                                (`--no-heal` disables this, e.g. in CI without API key)
```

## Quickstart

```bash
npm install @pcamarajr/scout       # or npm link during POC
npx playwright install chromium    # browser engine

scout init                         # creates scout.config.json + .scout/
scout create "Login with Google" \
  -c "On logged-out home, click Sign In; login page should show Google and email/password options" \
  -p anon
scout go                           # 1st run = AI (requires Anthropic credentials)
scout go                           # subsequent runs = deterministic replay
scout report                       # markdown ready to embed in PR body
```

### AI runner credentials

- **Local:** if you use Claude Code, the Agent SDK reuses your machine credentials — zero config.
- **CI/headless:** export `ANTHROPIC_API_KEY`. The SDK is self-contained (Claude Code CLI not required).
- Deterministic replay **does not use LLM** — in CI without a key, use `scout go --no-heal` (failure becomes ❌ in the report instead of healing).

## Auth profiles (storageState)

Authenticated flows use sessions captured once per environment:

```jsonc
// scout.config.json
{
  "baseUrl": "http://localhost:3000",
  "model": "claude-sonnet-4-6",
  "profiles": {
    "anon": { "description": "Logged-out session" },
    "subscriber": { "description": "User with active subscription", "env": ["QA_SUB_EMAIL", "QA_SUB_PASSWORD"] },
    "free-no-coins": { "description": "Free user with no coin balance" }
  }
}
```

```bash
scout login subscriber   # opens headed browser, log in, press Enter → saves .scout/state/subscriber.json (gitignored)
```

In CI, generate the storageState in a setup step (login via script) or let the agent log in using `$ENV:QA_SUB_EMAIL` / `$ENV:QA_SUB_PASSWORD` — placeholders are resolved from the environment at runtime; **secrets never enter the committed script or pass through the LLM**.

## Worktrees and environments

Everything is relative to the project directory and the target comes from env — two worktrees run in parallel without colliding:

```bash
SCOUT_BASE_URL=http://localhost:3001 scout go     # worktree B pointing to a different port
SCOUT_BASE_URL=https://staging.myapp.com scout go --no-heal   # against staging
```

- `.scout/scenarios.json` and `.scout/scripts/` are **committed** — the suite travels with the branch.
- `.scout/runs/` and `.scout/state/` are **gitignored** — artifacts and sessions are per-machine.

## Per-run artifacts

Each run records in `.scout/runs/<timestamp>-<slug>/`:

| File | What |
|---|---|
| `trace.zip` | Playwright trace — screenshots, DOM snapshots, network, console (`npx playwright show-trace trace.zip`) |
| `*.png` | Evidence screenshots (captured by the agent or at the end of replay/failure) |
| `report.md` | Verdict + reason + recorded script + evidence |
| `result.json` | Structured result (consumable by automation) |
| `transcript.md` | Agent reasoning (AI runs only) |

## MCP — usage by coding agents (Claude Code, cloud sessions)

Scout's main flow is to be called **by the agent that developed the feature**: the agent writes the scenario (in NL — never the script; the script is born from the verified execution) and triggers the verification.

```jsonc
// .mcp.json of the target project
{
  "mcpServers": {
    "scout": { "command": "npx", "args": ["scout", "mcp"] }
  }
}
```

Exposed tools: `scout_list_scenarios`, `scout_create_scenario`, `scout_run`, `scout_report`, `scout_get_run_report`.

## CI (GitHub Actions)

```yaml
qa-browser:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: 24 }
    - run: npm ci && npx playwright install --with-deps chromium
    - run: npm run start:test-server &        # app running
    - run: npx scout go --no-heal             # pure replay, no LLM, exit 1 on failure
      env: { SCOUT_BASE_URL: "http://localhost:3000" }
    - run: npx scout report >> "$GITHUB_STEP_SUMMARY"
      if: always()
    - uses: actions/upload-artifact@v4        # traces + screenshots in the action run
      if: always()
      with: { name: scout-runs, path: .scout/runs/ }
```

With heal in CI: add `ANTHROPIC_API_KEY` and switch to `npx scout go` — when the UI changes legitimately, the job re-records the script and the `.scout/scripts/` diff shows up for commit (e.g. via PR bot).

## Full CLI

```
scout init                      # bootstrap in the project
scout create <name> -c <scenario> [-p profile] [-n notes]
scout list                      # scenarios + status + 📜 if cached script exists
scout go [-s id|slug] [--ai] [--no-heal] [--headed]
scout report                    # markdown suite summary
scout login <profile>           # capture storageState in headed browser
scout mcp                       # MCP server stdio
```

## Verdicts

| | Meaning |
|---|---|
| ✅ `verified` | All expected behavior confirmed by assertions |
| ❌ `failed` | Broken behavior (the reason says exactly what) |
| ⚠️ `partial` | Partially verified |
| 🚫 `blocked` | Couldn't reach the flow (app down, login broken) |

## Architecture

```
src/
├── cli.ts                  # commander CLI
├── engine.ts               # orchestrates: replay → (failed?) → AI heal → re-record
├── config.ts               # scout.config.json + env overrides
├── store.ts                # .scout/ (scenarios, scripts, runs)
├── report.ts               # per-run markdown + suite summary
├── runner/
│   ├── browser.ts          # Playwright wrapper: snapshot with refs, trace, screenshots,
│   │                       #   ref→locator resolution (getByRole when unique, CSS fallback)
│   ├── ai-runner.ts        # Claude Agent SDK + in-process browser tools; records steps
│   └── script-runner.ts    # deterministic step replay
└── mcp/server.ts           # MCP interface (stdio)
```

Design decisions:

- **The agent never writes test code.** It acts in the browser; the script is recorded from actions that actually worked (`getByRole` + accessible name when unique on the page, CSS path as fallback). Eliminates hallucinated selectors.
- **Assertions are tools.** The agent registers each expectation via `browser_assert` — that's what makes the replay a real test, not just a click macro.
- **Trace > video.** Playwright's trace.zip gives per-action screenshots, DOM, network, and console in a single navigable artifact. Raw video stays as an optional enhancement.
- **No server/dashboard.** State is the filesystem in the target repo; report is markdown. Pluggable into any project with `npm i` + 2 files.

## Known POC limitations

- Replay runs sequentially (no sharding/parallelism).
- Snapshot covers interactive elements + text; canvas/video are verified indirectly (element presence, surrounding UI state).
- Flows that depend on reading email are not verifiable — covers UI + redirects.
- Heal re-records the script locally; committing the updated script is manual (intentional: script diff is reviewable).
- Fixed mobile viewport (390×844) — multi-viewport is a simple enhancement (per-scenario variant).
