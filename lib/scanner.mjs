// Library scanning: recursive walk of configured roots + classification
// (subtitle coverage + metadata) of every video found.

import fs from "node:fs";
import path from "node:path";
import { VIDEO_EXTS } from "./consts.mjs";
import { rootTypeFor } from "./config.mjs";
import { findEnglishSub } from "./detect.mjs";
import { guessMeta } from "./parse.mjs";
import { norm, keyOf } from "./utils.mjs";
import { rootPaths } from "./config.mjs";

export function scanRoots(cfg, onProgress) {
  const videos = [];
  const paths = rootPaths(cfg);
  if (!paths.length) {
    console.error("No library folders configured yet — run setup or add folders in the web UI.");
    return videos;
  }
  for (const root of paths) {
    if (!fs.existsSync(root)) { console.error(`Root unreachable: ${root}`); continue; }
    let rels;
    try { rels = fs.readdirSync(root, { recursive: true }); }
    catch (e) { console.error(`Root walk failed: ${root} (${e.message})`); continue; }
    for (const rel of rels) {
      if (!VIDEO_EXTS.has(path.extname(rel).toLowerCase())) continue;
      const n = norm(rel);
      if (/(^|\/)\.trickplay(\/|$)/i.test(n)) continue;
      const abs = norm(`${norm(root)}/${rel}`);
      videos.push(abs);
      if (onProgress && videos.length % 400 === 0) onProgress(videos.length, abs);
    }
  }
  return [...new Set(videos)];
}

/** attach subtitle-status + metadata to a flat video list (slow ops over SMB) */
export function classify(videos, prior, sniffCache = {}, cfg = null) {
  const out = new Array(videos.length);
  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    let size = 0, mtime = 0, existingSub = null;
    try {
      try { const s = fs.statSync(v); size = s.size; mtime = s.mtimeMs; } catch { /* vanished */ }
      // findEnglishSub does readdir/readFile over SMB — a transient error on
      // one folder must not kill a 30-minute walk; treat it as "no sub found"
      existingSub = size > 0 ? findEnglishSub(v, sniffCache) : null;
    } catch (e) {
      console.error(`scan: subtitle-detect failed on ${v} (${e.message})`);
    }
    out[i] = {
      video: v, size, mtime,
      existingSub,
      meta: guessMeta(v),
      rootType: cfg ? rootTypeFor(cfg, v) : "auto",
      prev: prior?.[keyOf(v)],
    };
  }
  return out;
}

/**
 * Rebuild state.files from a fresh walk; preserves per-item records for files
 * that still exist and drops vanished ones. Saves state when done.
 */
export function refreshInventory(cfg, state, { silent = false, progress } = {}) {
  const videos = scanRoots(cfg, silent ? null : (n, p) => progress?.(n, p));
  const items = classify(videos, state.files, (state.sniffs ??= {}), cfg);

  const keep = new Set();
  for (const it of items) {
    const k = keyOf(it.video);
    keep.add(k);
    const missing = !it.existingSub;
    if (it.size === 0) continue;                                   // unreadable/vanished: leave prior entry untouched
    const p = it.prev;
    if (!p) {
      state.files[k] = {
        status: missing ? "pending" : "covered", size: it.size, mtime: it.mtime, coverMtime: it.mtime,
        rootType: it.rootType, meta: compactMeta(it.meta),
      };
      continue;
    }
    // video file changed underneath us? re-evaluate
    if (p.coverMtime !== it.mtime) {
      if (missing && (p.status === "done" || p.status === "covered")) {
        state.files[k] = { status: "pending", size: it.size, mtime: it.mtime, coverMtime: it.mtime,
                           rootType: it.rootType, meta: compactMeta(it.meta) };
      } else {
        p.size = it.size; p.mtime = it.mtime; p.coverMtime = it.mtime;
        p.meta = compactMeta(it.meta);
        if (missing && p.status === "covered") p.status = "pending";
      }
    } else if (missing && p.status === "covered") p.status = "pending";

    // backfill metadata cached by older versions
    p.meta = compactMeta(it.meta);
    p.rootType ??= it.rootType;
  }
  for (const k of Object.keys(state.files)) if (!keep.has(k)) delete state.files[k];
  state.scannedAt = Date.now();
  return items;
}

/** shrink parsed metadata for storage */
export function compactMeta(m) {
  return m.kind === "episode"
    ? { kind: "episode", show: m.show, season: m.season, episode: m.episode,
        from: m.years?.[0], to: m.years?.[1] ?? m.years?.[0] }
    : { kind: "movie", title: m.title, year: m.year };
}

// ---------------------------------------------------------------------------
// Async variant for the web service: yields to the event loop periodically so
// the HTTP server / SSE stay responsive during long (SMB) walks. Logic and
// resulting state are identical to refreshInventory().
// ---------------------------------------------------------------------------

const yieldLoop = () => new Promise(r => setImmediate(r));

async function walkRootAsync(root, videos, onWalk) {
  // manual breadth-first walk instead of one-shot recursive readdir: the
  // built-in buffers the whole tree before returning (10-15 silent minutes
  // per root over SMB), while this reports progress as it goes. .trickplay
  // subtrees (Jellyfin thumbnails) are pruned outright — they only ever
  // contained files the old code filtered away anyway.
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch (e) { console.error(`walk: readdir failed (${e.message}): ${dir}`); continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // Jellyfin names trickplay dirs "<video name>.trickplay" — prune any
        // directory ending in .trickplay (hundreds of thumb subdirs inside)
        if (/\.trickplay$/i.test(ent.name)) continue;
        queue.push(full);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        if (!VIDEO_EXTS.has(path.extname(ent.name).toLowerCase())) continue;
        if (/(^|\/)\.trickplay(\/|$)/i.test(norm(full))) continue;
        videos.push(norm(full));
      }
    }
    onWalk?.(dir, videos.length);
  }
}

/** standing rule: a sidecar we own (*.en.srt) whose name doesn't match its
 *  video's exact filename gets renamed to match — video players pair sidecar
 *  subtitles by exact name, so a case-mismatched leftover is useless to them */
export function repairSidecarCase(v) {
  const dir = path.dirname(v);
  const want = path.basename(v).replace(/\.[^.]+$/, "") + ".en.srt";
  if (!fs.existsSync(path.join(dir, want))) return false;
  const hit = fs.readdirSync(dir).find(f => f.toLowerCase() === want.toLowerCase());
  if (!hit || hit === want) return false;
  fs.renameSync(path.join(dir, hit), path.join(dir, want));
  return true;
}

export async function refreshInventoryAsync(cfg, state, { onProgress, onWalk } = {}) {
  const started = Date.now();
  const videos = [];
  const paths = rootPaths(cfg);
  if (!paths.length) throw new Error("No library folders configured.");
  for (const root of paths) {
    if (!fs.existsSync(root)) { console.error(`Root unreachable: ${root}`); continue; }
    await walkRootAsync(root, videos, onWalk);
    await yieldLoop();
  }
  const uniq = [...new Set(videos)];
  const keep = new Set();
  const sniffs = (state.sniffs ??= {});

  let scanErrors = 0;
  let renames = 0;
  for (let i = 0; i < uniq.length; i++) {
    const v = uniq[i];
    const k = keyOf(v);
    keep.add(k);
    let size = 0, mtime = 0, existing = null;
    let metaC, rootType;
    try {
      try { const s = fs.statSync(v); size = s.size; mtime = s.mtimeMs; } catch { continue; }
      existing = findEnglishSub(v, sniffs);
      metaC = compactMeta(guessMeta(v));
      rootType = rootTypeFor(cfg, v);
    } catch (e) {
      scanErrors++;
      if (scanErrors <= 5) console.error(`scan: item failed (${e.message}): ${v}`);
      continue;
    }
    const missing = !existing;
    let p = state.files[k];

    try { if (repairSidecarCase(v)) renames++; } catch { /* best effort */ }

    if (size === 0) { /* unreadable: leave prior entry */ }
    else if (!p) {
      p = { status: missing ? "pending" : "covered", size, mtime, coverMtime: mtime, rootType, meta: metaC };
      state.files[k] = p;
    } else if (p.coverMtime !== mtime) {
      if (missing && (p.status === "done" || p.status === "covered")) {
        state.files[k] = { status: "pending", size, mtime, coverMtime: mtime, rootType, meta: metaC };
      } else {
        p.size = size; p.mtime = mtime; p.coverMtime = mtime; p.meta = metaC;
        if (missing && p.status === "covered") p.status = "pending";
      }
    } else if (missing && p.status === "covered") p.status = "pending";

    // backfill metadata cached by older versions
    if (p) {
      p.meta = metaC;
      p.rootType ??= rootType;
    }

    if (i % 150 === 0) {
      await yieldLoop();
      onProgress?.(i + 1, uniq.length, v);
    }
  }

  for (const k of Object.keys(state.files)) if (!keep.has(k)) delete state.files[k];
  state.scannedAt = Date.now();
  void started;
  if (scanErrors) console.error(`scan: completed with ${scanErrors} item-level errors (skipped items keep prior records)`);
  if (renames) console.log(`scan: renamed ${renames} sidecar subtitle(s) to match their video filenames`);
  return { total: uniq.length, errors: scanErrors, renamed: renames };
}
