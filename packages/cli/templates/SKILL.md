---
name: scout
description: >
  Help a QA team use Scout — browser QA where natural-language scenarios are
  AI-verified once and then replayed deterministically. TRIGGER when the user
  mentions Scout, a `.scout.md` scenario, `scout.config.json`, `scout go` /
  `scout init` / `scout report`, browser/E2E/QA testing of a user flow, or asks
  to author, verify, replay, or triage a browser test scenario. Do NOT trigger
  for unrelated unit tests or non-browser work.
---

# Scout

Scout is self-healing browser QA: QA describes a flow in plain English, an AI
agent verifies it once in a real browser and records a deterministic script,
and every later run replays that script with no LLM.

Your job is to **co-author `.scout.md` scenarios** with QA, **verify** them with
`scout go`, and **report the real verdict** — never claim a scenario passes
without running it.

**Read `AGENTS.md` at the repo root — it is the canonical, always-current guide**
to the authoring loop, the `.scout.md` format, per-scenario overrides (viewports,
permissions, `cookies:`, `storage:` and `device:` preconditions), base-URL/secret handling,
verdicts, and failure triage. Follow it. For commands and flags, run
`scout --help` / `scout <command> --help`.
