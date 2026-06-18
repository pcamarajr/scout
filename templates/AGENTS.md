# Scout — browser QA for AI agents

Scout turns **natural-language scenarios** into **AI-verified, deterministically-replayed** browser tests. A scenario is written in plain English in a `.scout.md` file; on its first `scout go` an AI agent drives a real browser (Playwright), judges the outcome, and records a deterministic script. Every later run replays that script with **no LLM** — fast and free — and only falls back to AI when the script breaks (self-heal).

This file is the **single source of truth** for how an AI agent should help a QA team work with Scout in this repo. The Claude Code skill and the Cursor rule both point here.

## Your primary job: co-author scenarios with QA

When a QA person describes a flow they want covered, **you write the `.scout.md` directly** — do not make them hand-write it. You have full repo context (routes, components, copy, auth), so you can author a richer, more accurate spec than the CLI scaffold (`scout create`) ever could. Then you verify it and iterate with the human until it is green.

The loop:

1. **Author** — translate the QA person's intent into one or more scenarios in a `.scout.md` file (format below). Capture the flow *and* the expected behavior, in plain language. No selectors, no code.
2. **Verify** — run `scout go` (optionally `-s <slug>` to target one scenario). The first run is AI-driven, in a real browser.
3. **Interpret** — read the verdict Scout reports and relay it to the human verbatim (see *Verdicts* below).
4. **Iterate** — refine the scenario text with QA until the verdict is `verified`, then commit the `.scout.md` and the recorded script.

> `scout create <name> -f <feature> -c <text>` exists as a convenience for **humans without an agent**. As the agent, prefer authoring the `.scout.md` directly — you can write a fuller spec from repo context.

## ⛔ Verification-integrity rule (non-negotiable)

**Never declare a scenario working, passing, or done without actually running `scout go` and reporting the real verdict.**

- Do **not** fabricate, assume, or predict success. Run it.
- Report the verdict Scout produced **verbatim** — including the `reason` line.
- If the result is `failed`, `partial`, or `blocked`, say so honestly. If a replay **healed**, surface that and show the script diff so a human can review what changed.

This rule protects Scout's entire value proposition: a verdict is trustworthy only because it came from a real run. Inventing one poisons the suite.

## The `.scout.md` authoring guide

Scenarios live as markdown under `.scout/specs/**/*.scout.md` — **one file per feature/component**, versioned and reviewed like any other test. The markdown is a **pure input**: a run never writes back to it (status lives in `.scout/runs/`), so the spec diff only ever reflects an intent change.

Format:

```markdown
---
feature: Paywall          # optional; defaults to the filename
profile: anon             # optional; default auth profile for scenarios below
tags: [monetization]      # optional
---

## Free user hits paywall on ep 3
Open ep 3 of series X without login; the paywall appears with a signup CTA.

## Subscriber bypasses paywall
profile: qa               # per-scenario override (also: notes, tags)

Logged-in subscriber opens ep 3; the episode plays with no paywall.
```

Rules that matter when you author:

- **Frontmatter** (YAML, optional): `feature` (defaults to the filename), `profile` (default auth profile), `tags`.
- **Each `## heading` is one scenario.** Its logical slug is `<file-slug>/<scenario-slug>` (e.g. `paywall/free-user-hits-paywall-on-ep-3`) and must be unique across the suite. Duplicate headings in a file, or a scenario with no body text, are hard errors.
- **Per-scenario overrides:** immediately under a heading you may place `profile:`, `notes:`, and `tags:` lines (before the prose) to override the file-level defaults.
- **Body = flow + expected behavior, in plain language.** Describe what the user does and what must (or must not) be true. No CSS selectors, no Playwright code — the agent discovers the real elements at run time and records them.
- A `.scout.md` whose every `##` lives inside a fenced ```` ``` ```` block parses as **zero scenarios** (that is how `example.scout.md` documents the format without polluting the suite).

## Base URL and secrets

There is a **default base URL** set at `scout init` (in `scout.config.json`). It can be **overridden per run** without editing the file:

- `scout go --base-url https://staging.example.com`
- `SCOUT_BASE_URL=https://staging.example.com scout go`
- Precedence: `--base-url` flag > `SCOUT_BASE_URL` env > `baseUrl` in `scout.config.json`.

Recorded scripts store navigation **relative to the base URL in effect at record time**, so a script recorded against `:3000` replays unchanged against staging.

For credentials and tokens, never put a literal secret in a scenario. Use a **`$ENV:VAR` placeholder** — Scout resolves it from the environment at run time, in both **form fills** and **`browser_navigate` URLs** (e.g. `/renew?token=$ENV:RENEW_TOKEN`). The real value never enters the committed script and never passes through the LLM. Declare the allowed env vars per auth profile in `scout.config.json` (`profiles.<name>.env`).

## Verdicts (what `scout go` reports)

| Verdict | Meaning |
|---|---|
| `verified` ✅ | All expected behavior confirmed by assertions. |
| `failed` ❌ | Broken behavior — the `reason` says exactly what. |
| `partial` ⚠️ | Only part of the expected behavior was confirmed. |
| `blocked` 🚫 | Couldn't reach the flow at all (app down, login broken). |

**Healed:** when a cached script breaks but the AI re-verifies and re-records it, the run is flagged `healed`. The recorded-script diff is the heal diff — review it; a legitimate UI change is fine to commit, an unexpected one is a real regression.

**Runner failure ≠ UI verdict:** an AI run can die without producing a verdict (turn budget exhausted, SDK error). Scout flags that as `runnerFailure` / 💥 — it is an infrastructure failure, **not** a judgment about the app. Rerun it; don't debug the app over it.

## Secondary: helping triage a failed replay

When a replay comes back `failed`/`partial`/`blocked` or `healed`, you can help — but the **human stays in the loop on intent**. Triage flow:

1. Read the `reason` and open the run artifacts under `.scout/runs/<timestamp>-<slug>/` — `report.md` (verdict + recorded script), `trace.zip` (`npx playwright show-trace`), screenshots, and `transcript.md` for AI runs.
2. Decide *with the human* whether this is a **real regression** (the app broke → fix the app) or a **legitimate UI change** (the spec/script is stale → re-verify with `scout go --ai -s <slug>` to re-record, then review the diff).
3. Never silently re-record to make a red suite green. A green verdict must reflect reality.

## Defer to the live CLI for commands and flags

Commands and flags evolve — read them live instead of trusting a copy:

- `scout --help` — all commands.
- `scout <command> --help` — flags for one command (e.g. `scout go --help`).

The core commands you will use: `scout go` (verify/replay), `scout list` (scenarios + status), `scout report` (suite summary, `--check` for a CI gate). `scout init` is the setup/upgrade entry point and also refreshes these onboarding files.
