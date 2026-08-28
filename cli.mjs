// CLI entry point. Commands:
//   scan | dry | run | status | retry | probe | setup | schedule
//
// If the web service is running on this machine, read-only commands prefer
// it (so you see the service's live state); write commands still work on the
// shared files. See docs/plan-web-service.md.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";

import { loadConfig, saveConfig, rootPaths } from "./lib/config.mjs";
import { loadState, saveState, summary } from "./lib/store.mjs";
import { openLog, log, closeLog, GRN, YEL, RED, DIM } from "./lib/logger.mjs";
import { scanRoots, classify, refreshInventory } from "./lib/scanner.mjs";
import { guessMeta } from "./lib/parse.mjs";
import { openSubtitlesHash } from "./lib/hash.mjs";
import { findEnglishSub } from "./lib/detect.mjs";
import { runFetch, failureLines } from "./lib/engine.mjs";
import { reconstructPath, norm, fmtSize } from "./lib/utils.mjs";
import { registerDaily, unregisterDaily } from "./lib/scheduler.mjs";

const SCRIPT_DIR = (() => {
  const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  return decodeURIComponent(here);
})();
const CONFIG_PATH = path.join(SCRIPT_DIR, "config.json");
const STATE_PATH = path.join(SCRIPT_DIR, "state.json");
const LOG_DIR = path.join(SCRIPT_DIR, "logs");

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  const [, , command = "run", ...rest] = process.argv;
  const cfg = loadConfig(CONFIG_PATH);

  try {
    switch (command) {
      case "scan": await cmdScan(cfg); break;
      case "dry": await cmdDry(cfg, rest); break;
      case "run": await cmdRun(cfg, process.argv); break;
      case "status": cmdStatus(); break;
      case "retry": await cmdRetry(cfg, rest.join(" ")); break;
      case "probe": await cmdProbe(cfg, rest.join(" ")); break;
      case "setup": await cmdSetup(cfg); break;
      case "schedule": cmdSchedule(cfg, rest); break;
      case "serve": console.log("Use: node service.mjs  (or: node install.mjs)"); break;
      default:
        console.log(`Unknown command '${command}'. Try: scan | dry | run | status | retry | probe | setup | schedule`);
    }
  } catch (e) {
    console.error(RED("Fatal: " + (e?.stack ?? e)));
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------

function stateProxy() { return loadState(STATE_PATH); }
function persist(state) { saveState(STATE_PATH, state); }

async function cmdScan(cfg) {
  openLog(LOG_DIR, "scan");
  log(DIM("Scanning library…"));
  const state = stateProxy();
  refreshInventory(cfg, state, {
    silent: false,
    progress: (n, p) => process.stdout.write(`\r  found ${n}… ${DIM(p.slice(-70))}        `),
  });
  process.stdout.write("\r" + " ".repeat(100) + "\r\n");
  const s = summary(state);
  persist(state);
  log(`videos total : ${GRN(String(s.total))}`);
  log(`have EN subs : ${GRN(String(s.covered))}`);
  log(`missing      : ${YEL(String(s.pending + s.failed))}`);
  log(`parked       : ${DIM(String(s.parked))}`);
  closeLog();
}

async function cmdDry(cfg, argv) {
  const nArg = argv.find(a => /^\d+$/.test(a));
  const state = stateProxy();
  const ageH = (Date.now() - (state.scannedAt ?? 0)) / 3600e3;
  if (!state.scannedAt || ageH > 6) {
    console.log(DIM(state.scannedAt ? `Inventory ${ageH.toFixed(0)}h old — refreshing…` : "No inventory yet — scanning…"));
    refreshInventory(cfg, state, { silent: false, progress: (n, p) => process.stdout.write(`\r  found ${n}… ${DIM(p.slice(-70))}        `) });
    process.stdout.write("\r" + " ".repeat(100) + "\r\n");
    persist(state);
  }
  const s = summary(state);
  console.log("");
  console.log(`videos: ${s.total} | need subs: ${YEL(String(s.pending + s.failed))}`);
  const queue = Object.entries(state.files)
    .filter(([, r]) => r.status === "pending" || r.status === "failed")
    .slice(0, nArg ? +nArg : 30);
  console.log(DIM(`next ${queue.length}:`));
  const paths = rootPaths(cfg);
  for (const [k] of queue) {
    const p = reconstructPath(k, paths);
    const m = guessMeta(p);
    console.log("  " + (m.kind === "episode"
      ? `TV  ${m.show} · S${String(m.season).padStart(2, "0")}E${String(m.episode).padStart(2, "0")}`
      : `MOV ${m.title}${m.year ? ` (${m.year})` : ""}`));
    console.log(DIM(`      …${p.slice(-100)}`));
  }
}

async function cmdRun(cfg, argv) {
  const limIdx = argv.indexOf("--limit");
  const limit = limIdx >= 0 ? +argv[limIdx + 1] || null : cfg.maxPerRun;
  const onlyIdx = argv.indexOf("--only");
  const onlySub = onlyIdx >= 0 ? String(argv[onlyIdx + 1] ?? "") : "";
  const rescan = argv.includes("--rescan");
  openLog(LOG_DIR, "run");
  const started = Date.now();

  const state = stateProxy();
  const result = await runFetch(cfg, state, {
    limit, onlySub, rescan,
    saveState: () => persist(state),
  });

  // summary (same shape as the v1 CLI)
  persist(state);
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  log("\n──── summary ────");
  log(` downloaded : ${GRN(String(result.done))} ${JSON.stringify(result.perProvider)}`);
  log(` missed     : ${result.missed}`);
  const left = summary(loadState(STATE_PATH));
  log(` still queued: ${left.pending + left.failed} ${DIM(`(${mins} min)`)}`);
  if (result.missed > 0 && result.missed <= 60) {
    const lines = failureLines(state, mins * 60000 + 5000);
    if (lines.length) {
      log(DIM("─── this run's failures ───"));
      for (const l of lines) log(DIM(l));
    }
  } else if (result.missed > 60) {
    log(DIM(`(${result.missed} misses — per-item reasons in state.json / dim lines above)`));
  }
  closeLog();
}

function cmdStatus() {
  const s = summary(stateProxy());
  const st = stateProxy();
  console.log(`videos total : ${s.total}`);
  console.log(` have EN subs: ${GRN(String(s.covered))}`);
  console.log(` missing     : ${YEL(String(s.pending + s.failed))} (queued ${s.pending}, retrying ${s.failed})`);
  console.log(` parked      : ${DIM(String(s.parked))}`);
  if (typeof st.osRemaining === "number")
    console.log(` OS quota left: ${st.osRemaining === 0 ? RED("0 (resets daily)") : st.osRemaining}`);
}

async function cmdRetry(cfg, substr) {
  if (!substr) { console.log("usage: retry <substring-of-path>"); return; }
  const needle = substr.toLowerCase();
  const state = stateProxy();
  let hits = 0;
  for (const [k, rec] of Object.entries(state.files)) {
    if (!k.includes(needle)) continue;
    if (["failed", "parked", "done"].includes(rec.status)) { rec.status = "pending"; rec.attempts = 0; }
    if (rec.status === "pending") hits++;
  }
  persist(state);
  console.log(`${hits} matching entries queued for '${substr}'…`);
  await cmdRun(cfg, ["run", "--limit", String(hits || 1), "--only", needle]);
}

async function cmdProbe(cfg, target) {
  if (!target) { console.log("usage: probe <full-or-relative-video-path>"); return; }
  let p = norm(target);
  if (!p.startsWith("//") && !/^[a-z]:[\\/]/i.test(p)) {
    for (const r of rootPaths(cfg)) {
      const cand = norm(r + "/" + target);
      if (fs.existsSync(cand)) { p = cand; break; }
    }
  }
  if (!fs.existsSync(p)) { console.error(RED("file not found: " + p)); return; }
  console.log("path :", p);
  console.log("meta :", JSON.stringify(guessMeta(p)));
  const existing = findEnglishSub(p, {});
  if (existing) console.log(GRN(`covered by ${existing.source}: ${existing.path} (${existing.note})`));
  else console.log(YEL("no usable English subtitle found locally → would be fetched"));
  process.stdout.write("hash : computing…");
  try {
    const h = await openSubtitlesHash(p);
    console.log("\rhash :", h, `(${fmtSize(fs.statSync(p).size)})`);
  } catch (e) { console.log("\rhash : failed —", e.message); }
}

async function cmdSetup(cfg) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(res => rl.question(q, res));

  console.log(`\n${GRN("Subtitle Fetcher setup")}\n${DIM("─".repeat(46))}`);
  console.log(DIM("\n① Library folders — enter each root, blank line to finish"));
  console.log(DIM("   Windows example: \\\\NAS\\media\\Videos\\Movies"));
  console.log(DIM("   Linux/macOS:     /mnt/nas/media/Videos/Movies"));
  const roots = [...(cfg.roots ?? [])];
  while (true) {
    const line = (await ask(` folder ${roots.length + 1} ${roots.length ? DIM("(blank = done)") : ""}: `)).trim();
    if (!line && roots.length) break;
    if (!line) continue;
    roots.push(line.replace(/^"(.*)"$/, "$1"));
  }
  cfg.roots = roots;

  console.log(DIM(`
② Sources — addic7ed (TV) and subdl (movies) work anonymously.
   Adding a FREE opensubtitles.com key adds hash-perfect fallback:
     register https://www.opensubtitles.com → Dashboard → API Keys.`));
  cfg.apiKey = (await ask(YEL(" OpenSubtitles API key (blank to skip): "))).trim() || cfg.apiKey;
  if (cfg.apiKey) {
    cfg.username = (await ask(" OpenSubtitles username : ")).trim();
    cfg.password = (await ask(" OpenSubtitles password : ")).trim();
  }
  const pv = (await ask(` providers [${cfg.providers.join(",") ?? "a7,sd,os"}]: `)).trim();
  if (pv) cfg.providers = pv.split(",").map(s => s.trim()).filter(Boolean);

  console.log(DIM("\n③ Automation — registers a daily run"));
  const schedQ = (await ask(YEL(" schedule daily? time like 13:05 (blank = skip): "))).trim();
  if (/^\d{1,2}[:.]?\d{2}$/.test(schedQ)) cfg.schedule = { ...(cfg.schedule ?? {}), enabled: true, time: schedQ };
  saveConfig(CONFIG_PATH, cfg);
  console.log(GRN("\n✔ config.json saved"));
  rl.close();

  if (/^\d{1,2}[:.]?\d{2}$/.test(schedQ)) registerDaily(SCRIPT_DIR, cfg.schedule.time);
  else console.log(DIM("\nEnable automation later:  node cli.mjs schedule 13:05"));
  console.log(GRN("\nNext: node cli.mjs dry   (preview)\n      node cli.mjs run    (first fetch)\n      or run the web UI:  node service.mjs"));
}

function cmdSchedule(cfg, args) {
  if (args.includes("--remove")) { unregisterDaily(); return; }
  const tm = /^(\d{1,2})[:.]?(\d{2})$/.exec(args.find(a => /^\d/.test(a)) ?? cfg.schedule?.time ?? cfg.taskTime);
  if (tm) {
    cfg.schedule = { ...(cfg.schedule ?? { enabled: true, catchUpIfMissed: true }), enabled: true, time: `${tm[1].padStart(2, "0")}:${tm[2]}` };
    cfg.taskTime = cfg.schedule.time;
  }
  saveConfig(CONFIG_PATH, cfg);
  registerDaily(SCRIPT_DIR, cfg.schedule.time);
}

void execSync;
