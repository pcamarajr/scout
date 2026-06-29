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
viewports: [mobile]       # optional; viewports each scenario below runs in
---

## Free user hits paywall on ep 3
Open ep 3 of series X without login; the paywall appears with a signup CTA.

## Subscriber bypasses paywall
profile: qa               # per-scenario override (also: notes, tags, viewports)
viewports: [mobile, desktop]

Logged-in subscriber opens ep 3; the episode plays with no paywall.
```

Rules that matter when you author:

- **Frontmatter** (YAML, optional): `feature` (defaults to the filename), `profile` (default auth profile), `tags`, `viewports`.
- **Each `## heading` is one scenario.** Its logical slug is `<file-slug>/<scenario-slug>` (e.g. `paywall/free-user-hits-paywall-on-ep-3`) and must be unique across the suite. Duplicate headings in a file, or a scenario with no body text, are hard errors.
- **Per-scenario overrides:** immediately under a heading you may place `profile:`, `notes:`, `tags:`, `viewports:`, `grantPermissions:`, `denyPermissions:`, and `geolocation:` lines (before the prose) to override the file-level defaults.
- **Body = flow + expected behavior, in plain language.** Describe what the user does and what must (or must not) be true. No CSS selectors, no Playwright code — the agent discovers the real elements at run time and records them.
- A `.scout.md` whose every `##` lives inside a fenced ```` ``` ```` block parses as **zero scenarios** (that is how `example.scout.md` documents the format without polluting the suite).

## Viewports (screen sizes)

Each scenario runs in one or more **named viewports**. Declaring more than one fans the scenario out into independent verification units — each viewport gets its own recorded script (`<slug>@<viewport>.json`), its own verdict, and its own demo video. This is how you cover responsive behavior (the mobile hamburger vs the desktop nav).

Built-in viewports, usable without any config:

- **`mobile`** — iPhone 13 emulation (touch + mobile UA), pinned to 390×844.
- **`desktop`** — 1280×800, no touch.
- **`tablet`** — iPad Mini (768×1024, touch).

Declare them in the **frontmatter** (default for every scenario in the file) and override **per scenario** — a per-scenario `viewports:` list **replaces** the file-level one (it does not merge like tags), so a scenario explicitly chooses its sizes. Omitting `viewports` everywhere uses the config's `defaultViewport` (`mobile`).

```markdown
---
feature: Navigation
viewports: [mobile, desktop]   # file default: every scenario runs in both
---

## Primary nav is reachable
Open the home page and reach the "Pricing" link from the main navigation.

## Hamburger menu opens on small screens
viewports: [mobile]            # this one only matters on mobile

Open the home page; tapping the menu button reveals the navigation drawer.
```

Add or override viewports in `scout.config.json` (`viewports`), where each entry is a Playwright `device` preset and/or explicit fields (`width`, `height`, `deviceScaleFactor`, `isMobile`, `hasTouch`, `userAgent`) — they compose, so `{ "device": "iPhone 13", "width": 414 }` is the preset with its width overridden. Set the fallback with `defaultViewport`.

Notes:

- Viewport names are limited to `[a-z0-9-]` (they become script-file tokens). A name not in the registry, or an unknown `device` preset, fails the run with a clear error.
- `scout go --viewport <name>` forces one viewport ad-hoc for debugging (must exist in the registry); that run never persists a script.
- The demo video follows the viewport — a `desktop` scenario records a landscape clip.

## Browser permissions

Some flows hit native browser permission prompts (geolocation, notifications, camera, microphone) that the agent cannot click — they live outside the page DOM. Declare a permission policy so Scout sets it at browser launch, for both the AI run and deterministic replay. Three states **per permission**:

- **Not declared** → native browser behavior, untouched (a headed run may show the prompt).
- **`grantPermissions:`** → granted explicitly.
- **`denyPermissions:`** → blocked via an init-script stub, so no native prompt appears.

Declarable in the **frontmatter** (default for every scenario in the file) and overridable **per scenario** (merged per-axis: a section that sets only `denyPermissions` still inherits the file's `grantPermissions`). Lists are comma-separated.

```markdown
---
feature: Store Locator
denyPermissions: [geolocation]      # file default: never prompt for location
---

## Search falls back to manual when location is blocked
Open the store locator, search for "Merate", and confirm results appear.

## Nearby stores with a fixed location
grantPermissions: geolocation       # this scenario grants instead
geolocation: 45.69, 9.43            # required when geolocation is granted (lat, lng)

Open the store locator; the nearest store to the given coordinates is shown.
```

Notes:

- Allowed permissions: `geolocation`, `notifications`, `camera`, `microphone`, `clipboard-read`, `clipboard-write`, `midi`. An unknown name fails the load with a clear error.
- Granting `geolocation` **requires** a `geolocation: <latitude>, <longitude>` line; supplying coordinates implies granting it.
- **Grant wins over deny:** a scenario that grants a permission overrides a file-level deny of the same permission (as in the example above).
- `denyPermissions` matters mainly in **headed** runs (headless already denies silently). What changes behavior in CI is `grantPermissions` and a granted `geolocation` with coordinates.

## New tabs / popups

When a click opens a new tab (a `target="_blank"` link or `window.open`), Scout's `browser_click` result flags it. The agent then calls **`browser_switch_tab`** to move control to that tab; with no argument it switches to the newest tab, or pass a `urlGlob` (e.g. `**/booking**`) to target a specific one. The switch waits for the tab to finish loading, then becomes a recorded `switchTab` step that replays deterministically.

Console and network observers are **per-tab**: assertions (`browser_assert_no_console_errors`, `browser_assert_network`, and the console-log assertion) always read the **active tab**, so after switching you assert on the right page. The browser permission policy applies to every tab in the context, including popups.

## Asserting a console log appeared

Beyond *absence* of errors, you can assert a **specific log was emitted** (e.g. a `DEBUG:[...]` line gated behind a debug flag). `browser_assert_console_message` requires a message on the **active tab** that contains **all** of the given substrings **within a single message**, optionally constrained to a `type` (`log`, `debug`, `error`, …). Inspect first (`browser_inspect_logs` now also lists `log`/`debug`/`info` messages), then assert on a **stable** substring — a prefix like `DEBUG:[FEATURE/x]`, never a volatile value — so the check tolerates unrelated console noise. It becomes a recorded step that fails the deterministic replay if the log goes missing.

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
