# 🔭 Scout

Self-healing browser QA. Scenarios written in **natural language** as versioned `.scout.md` files, verified by an **AI agent** in a real browser (Playwright), and recorded as a **deterministic script** that runs cheaply and quickly in CI — AI only kicks in when the script breaks.

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
scout create "Paywall free" -f paywall -c "Open ep 3 of series X without login; paywall should appear with signup CTA"
        │       (writes a `## Paywall free` section into .scout/specs/paywall.scout.md)
        ▼
scout go  ──── 1st run: AI agent runs in browser, judges (verified/failed/partial/blocked)
        │       and records .scout/scripts/paywall/paywall-free.json (deterministic steps + assertions)
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

scout init                         # creates scout.config.json + .scout/specs/
scout create "Login with Google" \
  -f auth \
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

## Scenarios are files (`.scout.md`)

Scenarios live as markdown under `.scout/specs/**/*.scout.md` — **one file per feature/component**, versioned and reviewed like the rest of your tests. The markdown is the **source of truth and a pure input**: a run never writes back to it. Status and last-run derive from `.scout/runs/` instead, so the spec diff only ever reflects an intent change, never run noise. The layout mirrors the Playwright Agents test-plan format, with YAML frontmatter as a scout superset.

```markdown
---
feature: Paywall          # optional; defaults to the filename
profile: anon             # default auth profile for scenarios below
tags: [monetization]      # optional
---

## Free user hits paywall on ep 3
Open ep 3 of series X without login; paywall appears with a signup CTA.

## Subscriber bypasses paywall
profile: qa               # per-scenario override (also: notes, tags)

Logged-in subscriber opens ep 3; plays with no paywall.
```

- Each `##` heading is one scenario; its **logical slug** is `<file>/<scenario>` (e.g. `paywall/free-user-hits-paywall-on-ep-3`), unique across the suite.
- Optional `profile`/`notes`/`tags` lines right after a heading override the file-level defaults.
- Author by hand, or via `scout create <name> -f <feature> -c <text>` / the `scout_create_scenario` MCP tool.

### Migrating from a legacy `scenarios.json`

Older scouts kept a single `.scout/scenarios.json`. Convert it once:

```bash
scout migrate   # → one .scout/specs/<slug>.scout.md per scenario, relocates cached scripts, backs up the JSON
```

It's idempotent and preserves cached scripts (so replay still works without re-recording). Re-run `scout go` once afterward to repopulate run status. Review the generated `feature:` frontmatter and delete the `.scout/scenarios.json.bak` when happy.

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

Everything is relative to the project directory and the target can be overridden per run — two worktrees run in parallel without colliding:

```bash
scout go --base-url http://localhost:3001                     # worktree B pointing to its ephemeral server
SCOUT_BASE_URL=http://localhost:3001 scout go                 # same, via env
SCOUT_BASE_URL=https://staging.myapp.com scout go --no-heal   # against staging
```

Precedence: `--base-url` flag (or the `baseUrl` param of the `scout_run` MCP tool) > `SCOUT_BASE_URL` > `baseUrl` in `scout.config.json`. Recorded scripts store navigation **relative to the baseUrl in effect at recording time**, so a script recorded against `:3000` replays unchanged against `:3001` or staging.

- `.scout/specs/` (the `.scout.md` suite) and `.scout/scripts/` are **committed** — the suite travels with the branch.
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
| `video.mp4` | Paced preview of the verified flow with baked step labels + verdict card — only with `--record-video` (see below) |
| `video.timeline.json` | Step→timestamp map the overlays are burned from |

### Preview video (`--record-video`)

Opt-in, off by default (zero overhead otherwise). When enabled, a **verified** scenario gets one extra, deterministic replay — recorded, paced for human viewing, and rendered by `ffmpeg` into a GitHub-playable MP4 with the scenario title, per-step captions, and a green/red verdict card burned in. It's meant as a **rich PR artifact**: a reviewer plays it and sees the implemented feature working, no tooling required.

- Always sourced from the clean deterministic replay — never the exploratory AI run.
- Pacing via `videoSpeed` in `scout.config.json` (`(0,1]`, default `0.4` = slower; `1` = natural speed).
- A verified scenario never yields zero video: if the paced replay trips on timing the authoritative run handled fine, scout silently records a non-paced fallback clip instead. The verdict is never affected.
- Requires `ffmpeg` on `PATH` (or `FFMPEG_PATH`). Missing it isn't fatal — scout keeps the raw `.webm` and warns with an install hint. Font autodetected, or set `SCOUT_VIDEO_FONT` to a `.ttf`.
- Enable per-run with `--record-video`, via `SCOUT_RECORD_VIDEO=1`, or `"recordVideo": true` in the config.

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
scout init                      # bootstrap in the project (.scout/specs/ + config)
scout create <name> -f <feature> -c <scenario> [-p profile] [-n notes]
scout list                      # scenarios + status + 📜 if cached script exists
scout go [-s slug|name] [--ai] [--no-heal] [--headed] [--record-video] [--base-url <url>]
scout report [--json] [--check] # suite summary (markdown default)
scout migrate                   # legacy scenarios.json → .scout.md specs
scout login <profile> [--base-url <url>]  # capture storageState in headed browser
scout mcp                       # MCP server stdio
```

### `scout report` — markdown, JSON and gate mode

By default `scout report` prints the markdown suite summary (embeddable in a PR body). Two flags make it consumable by scripts and CI gates — they compose freely:

```bash
scout report                  # markdown summary (default)
scout report --json           # machine-readable JSON (below)
scout report --check          # exit 1 if ANY scenario is not `verified`, exit 0 otherwise
scout report --json --check   # prints the JSON AND sets the exit code
```

`--json` shape:

```jsonc
{
  "scenarios": [
    { "slug": "paywall/paywall-free", "name": "Paywall free", "feature": "Paywall", "profile": "anon", "status": "verified", "lastRun": "2026-06-10T12:00:00.000Z" }
  ],
  "summary": { "total": 4, "verified": 3, "failed": 1, "partial": 0, "blocked": 0, "pending": 0 }
}
```

`--check` is the PR-gate primitive: no grepping the markdown for emojis/words. A scenario counts as passing only with status `verified` — `failed`, `partial`, `blocked` and `pending` all fail the check. An empty suite passes vacuously (gate scripts that require scenarios should test `summary.total`).

```bash
# typical gate script
npx scout report --check || { echo "Scout gate: non-verified scenarios"; exit 1; }
```

## Verdicts

| | Meaning |
|---|---|
| ✅ `verified` | All expected behavior confirmed by assertions |
| ❌ `failed` | Broken behavior (the reason says exactly what) |
| ⚠️ `partial` | Partially verified |
| 🚫 `blocked` | Couldn't reach the flow (app down, login broken) |

### Runner failure ≠ UI verdict

An AI run can also die without any verdict — agent ran out of turns, SDK error, dead subprocess. Scout treats that as an **infrastructure failure**, never as a judgment about the app:

1. **Forced verdict:** when the agent ends without calling `scout_verdict` (typically `maxTurns` exhausted), Scout resumes the same session with a tiny turn budget and demands a verdict based on what was already observed — a `partial` with context beats a silent death.
2. **Automatic retry:** if the rescue also fails, the whole AI run is retried once with a fresh browser and agent.
3. **Honest reporting:** if it still fails, the result is `blocked` with `runnerFailure` set in `result.json` (and flagged in `report.md` and the CLI output: 💥 *runner failure — not a UI judgment*), naming the cause (e.g. "agent exhausted the 40-turn limit") and pointing at the run artifacts. Rerun it instead of debugging the app.

Every AI run aborts its Agent SDK query on completion (success or failure), so no `claude` subprocess outlives the run.

## Architecture

```
src/
├── cli.ts                  # commander CLI
├── engine.ts               # orchestrates: replay → (failed?) → AI heal → re-record
├── config.ts               # scout.config.json + env overrides
├── specs.ts                # .scout.md parser + slug model + scenario writer
├── store.ts                # .scout/ (specs, scripts, runs)
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
- **Recorded scripts are pruned before caching.** Agent retries (e.g. re-filling the same field) are deduplicated conservatively: an earlier `fill`/`select` is dropped only when a later one targets the same element and nothing in between (click/press/navigate) could have consumed the value. Clicks are never deduplicated.
- **Trace for debugging, video for humans.** Playwright's trace.zip is the deep-debug artifact (per-action screenshots, DOM, network, console). The opt-in preview video is a different job: a low-friction, GitHub-playable clip a reviewer watches in the PR to see the feature working — sourced from the clean replay and paced + annotated so it's worth watching, not "video for the sake of video".
- **Scenarios are versioned source, not database rows.** One `.scout.md` per feature, reviewed in PRs like a `.test.ts`; the spec is a pure input that a run never mutates (status derives from `.scout/runs/`). The recorded JSON script is a derived sidecar — clean diffs, no run noise in history.
- **No server/dashboard.** State is the filesystem in the target repo; report is markdown. Pluggable into any project with `npm i` + 2 files.

## Known POC limitations

- Replay runs sequentially (no sharding/parallelism).
- Snapshot covers interactive elements + text; canvas/video are verified indirectly (element presence, surrounding UI state).
- Flows that depend on reading email are not verifiable — covers UI + redirects.
- Heal re-records the script locally; committing the updated script is manual (intentional: script diff is reviewable).
- Fixed mobile viewport (390×844) — multi-viewport is a simple enhancement (per-scenario variant).
