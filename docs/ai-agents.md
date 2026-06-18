# AI agents & MCP

Scout's main flow is meant to be driven **by the agent that built the feature**: the agent writes the scenario in natural language (never the script — the script is born from the verified execution) and triggers verification.

## What `scout init` scaffolds

On `scout init`, Scout writes onboarding artifacts so any coding agent in the repo can help:

- **`AGENTS.md`** (repo root) — the **single source of truth** for how an agent uses Scout. Written inside a managed block (`<!-- scout:start -->…<!-- scout:end -->`), so it refreshes on re-init without clobbering anything else in the file.
- **`.claude/skills/scout/SKILL.md`** — a Claude Code skill, scoped to Scout/QA intent; points at `AGENTS.md`.
- **`.cursor/rules/scout.mdc`** — a Cursor rule, glob-scoped to `**/*.scout.md` + `scout.config.json`; points at `AGENTS.md`.

Re-running `init` refreshes all three — init is the upgrade path. They're scoped, not always-on, so they stay out of the way in repos where Scout is incidental.

## The co-author loop

1. **You describe** a flow you want covered, in plain language.
2. **The agent writes** the `.scout.md` directly (richer than the CLI scaffold — it has full repo context: routes, components, copy, auth).
3. **The agent verifies** with `scout go`.
4. **The agent reports the real verdict** — verbatim. It never declares a scenario working without running it.
5. **You iterate** together until it's `verified`, then commit the `.scout.md` and recorded script.

> **Verification-integrity rule** (baked into `AGENTS.md`): an agent must never claim a scenario passes without running `scout go` and reporting the actual verdict. A verdict is trustworthy only because it came from a real run.

## MCP server

Expose Scout to a coding agent (Claude Code, cloud sessions) over MCP:

```jsonc
// .mcp.json of the target project
{
  "mcpServers": {
    "scout": { "command": "npx", "args": ["scout", "mcp"] }
  }
}
```

Exposed tools: `scout_list_scenarios`, `scout_create_scenario`, `scout_run`, `scout_report`, `scout_get_run_report`. The `scout_run` tool takes a `baseUrl` param (same precedence as the CLI flag).
