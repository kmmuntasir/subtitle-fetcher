# subtitle-fetcher

Scans your **movie / TV-series library** (local disk, NAS mount, Windows UNC share) and
downloads English sidecar subtitles (`<name>.en.srt`) for every video that is missing them.
Then keeps doing it daily until the whole library is covered.

Zero npm dependencies · Node ≥ 18 · Windows / Linux / macOS.

## Features

- **Two free sources, no accounts required to start**
  - [subdl.com](https://subdl.com) — anonymous, community-reported cap ≈ 300 downloads/day per IP
  - [opensubtitles.com](https://www.opensubtitles.com) API — optional free key; hash-exact sync fallback
- **Respects daily caps automatically** — stops politely mid-run, resumes tomorrow, queue preserved
- **Library-aware detection**
  - credits subtitles bundled in `Subs/` / `subs` / `Subtitles` folders (multi-language YTS-style packs)
  - detects **fake stub `.srt` files** (the classic 1–10 KB saved-HTML-page) via content inspection
    (cue structure + Latin-script ratio), so they don't mask a missing language
  - skips videos that already have `<name>.srt` / `<name>.en.srt`; *replaces* nothing,
    always writes `<name>.en.srt`
- **Release-aware selection** — ranks candidate releases by overlap with your actual
  file name (`YIFY`, `PSA`, resolution tags…); extracts *your* `S02E05` from multi-episode
  zip packs; prefers non-AI-translated, non-forced, non-hearing-impaired uploads
- Opensubtitles-style **hash fingerprints** for exact-sync matching (only reads 128 KB per video)
- Auto-parks hopeless titles after N attempts so nightly logs stay clean
- One-command daily automation: Windows Task Scheduler or cron

## Quickstart

```bash
git clone https://github.com/kmmuntasir/subtitle-fetcher.git
cd subtitle-fetcher

# interactive wizard: folders, optional key, daily schedule
node subtitles-fetcher.mjs setup       # Windows users may double-click install.cmd
```

That registers everything and prints next steps. Manual equivalents:

| step | command |
|------|---------|
| preview what would be fetched | `node subtitles-fetcher.mjs dry` |
| fetch now | `node subtitles-fetcher.mjs run [--limit N]` |
| progress dashboard | `node subtitles-fetcher.mjs status` |
| enable/disable daily run | `node subtitles-fetcher.mjs schedule 13:05` / `schedule --remove` |
| force-retry paths containing X | `node subtitles-fetcher.mjs retry "inception"` |
| debug one file | `node subtitles-fetcher.mjs probe "/path/Movie (2019)/file.mkv"` |

## Automation details

- **Windows** — creates `SubtitleFetcherDaily` in Task Scheduler plus a `run-daily.cmd`
  launcher; output lands in `logs\task.log`.
- **Linux/macOS** — appends one marked line to your crontab:
  ```
  5 13 * * * cd '/path/to/subtitle-fetcher' && /path/to/node subtitles-fetcher.mjs run >> logs/task.log 2>&1 # subtitle-fetcher
  ```
  verify with `crontab -l | grep subtitle`.

The run itself decides whether a fresh library walk is needed (inventory older than ~20 h),
so adding new episodes during the day gets picked up on the next scheduled pass.

## Configuration → `config.json`

Created by `setup`; safe to hand-edit. Committed nowhere (see `.gitignore`).

| field | meaning |
|-------|---------|
| `roots` | array of library folder paths |
| `providers` | order tried: `"sd"`, `"os"`, … |
| `apiKey` / `username` / `password` | OpenSubtitles credentials (optional) |
| `hearingImpairedOk` | accept HI subs when nothing cleaner exists (default true) |
| `aiTranslatedOk` | accept machine-translated uploads (default false) |
| `maxPerRun` | cap videos attempted per invocation |
| `attemptsBeforePark` | failed-lookup retries before parking (default 3) |
| `taskTime` | default time used by `schedule` |

Progress & history live in `state.json` (also untracked): per-video status
(`covered/pending/failed/parked/done`), chosen release, timestamps, failure reasons.

## Logging

```
logs/run-<date>.log   every fetch attempt: ✔/✖ per item, release picked, quota events,
                      end-of-run summary + failures-with-reasons block
logs/scan-<date>.log  inventory scan results
logs/task.log         raw console of scheduled runs
state.json            machine-readable ledger across days
```

## Notes on sources

- subdl zips are fetched anonymously; when their per-IP daily allowance runs out the app
  notices (`403/429` patterns) and switches providers or pauses until tomorrow.
- opensubtitles needs a free personal API key (dashboard.opensubtitles.com);
  attaching your account login raises the anonymous allowance considerably.
- A few community keyless sites are commonly ISP-blocked in some regions
  (podnapisi/gestdown/yts mirrors). Adapters exist but stay off unless reachable.

Intended for use with media you legitimately possess; respect each provider's terms.
