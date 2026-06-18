# Run artifacts

Each run records in `.scout/runs/<timestamp>-<slug>/` (gitignored):

| File | What |
|---|---|
| `trace.zip` | Playwright trace — screenshots, DOM snapshots, network, console (`npx playwright show-trace trace.zip`) |
| `*.png` | Evidence screenshots (captured by the agent or at the end of replay/failure) |
| `report.md` | Verdict + reason + recorded script + evidence |
| `result.json` | Structured result (consumable by automation) |
| `transcript.md` | Agent reasoning (AI runs only) |
| `video.mp4` | Paced preview of the verified flow with baked step labels + verdict card — only with `--record-video` |
| `video.timeline.json` | Step→timestamp map the overlays are burned from |

## Preview video (`--record-video`)

Opt-in, off by default (zero overhead otherwise). When enabled, a **verified** scenario gets one extra, deterministic replay — recorded, paced for human viewing, and rendered by `ffmpeg` into a GitHub-playable MP4 with the scenario title, per-step captions, and a green/red verdict card burned in. It's meant as a **rich PR artifact**: a reviewer plays it and sees the feature working, no tooling required.

- Always sourced from the clean deterministic replay — never the exploratory AI run.
- Pacing via `videoSpeed` in `scout.config.json` (`(0,1]`, default `0.4` = slower; `1` = natural speed).
- **A verified scenario never yields zero video:** if the paced replay trips on timing the authoritative run handled fine, Scout records a non-paced fallback clip instead. The verdict is never affected.
- Requires `ffmpeg` on `PATH` (or `FFMPEG_PATH`). Missing it isn't fatal — Scout keeps the raw `.webm` and warns with an install hint. Font is autodetected, or set `SCOUT_VIDEO_FONT` to a `.ttf`.
- Enable per-run with `--record-video`, via `SCOUT_RECORD_VIDEO=1`, or `"recordVideo": true` in the config.

## Trace vs video

Playwright's `trace.zip` is the deep-debug artifact (per-action screenshots, DOM, network, console). The opt-in preview video is a different job: a low-friction, GitHub-playable clip a reviewer watches in the PR to see the feature working — sourced from the clean replay and paced + annotated so it's worth watching.
