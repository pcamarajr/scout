# Writing scenarios (`.scout.md`)

Scenarios live as markdown under `.scout/specs/**/*.scout.md` — **one file per feature/component**, versioned and reviewed like the rest of your tests. The markdown is the **source of truth and a pure input**: a run never writes back to it. Status and last-run derive from `.scout/runs/` instead, so the spec diff only ever reflects an intent change, never run noise.

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

## Rules

- Each `##` heading is one scenario. Its **logical slug** is `<file>/<scenario>` (e.g. `paywall/free-user-hits-paywall-on-ep-3`) and must be unique across the suite.
- **Frontmatter** (YAML, optional): `feature` (defaults to the filename), `profile` (default auth profile for the file), `tags`.
- **Per-scenario overrides:** `profile:`, `notes:`, and `tags:` lines placed immediately under a heading (before the prose) override the file-level defaults.
- **Body = flow + expected behavior, in plain language.** Describe what the user does and what must (or must not) be true. No CSS selectors, no Playwright code — the agent discovers the real elements at run time and records them.
- A `.scout.md` whose every `##` lives inside a fenced ```` ``` ```` block parses as **zero scenarios** (that's how `example.scout.md` documents the format without polluting the suite).
- Duplicate headings in a file, or a scenario with no body text, are hard errors.

## Asserting console logs & API calls

Beyond what's on screen, scout can verify the **browser console** and the **network calls** the page makes. Just describe the expectation in the prose — the agent observes the real console/network on the first verified run and records a **tolerant, deterministic** assertion that replay re-checks without an LLM.

```markdown
## Checkout fires the order API cleanly
The user completes checkout. A POST to /api/checkout returns 2xx and the
response includes an orderId. No errors appear in the browser console.
```

What the agent records:

- **Network** — matched by method + URL pattern (glob with `*`/`**`) + status class (`2xx`), optionally requiring stable substrings in the response body (field names like `orderId`). It deliberately avoids volatile values (ids, timestamps), so the assertion survives replay.
- **Console** — "no errors" covers `console.error` **and** uncaught exceptions. Known/expected noise can be ignored by substring (e.g. a third-party `favicon` 404).

Keep these expectations about **shape, not exact values** — "a POST to `/api/checkout` returned 2xx with an `orderId`", not "orderId was `ord_42`". Pinning a volatile value is the main way a network assertion turns flaky.

## Authoring options

- **By hand** — write the markdown directly.
- **CLI** — `scout create <name> -f <feature> -c <text> [-p profile] [-n notes]`. A convenience for humans without an agent.
- **AI agent** — your coding agent writes a richer spec straight from repo context. See [AI agents & MCP](./ai-agents.md).

## Migrating from a legacy `scenarios.json`

Older scouts kept a single `.scout/scenarios.json`. Convert it once:

```bash
scout migrate   # → one .scout/specs/<slug>.scout.md per scenario, relocates cached scripts, backs up the JSON
```

It's idempotent and preserves cached scripts (so replay still works without re-recording). Re-run `scout go` once afterward to repopulate run status, review the generated `feature:` frontmatter, and delete `.scout/scenarios.json.bak` when happy.
