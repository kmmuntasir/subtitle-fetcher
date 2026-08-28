// Configuration: defaults, load/save, v2 normalization.
// Roots may be plain strings (legacy/auto) or {path, type: movie|tv|auto}.

import fs from "node:fs";
import crypto from "node:crypto";
import { norm } from "./utils.mjs";

export const DEFAULT_CONFIG = {
  roots: [],                       // configured by `setup` / web UI
  language: "en",

  // opensubtitles.com credentials (optional)
  apiKey: "",
  username: "",
  password: "",

  providers: ["a7", "sd", "os"],   // order tried per video; a7 auto-skips movies
  maxPerRun: null,
  hearingImpairedOk: true,
  aiTranslatedOk: false,
  attemptsBeforePark: 3,
  taskTime: "13:05",               // legacy field (CLI `schedule`); schedule.time wins

  schedule: { enabled: true, time: "13:05", catchUpIfMissed: true },
  server: { port: 8097, bind: "0.0.0.0", token: "" },
  fetch: { politenessMs: { a7: 3200, sd: 250, os: 250 } },
};

export function loadConfig(configPath) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  if (fs.existsSync(configPath)) {
    try {
      Object.assign(cfg, JSON.parse(fs.readFileSync(configPath, "utf8")));
    } catch (e) {
      throw new Error(`config invalid (${e.message}) — fix or delete it.`);
    }
  }
  if (!cfg.server.token) cfg.server.token = crypto.randomBytes(12).toString("hex");
  // schedule.time overrides legacy taskTime
  if (cfg.schedule?.time) cfg.taskTime = cfg.schedule.time;
  return cfg;
}

export function saveConfig(configPath, cfg) {
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
}

/** roots → [{path, type}] with normalized separators */
export function normalizeRoots(cfg) {
  return (cfg.roots ?? []).map(r =>
    typeof r === "string"
      ? { path: norm(r), type: "auto" }
      : { path: norm(r.path), type: r.type || "auto" });
}

/** roots → plain path strings (for the scanner/engine, which treat all alike) */
export function rootPaths(cfg) {
  return normalizeRoots(cfg).map(r => r.path);
}

/** best-effort root-type for an absolute path (first matching root wins) */
export function rootTypeFor(cfg, absPath) {
  const p = norm(absPath).toLowerCase();
  for (const r of normalizeRoots(cfg)) {
    const rk = r.path.toLowerCase();
    if (p.startsWith(rk)) return r.type;
  }
  return "auto";
}
