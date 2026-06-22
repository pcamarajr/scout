# 🔭 Scout — monorepo

Self-healing browser QA. Describe a test in plain English; Scout verifies it in a
real browser, records a deterministic Playwright script, and replays it for free.

This repository is an npm-workspaces monorepo:

| Package | What it is |
|---|---|
| [`packages/cli`](./packages/cli) | **`@pcamarajr/scout`** — the published CLI. See its [README](./packages/cli/README.md) for usage, quickstart, and docs. |
| `packages/site` | The marketing + docs site (Astro). _Coming soon._ |

## Working in the repo

```bash
npm install            # installs every workspace (single root lockfile)
npm run build          # build the CLI (delegates to packages/cli)
npm test               # test the CLI
npm run typecheck      # typecheck the CLI
```

Conventional Commits are enforced (commitlint + husky). Releases for the CLI are
automated by release-please; the site deploys independently. See
[`CLAUDE.md`](./CLAUDE.md) for the full contributor guide.

MIT licensed.
