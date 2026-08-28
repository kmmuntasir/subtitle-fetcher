// Engine: the fetch pipeline. Walks the pending queue, tries providers in
// order, writes `<base>.en.srt`, updates the state ledger.
//
// Hooks make it embeddable in the web service:
//   log(msg)            per-line output (defaults to console)
//   onEvent(evt)        structured activity events (SSE/activity.jsonl)
//   shouldStop()        cooperative cancellation between items

import fs from "node:fs";
import path from "node:path";
import { BASE, sleep, keyOf, reconstructPath } from "./utils.mjs";
import { GRN, YEL, RED, DIM } from "./logger.mjs";
import { refreshInventory, compactMeta } from "./scanner.mjs";
import { guessMeta } from "./parse.mjs";
import { buildProviders } from "./providers/index.mjs";

const noop = () => {};

/**
 * Fetch subtitles for everything pending.
 * @returns {{done:number, missed:number, perProvider:Object, stopped:boolean, queue:number}}
 */
export async function runFetch(cfg, state, opts = {}) {
  const { limit = cfg.maxPerRun ?? null, onlySub = "", rescan = false,
          log = console.log, onEvent = noop, shouldStop = noop,
          takePriority = null, saveState = null, skipRescan = false } = opts;
  const started = Date.now();

  // providers before refresh so a missing config fails fast
  const provs = buildProviders(cfg, state);
  if (!provs.length) {
    const err = "No providers enabled. Configure apiKey or enable keyless sources.";
    log(RED(err));
    return { done: 0, missed: 0, perProvider: {}, stopped: false, queue: 0, error: err };
  }

  if (!skipRescan && (rescan || !state.scannedAt || Date.now() - state.scannedAt > 20 * 3600e3)) {
    log(DIM(rescan ? "Refreshing inventory (--rescan)…"
                   : state.scannedAt ? `Inventory ${((Date.now() - state.scannedAt) / 3600e3).toFixed(0)}h old — refreshing…`
                   : "No inventory yet — building…"));
    refreshInventory(cfg, state, { silent: true });
    onEvent({ ev: "scan", pending: Object.values(state.files).filter(r => r.status === "pending" || r.status === "failed").length });
  } else {
    log(DIM(`Using inventory scanned ${new Date(state.scannedAt).toLocaleString()} (${((Date.now() - state.scannedAt) / 3600e3).toFixed(1)}h ago; force with --rescan)`));
  }

  const paths = (cfg.roots ?? []).map(r => typeof r === "string" ? r : r.path);

  let entries = Object.entries(state.files)
    .filter(([, r]) => r.status === "pending" || r.status === "failed")
    .filter(([k]) => !onlySub || k.includes(onlySub.toLowerCase()))
    .map(([k, r]) => ({ k, ...r }));
  const queue = entries.length;
  if (limit) entries = entries.slice(0, limit);

  if (!entries.length) { log(GRN("✔ Nothing pending — whole library covered.")); return { done: 0, missed: 0, perProvider: {}, stopped: false, queue: 0 }; }
  if (!provs.some(p => p.id === "os") && cfg.providers.includes("os"))
    log(YEL("(opensubtitles.com skipped — no apiKey yet; falling back to keyless sources only)"));

  log(`queue: ${entries.length}${limit ? ` (limited run)` : ""} via [${provs.map(p => p.id).join(", ")}]\n`);
  onEvent({ ev: "run_start", queue: entries.length, providers: provs.map(p => p.id) });

  const stats = { done: 0, missed: 0, deferred: 0, perProvider: {} };
  const deadProviders = new Set();          // hit a daily cap during this run
  let stopped = false;

  const alive = (id) => provs.some(p => p.id === id) && !deadProviders.has(id);

  for (const e of entries) {
    if (shouldStop()) { stopped = true; log(YEL("⏸ stop requested — finishing gracefully.")); break; }

    // user-priority items jump the queue mid-run
    if (takePriority) {
      const prio = takePriority();
      for (const k of prio) {
        const i = entries.findIndex(x => x.k === k);
        if (i > 0) entries.unshift(...entries.splice(i, 1));
      }
      if (prio.length) {
        const next = entries[0];
        if (next && prio.includes(next.k)) log(DIM(`   ⏩ priority: ${next.k.split("/").pop()}`));
      }
    }

    if (deadProviders.size >= provs.length) {
      log(RED("⏸ Every configured source has hit its daily cap — stopping. Re-run tomorrow; queue preserved."));
      onEvent({ ev: "quota", detail: "all providers capped" });
      break;
    }

    const shortName = e.k.split("/").slice(-2).join("/");
    const vPath = reconstructPath(e.k, paths);
    const meta = guessMeta(vPath);

    // a7 only covers episodes; movies need sd/os. If nothing can serve this
    // item today, defer WITHOUT burning an attempt (it would only park).
    const servable = meta.kind === "episode"
      ? provs.some(p => !deadProviders.has(p.id))
      : (alive("sd") || alive("os"));
    if (!servable) { stats.deferred++; continue; }

    onEvent({ ev: "item_start", key: e.k, label: shortName, meta: compactMeta(meta) });

    let gotText = null, usedProv = null, candInfo = null, lastFailNote = "";
    const noteFail = (msg) => { if (msg) lastFailNote = String(msg).slice(0, 180); };
    const vBase = BASE(path.basename(vPath));

    for (const prov of provs) {
      if (deadProviders.has(prov.id)) continue;
      if (prov.id === "os" && prov.quotaLeft <= 0) { deadProviders.add("os"); continue; }
      let cands = [];
      try {
        cands = (await prov.search({}, meta)).slice(0, 4);
        if (prov.id === "sd") trackSdSearch(state, cands.length, deadProviders, log, onEvent);
      } catch (err) {
        if (err.fatal) { log(RED(`⛔ ${err.message}`)); onEvent({ ev: "fatal", provider: prov.id, detail: err.message }); return finish(2); }
        log(DIM(`   ${prov.id}: ${err.message}`));
        noteFail(`${prov.id}: ${err.message}`);
        if (err.quotaExhausted) { deadProviders.add(err.providerId ?? prov.id); log(RED(`   ↳ ${prov.id} daily cap reached — skipping it for the rest of this run.`)); }
        continue;
      }
      for (const cand of cands) {
        cand.meta = meta;
        cand.videoBase = vBase;
        try {
          gotText = await prov.fetchCandidate({}, cand);
          usedProv = prov.id; candInfo = cand;
          break;
        } catch (err) {
          if (err.quotaExhausted) {
            deadProviders.add(err.providerId ?? prov.id);
            log(RED(`   ↳ ${prov.id} daily cap reached (${err.message})`));
            break;
          }
          log(DIM(`   ${prov.id}: candidate failed — ${err.message}`));
          noteFail(`${prov.id}: ${err.message}`);
        }
      }
      if (gotText) break;
      await sleep(200);
    }

    if (gotText) {
      const dest = `${BASE(vPath)}.en.srt`;
      try {
        fs.writeFileSync(dest, "﻿" + gotText);
        state.files[e.k] = { ...(state.files[e.k] ?? {}), status: "done", provider: usedProv, when: new Date().toISOString(),
                              rel: String(candInfo?.pickedRelease ?? "").slice(0, 80) || undefined,
                              hi: !!candInfo?.hi, ai: !!candInfo?.ai,
                              meta: compactMeta(meta) };
        state.sdCount = (state.sdDay === utcDay() ? state.sdCount ?? 0 : 0) + (usedProv === "sd" ? 1 : 0);
        state.sdDay = utcDay();
        stats.done++; stats.perProvider[usedProv] = (stats.perProvider[usedProv] ?? 0) + 1;
        const tag = candInfo?.pickedRelease ? DIM(`  « ${String(candInfo.pickedRelease).slice(0, 58)} »`) : "";
        log(GRN(` ✔ ${shortName}${tag}`));
        onEvent({ ev: "download", key: e.k, label: shortName, provider: usedProv, release: candInfo?.pickedRelease, hi: !!candInfo?.hi, ai: !!candInfo?.ai });
      } catch (wErr) {
        const rec = state.files[e.k] ?? {};
        rec.attempts = (rec.attempts ?? 0) + 1; rec.lastError = `write failed: ${wErr.message}`;
        rec.status = rec.attempts >= cfg.attemptsBeforePark ? "parked" : "failed"; rec.when = new Date().toISOString();
        state.files[e.k] = rec;
        log(RED(` ! write failed ${shortName}: ${wErr.message}`));
        stats.missed++;
        onEvent({ ev: "miss", key: e.k, label: shortName, reason: rec.lastError });
      }
    } else {
      const rec = state.files[e.k] ?? {};
      rec.attempts = (rec.attempts ?? 0) + 1;
      rec.lastError = lastFailNote || "no provider had it";
      rec.when = new Date().toISOString();
      rec.status = rec.attempts >= cfg.attemptsBeforePark ? "parked" : "failed";
      rec.meta ??= compactMeta(meta);
      state.files[e.k] = rec;
      stats.missed++;
      log(DIM(` ✖ ${shortName}`));
      onEvent({ ev: "miss", key: e.k, label: shortName, reason: rec.lastError, attempts: rec.attempts, parked: rec.status === "parked" });
    }

    if ((stats.done + stats.missed) % 5 === 0) opts.saveState?.();
  }

  return finish(0);

  function finish(exitCode) {
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    onEvent({ ev: "run_end", done: stats.done, missed: stats.missed, deferred: stats.deferred, minutes: +mins, stopped });
    return { ...stats, stopped, queue, exitCode, minutes: +mins };
  }
}

function utcDay() { return new Date().toISOString().slice(0, 10); }

/**
 * SubDL enforces its ~300/day cap as a SILENT soft block: search pages come
 * back HTTP-200 with result lists stripped, so misses look organic. Detection
 * (observed 2026-08-28): ≥40 consecutive zero-result sd searches on a day
 * where sd already delivered ≥100. When tripped: sd is dead for the UTC day
 * and attempt-spending during the streak is retroactively forgiven.
 */
function trackSdSearch(state, resultCount, deadProviders, log, onEvent) {
  const today = utcDay();
  if (state.sdDay !== today) { state.sdDay = today; state.sdCount = state.sdCount ?? 0; state.sdZeroStreak = 0; state.sdZeroSince = null; }
  if (resultCount > 0) { state.sdZeroStreak = 0; state.sdZeroSince = null; return; }
  state.sdZeroStreak = (state.sdZeroStreak ?? 0) + 1;
  if (state.sdZeroStreak === 1) state.sdZeroSince = new Date().toISOString();
  if ((state.sdCount ?? 0) >= 100 && state.sdZeroStreak >= 40) {
    deadProviders.add("sd");
    log(RED("   ↳ sd appears soft-blocked (daily cap) — zero results all streak. Retiring it for today and forgiving streak attempts."));
    onEvent({ ev: "quota", provider: "sd", detail: "soft block detected (empty results streak)" });
    forgiveStreak(state, state.sdZeroSince);
    state.sdZeroStreak = 0; state.sdZeroSince = null;
  }
}

function forgiveStreak(state, since) {
  if (!since) return;
  let forgiven = 0;
  for (const rec of Object.values(state.files)) {
    if (rec.status === "failed" && rec.when && rec.when >= since && /sd:/.test(rec.lastError ?? "")) {
      rec.status = "pending";
      rec.attempts = Math.max(0, (rec.attempts ?? 1) - 1);
      forgiven++;
    }
  }
  if (forgiven) log(DIM(`     forgave ${forgiven} streak attempt(s) — requeued for a later provider.`));
}

/** per-item failure detail lines for the end-of-run report (CLI summary) */
export function failureLines(state, withinMs) {
  const cutoff = Date.now() - withinMs;
  return Object.entries(state.files)
    .filter(([, r]) => r.status === "failed" && r.when && Date.now() - Date.parse(r.when) < cutoff)
    .slice(0, 60)
    .map(([k, r]) => ` ✖ …${k.split("/").slice(-2).join("/")} — ${r.lastError ?? "?"} (attempt ${r.attempts})`);
}

export { keyOf };
