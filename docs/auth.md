# Auth profiles & secrets

Authenticated flows use a browser session captured once per environment (Playwright `storageState`).

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

A scenario picks a profile via file-level `profile:` frontmatter or a per-scenario override (see [Writing scenarios](./scenarios.md)).

## Capturing a session

```bash
scout login subscriber   # opens a headed browser; log in, press Enter → saves .scout/state/subscriber.json (gitignored)
```

> `scout login` captures **your application's** logged-in session — it is **not** AI/model-provider auth. For that, see [Providers & credentials](./providers) and `scout doctor`.

## Secrets (`$ENV:` placeholders)

Never put a literal secret in a scenario. Use a `$ENV:VAR` placeholder — Scout resolves it from the environment at run time, in **both form fills and `browser_navigate` URLs** (e.g. `/renew?token=$ENV:RENEW_TOKEN`):

- The real value never enters the committed script and never passes through the LLM.
- Declare the allowed env vars per profile with `profiles.<name>.env`.

In CI, either generate the `storageState` in a setup step (login via script) or let the agent log in using `$ENV:QA_SUB_EMAIL` / `$ENV:QA_SUB_PASSWORD`.

## What's committed

- `.scout/specs/` and `.scout/scripts/` are **committed** — the suite travels with the branch.
- `.scout/state/` (sessions) and `.scout/runs/` (artifacts) are **gitignored** — per-machine.
