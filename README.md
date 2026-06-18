# 🔭 Scout

**Describe a test in plain English. Scout verifies it in a real browser, then replays it for free, forever.**

[![npm](https://img.shields.io/npm/v/@pcamarajr/scout.svg)](https://www.npmjs.com/package/@pcamarajr/scout)
[![license](https://img.shields.io/npm/l/@pcamarajr/scout.svg)](./LICENSE)

Scout is self-healing browser QA. You write a scenario in one sentence; an AI agent drives a real browser (Playwright) to verify it and records a deterministic script. Every run after that is pure replay — no LLM, fast and free — and AI only steps back in when the UI changes and the script breaks.

- ✍️ **Author in one sentence** — no selectors, no code. Just the flow and what should happen.
- 🤖 **Verified in a real browser** — an agent judges behavior ("the paywall must *not* appear"), not just clicks.
- ⚡ **Replays for free** — recorded runs are pure Playwright. ~zero cost, seconds per scenario, CI-ready.
- 🔧 **Self-heals** — when the UI changes, AI re-verifies and re-records; you review the diff.
- 🧠 **Works with Claude, Gemini, or OpenAI** — zero-config with Claude Code; one env var for the rest.

## How it works

```
You write:   "On the homepage, search for 'shoes' and results appear."
     │
     ▼  scout go  (first run)
AI agent runs it in a real browser, judges the outcome (verified / failed / …),
and records a deterministic script (steps + assertions).
     │
     ▼  scout go  (every run after)
Pure Playwright replay — no LLM, seconds per scenario, ~zero cost.
     │
     ▼  UI changed and replay broke?
AI re-runs, re-judges, re-records the script (self-healing). You review the diff.
```

| | Pure Playwright | Pure AI | **Scout** |
|---|---|---|---|
| Authoring | code + selectors | one sentence | **one sentence** |
| Cost per CI run | ~zero | $$ + slow | **~zero (replay)** |
| Survives UI changes | breaks | adapts | **breaks → AI re-records** |
| Judges behavior | only what you coded | yes | **yes** |

## Quickstart — try it on any live URL (~2 min)

No codebase required. Point Scout at a site you already have and watch it verify a real flow.

```bash
npm install -g @pcamarajr/scout     # or: npx @pcamarajr/scout <command>
npx playwright install chromium     # the browser engine

scout init --base-url https://your-app.com   # or run `scout init` and answer the prompt
scout doctor                                  # check your AI credentials (see below)

scout create "Homepage search" \
  -f home \
  -c "On the homepage, search for 'shoes'; a list of results appears"

scout go        # first run: the AI agent verifies it in a real browser
scout go        # again: deterministic replay, no LLM, seconds
```

That's it — you have a verified test that replays for free.

### AI credentials

The first `scout go` needs an AI provider. Run `scout doctor` anytime to check.

- **Claude Code (zero-config) — the happy path.** If you're signed in to [Claude Code](https://claude.com/claude-code), Scout reuses that session automatically. Nothing to set.
- **Or an API key:** `export ANTHROPIC_API_KEY=…` (Claude), `export GEMINI_API_KEY=…` (Gemini), or `export OPENAI_API_KEY=…` (OpenAI). Scout picks the provider from the `model` in `scout.config.json`.

Full provider setup → [`docs/providers/`](./docs/providers). Deterministic **replay never uses an LLM**, so CI needs no credentials (`scout go --no-heal`).

## Use it in your codebase

Same flow, committed alongside your app — the suite travels with the branch and runs as a PR gate.

```bash
cd your-project
npm install --save-dev @pcamarajr/scout
npx playwright install chromium
scout init                        # writes scout.config.json, .scout/, and AI agent files (below)
```

- `.scout/specs/*.scout.md` (your scenarios) and `.scout/scripts/` are **committed**; runs and sessions are gitignored.
- Gate a PR on it: `scout report --check` exits non-zero if any scenario isn't `verified`. → [CI setup](./docs/environments.md)

## Use it with your AI agent

`scout init` also scaffolds onboarding for coding agents, so the agent that builds a feature can write and verify its test:

- **`AGENTS.md`** (repo root) — the canonical guide; the source of truth for how an agent uses Scout.
- **`.claude/skills/scout/SKILL.md`** + **`.cursor/rules/scout.mdc`** — point your agent at it automatically.
- **MCP server** (`scout mcp`) — exposes `scout_create_scenario`, `scout_run`, `scout_report`, … so the agent runs the loop end-to-end.

The loop: you describe a flow → the agent writes the `.scout.md` → runs `scout go` → reports the **real** verdict (never claims success without running it) → iterates with you until it's green. Full guide → [`docs/ai-agents.md`](./docs/ai-agents.md).

## Docs

| Topic | |
|---|---|
| [Writing scenarios](./docs/scenarios.md) | the `.scout.md` format, slugs, per-scenario overrides |
| [Providers & credentials](./docs/providers) | Claude, Gemini, OpenAI — detection order + `scout doctor` |
| [Auth profiles](./docs/auth.md) | logged-in flows, `scout login`, `$ENV:` secrets |
| [Environments & CI](./docs/environments.md) | base-URL overrides, worktrees, the PR gate |
| [Run artifacts](./docs/artifacts.md) | traces, screenshots, the preview video |
| [AI agents & MCP](./docs/ai-agents.md) | the co-author loop, the scaffolded files, MCP tools |
| [CLI reference](./docs/cli.md) | every command, `scout report --json/--check` |
| [Architecture](./docs/architecture.md) | how it works inside + design decisions + limitations |

## Verdicts

| | Meaning |
|---|---|
| ✅ `verified` | All expected behavior confirmed by assertions |
| ❌ `failed` | Broken behavior — the reason says what |
| ⚠️ `partial` | Only part of the expected behavior confirmed |
| 🚫 `blocked` | Couldn't reach the flow (app down, login broken) |

---

Early but functional, and published on npm. Issues and PRs welcome — see [`docs/architecture.md`](./docs/architecture.md) for internals. MIT licensed.
