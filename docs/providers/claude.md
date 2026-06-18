# Claude (Anthropic) — default

Set in `scout.config.json`: `"model": "claude-sonnet-4-6"` (any `claude…` id). This is Scout's default and runs on the trusted **Claude Agent SDK** engine.

## Credentials (detection order, first match wins)

1. **`ANTHROPIC_API_KEY`** env var.
2. **`CLAUDE_CODE_OAUTH_TOKEN`** env var.
3. **`~/.claude/.credentials.json`** — a real Claude Code credential file (Linux).
4. **macOS login keychain** — a Claude Code session (`security` entry `Claude Code-credentials`). Probed for existence only; never read, never prompts to unlock.

Steps 3–4 are what make the **zero-config Claude Code happy path** work: if you've run `claude` and signed in, Scout reuses that session with nothing to set.

## Setup

**Happy path — Claude Code:**

```bash
# install Claude Code (https://claude.com/claude-code), then:
claude            # sign in once
scout doctor      # → ✓ credentials valid
```

**Or an API key:**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
scout doctor
```

## Notes

- On macOS the Claude Code token lives in the keychain, so `~/.claude/.credentials.json` is often absent even when you're signed in — the keychain probe covers that. `scout doctor` may show "Detection: ✗ no credential file" and still pass on the live ping; that's expected.
- If you force the **AI SDK** engine (`SCOUT_ENGINE=ai-sdk`), the keychain/OAuth session doesn't apply — set `ANTHROPIC_API_KEY`, or switch back with `unset SCOUT_ENGINE`.
