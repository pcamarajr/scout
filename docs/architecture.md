# Architecture

```
src/
├── cli.ts                  # commander CLI
├── engine.ts               # orchestrates: replay → (failed?) → AI heal → re-record
├── config.ts               # scout.config.json + env overrides
├── credentials.ts          # provider inference + network-free credential detection ladders
├── specs.ts                # .scout.md parser + slug model + scenario writer
├── store.ts                # .scout/ (specs, scripts, runs)
├── init.ts / scaffold.ts   # init + the AI onboarding artifacts (AGENTS.md, skill, rule)
├── report.ts               # per-run markdown + suite summary
├── runner/
│   ├── browser.ts          # Playwright wrapper: snapshot with refs, trace, screenshots,
│   │                       #   ref→locator resolution (getByRole when unique, CSS fallback)
│   ├── ai-runner.ts        # Claude Agent SDK + in-process browser tools; records steps
│   ├── engines/            # agent-sdk (default) + ai-sdk (Gemini/OpenAI/Claude parity)
│   └── script-runner.ts    # deterministic step replay
└── mcp/server.ts           # MCP interface (stdio)
```

## Design decisions

- **The agent never writes test code.** It acts in the browser; the script is recorded from actions that actually worked (`getByRole` + accessible name when unique on the page, CSS path as fallback). Eliminates hallucinated selectors.
- **Assertions are tools.** The agent registers each expectation via `browser_assert` — that's what makes the replay a real test, not just a click macro.
- **Recorded scripts are pruned before caching.** Agent retries (e.g. re-filling the same field) are deduplicated conservatively: an earlier `fill`/`select` is dropped only when a later one targets the same element and nothing in between (click/press/navigate) could have consumed the value. Clicks are never deduplicated.
- **Trace for debugging, video for humans.** `trace.zip` is the deep-debug artifact; the opt-in preview video is a low-friction, GitHub-playable clip for PR review. See [artifacts](./artifacts.md).
- **Scenarios are versioned source, not database rows.** One `.scout.md` per feature, reviewed in PRs like a `.test.ts`; the spec is a pure input a run never mutates (status derives from `.scout/runs/`). The recorded JSON script is a derived sidecar — clean diffs, no run noise.
- **No server/dashboard.** State is the filesystem in the target repo; the report is markdown. Pluggable into any project with `npm i` + 2 files.

## Runner failure ≠ UI verdict

An AI run can die without producing a verdict — agent ran out of turns, SDK error, dead subprocess. Scout treats that as an **infrastructure failure**, never a judgment about the app:

1. **Forced verdict** — when the agent ends without calling `scout_verdict` (typically `maxTurns` exhausted), Scout resumes the session with a tiny turn budget and demands a verdict from what was already observed — a `partial` with context beats a silent death.
2. **Automatic retry** — if the rescue also fails, the whole AI run is retried once with a fresh browser and agent.
3. **Honest reporting** — if it still fails, the result is `blocked` with `runnerFailure` set in `result.json` (and 💥 in `report.md` / CLI output), naming the cause and pointing at the artifacts. Rerun it instead of debugging the app.

Every AI run aborts its Agent SDK query on completion, so no `claude` subprocess outlives the run.

## Known limitations

- Replay runs sequentially (no sharding/parallelism).
- Snapshot covers interactive elements + text; canvas/video are verified indirectly (element presence, surrounding UI state).
- Flows that depend on reading email are not verifiable — covers UI + redirects.
- Heal re-records the script locally; committing the updated script is manual (intentional: the diff is reviewable).
- Fixed mobile viewport (390×844) — multi-viewport is a planned per-scenario variant.
