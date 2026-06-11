# CLAUDE.md

Guidance for AI agents (Claude Code and others) working in this repository.

## What this is

`@pcamarajr/scout` — self-healing browser QA. Natural-language scenarios are verified by an AI agent on first run, recorded as deterministic Playwright scripts, and replayed without LLM afterwards. Published publicly on npm.

## Language

All project content is **English**: commit messages, code, comments, docs, PR titles and bodies, issue text. No exceptions.

## Commits (enforced by tooling, not convention)

- **Conventional Commits** are mandatory. `commitlint` (`@commitlint/config-conventional`) runs on every commit via the husky `commit-msg` hook, and again in CI on all PR commits and the PR title.
- Common types: `feat` (minor bump), `fix` (patch bump), `chore` / `docs` / `refactor` / `test` / `ci` (no release impact).
- Breaking changes: `feat!:` / `fix!:` or a `BREAKING CHANGE:` footer (major bump).
- PR titles must also be conventional — they become the commit message on squash-merge, which is what release-please reads.

## Releases (release-please — fully automated, do NOT do it manually)

The release pipeline is `.github/workflows/release-please.yml`:

1. Merging conventional commits into `main` makes release-please open/update a **release PR** with the version bump and CHANGELOG, derived from commit types.
2. Merging that release PR creates the tag + GitHub Release and publishes to npm (`--provenance`) after typecheck + tests pass.

Rules for agents:

- **Never** edit `version` in `package.json` manually.
- **Never** edit `CHANGELOG.md` manually — it is generated.
- **Never** run `npm publish` or `git tag` manually.
- **Never** merge the release PR on your own initiative — cutting a release is a human decision.
- To influence the next version, use the right commit type. That is the only lever.

## Workflow

- Never commit directly to `main`. Branch from `main`, open a PR.
- CI (`.github/workflows/ci.yml`) runs commitlint, typecheck, tests, and build on every PR.
- Build with `npm run build` (tsc), test with `npm test`, typecheck with `npm run typecheck`.
