# Plan: Subtitle Fetcher as a self-hosted LAN service

**Status:** proposal — awaiting go-ahead
**Date:** 2026-08-28
**Author:** analysis session for kmmuntasir/subtitle-fetcher

---

## 1. Vision

> `git clone`, one install command, and Subtitle Fetcher runs as a background
> service on the media server (alongside Jellyfin :8096 and qBittorrent :8090),
> reachable from any browser on the home network. Point it at your movie and TV
> folders through the UI, and it quietly subtitles the whole library — with a
> dashboard to watch progress, inspect what it did, and hand-pick a different
> subtitle for any title you don't like.

Target user: self-hosting hobbyist (that's us). Target machine: the media server
itself (old Core-i5 Thinkcentre M93p — plenty; the workload is I/O-light and
network-bound).

### Goals

1. **Single-command install** that registers an auto-start service entry
   (systemd on Linux, Task Scheduler boot task on Windows) and starts it detached.
2. **Web UI on the LAN**: pick movie folders and TV-show folders, watch status,
   browse reports and history, read logs, trigger scans/runs.
3. **Per-title control**: browse the shows/movies already subtitled, inspect the
   chosen subtitle, **re-search alternatives and swap** in one click.
4. Keep the proven engine: providers, parsing, fake-srt detection, Subs/ pack
   awareness, quota/pacing behavior — all battle-tested against real library data.
5. Stay **zero-dependency** (Node stdlib only, vanilla-JS frontend, no build step).

### Non-goals (v1)

- No multi-user accounts, no cloud features, no built-in HTTPS (reverse-proxy if
  ever needed), no mobile app, no GPU/whisper transcription, no multi-language
  subtitle profiles (architecture allows it later; English-only today).
- No Docker image in v1 (may come later; zero-dep design makes it trivial).

---

## 2. Current state assessment (what we build on)

```
subtitles-fetcher.mjs   1432 lines, zero deps, ESM
├─ scanner         scanRoots() recursive walk, .trickplay filtering
├─ detection       findEnglishSub()/inspectSubFile() — sidecar pairing,
│                  Subs/ pack credit, fake-stub .srt content verification,
│                  Latin-ratio language sniffing  (unit-tested, 9/9)
├─ parser          guessMeta() — movie/episode, show/season/episode/year
│                  (underscore-safe, season-pack aware)
├─ hash            openSubtitlesHash() — 128 KB head/tail fingerprint
├─ providers       a7 Addic7ed (TV-primary, 302+list dual mode, paced)
│                  sd SubDL (referer'd zips, ~300/day), os OpenSubtitles
│                  (keyed), pn/gd/yts dormant adapters
├─ engine          queue loop with provider fallback, per-item attempt
│                  counters, park-after-3, quota trip-wires
├─ state           state.json ledger + sniffs cache, atomic writes
└─ CLI             scan|dry|run|status|retry|probe|setup|schedule
```

**Verdict: evolve, don't rebuild.** The hard-won value in this project is not
structure — it's *empirical knowledge baked into code*: SubDL's referer
hotlink-guard, Addic7ed's 302-vs-list duality and button markup, the
underscore `S01E01` parser trap, fake-stub `.srt` files in YTS packs, 503
cooldown behavior. A rewrite re-pays those tuition fees. The right move is to
extract the engine into modules behind clean interfaces, then grow the service
around it. Net effect for the user is the same as a rebuild: new repo layout,
new entry points, new capabilities — same proven core.

Gaps the service must add: long-running process supervision, HTTP layer, typed
roots (movies vs TV as first-class), interactive scheduler, per-item candidate
inspection, persistent activity feed, and a frontend.

---

## 3. Target architecture

```
                ┌────────────────────────────────────────────────┐
                │                 service.mjs                    │
                │  (single long-running process, detached)       │
                │                                                │
  browser ─────►│  http-server ──── static /web + JSON /api      │
  (LAN)         │       │  SSE /api/events (live activity)       │
                │       ▼                                       │
                │  scheduler ── daily trigger + catch-up on boot │
                │       ▼                                       │
                │  engine ── scan → classify → fetch loop        │
                │       │        (state machine, quotas, pacing) │
                │       ▼                                       │
                │  providers: a7 → sd → os (per-item fallback)  │
                │                                                │
                │  store ── state.json + activity log (append)   │
                └────────────────────────────────────────────────┘
                        ▲
  cli.mjs (thin) ────────┘ detects service on port → becomes remote
                          control; else runs engine in-process (today's
                          behavior, kept for headless fans)
```

### Process model

- **One process, one port.** The listening port doubles as the single-instance
  lock: a second instance fails to bind and exits with a friendly message.
- CLI stays useful: `node cli.mjs status` pings `http://127.0.0.1:PORT` and
  pretty-prints; if no service is running it falls back to reading state
  directly (read-only commands) or refuses writes with a hint.
- Graceful shutdown on SIGTERM/SIGINT: finish current item → flush state →
  close server. systemd restarts are always safe.

### Module map

```
lib/
  config.mjs        load/save/validate + v1→v2 migration (typed roots)
  store.mjs         state.json, atomic writes, activity ring buffer + append log
  scanner.mjs       roots walk (SMB-hardened), trickplay filtering
  detect.mjs        findEnglishSub / inspectSubFile / language sniffing
  parse.mjs         guessMeta + cleaners (pure functions)
  hash.mjs          opensubtitles fingerprint
  engine.mjs        run lifecycle, queue, candidate ranking, quota/pacing
  scheduler.mjs     daily trigger + missed-slot catch-up
  http-server.mjs   node:http router, static files, JSON, SSE, token auth
  logger.mjs        ring buffer + file logs (what exists today, formalized)
  providers/
    base.mjs        interface: search(ctx, meta) → [cand]; fetch(cand) → text
    addic7ed.mjs  subdl.mjs  opensubtitles.mjs   (+ dormant: podnapisi,
                                                   gestdown, yts)
web/
  index.html  app.js  style.css    vanilla SPA, dark theme, no build step
install/
  subtitle-fetcher.service.template   (systemd)
  windows-boot-task.ps1               (schtasks ONSTART helper)
service.mjs          service entry (http + scheduler + engine wiring)
cli.mjs              CLI entry (back-compat commands)
install.mjs          the "one command" installer/uninstaller
```

Extraction rule for Phase 0: behavior byte-identical — same logs, same state
format, same CLI output. `tests/` must pass untouched before anything new lands.

---

## 4. Configuration & data model

### config.json v2

```jsonc
{
  "roots": [
    { "path": "/srv/media/Videos/Movies",    "type": "movie" },
    { "path": "/srv/media/Videos/TV Series", "type": "tv"    },
    { "path": "/srv/media/Videos/Mixed",     "type": "auto"  }   // infer per item (today's logic)
  ],
  "language": "en",

  "server": {
    "port": 8097,                 // default; NOT 8090/8096 (qBittorrent/Jellyfin)
    "bind": "0.0.0.0",            // LAN-reachable
    "token": "<auto-generated>"   // auth: ?token=… or X-Auth-Token header
  },

  "schedule": { "enabled": true, "time": "13:05", "catchUpIfMissed": true },

  "providers": ["a7", "sd", "os"],
  "opensubtitles": { "apiKey": "", "username": "", "password": "" },

  "fetch": {
    "hearingImpairedOk": true,
    "aiTranslatedOk": false,
    "attemptsBeforePark": 3,
    "maxPerRun": null,
    "politenessMs": { "a7": 3200, "sd": 800, "os": 1000 }
  }
}
```

**Migration:** old flat `roots: ["\\\\nas\…"]` arrays are read as
`type:"auto"`; everything else maps 1:1. The installer/UI never breaks an
existing state.json — item keys stay the *normalized video path*, unchanged.

### state.json v2 additions

Per-item record gains **history** and **candidate provenance**:

```jsonc
"videos/movies/up (2009)/up.2009.1080p.bluray.x264.yify.mp4": {
  "status": "done",                    // covered|pending|failed|parked|done
  "rootType": "movie",
  "meta":   { "title": "Up", "year": 2009 },          // cached parse
  "current": {                          // what's on disk because of us
    "file": "…/up…mp4.en.srt",
    "provider": "sd",
    "release": "Up.2009.1080p.BluRay.x264.YIFY",
    "downloadedAt": "2026-08-28T13:07:22Z"
  },
  "history": [                          // newest first, capped at 20
    { "provider": "sd", "release": "…", "at": "…", "outcome": "kept" },
    { "provider": "sd", "release": "…", "at": "…", "outcome": "replaced" },
    { "provider": "a7", "release": "…", "at": "…", "outcome": "rejected" }
  ],
  "attempts": 1, "lastError": null
}
```

**New: `activity.jsonl`** (append-only, rotated monthly) — one line per engine
event. Powers the live "current activity" feed and historical reports without
touching the hot path:

```jsonc
{"t":"…","ev":"download","key":"…","provider":"a7","release":"…"}
{"t":"…","ev":"miss","key":"…","reason":"a7: no exact serie link"}
{"t":"…","ev":"quota","provider":"sd","detail":"403 cap"}
{"t":"…","ev":"scan","videos":18282,"pending":14007}
{"t":"…","ev":"run_start"}/{"ev":"run_end","done":271,"missed":14}
{"t":"…","ev":"replace","key":"…","from":"…","to":"…"}   // user-driven swap
```

Size sanity: 18k items × ~400 B ≈ 7 MB JSON — fine for atomic-write loads on
boot + incremental saves every 5 items (already the cadence). If UI queue
queries ever feel slow, `node:sqlite` (built-in since Node 22) is the
zero-dep escape hatch — noted, not scheduled.

---

## 5. HTTP API (all JSON under `/api`, token-authenticated)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/status` | aggregate snapshot: counters, engine state, next run, provider quota/status |
| GET | `/config` · PUT `/config` | read/write config (validated; hot-applies) |
| POST | `/scan` | trigger library scan (async; progress via events) |
| POST | `/run` `{limit?}` | start fetch pass · `POST /stop` cancels after current item |
| GET | `/queue?status=&type=&q=&page=` | paginated queue browser |
| GET | `/items/:key` | full record: meta, current sub, history |
| GET | `/items/:key/candidates` | **re-search**: ranked candidates from all providers, no download |
| POST | `/items/:key/candidates/:idx` | **download & swap** to that candidate |
| POST | `/items/:key/retry` | requeue item (attempt counter reset) |
| GET | `/library?type=tv` | covered titles grouped: show → seasons → episodes with sub status |
| GET | `/report?days=7` | per-day downloads/misses, per-provider share, top failures |
| GET | `/activity?limit=100` | recent events (from ring buffer) |
| GET | `/logs` · `/logs/:file/tail?bytes=` | list + tail log files |
| GET | `/fs/list?path=…` | server-side directory browser (for folder picker) |
| GET | `/events` | **SSE stream**: state changes, per-item progress, quota events |

Response envelope: `{"ok":true,"data":…}` / `{"ok":false,"error":"…"}`.

The candidates endpoints are the heart of the re-search feature: providers
already return ranked candidates — today the engine just picks the best and
discards the rest. The service keeps the top ~10 per request (with provider +
release + HI/forced flags + downloads count), lets the UI show them, and swaps
by index. Swapping = download new → atomic-rename `.en.srt` → old file kept
as `.en.srt.1` (one-deep backup) → history entry `outcome:"replaced"`.

---

## 6. Web UI spec (`web/`, vanilla JS, no build step)

Dark theme by default (fits the Jellyfin/qBittorrent crowd). Five tabs:

```
┌──────────────────────────────────────────────────────────────────────┐
│ ● Subtitle Fetcher      running · next run 13:05     [Scan] [Fetch] │
├───────────┬──────────────────────────────────────────────────────────┤
│ Dashboard │ Folders │ Queue │ Library │ Logs │ Settings               │
└───────────┴──────────────────────────────────────────────────────────┘
```

**Dashboard (status + current activity)**
- Stat tiles: total videos / covered / pending / failed / parked; today:
  downloaded, misses; queue rate (subs/hour).
- Provider pills: `a7 OK · sd 143 left est. · os no key` (live from engine).
- **Current activity feed** — live lines from SSE: what item is being searched
  now, which provider answered, what downloaded; quota/cooldown notices.
- Last run summary card + next scheduled run; button "Run now".

**Folders**
- Two lists: *Movie folders* and *TV-show folders* (+ optional *auto*).
- Add via **server-side browser** (`/api/fs/list`): start at filesystem root /
  drives, click down into directories, pick with ✓. Manual path entry too,
  with reachability check on blur.
- Per-root line: path, item count from last scan, reachability dot.

**Queue**
- Filterable/paged table (status, movie/TV, root, text search).
- Row actions: retry (requeue), park, probe (jumps to item detail modal:
  parsed meta, last error, history timeline).

**Library (the covered browser)**
- TV: show list → season grid → episodes with ✅ sub / ❌ none, each opening
  the item detail.
- Movies: grid with search.
- Item detail: current subtitle (provider, release, downloaded-at, size),
  history, and the **"Find alternatives"** button → candidates table
  `[choose]` per row (flags: HI, forced, AI-translated, downloads) → swap.
  This is the re-search/re-download flow the vision demands.

**Logs**
- File picker + tail view, auto-follow toggle, plain-text (colors already
  stripped in files).

**Settings**
- Server: port, bind, token (regenerate).
- Schedule: enable, time, catch-up toggle.
- Providers: ordered list (up/down), OpenSubtitles credentials, politeness ms,
  attemptsBeforePark, maxPerRun.
- About: version, uptime, links to docs.

Frontend notes: hash routing for tabs, `fetch` + `EventSource`, localStorage
token, ~600–800 lines total across three files. No framework — a dashboard of
this size doesn't earn one, and zero-build keeps `git pull` = deploy.

---

## 7. Service & installation

### Linux (the M93p if it ran Linux) — systemd

`install.mjs` writes `/etc/systemd/system/subtitle-fetcher.service`:

```ini
[Unit]
Description=Subtitle Fetcher
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/subtitle-fetcher          # the git clone
ExecStart=/usr/bin/node service.mjs
Restart=on-failure
RestartSec=10
User=media                                       # must have rw on media dirs

[Install]
WantedBy=multi-user.target
```

`systemctl daemon-reload && systemctl enable --now subtitle-fetcher`.
Installer re-execs itself under `sudo` only for the privileged step.
Update path: `git pull && systemctl restart subtitle-fetcher`.

### Windows (the M93p as-is) — boot scheduled task, zero extra tools

```
schtasks /Create /F /SC ONSTART /DELAY 0001:00 /TN "SubtitleFetcherService"
        /TR "'C:\Program Files\nodejs\node.exe' 'D:\subtitle-fetcher\service.mjs'"
        /RU <chosen user> /RL HIGHEST   (+ StartWhenAvailable via powershell)
```

- Runs detached as a chosen user (prompted by installer) so it can write to
  local media folders; SYSTEM also offered if media is local.
- Boot delay avoids racing NIC/SMB startup (the NAS-mount lesson).
- Alternative documented (not default): NSSM for a *true* Windows service.
- Stop/start via `schtasks /Run /End` — also exposed as `cli.mjs` shortcuts.

### install.mjs — the "single command" UX

```
$ git clone https://github.com/kmmuntasir/subtitle-fetcher.git
$ cd subtitle-fetcher
$ node install.mjs

  Subtitle Fetcher installer
  ✔ Node v24.15.0 (≥20 required)
  ✔ OS: linux · ports 8097 free
  Port        [8097]:
  Auth token  [auto-generated: 9f3a…]
  Run as user [media]:
  Add folders now, or later in the web UI? [later]
  ✔ wrote config.json
  ✔ installed systemd unit, enabled + started
  ✔ service healthy (http://127.0.0.1:8097/api/status)

  Open on your LAN:
     http://192.168.0.102:8097/?token=9f3a…
  Uninstall: node install.mjs --uninstall
```

Flags for unattended installs: `--port --token --user --folders a,b
--yes`. `install.cmd` / `install.sh` remain as thin wrappers for
double-click convenience.

---

## 8. Engine & scheduler design (service internals)

**Run lifecycle state machine**

```
idle ──scan──► scanning ──► fetching ──► idle
                  │            │
                  │            ├──► cooldown (quota tripped; exits at reset
                  │            │      time or when other providers exhausted)
                  ▼            ▼
                failed(kept)  paused (user) ──resume──► fetching
```

- One worker per provider (a7 must stay serialized by its global pacing anyway);
  per-provider politeness gaps, exactly today's values as defaults.
- Quota handling: OS reads real `remaining` from API; SubDL cap is *estimated*
  (count per UTC-day, corrected when a 403 arrives); Addic7ed gets cooldown
  state after 429/503. All surfaced to `/status`.
- Catch-up semantics identical to the schtasks `StartWhenAvailable` fix: if the
  scheduled slot was missed while powered off, run once on next boot.
- **Cancellation** checks between items; state saves every ≤5 items (existing
  cadence) and at every transition — a killed service never loses more than a
  few seconds of bookkeeping.

**Scanner cadence:** full walk when inventory >20 h old (unchanged), plus
per-root mtime spot-check before targeted rescans when cheap. Local disks make
the 35-minute SMB walk a ~2–4-minute walk, which changes the UX entirely —
"Scan" can be a dashboard button.

---

## 9. Security model

- Bind `0.0.0.0` by default (LAN reachability is the point) **with a mandatory
  token**: generated at install, passed as `?token=` (the installer prints the
  ready-to-bookmark URL) or `X-Auth-Token`; the UI stores it in localStorage.
  UI is unusable without it; API returns 401 on mismatch.
- CSRF-safe by construction (custom header / token, no cookies).
- Read-heavy endpoints (status, SSE) also token-gated — same token, no
  distinction; this is a single-operator tool.
- Config PUT with credentials requires the token *and* re-auth if token itself
  is being changed (prevent lockout: old token stays valid for the open session).
- Documented hardening: reverse proxy for HTTPS, `bind:127.0.0.1` + SSH tunnel
  for the paranoid. No plaintext credentials in logs — logger redacts
  `password`/`token` keys.

---

## 10. Implementation phases

Each phase lands working software; each ends with a pushed tag.

**Phase 0 — extraction (no behavior change).** Split monolith into `lib/`,
add `cli.mjs` wrapper, keep every command's output identical. Parser and
detection get the table-driven tests they deserve (real-path fixtures).
*Accept:* `tests/` green; side-by-side `dry` output identical before/after.

**Phase 1 — service core.** `service.mjs`: http-server + store v2 (activity
log, item history) + scheduler + engine-in-process + SSE. Installer for
systemd + Windows task. Dashboard + Logs tabs work; config via file still.
*Accept:* installed on the M93p via the one command; survives reboot; a full
daily run happens inside the service; activity feed shows it live.

**Phase 2 — the UI grows up.** Folders tab (server-side browser), Queue tab,
Settings tab; `/api/queue`, `/fs/list`, config PUT with hot-apply.
*Accept:* library fully configurable from a fresh browser on another LAN
machine; retry/park from UI.

**Phase 3 — library browser & re-search.** `/library`, `/items/:key`,
candidates endpoints, Library tab with swap flow + `.en.srt.1` backup,
history timeline. *Accept:* pick any covered movie, list 5+ alternatives
from ≥2 providers, swap, verify file replacement + history entry + Jellyfin
picks up the new track.

**Phase 4 — reports & polish.** `/report` (per-day chart, provider share,
top failures), quota-aware scheduling hints, README overhaul with screenshots,
`node:sqlite` evaluation note, optional Dockerfile.

Rough effort: P0 1 evening · P1 2–3 · P2 2 · P3 2 · P4 1–2. (Analysis-time
estimates; the engine already exists, which is most of the risk retired.)

---

## 11. Risks & mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Scraper markup drift (a7/sd) | provider dies quietly | provider health in `/status` + UI pills; recorded-HTML fixtures in tests; failures park items, never corrupt state |
| Windows task-as-service quirks | service not running after boot | installer verifies with health-check + retry; NSSM documented path; `cli.mjs doctor` |
| Token in URL bookmarks | leaked via shoulder-surf | acceptable LAN trade-off; localStorage after first load; regenerate button |
| state.json growth with history | slow loads | cap history at 20/item; activity.jsonl rotates; sqlite escape hatch |
| Two instances (desktop + server) | duplicate quota burn, racing writes | port-as-lock + CLI detects service; migration runbook step: disable desktop task first |
| Auth lockout after token change | user locked out | old token valid for current session; token change requires confirmation modal |

## 12. Migration for existing installs (and for this specific desktop→M93p move)

1. On desktop: let the current detached run finish (it's burning today's SubDL
   quota productively), then `node cli.mjs schedule --remove`.
2. On server: `git clone` (or copy `\\nas\circus\subtitle-fetcher`), `node
   install.mjs`, pick folders via UI browser, `Scan` — local disk makes it fast.
3. Copy `state.json` from desktop if you want the history/park-state to carry
   over (optional; a fresh scan re-derives coverage from disk since every
   downloaded `.en.srt` is already sitting beside its video — by design).
4. Keep the desktop clone as a CLI fallback for debugging (`cli.mjs` works
   read-only against the service).

---

## 13. Future ideas (explicitly out of scope for v1)

Multi-language profiles per show · whisper.cpp local transcription fallback ·
notification webhooks (Telegram/Discord) on run summaries · subtitle rating
learned from swaps · readarr-style "wanted" list for missing titles.
