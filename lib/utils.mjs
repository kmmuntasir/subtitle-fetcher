// Shared micro-utilities used across the codebase.

import fs from "node:fs";
import path from "node:path";

export const norm = (p) => p.replace(/\\/g, "/");
export const BASE = (f) => f.slice(0, f.length - path.extname(f).length);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const keyOf = (p) => norm(p).toLowerCase();

export const fmtSize = (n) =>
  n > 1e9 ? (n / 1e9).toFixed(2) + " GB" : n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : n / 1e3 + " KB";

/** keys in state.json are lowercase-normalized; rebuild a working absolute
 *  path from the configured roots (Windows/UNC is case-insensitive). */
export function reconstructPath(key, rootPaths) {
  for (const r of rootPaths) {
    const rk = norm(r).toLowerCase();
    if (key.toLowerCase().startsWith(rk)) return norm(r) + key.slice(rk.length);
  }
  return key;
}

/** State keys are lowercased, so a rebuilt path has a wrong-case tail — and
 *  video players pair sidecar subtitles by exact filename. Resolve the video's
 *  real on-disk name (one parent-dir read) before writing anything next to it. */
export function trueVideoPath(vPath) {
  const dir = path.dirname(vPath);
  const base = path.basename(vPath);
  try {
    const hit = fs.readdirSync(dir).find(f => f.toLowerCase() === base.toLowerCase());
    return hit ? path.join(dir, hit) : vPath;
  } catch { return vPath; }
}
