#!/usr/bin/env node
// Service entry point: web UI + scheduler + engine in one detached process.
//   node service.mjs [--port N] [--token T]
// Install as a boot service with:  node install.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, saveConfig, normalizeRoots } from "./lib/config.mjs";
import { loadState, saveState, summary, initActivity, pushActivity, getActivity } from "./lib/store.mjs";
import { openLog, closeLog, setLogHook, GRN, YEL, DIM } from "./lib/logger.mjs";
import { refreshInventory, refreshInventoryAsync } from "./lib/scanner.mjs";
import { guessMeta } from "./lib/parse.mjs";
import { openSubtitlesHash } from "./lib/hash.mjs";
import { runFetch } from "./lib/engine.mjs";
import { buildProviders } from "./lib/providers/index.mjs";
import { WebServer, newToken } from "./lib/webserver.mjs";
import { reconstructPath, norm } from "./lib/utils.mjs";

const SCRIPT_DIR = path.dirname(path.resolve(fileURLToPath(import.meta.url)));
const CONFIG_PATH = path.join(SCRIPT_DIR, "config.json");
const STATE_PATH = path.join(SCRIPT_DIR, "state.json");
const LOG_DIR = path.join(SCRIPT_DIR, "logs");

// ---- arg overrides --------------------------------------------------------
const argv = process.argv.slice(2);
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };

// ---- core objects ----------------------------------------------------------
let cfg = loadConfig(CONFIG_PATH);
delete cfg.server.tokenPrev;                       // grace token only lives for one session
if (argOf("--port")) { cfg.server.port = +argOf("--port"); }
if (argOf("--token")) { cfg.server.token = argOf("--token"); }

let state = loadState(STATE_PATH);
const persist = () => saveState(STATE_PATH, state);
const persistCfg = () => saveConfig(CONFIG_PATH, cfg);

initActivity(LOG_DIR);
openLog(LOG_DIR, "service");
setLogHook((_msg, plain) => pushActivity({ ev: "log", line: plain.slice(0, 200) }));

// ---- engine control ---------------------------------------------------------
const prioritySet = new Set();       // keys the user wants fetched next
let miniRunning = false;             // scoped single-item fetch (runs alongside scans)

// every engine event also carries a (throttled) status snapshot over SSE so
// the dashboard's count cards update in real time without polling
let lastStatusBroadcast = 0;
function broadcastStatus(force = false) {
  const now = Date.now();
  if (!force && now - lastStatusBroadcast < 2000) return;
  lastStatusBroadcast = now;
  Promise.resolve(api.status()).then(st => web.broadcast({ ev: "status", data: st })).catch(() => {});
}
function pushEvent(e) {
  pushActivity(e);
  web.broadcast(e);
  broadcastStatus();
}

const engine = {
  running: false, stopRequested: false,
  lastResult: null, startedAt: null, phase: "idle",        // idle|scanning|fetching
  current: null,                                            // item being worked
  lastRunDate: state.lastRunDate ?? null,

  /** user clicked "fetch now" on a specific item — enqueue and return at once;
   *  a background drain loop does the actual fetching so multi-hundred-item
   *  requests (whole-show "Fetch Missing") survive the browser walking away. */
  async priorityRequest(key) {
    const k = key.toLowerCase();
    const rec = state.files[k];
    if (rec && (rec.status === "done" || rec.status === "covered"))
      return { queued: false, note: "Already has an English subtitle — use “Find alternatives” to swap it." };
    if (rec) { rec.status = "pending"; rec.attempts = 0; delete rec.a7miss; persist(); }

    if (this.phase === "fetching") { prioritySet.add(k); return { queued: true, mode: "next-in-run" }; }
    prioritySet.add(k);
    this.drainPriority();
    return { queued: true, mode: "immediate" };
  },

  /** keeps a scoped runner alive while the priority set is non-empty */
  drainPriority() {
    if (miniRunning) return;
    miniRunning = true;
    (async () => {
      try {
        while (prioritySet.size > 0 && this.phase !== "fetching") {
          const k = [...prioritySet][0];
          prioritySet.delete(k);
          pushActivity({ ev: "priority", key: k });
          await runFetch(cfg, state, {
            onlySub: k, saveState: persist, skipRescan: true,
            onEvent: (e) => pushEvent(e),
          });
        }
      } catch (err) {
        pushActivity({ ev: "error", message: String(err?.message ?? err) });
      } finally { miniRunning = false; }
    })();
  },

  async startScan() {
    if (this.running) throw new Error("engine busy");
    this.running = true; this.phase = "scanning"; this.stopRequested = false;
    pushEvent({ ev: "scan_start" });
    // yield so the HTTP response for POST /scan goes out before the heavy walk
    await new Promise(r => setTimeout(r, 30));
    try {
      // stream the walk into the feed (throttled — a full pass touches
      // thousands of directories and would flood it otherwise)
      let lastWalkEmit = 0;
      const emitWalk = (label, samplePath) => {
        this.current = { label };
        const now = Date.now();
        if (now - lastWalkEmit < 2500) return;
        lastWalkEmit = now;
        pushEvent({ ev: "scan_walk", path: samplePath });
      };
      const r = await refreshInventoryAsync(cfg, state, {
        onWalk: (dir, files) => emitWalk(`walking · ${files} videos found`, dir),
        onProgress: (n, total, sample) => {
          emitWalk(`scanning ${n}/${total}`, sample);
          if (n % 3000 === 0) pushEvent({ ev: "scan_progress", n, total });
        },
      });
      persist();
      const s = summary(state);
      pushEvent({ ev: "scan", ...s, total: r.total, errors: r.errors ?? 0 });
    } catch (e) {
      console.error("[scan] failed:", e.message);
      pushEvent({ ev: "error", message: `scan failed: ${e.message}` });
    } finally {
      this.running = false; this.phase = "idle"; this.current = null;
    }
  },
  async startRun(limit = null, only = "", runOpts = {}) {
    if (this.running || miniRunning) throw new Error("engine busy");
    this.running = true; this.phase = "fetching"; this.stopRequested = false;
    this.startedAt = Date.now();
    openLog(LOG_DIR, "run");
    try {
      const result = await runFetch(cfg, state, {
        limit, onlySub: only,
        ...runOpts,
        saveState: persist,
        shouldStop: () => this.stopRequested,
        takePriority: () => { const ks = [...prioritySet]; prioritySet.clear(); return ks; },
        onEvent: (e) => {
          if (e.ev === "item_start") this.current = { key: e.key, label: e.label };
          if (e.ev === "run_end" || e.ev === "quota") this.current = null;
          pushEvent(e);
        },
      });
      this.lastResult = { ...result, at: new Date().toISOString() };
      state.lastRunDate = new Date().toISOString().slice(0, 10);
      persist();
      return result;
    } finally {
      this.running = false; this.phase = "idle"; this.current = null;
      closeLog();
    }
  },
  stop() { if (this.running) this.stopRequested = true; },
};

// ---- API implementation ------------------------------------------------------
/** human display name for a queue row: cached meta when present, otherwise a
 *  full parse of the reconstructed path — never the lowercased key itself */
function queueLabel(k, r) {
  const meta = r.meta ?? metaFromKey(k);
  if (meta?.kind === "episode" && meta.show && meta.show !== "$1") {
    return `${prettyTitle(meta.show)} · S${String(meta.season).padStart(2, "0")}E${String(meta.episode).padStart(2, "0")}`;
  }
  const title = prettyTitle(meta?.title || decodeURIComponent(k.split("/").pop().replace(/\.[^.]+$/, "")));
  return meta?.year ? `${title} (${meta.year})` : title;
}

const api = {
  async status() {
    const s = summary(state);
    const provs = buildProviders(cfg, state).map(p => ({
      id: p.id, enabled: true,
      quotaLeft: typeof p.quotaLeft === "number" ? p.quotaLeft : null,
    }));
    // per-root progress for the folders tab
    const perRoot = normalizeRoots(cfg).map(r => {
      const prefix = r.path.toLowerCase();
      let total = 0, pending = 0, done = 0;
      for (const [k, rec] of Object.entries(state.files)) {
        if (!k.startsWith(prefix)) continue;
        total++;
        if (rec.status === "done" || rec.status === "covered") done++;
        else if (rec.status === "pending" || rec.status === "failed") pending++;
      }
      return { path: r.path, type: r.type, reachable: fs.existsSync(r.path), total, pending, done };
    });
    return {
      totals: s,
      perRoot,
      lan: lanInfo(),
      engine: {
        running: engine.running, phase: engine.phase, current: engine.current,
        lastResult: engine.lastResult,
        nextRun: cfg.schedule?.enabled ? nextRunDescription() : null,
      },
      providers: provs,
      sdDownloadsToday: state.sdDay === new Date().toISOString().slice(0, 10) ? state.sdCount ?? 0 : 0,
      scannedAt: state.scannedAt ? new Date(state.scannedAt).toISOString() : null,
      uptimeS: Math.round(process.uptime()),
      version: "2.0.0",
    };
  },

  activity: (limit) => getActivity(limit),

  async scan() { await engine.startScan(); },

  async run(limit, only) { await engine.startRun(limit, only); },

  stop() { engine.stop(); },

  queue(sp) {
    const status = sp.get("status") ?? "";
    const type = sp.get("type") ?? "";
    const q = (sp.get("q") ?? "").toLowerCase();
    const page = Math.max(1, +sp.get("page") || 1);
    const per = Math.min(200, +sp.get("per") || 50);
    let rows = Object.entries(state.files);
    if (status) rows = rows.filter(([, r]) => r.status === status);
    if (type) rows = rows.filter(([, r]) => (r.meta?.kind ?? "") === type || (r.rootType ?? "") === type);
    if (q) rows = rows.filter(([k]) => k.includes(q));
    rows.sort((a, b) => (a[1].status === "pending" ? 0 : 1) - (b[1].status === "pending" ? 0 : 1) || a[0].localeCompare(b[0]));
    const total = rows.length;
    rows = rows.slice((page - 1) * per, page * per);
    return {
      total, page, per,
      items: rows.map(([k, r]) => ({ key: k, name: queueLabel(k, r), ...pick(r, ["status", "attempts", "lastError", "provider", "rel", "when", "meta", "rootType"]) })),
    };
  },

  item(key) {
    const rec = state.files[key.toLowerCase()];
    if (!rec) throw new Error("unknown item");
    return { key: key.toLowerCase(), ...rec, videoPath: reconstructPath(key.toLowerCase(), rootPathsOf()) };
  },

  async candidates(key) {
    const rec = mustItem(key);
    const vPath = reconstructPath(rec.key, rootPathsOf());
    const meta = guessMeta(vPath);
    const ctx = { hash: await safeHash(vPath) };
    const provs = buildProviders(cfg, state);
    const out = [];
    for (const prov of provs) {
      try {
        const cands = await prov.search(ctx, meta);
        for (const [i, c] of cands.entries()) {
          out.push({
            provider: prov.id, idx: out.length,
            release: c.pickedRelease ?? c.rel ?? c.team ?? (c.fid ? `#${c.fid}` : c.id ?? c.zip ?? `#${i}`),
            hi: !!c.hi, ai: !!c.ai, score: c.score ?? 0, raw: c,
          });
        }
      } catch (e) {
        out.push({ provider: prov.id, error: e.message.slice(0, 140) });
      }
    }
    return { key: rec.key, meta, candidates: out };
  },

  async swapCandidate(key, idx) {
    const listing = await this.candidates(key);
    const cand = listing.candidates.filter(c => !c.error)[idx];
    if (!cand) throw new Error("candidate index out of range");
    const prov = buildProviders(cfg, state).find(p => p.id === cand.provider);
    if (!prov) throw new Error("provider unavailable");
    const raw = cand.raw;
    raw.meta = listing.meta;
    raw.videoBase = path.basename(reconstructPath(listing.key, rootPathsOf()));
    const text = await prov.fetchCandidate({}, raw);

    const vPath = reconstructPath(listing.key, rootPathsOf());
    const dest = `${vPath.replace(/\.[^.]+$/, "")}.en.srt`;
    const prev = fs.existsSync(dest) ? `${dest}.1` : null;
    if (prev) fs.renameSync(dest, prev);            // one-deep backup
    fs.writeFileSync(dest, "﻿" + text);

    const rec = state.files[listing.key] ?? {};
    rec.history = [
      ...(rec.history ?? []),
      { provider: rec.provider, release: rec.rel, at: rec.when, outcome: prev ? "replaced" : "kept" },
    ].slice(-20);
    rec.status = "done"; rec.provider = cand.provider; rec.rel = String(raw.pickedRelease ?? cand.release).slice(0, 80);
    rec.when = new Date().toISOString();
    state.files[listing.key] = rec;
    persist();
    pushEvent({ ev: "replace", key: listing.key, provider: cand.provider, release: rec.rel });
    return { swapped: true, file: dest, backup: prev, release: rec.rel };
  },

  retryItem(key) {
    const k = key.toLowerCase();
    const rec = state.files[k];
    if (!rec) throw new Error("unknown item");
    rec.status = "pending"; rec.attempts = 0;
    persist();
    return { requeued: true };
  },

  async priorityItem(key) {
    return engine.priorityRequest(key.toLowerCase());
  },

  /** resolve poster/backdrop/logo art: local Jellyfin files (episode dir →
   *  show dir → grandparent) first; OMDB fallback SAVES the poster into the
   *  item/show folder so Jellyfin benefits too. */
  async img(sp) {
    const key = sp.get("key");
    if (!key) return {};
    const k = key.toLowerCase();
    const rec = state.files[k];
    const kind = rec?.meta?.kind === "episode" ? "tv"
               : rec?.rootType === "tv" ? "tv"
               : sp.get("kind") === "tv" ? "tv" : "movie";
    const type = sp.get("type") === "backdrop" ? "backdrop"
               : sp.get("type") === "logo" ? "logo" : "poster";

    const vPath = reconstructPath(k, rootPathsOf());
    const dir = path.dirname(vPath);
    const parent = path.dirname(dir);

    // candidate directories, nearest first; for TV go up to the show folder
    const dirs = kind === "tv" ? [dir, parent, path.dirname(parent)] : [dir];

    // poster requests may fall back to a backdrop/fanart — user prefers
    // "either one" over nothing. Any image container (.jpg/.png/.webp).
    const IMG_EXTS = [".jpg", ".jpeg", ".png", ".webp"];
    const wantFor = {
      poster:   ["poster", "folder", "cover", "default", "backdrop", "fanart"],
      backdrop: ["backdrop", "fanart", "poster", "folder"],
      logo:     ["logo", "clearlogo"],
    }[type];

    const scanForArt = (d, stems) => {
      let files;
      try { files = fs.readdirSync(d); } catch { return null; }
      const lower = files.map(f => f.toLowerCase());
      for (const stem of stems)
        for (const ext of IMG_EXTS) {
          const i = lower.indexOf(stem + ext);
          if (i >= 0 && fs.statSync(path.join(d, files[i])).size < 25e6)
            return path.join(d, files[i]);
        }
      return null;
    };

    for (const d of dirs) {
      const art = scanForArt(d, wantFor);
      if (art) return { file: art };
    }

    // ---- nothing local: fetch from OMDB and PERSIST into the library ----
    const omdbKey = cfg.images?.omdbApiKey;
    if (!omdbKey || type === "logo") return {};
    const meta = rec?.meta ?? metaFromKey(k);
    const title = meta?.show ?? meta?.title;
    if (!title) return {};
    const q = `${title.toLowerCase()}|${meta.year ?? ""}|${meta.kind}`;
    omdbCache ??= loadOmdbCache();
    if (!(q in omdbCache)) {
      try {
        const u = `https://www.omdbapi.com/?apikey=${omdbKey}&t=${encodeURIComponent(title)}${meta.year ? `&y=${meta.year}` : ""}`;
        const res = await fetch(u, { signal: AbortSignal.timeout(8000) });
        const j = await res.json();
        omdbCache[q] = j?.Poster && j.Poster !== "N/A" ? j.Poster : "";
      } catch { omdbCache[q] = ""; }
      saveOmdbCacheDebounced();
    }
    const posterUrl = omdbCache[q];
    if (!posterUrl) return {};

    // save target: show folder for TV (parent of episode dir), movie folder for movies
    const saveDir = kind === "tv" && fs.existsSync(parent) && parent.length > vPath.indexOf("/media/") ? parent : dir;
    const dest = path.join(saveDir, type === "backdrop" ? "backdrop.jpg" : "poster.jpg");
    if (!fs.existsSync(dest)) {
      try {
        const r = await fetch(posterUrl, { signal: AbortSignal.timeout(15000) });
        const buf = Buffer.from(await r.arrayBuffer());
        const isImg = buf.length > 1024 &&
          ((buf[0] === 0xff && buf[1] === 0xd8) || (buf[0] === 0x89 && buf[1] === 0x50));   // JPEG / PNG magic
        if (isImg) { fs.mkdirSync(saveDir, { recursive: true }); fs.writeFileSync(dest, buf); pushActivity({ ev: "art_saved", key: k, file: dest }); }
        else {
          delete omdbCache[q];             // dead/expired hotlink — stop serving it
          saveOmdbCacheDebounced();
          return {};
        }
      } catch { /* fall through to redirect */ }
    }
    if (fs.existsSync(dest)) return { file: dest };
    return { redirect: posterUrl };     // last resort: hot-link so the UI still shows art
  },

  parkItem(key) {
    const k = key.toLowerCase();
    const rec = state.files[k];
    if (!rec) throw new Error("unknown item");
    rec.status = rec.status === "parked" ? "pending" : "parked";
    rec.attempts = rec.status === "pending" ? 0 : rec.attempts;
    persist();
    pushEvent({ ev: "park", key: k, status: rec.status });
    return { status: rec.status };
  },

  library(sp) {
    const type = sp.get("type") ?? "tv";
    const shows = new Map();
    const movies = [];

    // raw folder segment from the (original-case) path — display fallback
    // that needs no scan: carries the year stamp and true show name
    const showInfoFromKey = (k) => {
      const segs = k.split("/").filter(Boolean);
      const tvIdx = segs.findIndex(s => /^tv[\s._-]*series$/i.test(s));
      const seg = tvIdx >= 0 ? segs[tvIdx + 1] : segs[segs.length - 2] ?? "";
      const ym = /\((\d{4})(?:\s*[-–—]\s*(\d{4}))?\)/.exec(seg);
      let name = seg.replace(/\((?:19|20)\d{2}(?:\s*[-–—]\s*(?:19|20)\d{2})?\)/g, "")
                    .replace(/\bseason[s]?\b.*$|\bs\d{1,2}\b.*$/i, "")
                    .replace(/[._]/g, " ").replace(/\s+/g, " ").trim();
      if (/^(?:complete|full|series|all)$/i.test(name)) name = "";
      return { name: name ? prettyTitle(name) : "", from: ym ? +ym[1] : null, to: ym ? +(ym[2] ?? ym[1]) : null };
    };

    for (const [k, r] of Object.entries(state.files)) {
      const meta = r.meta ?? metaFromKey(k);
      if (meta.kind === "episode") {
        const raw = showInfoFromKey(k);
        const showName = (meta.show && meta.show !== "$1" ? prettyTitle(meta.show) : "") || raw.name || "(unknown)";
        const sh = shows.get(showName) ?? { show: showName, seasons: new Map(), total: 0, covered: 0, from: null, to: null };
        const season = sh.seasons.get(meta.season) ?? [];
        season.push({ key: k, episode: meta.episode, status: r.status, rel: r.rel ?? null });
        sh.seasons.set(meta.season, season);
        sh.total++; if (r.status === "done" || r.status === "covered") sh.covered++;
        const from = meta.from ?? raw.from, to = meta.to ?? raw.to;
        if (from) { sh.from = Math.min(sh.from ?? from, from); sh.to = Math.max(sh.to ?? to, to); }
        shows.set(showName, sh);
      } else {
        const title = prettyTitle(meta.title || k.split("/").pop().replace(/\.[^.]+$/, ""));
        const label = meta.year ? `${title} (${meta.year})` : title;
        movies.push({ key: k, title, label, year: meta.year ?? null, status: r.status, rel: r.rel ?? null });
      }
    }
    if (type === "movie") return { movies: movies.sort((a, b) => (a.title ?? "").localeCompare(b.title ?? "")) };
    const tv = [...shows.values()].map(sh => {
      const yr = sh.from ? (sh.to && sh.to !== sh.from ? `${sh.from} - ${sh.to}` : `${sh.from}`) : null;
      return {
        show: sh.show, label: yr ? `${sh.show} (${yr})` : sh.show, years: yr,
        total: sh.total, covered: sh.covered,
        seasons: [...sh.seasons.entries()].map(([s, eps]) => ({ season: s, episodes: eps.sort((a, b) => a.episode - b.episode) }))
          .sort((a, b) => a.season - b.season),
      };
    }).sort((a, b) => a.show.localeCompare(b.show));
    return { tv };
  },

  report(days) {
    const perDay = new Map();
    const byProvider = new Map();
    let events = 0, missed = 0, failed = 0;
    try {
      const lines = fs.readFileSync(path.join(LOG_DIR, "activity.jsonl"), "utf8").split("\n").filter(Boolean);
      const cutoff = Date.now() - days * 86400e3;
      for (const l of lines) {
        let e; try { e = JSON.parse(l); } catch { continue; }
        if (!e.t || Date.parse(e.t) < cutoff) continue;
        events++;
        if (e.ev === "download") {
          const d = e.t.slice(0, 10);
          perDay.set(d, (perDay.get(d) ?? 0) + 1);
          byProvider.set(e.provider, (byProvider.get(e.provider) ?? 0) + 1);
        }
        if (e.ev === "miss") missed++;
      }
    } catch { /* no activity yet */ }
    failed = Object.values(state.files).filter(r => r.status === "failed").length;
    return {
      days, events, missed, failed,
      downloadsPerDay: [...perDay.entries()].sort(),
      byProvider: [...byProvider.entries()].sort((a, b) => b[1] - a[1]),
      totals: summary(state),
    };
  },

  logs() {
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => /\.(log|out|err|jsonl)$/i.test(f))
      .map(f => {
        let size = 0, mtime = 0;
        try { const st = fs.statSync(path.join(LOG_DIR, f)); size = st.size; mtime = st.mtimeMs; } catch {}
        return { file: f, size, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return files;
  },

  tailLog(file, bytes) {
    const abs = path.join(LOG_DIR, path.basename(file));           // no traversal
    if (!fs.existsSync(abs)) throw new Error("no such log");
    const size = fs.statSync(abs).size;
    const start = Math.max(0, size - bytes);
    const fd = fs.openSync(abs, "r");
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return { file, size, text: buf.toString("utf8") };
  },

  fsList(dir) {
    const winDrives = () => {
      const drives = [];
      for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
        const d = `${letter}:\\`;
        try { if (fs.existsSync(d)) drives.push(d); } catch {}
      }
      return drives;
    };
    if (!dir) {
      const roots = normalizeRoots(cfg);
      const drives = process.platform === "win32" ? winDrives() : [];
      return { path: "", parent: null, roots, dirs: drives.length ? drives : roots.map(r => r.path), drives };
    }
    let p = norm(dir);
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error("not a directory");
    if (!p.endsWith("/") && !p.endsWith("\\")) p += "/";
    const parent = path.dirname(p) === p ? null : path.dirname(p) + path.sep;
    const out = { path: p, parent, dirs: [], roots: normalizeRoots(cfg) };
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".")) out.dirs.push(p + e.name + path.sep);
      if (out.dirs.length > 400) break;
    }
    return out;
  },

  configPut(body) {
    // merge whitelisted sections only
    const wl = (dst, src, keys) => { for (const k of keys) if (src && k in src) dst[k] = src[k]; };
    wl(cfg, body, ["language", "providers", "maxPerRun", "hearingImpairedOk", "aiTranslatedOk", "attemptsBeforePark", "roots"]);
    if (body.images) cfg.images = { ...(cfg.images ?? {}), omdbApiKey: body.images.omdbApiKey ?? cfg.images?.omdbApiKey ?? "" };
    if (body.schedule) cfg.schedule = { ...cfg.schedule, ...body.schedule };
    if (body.server) {
      const oldToken = cfg.server.token;
      cfg.server = { ...cfg.server, ...body.server };
      if (body.server.token && body.server.token !== oldToken) cfg.server.tokenPrev = oldToken;  // old stays valid this session
    }
    if (body.opensubtitles) {
      cfg.apiKey = body.opensubtitles.apiKey ?? cfg.apiKey;
      cfg.username = body.opensubtitles.username ?? cfg.username;
      if (body.opensubtitles.password && body.opensubtitles.password !== "•••") cfg.password = body.opensubtitles.password;
    }
    persistCfg();
    pushEvent({ ev: "config", detail: "updated via UI" });
    return { saved: true };
  },
};

// ---- helpers -----------------------------------------------------------------

function rootPathsOf() { return (cfg.roots ?? []).map(r => typeof r === "string" ? r : r.path); }
function mustItem(key) {
  const k = key.toLowerCase();
  const rec = state.files[k];
  if (!rec) throw new Error("unknown item");
  return { key: k, ...rec };
}
function metaFromKey(k) {
  try { return guessMeta(reconstructPath(k, rootPathsOf())); }
  catch { return { kind: "movie", title: prettyTitle(k.split("/").pop().replace(/\.[^.]+$/, "")) }; }
}
function prettyTitle(s) {
  s = String(s ?? "").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  const num = /^(\d{1,4})[\s._-]+(\S.*)$/.exec(s);
  if (num && (/^0/.test(num[1]) || num[2].trim().split(/\s+/).length >= 2)) s = num[2];
  return s.split(" ").map((w, i) =>
    w.replace(/^([^a-zA-Z]*)([a-zA-Z])(.*)$/, (_, p, c, r) => p + c.toUpperCase() + r)).join(" ");
}
async function safeHash(p) { try { return await openSubtitlesHash(p); } catch { return null; } }
function pick(o, keys) { const out = {}; for (const k of keys) if (o[k] !== undefined) out[k] = o[k]; return out; }

function nextRunDescription() {
  const [hh, mm] = (cfg.schedule?.time ?? "13:05").split(":").map(Number);
  const now = new Date();
  const next = new Date(now); next.setHours(hh, mm, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

function lanInfo() {
  let ip = "127.0.0.1";
  try {
    for (const list of Object.values(os.networkInterfaces()))
      for (const n of list ?? [])
        if (n.family === "IPv4" && !n.internal) { ip = n.address; break; }
  } catch {}
  return { url: `http://${ip}:${cfg.server.port}`, ip, port: cfg.server.port, token: cfg.server.token };
}

// ---- omdb poster cache ---------------------------------------------------------
let omdbCache = null;
let omdbSaveTimer = null;
function loadOmdbCache() {
  try { return JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, "cache", "omdb.json"), "utf8")); }
  catch { return {}; }
}
function saveOmdbCacheDebounced() {
  clearTimeout(omdbSaveTimer);
  omdbSaveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.join(SCRIPT_DIR, "cache"), { recursive: true });
      fs.writeFileSync(path.join(SCRIPT_DIR, "cache", "omdb.json"), JSON.stringify(omdbCache));
    } catch {}
  }, 3000);
  omdbSaveTimer.unref?.();
}

// ---- scheduler loop ------------------------------------------------------------
let lastScheduledDay = state.lastRunDate ?? null;
let lastTvRunEnd = 0;          // when the last tv247 run finished (or was reserved)
let lastTvRunDone = 0;         // downloads it achieved — drives the backoff below
let lastTvRunStopped = false;  // ended by the catastrophic breaker
setInterval(async () => {
  broadcastStatus(true);   // keep dashboard tiles fresh even in quiet periods
  if (!cfg.schedule?.enabled || engine.running || miniRunning || prioritySet.size > 0) return;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const [hh, mm] = (cfg.schedule?.time ?? "13:05").split(":").map(Number);
  const due = now.getHours() > hh || (now.getHours() === hh && now.getMinutes() >= mm);

  // ---- daily full run (all providers; movies ride SubDL's daily quota) ----
  if (due && lastScheduledDay !== today) {
    lastScheduledDay = today;
    console.log(`[scheduler] daily run starting (${cfg.schedule.time})`);
    try { await engine.startRun(); } catch (e) { console.error("[scheduler]", e.message); }
    return;
  }

  // ---- tv247: keep addic7ed chewing TV around the clock --------------------
  // a7 is uncapped but human-paced; sd stays out of these runs so its daily
  // quota is reserved for the movies at the scheduled slot. When a cycle
  // downloads nothing we back off 3 h — provider misses must not hot-cycle
  // into parking.
  if (cfg.schedule?.tv247 === false) return;

  // a stale inventory gets scanned first — tv247 runs skip rescanning by design
  if (!state.scannedAt || Date.now() - state.scannedAt > 20 * 3600e3) {
    console.log("[scheduler] inventory stale — scanning before tv247 cycle");
    try { await engine.startScan(); } catch (e) { console.error("[scheduler] scan:", e.message); }
    return;
  }
  // productive run → chain in 30 s; breaker-tripped run → it made progress
  // (skipped items are marked), continue in 2 min; nothing left to do → 3 h
  const idleFor = Date.now() - lastTvRunEnd;
  if (idleFor < (lastTvRunDone > 0 ? 30e3 : lastTvRunStopped ? 2 * 60e3 : 3 * 3600e3)) return;
  lastTvRunEnd = Date.now();
  console.log("[scheduler] tv247: starting addic7ed-only TV run");
  try {
    const r = await engine.startRun(null, "/tv series/", { skipRescan: true, providers: ["a7"], skipA7MissedToday: true });
    lastTvRunDone = r?.done ?? 0;
    lastTvRunStopped = !!r?.stopped;
  } catch (e) {
    console.error("[scheduler] tv247:", e.message);
    lastTvRunDone = 0;
    lastTvRunStopped = false;
  }
  void mm;
}, 30000).unref();

// ---- boot ---------------------------------------------------------------------
const web = new WebServer({
  port: cfg.server.port, bind: cfg.server.bind,
  token: () => cfg.server.token,
  tokenPrev: () => cfg.server.tokenPrev ?? null,
  getConfig: () => cfg,
  api,
});

try {
  await web.start();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const lanUrl = `http://${cfg.server.bind === "0.0.0.0" ? "<lan-ip>" : cfg.server.bind}:${cfg.server.port}/?token=${cfg.server.token}`;
console.log(GRN(`✔ subtitle-fetcher service on http://localhost:${cfg.server.port}`));
console.log(`  ${YEL("LAN URL (bookmark this):")} ${lanUrl}`);
console.log(DIM(`  token: ${cfg.server.token}`));

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
function shutdown() {
  console.log(DIM("\nshutting down…"));
  try { persist(); } catch {}
  web.stop().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
