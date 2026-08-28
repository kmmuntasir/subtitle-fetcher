#!/usr/bin/env node
// Service entry point: web UI + scheduler + engine in one detached process.
//   node service.mjs [--port N] [--token T]
// Install as a boot service with:  node install.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, saveConfig, normalizeRoots } from "./lib/config.mjs";
import { loadState, saveState, summary, initActivity, pushActivity, getActivity } from "./lib/store.mjs";
import { openLog, closeLog, setLogHook, GRN, YEL, DIM } from "./lib/logger.mjs";
import { refreshInventory } from "./lib/scanner.mjs";
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
if (argOf("--port")) { cfg.server.port = +argOf("--port"); }
if (argOf("--token")) { cfg.server.token = argOf("--token"); }

let state = loadState(STATE_PATH);
const persist = () => saveState(STATE_PATH, state);
const persistCfg = () => saveConfig(CONFIG_PATH, cfg);

initActivity(LOG_DIR);
openLog(LOG_DIR, "service");
setLogHook((_msg, plain) => pushActivity({ ev: "log", line: plain.slice(0, 200) }));

// ---- engine control ---------------------------------------------------------
const engine = {
  running: false, stopRequested: false,
  lastResult: null, startedAt: null, phase: "idle",        // idle|scanning|fetching
  current: null,                                            // item being worked
  lastRunDate: state.lastRunDate ?? null,
  async startScan() {
    if (this.running) throw new Error("engine busy");
    this.running = true; this.phase = "scanning"; this.stopRequested = false;
    pushActivity({ ev: "scan_start" });
    try {
      refreshInventory(cfg, state, {
        silent: true,
        progress: (n) => { this.current = { label: `scanning… ${n} files` }; },
      });
      persist();
      const s = summary(state);
      pushActivity({ ev: "scan", ...s });
    } finally {
      this.running = false; this.phase = "idle"; this.current = null;
    }
  },
  async startRun(limit = null, only = "") {
    if (this.running) throw new Error("engine busy");
    this.running = true; this.phase = "fetching"; this.stopRequested = false;
    this.startedAt = Date.now();
    openLog(LOG_DIR, "run");
    try {
      const result = await runFetch(cfg, state, {
        limit, onlySub: only,
        saveState: persist,
        shouldStop: () => this.stopRequested,
        onEvent: (e) => {
          if (e.ev === "item_start") this.current = { key: e.key, label: e.label };
          if (e.ev === "run_end" || e.ev === "quota") this.current = null;
          pushActivity(e);
          web.broadcast(e);
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
const api = {
  async status() {
    const s = summary(state);
    const provs = buildProviders(cfg, state).map(p => ({
      id: p.id, enabled: true,
      quotaLeft: typeof p.quotaLeft === "number" ? p.quotaLeft : null,
    }));
    return {
      totals: s,
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
      items: rows.map(([k, r]) => ({ key: k, ...pick(r, ["status", "attempts", "lastError", "provider", "rel", "when", "meta", "rootType"]) })),
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
    pushActivity({ ev: "replace", key: listing.key, provider: cand.provider, release: rec.rel });
    web.broadcast({ ev: "replace", key: listing.key, release: rec.rel });
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

  library(sp) {
    const type = sp.get("type") ?? "tv";
    const shows = new Map();
    const movies = [];
    for (const [k, r] of Object.entries(state.files)) {
      const meta = r.meta ?? metaFromKey(k);
      if (meta.kind === "episode") {
        const sh = shows.get(meta.show) ?? { show: meta.show, seasons: new Map(), total: 0, covered: 0 };
        const season = sh.seasons.get(meta.season) ?? [];
        season.push({ key: k, episode: meta.episode, status: r.status, rel: r.rel ?? null });
        sh.seasons.set(meta.season, season);
        sh.total++; if (r.status === "done" || r.status === "covered") sh.covered++;
        shows.set(meta.show, sh);
      } else {
        movies.push({ key: k, title: meta.title, year: meta.year ?? null, status: r.status, rel: r.rel ?? null });
      }
    }
    if (type === "movie") return { movies: movies.sort((a, b) => (a.title ?? "").localeCompare(b.title ?? "")) };
    const tv = [...shows.values()].map(sh => ({
      show: sh.show, total: sh.total, covered: sh.covered,
      seasons: [...sh.seasons.entries()].map(([s, eps]) => ({ season: s, episodes: eps.sort((a, b) => a.episode - b.episode) }))
        .sort((a, b) => a.season - b.season),
    })).sort((a, b) => a.show.localeCompare(b.show));
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
    return fs.readdirSync(LOG_DIR).filter(f => f.endsWith(".log") || f.endsWith(".out") || f.endsWith(".err")).sort();
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
    if (body.schedule) cfg.schedule = { ...cfg.schedule, ...body.schedule };
    if (body.server) {
      const tokenChanging = body.server.token && body.server.token !== cfg.server.token;
      cfg.server = { ...cfg.server, ...body.server };
      if (tokenChanging) cfg.server.tokenPrev = cfg.server.token;   // old token stays valid this session
    }
    if (body.opensubtitles) {
      cfg.apiKey = body.opensubtitles.apiKey ?? cfg.apiKey;
      cfg.username = body.opensubtitles.username ?? cfg.username;
      if (body.opensubtitles.password && body.opensubtitles.password !== "•••") cfg.password = body.opensubtitles.password;
    }
    persistCfg();
    pushActivity({ ev: "config", detail: "updated via UI" });
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
function metaFromKey(k) { try { return guessMeta(reconstructPath(k, rootPathsOf())); } catch { return { kind: "movie", title: k.split("/").pop() }; } }
async function safeHash(p) { try { return await openSubtitlesHash(p); } catch { return null; } }
function pick(o, keys) { const out = {}; for (const k of keys) if (o[k] !== undefined) out[k] = o[k]; return out; }

function nextRunDescription() {
  const [hh, mm] = (cfg.schedule?.time ?? "13:05").split(":").map(Number);
  const now = new Date();
  const next = new Date(now); next.setHours(hh, mm, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

// ---- scheduler loop ------------------------------------------------------------
let lastScheduledDay = state.lastRunDate ?? null;
setInterval(async () => {
  if (!cfg.schedule?.enabled || engine.running) return;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const [hh, mm] = (cfg.schedule?.time ?? "13:05").split(":").map(Number);
  const due = now.getHours() > hh || (now.getHours() === hh && now.getMinutes() >= mm);
  if (!due || lastScheduledDay === today) return;
  const catchUp = cfg.schedule?.catchUpIfMissed !== false;
  const missedBoot = catchUp && lastScheduledDay !== today && now.getHours() < (hh + 2);   // boot shortly after slot
  if (now.getHours() === hh || now.getHours() === hh || missedBoot || true) {
    // daily slot reached (or catch-up after boot); run once per day
    lastScheduledDay = today;
    console.log(`[scheduler] daily run starting (${cfg.schedule.time})`);
    try { await engine.startRun(); } catch (e) { console.error("[scheduler]", e.message); }
  }
  void mm;
}, 30000).unref();

// ---- boot ---------------------------------------------------------------------
const web = new WebServer({
  port: cfg.server.port, bind: cfg.server.bind, token: cfg.server.token,
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
