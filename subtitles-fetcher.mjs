#!/usr/bin/env node
/*
 * Subtitle Fetcher — scans movie/TV libraries, downloads English sidecar subtitles.
 *
 * Free pipeline (tried in configured order):
 *   a7   — addic7ed.com               (anonymous, TV specialist, throttled → paced
 *          globally; unique searches 302 straight to the episode page)
 *   sd   — subdl.com                  (anonymous, ~300 downloads/day per IP;
 *          scrapes search → detail pages → direct dl.subdl.com zips)
 *   os   — opensubtitles.com REST API (free account + free personal API key;
 *          hash-exact sync; respects its daily quota automatically)
 *   pn/gd/yts — adapters exist but their domains are DNS-blocked on this
 *          network (probed 2026-08); enable manually if that ever changes.
 *
 * Zero npm dependencies. Node >= 18 required. Works over Windows UNC shares.
 *
 * Commands:
 *   scan                Walk library, refresh inventory in state.json
 *   dry [--count N]     Show what WOULD be fetched, touch nothing
 *   run [--limit N]     Fetch subtitles (this is the daily command)
 *   status              Quick inventory summary
 *   retry <substring>   Force-refetch videos whose path contains substring
 *   probe <video>       Debug one file: parsed metadata + opensubtitles hash
 *   setup               Interactive credential entry (free OpenSubtitles account)
 *   schedule [HH:MM]    Register daily Windows scheduled task (--remove to delete)
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import readline from "node:readline";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Constants / config
// ---------------------------------------------------------------------------

const SCRIPT_DIR = (() => {
  const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  return decodeURIComponent(here);
})();
const CONFIG_PATH = path.join(SCRIPT_DIR, "config.json");
const STATE_PATH = path.join(SCRIPT_DIR, "state.json");
const LOG_DIR = path.join(SCRIPT_DIR, "logs");

const VIDEO_EXTS = new Set([".mkv", ".mp4", ".avi", ".m4v", ".mov", ".wmv", ".ts", ".mpg", ".mpeg", ".flv", ".webm"]);
const SUB_EXTS = new Set([".srt", ".ass", ".ssa", ".sub", ".vtt"]);

const DEFAULT_CONFIG = {
  roots: [],        // configured by `setup` — e.g. \\NAS\media\Movies or /mnt/nas/media/Movies
  language: "en",

  apiKey: "",        // free: https://www.opensubtitles.com -> Dashboard -> API Keys
  username: "",      // free opensubtitles.com account (raises download quota massively)
  password: "",

  providers: ["a7", "sd", "os"],  // order tried per video; a7 addic7ed.com auto-skips movies,
                                  // so effectively TV-first with SubDL as workhorse fallback
  maxPerRun: null,
  hearingImpairedOk: true,
  aiTranslatedOk: false,
  attemptsBeforePark: 3,
  taskTime: "13:05",
};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const norm = (p) => p.replace(/\\/g, "/");
const BASE = (f) => f.slice(0, f.length - path.extname(f).length);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (p) => norm(p).toLowerCase();

let logStream = null;
function log(msg) {
  console.log(msg);
  logStream?.write(String(msg).replace(/\x1b\[[0-9;]*m/g, "") + "\n");
}
function openLog(tag) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  logStream = fs.createWriteStream(path.join(LOG_DIR, `${tag}-${new Date().toISOString().slice(0, 10)}.log`), { flags: "a" });
}
const GRN = (s) => `\x1b[32m${s}\x1b[0m`;
const YEL = (s) => `\x1b[33m${s}\x1b[0m`;
const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;

function loadConfig() {
  const cfg = { ...DEFAULT_CONFIG };
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      Object.assign(cfg, JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
    } catch (e) {
      console.error(RED(`config.json invalid (${e.message}) — fix or delete it.`));
      process.exit(1);
    }
  }
  return cfg;
}
const saveConfig = (cfg) => fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return { files: {}, totals: {}, osToken: null, sniffs: {}, scannedAt: 0, ...s };
  } catch {
    return { files: {}, totals: {}, osToken: null, sniffs: {}, scannedAt: 0 };
  }
}
function saveState(state) {
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_PATH);
}

// ---------------------------------------------------------------------------
// Subtitle presence detection
// ---------------------------------------------------------------------------

/** directories that commonly hold bundled multi-language subtitle packs */
const SUB_DIR_RX = /^(?:sub|subs|subtitles|subtitle|srt|subtitles?\s*pack)$/i;

/** tokens meaning English in a subtitle filename */
const LANG_EN_RX = /(?:^|[^a-z])(?:en|eng|english)(?:[^a-z]|$)/i;

/** non-English language tokens seen in release subtitle filenames */
const LANG_OTHER = new Set(("ara|arabic|ab|fre|fra|french|vf|vff|spa|esp|spanish|español|ger|deu|german|ita|italian|" +
  "pt|por|pob|brazilian|portuguese|rus|russian|hin|hindi|tam|tamil|tel|telugu|mal|malayalam|kan|kannada|ben|bangla|bengali|" +
  "mar|marathi|pan|punjabi|guj|gujarati|urd|urdu|nep|nepali|sin|sinhala|tur|turkish|fas|far|persian|farsi|heb|hebrew|" +
  "kor|korean|jpn|japanese|chi|zho|chinese|mandarin|tha|thai|vie|vietnamese|ind|bahasa|indo|malay|dut|dutch|pol|polish|" +
  "ukr|ukrainian|cze|czech|hun|hungarian|rum|romanian|gre|greek|swe|swedish|nor|norwegian|dan|danish|fin|finnish|" +
  "bul|bulgarian|hrv|croatian|srp|serbian|slk|slovak|slv|slovenian|est|estonian|lav|latvian|lit|lithuanian|" +
  "tagalog|filipino").split("|"));
/** short codes that collide with ordinary words/titles — only trusted with extra context */
const LANG_RISKY_SHORT = new Set(["it", "no", "hi", "id", "da", "go", "mr", "ml", "so", "pa"]);

const MIN_TRUST_BYTES = 15000;          // sidecars ≥ this size are trusted blindly
const NON_LATIN_MAX_RATIO = 0.06;       // >6% non-basic-latin letters ⇒ definitely not English

function langFromFilename(stem) {
  if (LANG_EN_RX.test(stem)) return "en";
  const tokens = stem.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const hits = tokens.filter(t => LANG_OTHER.has(t));
  if (!hits.length) return null;
  // bare short codes can be titles ("It (2017)", "NO.") — demand weak extra evidence
  const solid = hits.find(t => !LANG_RISKY_SHORT.has(t));
  if (solid) return "other";
  const endsWithYear = /^(?:19|20)\d{2}$/.test(tokens[tokens.length - 1] ?? "");
  return hits.some(t => !LANG_RISKY_SHORT.has(t)) || (endsWithYear && tokens.length <= 3) ? "other" : null;
}

/**
 * Content sanity/language check for subtitle files whose name gives no language,
 * or which are suspiciously small. Reads at most 256 KB.
 * @returns {{usable:boolean, why:string}}
 */
function inspectSubFile(filePath, cache) {
  let st;
  try { st = fs.statSync(filePath); } catch { return { usable: false, why: "unreadable" }; }
  if (st.size < 120) return { usable: false, why: "tiny(<120B)" };

  const key = keyOf(filePath);
  const cached = cache?.[key];
  if (cached && cached.mtime === st.mtimeMs) return { usable: cached.usable, why: cached.why };

  let buf;
  try { buf = fs.readFileSync(filePath).subarray(0, 262144); } catch { return { usable: false, why: "read-error" }; }
  const text = buf.toString("utf8");
  const cues = (text.match(/-->/g) ?? []).length;
  let result;
  if (cues === 0) result = { usable: false, why: "no-cues(not-srt)" };
  else {
    // crude non-English script detector
    const letters = text.replace(/[^\p{L}]/gu, "");
    const latinCount = (letters.match(/\p{Script=Latin}/gu) ?? []).length;
    const nonLatinRatio = letters.length ? 1 - latinCount / letters.length : 1;
    const minCues = st.size < MIN_TRUST_BYTES ? 25 : 5;
    result = cues >= minCues && nonLatinRatio <= NON_LATIN_MAX_RATIO
      ? { usable: true, why: `ok(${cues}cues)` }
      : { usable: false, why: `${cues < minCues ? "few-cues:" + cues : "non-latin:" + Math.round(nonLatinRatio * 100) + "%"}` };
  }
  if (cache) cache[key] = { mtime: st.mtimeMs, usable: result.usable, why: result.why };
  return result;
}

/**
 * Find an English-usable subtitle for a video.
 * Checks: ① sidecar next to the video (with fake-file protection),
 *          ② files inside neighbouring `sub`, `subs`, `Subtitles`… directories (recursively).
 * @returns {{path:string, source:'sidecar'|'subdir', note:string}|null}
 */
export function findEnglishSub(videoPath, cache = {}) {
  const vdir = path.dirname(videoPath);
  let entries;
  try { entries = fs.readdirSync(vdir, { withFileTypes: true }); } catch { return null; }
  const base = BASE(path.basename(videoPath)).toLowerCase();

  const judge = (absPath, stemLower, allowNameLang) => {
    const rel = stemLower.slice(base.length);
    // explicit ".en/.eng" tag right after base name: trust instantly
    if (/^\.(?:en|eng)(?:\.[a-z0-9_-]+)?$/.test(rel)) return { usable: true, note: "en-tag" };
    const lang = allowNameLang ? langFromFilename(BASE(stemLower)) : null;
    if (lang === "en") {
      let sz = 0; try { sz = fs.statSync(absPath).size; } catch {}
      return sz >= 500 ? { usable: true, note: "name=english" } : { usable: false, note: "english-tiny" };
    }
    if (lang === "other") return { usable: false, note: "named-other-lang" };
    // untagged file: content decides
    const ins = inspectSubFile(absPath, cache);
    return ins.usable ? { usable: true, note: ins.why } : { usable: false, note: ins.why };
  };

  // ① sidecars in the same directory
  const dirs = [];
  for (const ent of entries) {
    if (!SUB_EXTS.has(path.extname(ent.name).toLowerCase())) {
      if (ent.isDirectory() && SUB_DIR_RX.test(ent.name)) dirs.push(ent.name);
      continue;
    }
    const stem = BASE(ent.name).toLowerCase();
    const abs = path.join(vdir, ent.name);
    if (stem === base) {
      let sz = 0; try { sz = fs.statSync(abs).size; } catch {}
      if (sz >= MIN_TRUST_BYTES) return { path: abs, source: "sidecar", note: `${sz}B` };
      // suspicious stub (user-reported: fake 1-10KB srt) → verify contents instead
      const ins = inspectSubFile(abs, cache);
      if (ins.usable) return { path: abs, source: "sidecar", note: ins.why };
      continue;                                    // fake: fall through to sub-packs / download
    }
    if (/^\.(?:en|eng)(?:\.[a-z0-9_-]+)?$/.test(stem.slice(base.length))) {
      const r = judge(abs, stem, false);
      if (r.usable) return { path: abs, source: "sidecar", note: r.note };
    }
  }

  // ② bundled subtitle directories
  for (const d of dirs) {
    let stack = [path.join(vdir, d)], guard = 0;
    while (stack.length && guard++ < 200) {
      const cur = stack.pop();
      let des;
      try { des = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of des) {
        if (e.isDirectory()) { if (!e.name.startsWith(".")) stack.push(path.join(cur, e.name)); continue; }
        if (!SUB_EXTS.has(path.extname(e.name).toLowerCase())) continue;
        const r = judge(path.join(cur, e.name), BASE(e.name).toLowerCase(), true);
        if (r.usable) return { path: path.join(cur, e.name), source: "subdir", note: r.note };
      }
    }
  }
  return null;
}

/** boolean convenience used by scanner paths */
export function hasUsableSub(videoPath, cache = {}) {
  return !!findEnglishSub(videoPath, cache);
}

// ---------------------------------------------------------------------------
// Filename intelligence
// ---------------------------------------------------------------------------

const QUALITY_CUT = /\b(?:2160p|1080p|720p|480p|360p|4k|web[\s._-]?(?:rip|dl|hdtv)|blu\s?-?ray|br\s?-?rip|bd\s?-?rip|hd\s?-?rip|hdts|dvd\s?-?rip|dvdscr|cam\s?-?rip|hc\b|xvid|x264|h\.?\s?264|x265|h\.?\s?265|hevc|avc\b|hdtv|amzn|nf\b|hmax|dsnp|max\b|atvp)\b/i;

/** Titles like "Adventure Time (2010) Season 1-10 S01-10 (1080p HMAX.WEBDL x265 ...)" -> "Adventure Time" */
export function cleanShowName(rawSeg) {
  let t = String(rawSeg).replace(/\[[^\]]*\]/g, " ");
  t = t.replace(/\(\s*(?:19|20)\d{2}(?:\s*[-–]\s*(?:19|20)\d{2})?\s*\)/g, " ");       // (2010), (1996 - 1999)
  t = t.replace(/\((?:[^)]*(?:yts|pahe|mkvcinemas|hdhub|web|blu|ray|hevc|x26[45]|aac|ac3|ddp?)[^)]*)\)/gi, " ");
  t = t.replace(/[._]+(?=\S)/g, " ");
  for (let i = 0; i < 4; i++) {
    t = t.replace(/^(?:.*?\s)?-\s*(?:complete|full)[^\w]*(?:.*)$/i, "$1");             // "... - Complete 2005-2007 ..."
    t = t.replace(/\bseason[s]?\b.*$/i, "");
    t = t.replace(/\bs\d{1,2}\s*([-–—]|to|through)\s*s?\d{1,2}\b.*$/i, "");
    t = t.split(QUALITY_CUT)[0];
    if (!/\bseason|\bs\d/i.test(t)) break;
  }
  t = t.replace(/\s*[-–—]+\s*$/, "").replace(/^(?:19|20)\d{2}\s*/, "").replace(/\s+/g, " ").trim();
  t = t.replace(/\s*\((?:part|season|vol)\s*[^)]*\)$/i, "").trim();
  // trailing lone season token ("3 Body Problem S01") when it leaves ≥2 words
  const beforeSeason = t.replace(/\s+\bS\d{1,2}\b.*$/i, "").trim();
  if (beforeSeason.split(/\s+/).length >= 2 && !/^s\d/i.test(t)) t = beforeSeason;
  return t.trim();
}

/** Movie-ish cleaner: "10 Cloverfield Lane (2016) 1080p" / "Movie.Name.2019.1080p.BluRay.x264-GRP" */
export function cleanMovieTitle(rawSeg) {
  let t = String(rawSeg).replace(/\[[^\]]*\]/g, " ");
  t = t.replace(/\(\s*(?:19|20)\d{2}(?:\s*[-–]\s*(?:19|20)\d{2})?\s*\)/g, " ");
  t = t.replace(/\(\s*\)/g, " ").replace(/~/g, " ");
  // release junk inside remaining parens
  t = t.replace(/\([^)]*\)/g, (m) => QUALITY_CUT.test(m) ? " " : m);
  t = t.replace(/[._]+(?=[^\s])/g, " ");
  t = t.split(QUALITY_CUT)[0];
  // trailing release-group "-GRP"
  t = t.replace(/\s*-\s*[a-z0-9_@]{1,15}$/i, "");
  t = t.replace(/^[\s\-–_.]+/, "").replace(/[\s\-–_.]+$/, "");
  t = t.replace(/\s{2,}/g, " ").trim();
  return t.trim();
}

/**
 * Guess metadata from full path.
 * @returns {{kind:'movie',title:string,year:number|null}
 *          |{kind:'episode',show:string,title:string,season:number,episode:number}}
 */
export function guessMeta(videoPath) {
  const segs = norm(videoPath).split("/").filter(Boolean);
  const fname = segs[segs.length - 1];
  const parentDir = segs.length >= 2 ? segs[segs.length - 2] : "";
  const underTv = segs.some(s => /^tv[\s._-]*series$/i.test(s));
  const underMovies = segs.some(s => /^movies$/i.test(s));

  // ---- episode patterns -----------------------------------------------
  // NOTE: '\b' fails around S01E01 when separated by UNDERSCORES ('_S01'), so
  // anchor on any non-alphanumeric instead.
  let m = /(?:^|[^a-z0-9])s(\d{1,2})[\s._-]{0,3}e(\d{1,4})(?!\d)/i.exec(fname)
       || /(?:^|[^a-z0-9])s(\d{1,2})[\s._-]{0,3}e(\d{1,4})(?!\d)/i.exec(parentDir);
  if (!m) m = /(?:^|[^a-z0-9])(\d{1,2})x(\d{1,3})(?!\d)/i.exec(fname);
  if (!m && underTv) {
    // season hint: "Season 02" in any nearby segment, or leading S01 in folder names
    let seasonHint = null;
    for (const seg of segs.slice(-3)) {
      const sm = /\bseason[\s._-]{0,2}(\d{1,2})\b/i.exec(seg) ?? /\bs(\d{1,2})(?:\b|\s|$)/i.exec(seg);
      if (sm && !(seg === fname)) { seasonHint = sm[1]; break; }
    }
    const eEp = /(?:^|[\s._-])(?:ep\b|e)(?![a-z])[\s._-]{0,2}(\d{1,4})\b(?!\d)/i.exec(BASE(fname));
    const eWord = /\bepisode[s]?[\s._-]{0,2}(\d{1,4})\b/i.exec(BASE(fname));
    const bareNum = /^[\[(]?\s*(\d{1,4})\s*[\])]?(?:\s*[-–_.].*)?$/.exec(BASE(fname));
    if (eEp || eWord || bareNum) {
      m = [null, seasonHint ?? (eEp ? guessSeasonFromEpisode(segs[segs.length - 2]) : null) ?? "1",
           (eWord ?? eEp ?? bareNum)[1]];
      // bare numbers with a real word title are ambiguous; only trust them inside a Season-labeled path
      if (!seasonHint && bareNum && !eEp && !eWord) m = null;
    }
  }

  // Find show-name segment: the child dir right under "TV Series"
  const tvIdx = segs.findIndex(s => /^tv[\s._-]*series$/i.test(s));
  const showSeg = underTv && segs.length > tvIdx + 1 ? segs[tvIdx + 1] : parentDir;

  if (m) {
    const season = parseInt(m[1], 10);
    const episode = parseInt(m[2], 10);
    const show = cleanShowName(showSeg);
    return { kind: "episode", show, title: show, season, episode };
  }

  // ---- movie -----------------------------------------------------------
  const yParent = /\b(19|20)\d{2}\b/.exec(cleanYearish(parentDir));
  const yName = /\b(19|20)\d{2}\b/.exec(fname);
  const year = yName ? parseInt(yName[0], 10) : yParent ? parseInt(yParent[0], 10) : null;

  let title;
  if (underMovies) {
    const mvIdx = segs.findIndex(s => /^movies$/i.test(s));
    const movieSeg = segs[mvIdx + 1] ?? parentDir;
    title = cleanMovieTitle(movieSeg) || cleanMovieTitle(BASE(fname));
  } else {
    title = cleanMovieTitle(BASE(fname)) || cleanMovieTitle(parentDir);
  }
  return { kind: "movie", title, year };
}

function cleanYearish(s) {
  return String(s).replace(/^(?:19|20)\d{2}(?:\s|$)+/, "");   // folders that START with a year aren't a year-stamp of nothing
}

// ---------------------------------------------------------------------------
// opensubtitles.com hash
// ---------------------------------------------------------------------------

export async function openSubtitlesHash(filePath) {
  const fh = await fs.promises.open(filePath, "r");
  try {
    const size = (await fh.stat()).size;
    const READ = 65536;
    let acc = BigInt(size) & 0xffffffffffffffffn;
    const readChunk = async (off) => {
      const len = Math.min(READ, Math.max(0, size - off));
      if (len <= 0) return;
      const buf = Buffer.alloc(len);
      const r = await fh.read(buf, 0, len, off);
      for (let i = 0; i + 8 <= r.bytesRead; i += 8) {
        acc = (acc + buf.readBigUInt64LE(i)) & 0xffffffffffffffffn;
      }
    };
    await readChunk(0);
    await readChunk(Math.max(0, size - READ));
    return acc.toString(16).padStart(16, "0");
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function http(url, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fetch(url, {
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30000),
        redirect: opts.redirect ?? "follow",
        ...opts,
        headers: { "User-Agent": "Mozilla/5.0 SubtitleFetcher/1.0", ...(opts.headers || {}) },
      });
    } catch (e) {
      lastErr = e;
      if (i < tries) await sleep(1200 * i);
    }
  }
  throw lastErr;
}

function plausibleSub(buf) {
  if (!buf || buf.length < 80) return false;
  const head = buf.subarray(0, 40000).toString("latin1");
  return (head.match(/-->/g) ?? []).length >= 2;      // needs ≥2 cue timings to pass
}

function decodeToText(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) {                          // gzip
    try { return zlib.gunzipSync(buf); } catch {}
  }
  try { return zlib.inflateSync(buf); } catch {}                      // zlib / deflate
  try { return zlib.inflateRawSync(buf); } catch {}                   // raw zip stream member?
  return buf;                                                         // assume plain text/zip
}

/** Parse local-file headers of a zip into [{name,size,data}] (store + deflate only). */
export function listZipEntries(buf) {
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) return null;
  const out = [];
  let i = 0;
  while (i < buf.length - 30) {
    if (buf.readUInt32LE(i) !== 0x04034b50) { i++; continue; }
    const flags = buf.readUInt16LE(i + 6);
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString("utf8").replace(/^\/+/, "");
    const dataStart = i + 30 + nameLen + extraLen;
    if (!(flags & 0x08) && compSize > 0 && compSize < buf.length) {
      try {
        const raw = buf.subarray(dataStart, dataStart + compSize);
        const data = method === 8 ? zlib.inflateRawSync(raw)
                   : method === 0 ? raw
                   : Buffer.alloc(0);
        out.push({ name, size: data.length, data });
        i = dataStart + compSize;
        continue;
      } catch { /* fallthrough */ }
    }
    i = dataStart > i ? dataStart : i + 1;   // unknown sizes / damaged member: resync by scanning
  }
  return out;
}

/** rank a candidate srt filename inside a pack against what we're fetching */
function entryScore(nameLower, meta) {
  let s = 0;
  if (/forced/.test(nameLower)) s -= 6;
  if (meta?.kind === "episode") {
    const se = `s${String(meta.season).padStart(2, "0")}e${String(meta.episode).padStart(2, "0")}`;
    if (nameLower.includes(se)) s += 100;
    else if (new RegExp(`\\b${meta.season}x${String(meta.episode).padStart(2, "0")}\\b`).test(nameLower)) s += 90;
    else {
      const epTok = new RegExp(`(?:^|[\\s._-])0?${meta.episode}(?:[\\s._-]|$)`).test(nameLower.replace(/\.srt$/, ""));
      s += epTok && !/complete|pack/i.test(nameLower) ? 40 : -25;
    }
  }
  return s;
}

const FOREIGN_NAME_RX = new RegExp(
  "\\b(ar|ara|arabic|fa|per|farsi|heb|hebrew|ru|rus|russian|zh|chi|zho|chinese|ko|kor|korean|ja|jp|jpn|japanese|" +
  "brazilian|por|portuguese|fre|fra|french|spa|spanish|ger|deu|german|ita|italian|dut|nl|dutch|pol|polish|tur|turkish|" +
  "vie|vietnamese|tha|thai|ind|bahasa|indonesian|urdu|hindi|tamil|telugu|malayalam|vostfr)\\b", "i");

/** extract the best-fitting English .srt payload from zipped/gzipped/binary/plain response */
function extractSrt(buf, meta = null) {
  const entries = listZipEntries(buf);
  if (entries?.length) {
    const srts = entries.filter(e => /\.srt$/i.test(e.name) && e.size > 60);
    if (srts.length) {
      let pool = srts.filter(e => !FOREIGN_NAME_RX.test(e.name));
      if (!pool.length) pool = srts;                       // all foreign-named → still better than failing
      pool.sort((a, b) =>
        (meta ? entryScore(a.name.toLowerCase(), meta) - entryScore(b.name.toLowerCase(), meta) : 0) ||
        b.size - a.size);
      return pool[0].data.toString("utf8");
    }
  }
  return decodeToText(buf).toString("utf8");
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/* ---- 1. opensubtitles.com ------------------------------------------------ */

class OpenSubtitlesProvider {
  constructor(cfg, state) {
    this.cfg = cfg; this.state = state;
    this.id = "os";
    this.base = "https://api.opensubtitles.com/api/v1";
    this.enabled = !!cfg.apiKey;
    this.quotaLeft = typeof state.osRemaining === "number" ? state.osRemaining : Infinity;
  }

  hdr(withAuth) {
    const h = { "Api-Key": this.cfg.apiKey, Accept: "application/json" };
    if (withAuth && this.state.osToken?.token) h.Authorization = `Bearer ${this.state.osToken.token}`;
    return h;
  }

  async ensureLogin() {
    if (!this.cfg.username || !this.cfg.password) return;
    const t = this.state.osToken;
    if (t?.token && Date.now() < (t.expiresAt ?? 0)) return;
    const res = await http(`${this.base}/login`, {
      method: "POST",
      headers: { "Api-Key": this.cfg.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username: this.cfg.username, password: this.cfg.password }),
    });
    if (!res.ok) throw Object.assign(new Error(`OpenSubtitles login ${res.status} — check credentials`), { fatal: true });
    const j = await res.json();
    this.state.osToken = { token: j.token, expiresAt: Date.now() + 23 * 3600e3 };
    saveState(this.state);
  }

  /** ranked search: exact-file hash match first, then textual fallback */
  async search(ctx, meta) {
    await this.ensureLogin();
    const langs = this.cfg.language;
    const queries = [];
    if (ctx.hash) queries.push(new URLSearchParams({ languages: langs, moviehash: ctx.hash }));
    if (meta.kind === "episode") {
      queries.push(new URLSearchParams({
        languages: langs, type: "episode", query: meta.show,
        season_number: String(meta.season), episode_number: String(meta.episode),
      }));
    } else {
      if (meta.year) queries.push(new URLSearchParams({ languages: langs, type: "movie", query: meta.title, year: String(meta.year) }));
      queries.push(new URLSearchParams({ languages: langs, type: "movie", query: meta.title }));
    }

    const seen = new Set();
    const cands = [];
    for (const q of queries) {
      const res = await http(`${this.base}/subtitles?${q}`, { headers: this.hdr(true) });
      if (res.status === 401) throw Object.assign(new Error("OpenSubtitles auth failed (bad Api-Key/token)"), { fatal: true });
      if (!res.ok) throw new Error(`search ${res.status}`);
      const j = await res.json();
      for (const item of j.data ?? []) {
        const a = item.attributes;
        const hi = !!a.hearing_impaired, ai = !!a.ai_translated, foreign = !!a.foreign_parts_only;
        if (foreign) continue;
        if (hi && !this.cfg.hearingImpairedOk) continue;
        if (ai && !this.cfg.aiTranslatedOk) continue;
        for (const f of a.files ?? []) {
          const fid = f.file_id;
          if (fid == null || seen.has(fid)) continue;
          seen.add(fid);
          cands.push({ fid, ai, hi, score:
            (ai ? 0 : 50) + (hi ? 0 : 25) +
            (a.points ?? 0) + (a.ratings ?? 0) * 10 + (a.votes ?? 0) / 100 +
            (f.upload_count ?? a.upload_count ?? 0) / 200 });
        }
      }
      if (cands.length >= 8) break;
    }
    return cands.sort((x, y) => y.score - x.score).slice(0, 6);
  }

  async fetchCandidate(ctx, cand) {
    const res = await http(`${this.base}/download`, {
      method: "POST",
      headers: { ...this.hdr(true), "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: cand.fid }),
    });

    if (res.status === 406) {
      const j = await res.json().catch(() => ({}));
      this.quotaLeft = 0;
      throw Object.assign(
        new Error(`OpenSubtitles quota exhausted: ${j.message ?? res.statusText}`),
        { quotaExhausted: true });
    }
    if (res.status === 429) {
      const waitSec = parseInt(res.headers.get("retry-after") || "10", 10);
      await sleep(waitSec * 1000 + 250);
      return this.fetchCandidate(ctx, cand);
    }
    if (!res.ok) throw new Error(`download ${res.status}`);

    const j = await res.json().catch(() => null);
    if (!j?.link) throw new Error("no download link returned");

    if (typeof j.remaining === "number") { this.quotaLeft = j.remaining; this.state.osRemaining = j.remaining; }
    const resetAt = j.reset_time_utc ? Date.parse(j.reset_time_utc) : null;
    if (resetAt) this.state.osReset = resetAt;

    const dl = await http(j.link, { timeoutMs: 60000 });
    if (!dl.ok) throw new Error(`CDN ${dl.status}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    const text = extractSrt(buf);
    if (!plausibleSub(Buffer.from(text))) throw new Error("not a usable .srt");
    return text.replace(/^﻿/, "");
  }
}

/* ---- 2. podnapisi ---------------------------------------------------------- */
/* Enabled after verification step; implements their site JSON endpoint used widely by tools. */

class PodnapisiProvider {
  constructor(cfg) { this.id = "pn"; this.enabled = true; this.cfg = cfg; }

  async search(ctx, meta) {
    const q = new URLSearchParams({ language: this.cfg.language });
    if (ctx.hash) q.set("moviehash" /*unsupported*/ , ""); void ctx;
    if (meta.kind === "episode") {
      q.set("season", String(meta.season));
      q.set("episode", String(meta.episode));
      q.set("movies", meta.show);
    } else {
      q.set("movies", meta.title);
      if (meta.year) q.set("year", String(meta.year));
    }
    const res = await http(`https://podnapisi.net/subtitles/search/old?${q}`, { timeoutMs: 25000 });
    if (!res.ok) throw new Error(`pn search ${res.status}`);
    const html = await res.text();

    // result cards: links to subtitle detail pages "/subtitles/<id>" plus names
    const found = [];
    const rx = /\/subtitles\/([a-zA-Z0-9]+)(?:\/[^"]*)?"/g;
    let mch;
    while ((mch = rx.exec(html)) && found.length < 8) {
      const id = mch[1];
      if (!found.includes(id)) found.push(id);
    }
    return found.map(id => ({ id, score: found.length }));
  }

  async fetchCandidate(_ctx, cand) {
    // detail page holds the real download URL in a data attribute / href of the Download button
    const res = await http(`https://podnapisi.net/subtitles/${cand.id}`, { timeoutMs: 25000 });
    if (!res.ok) throw new Error(`pn detail ${res.status}`);
    const html = await res.text();
    const dlMatch =
      /data-(?:href|url)="(https:\/\/podnapisi\.net\/static\/[^"]+)"/.exec(html) ||
      /href="(https:\/\/podnapisi\.net\/subtitles\/[^"]*\/download[^"]*)"/i.exec(html) ||
      /(https:\/\/podnapisi\.net\/static\/[a-z0-9/-]+\/ppdf[a-z0-9]+\.zip)/i.exec(html);
    if (!dlMatch) throw new Error("no download url on page");
    const dl = await http(dlMatch[1], { timeoutMs: 60000 });
    if (!dl.ok) throw new Error(`pn cdn ${dl.status}`);
    const text = extractSrt(Buffer.from(await dl.arrayBuffer()));
    if (!plausibleSub(Buffer.from(text))) throw new Error("pn not srt");
    return text.replace(/^﻿/, "");
  }
}

/* ---- 3. gestdown (TV only) -------------------------------------------------- */

class GestdownProvider {
  constructor(cfg) { this.id = "gd"; this.enabled = true; this.cfg = cfg; }

  async search(ctx, meta) {
    if (meta.kind !== "episode") return [];
    const res = await http("https://api.gestdown.tv/subtitles/find", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ show: meta.show, season: meta.season, episode: meta.episode }),
      timeoutMs: 25000,
    });
    if (!res.ok) throw new Error(`gd search ${res.status}`);
    const j = await res.json().catch(() => null);
    if (!j?.subtitles?.length) return [];
    return j.subtitles
      .filter(s => !this.cfg.aiTranslatedOk ? true : true)
      .map(s => ({ id: s.subtitleId ?? s.id, lang: s.language, released: s.released, version: s.version }))
      .map(x => ({ ...x, score: 10 }))
      .slice(0, 5);
  }

  async fetchCandidate(ctx, cand) {
    const info = await http(`https://api.gestdown.tv/subtitles/info/${cand.id}`, { timeoutMs: 25000 });
    if (!info.ok) throw new Error(`gd info ${info.status}`);
    const j = await info.json().catch(() => null);
    const frameshifted = j?.subtitle?.frameshifted ? "&frameshift=true" : "";
    const dl = await http(`https://api.gestdown.tv/subtitles/download/${cand.id}${frameshifted}`, { timeoutMs: 60000 });
    if (!dl.ok) throw new Error(`gd dl ${dl.status}`);
    const text = extractSrt(Buffer.from(await dl.arrayBuffer()));
    if (!plausibleSub(Buffer.from(text))) throw new Error("gd not srt");
    return text.replace(/^﻿/, "");
  }
}

/* ---- 4. YIFY subtitles (perfect for the huge YTS part of this library) ------ */

class YtsProvider {
  constructor(cfg) { this.id = "yts"; this.enabled = true; this.cfg = cfg; }

  async search(ctx, meta) {
    if (meta.kind !== "movie" || !meta.title) return [];
    const q = `${meta.title}${meta.year ? " " + meta.year : ""}`;
    const res = await http(`https://yts.mx/api/v2/list_movies.json?limit=5&query_term=${encodeURIComponent(q)}`, { timeoutMs: 25000 });
    if (!res.ok) throw new Error(`yts search ${res.status}`);
    const j = await res.json().catch(() => null);
    const movies = j?.data?.movies ?? [];
    if (!movies.length) return [];
    const pick =
      movies.find(m => meta.year && m.year === meta.year && m.title_long.toLowerCase().startsWith(meta.title.toLowerCase())) ||
      movies.find(m => m.title_long.toLowerCase().includes(meta.title.toLowerCase())) || movies[0];

    const htmlRes = await http(`https://yifysubtitles.com/movie-imdb/${pick.imdb_code}`, { timeoutMs: 30000 });
    if (!htmlRes.ok) throw new Error(`yts subs ${htmlRes.status}`);
    const html = await htmlRes.text();

    // table rows: /subtitle/slugname.zip  with row text containing language + quality flags
    const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(r => r[1]).filter(r => /english/i.test(r));
    const srcQ = /2160p/.test(q) ? "2160" : /1080p/.test(q) ? "1080" : /720p/.test(q) ? "720" : null;
    const cands = rows
      .map(row => ({
        zip: /href="\/subtitle\/([^"]+\.zip)"/.exec(row)?.[1],
        hi: /hearing.impaired/i.test(row),
        quality: /(2160|1080|720)p?/.exec(row)?.[1],
      }))
      .filter(c => c.zip)
      .sort((a, b) =>
        Number(b.quality === srcQ) - Number(a.quality === srcQ) ||
        Number(a.hi) - Number(b.hi))
      .slice(0, 4)
      .map(c => ({ zip: c.zip, hi: c.hi, score: 8 }));
    return cands;
  }

  async fetchCandidate(ctx, cand) {
    const dl = await http(`https://yifysubtitles.com/subtitle/${cand.zip}`, { timeoutMs: 60000 });
    if (!dl.ok) throw new Error(`yts dl ${dl.status}`);
    const text = extractSrt(Buffer.from(await dl.arrayBuffer()));
    if (!plausibleSub(Buffer.from(text))) throw new Error("yts not srt");
    return text.replace(/^﻿/, "");
  }
}

/* ---- 4b. addic7ed.com -------------------------------------------------------
 * Community-maintained TV subtitles. Anonymous downloads work but the site
 * throttles aggressively — we pace requests globally and back off when told.
 * Markup verified live 2026-08; the classic scrapers broke on the button HTML,
 * this parses current structure directly (language cell → /original/S/E link). */

const A7_URL = "https://www.addic7ed.com";
const A7_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
let _a7last = 0;
async function a7Pace(gapMs = 3200) {
  const wait = _a7last + gapMs - Date.now();
  if (wait > 0) await sleep(wait);
  _a7last = Date.now();
}

export class Addic7edProvider {
  constructor(cfg) { this.id = "a7"; this.enabled = true; this.cfg = cfg; }

  async search(_ctx, meta) {
    if (meta.kind !== "episode") return [];                       // TV specialist
    const ss = String(meta.season).padStart(2, "0");
    const ee = String(meta.episode).padStart(2, "0");
    await a7Pace();
    const res = await http(`${A7_URL}/srch.php?search=${encodeURIComponent(`${meta.show} S${ss}E${ee}`)}&Submit=Search`,
      { headers: { "User-Agent": A7_UA }, timeoutMs: 25000, redirect: "manual" });

    let linkPath = null;
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      // unique match: site redirects straight to the episode page
      const loc = String(res.headers.get("location") ?? "").replace(/^https?:\/\/[^/]+/, "");
      if (!/^\/?serie\/[^/]+\/\d+\/\d+\/?/i.test(loc))
        throw new Error(`a7: unexpected redirect ${loc || "(none)"}`);
      linkPath = loc.replace(/^\//, "");
    } else {
      if (!res.ok) throw new Error(`a7 search ${res.status}`);
      const html = await res.text();
      if (/<b>0 results found<\/b>/i.test(html)) return [];
      const linkRx = new RegExp(`href="(serie\\/[^"']+\\/${meta.season}\\/${meta.episode}\\/[^"]*)"`, "i");
      linkPath = linkRx.exec(html)?.[1];
      if (!linkPath) {
        const n = /<b>(\d+) results found<\/b>/i.exec(html)?.[1];
        throw new Error(`a7: no exact serie link (search said '${n ?? "?"}' results)`);
      }
    }
    const pageRes = await http(`${A7_URL}/${linkPath}`, { headers: { "User-Agent": A7_UA }, timeoutMs: 30000 });
    if (!pageRes.ok) throw new Error(`a7 page ${pageRes.status}`);
    const pageHtml = await pageRes.text();

    // Each language cell owns its status cell and download anchor directly after it.
    // "Completed" rows are trusted; rows showing "<b>NN%</b>" are skipped.
    const out = [];
    for (const seg of pageHtml.split(/class="language">/i).slice(1)) {
      const lang = /^[\s]*([\w ()&'-]{3,30}?)\s*<(?:a\b|\/td)/i.exec(seg)?.[1]?.trim() ?? "?";
      if (!/^english$/i.test(lang)) continue;
      const statusCell = seg.slice(0, 700);
      const incomplete = /\b\d{1,3}\s*%(?:\s|<)/i.test(statusCell);
      if (incomplete && !/<b>\s*Completed\s*<\/b>/i.test(statusCell)) continue;
      const href = /href="(\/original\/\d+\/\d+)"/i.exec(seg)?.[1];
      if (!href) continue;
      // nearest "Version …," header above this anchor tells us the release + HI flag
      const anchorPos = pageHtml.lastIndexOf(`href="${href}"`);
      const before = pageHtml.slice(Math.max(0, anchorPos - 3000), anchorPos);
      const heads = [...before.matchAll(/Version [^,<]{3,80},/gi)];
      const headText = heads.length ? heads[heads.length - 1][0] : "";
      out.push({
        href,
        hi: /hearing impaired/i.test(headText),
        team: headText.replace(/^Version\s+/i, "").replace(/,\s*$/, "").trim().slice(0, 60),
        referer: "/" + linkPath,
        score: /hearing impaired/i.test(headText) ? 6 : 10,
      });
    }
    return out.slice(0, 3);
  }

  async fetchCandidate(_ctx, cand) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await a7Pace();
      const res = await http(`${A7_URL}${cand.href}`, {
        headers: { "User-Agent": A7_UA, Referer: A7_URL + cand.referer },
        timeoutMs: 45000,
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const head = buf.subarray(0, 600).toString("latin1");
      const throttled = res.status === 429 || /too many requests|please wait|try again in \d+ seconds/i.test(head);
      if (throttled && attempt === 0) { log(DIM("   a7: throttled, cooling down 25s…")); await sleep(25000); continue; }
      if (throttled) throw Object.assign(new Error("throttled twice"), { quotaExhausted: true, providerId: "a7" });

      const text = buf.toString("utf8").replace(/^﻿/, "");
      if ((text.match(/-->/g) ?? []).length >= 2) {
        cand.pickedRelease = cand.team ? `addic7ed ${cand.team}${cand.hi ? " (HI)" : ""}` : `addic7ed ${cand.href}`;
        return text;
      }
      throw new Error(`not-srt (${res.status}, ${head.slice(30, 90)})`);
    }
    throw new Error("unreachable");
  }
}

/* ---- 5. subdl.com ----------------------------------------------------------
 * Anonymous site scraping: search → subtitle detail pages carry per-language
 * sections; every release row links a direct dl.subdl.com zip.
 * Anonymous downloads are capped (~300/day/IP per community reports) — when the
 * cap trips, zip fetches fail and we flag quota exhaustion for this provider.  */

const SUBDL_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export class SubDlProvider {
  constructor(cfg) { this.id = "sd"; this.enabled = true; this.cfg = cfg; }

  async search(ctx, meta) {
    const q = meta.kind === "episode"
      ? `${meta.show} s${String(meta.season).padStart(2, "0")}`       // season-level query
      : `${meta.title}${meta.year ? " " + meta.year : ""}`;
    const res = await http(`https://subdl.com/search/${encodeURIComponent(q).replace(/%20/g, "+")}`,
                           { headers: { "User-Agent": SUBDL_UA }, timeoutMs: 25000 });
    if (!res.ok) throw new Error(`sd search ${res.status}`);
    const html = await res.text();

    // distinct detail pages (keep exact slug — ids alone 404), in relevance order as served
    const seen = new Set(), out = [];
    for (const m of html.matchAll(/href="(\/subtitle\/sd\d+\/[^"\/?#]+)/g)) {
      const id = /sd\d+/.exec(m[1])[0];
      if (!seen.has(id)) { seen.add(id); out.push({ href: m[1], id, score: 10 }); }
      if (out.length >= 4) break;
    }
    return out;
  }

  /** Pull entries ONLY from English sections of a detail page */
  parseEnglishReleases(html) {
    const marks = [...html.matchAll(/data-language="([a-z_-]+)"[^>]*data-language-name="([^"]*)"/g)]
      .filter(m => /^(en|english)$/.test(m[1]));
    if (!marks.length) return [];
    const entries = [];
    for (let i = 0; i < marks.length; i++) {
      const seg = html.slice(marks[i].index, i + 1 < marks.length ? marks[i + 1].index : undefined);
      for (const chunk of seg.split("<li")) {
        const zi = chunk.indexOf("https://dl.subdl.com/subtitle/");
        if (zi < 0) continue;
        const head = chunk.slice(0, Math.max(zi, 900));
        entries.push({
          zip: /https:\/\/dl\.subdl\.com\/subtitle\/[\d-]+\.zip/.exec(chunk)?.[0],
          rel: /<h4>([^<]{4,120})<\/h4>/.exec(head)?.[1] ?? "",
          fullSeason: /data-full-season(?![a-z-])/.test(chunk.slice(0, 300)),
          epFrom: +(chunk.match(/data-episode-from="?(\d+)/)?.[1] ?? NaN),
          epTo: +(chunk.match(/data-episode-to="?(\d+)/)?.[1] ?? NaN),
        });
      }
    }
    return entries.filter(e => e.zip);
  }

  rankRelease(entry, meta, videoNameLower) {
    let s = 0;
    const rel = entry.rel.toLowerCase().replace(/[._]/g, " ");
    if (meta.kind === "episode") {
      if (!Number.isNaN(entry.epFrom)) {
        if ((entry.epTo >= meta.episode || Number.isNaN(entry.epTo)) && entry.epFrom <= meta.episode) s += 60;
        else s -= 80;
      } else if (entry.fullSeason) s += 40;
      else if (rel.includes(`s${String(meta.season).padStart(2, "0")}`)) s += 25;
      else s -= 20;
    } else if (meta.year && rel.includes(String(meta.year))) s += 30;

    // release-name overlap with our actual file ("inception 2010 720p brrip x264 yify")
    const ourWords = new Set(videoNameLower.split(/[^a-z0-9]+/).filter(w => w.length > 2 && !/^(?:mkv|mp4|x26[45]|hevc)$/.test(w)));
    for (const w of rel.split(" ")) if (ourWords.has(w)) s += 8;
    if (/720p/.test(rel) === /720p/.test(videoNameLower) && /1080p/.test(rel) === /1080p/.test(videoNameLower)) s += 6;
    void meta.titleLower;
    return s;
  }

  async fetchCandidate(ctx, cand) {
    const res = await http(`https://subdl.com${cand.href}`, { headers: { "User-Agent": SUBDL_UA }, timeoutMs: 40000 });
    if (!res.ok) throw new Error(`sd page ${res.status}`);
    const html = await res.text();
    const releases = this.parseEnglishReleases(html);
    if (!releases.length) throw new Error("no english releases on page");

    const videoLower = cand.videoBase?.toLowerCase?.() ?? "";
    releases.sort((a, b) => this.rankRelease(b, cand.meta ?? {}, videoLower) - this.rankRelease(a, cand.meta ?? {}, videoLower));

    for (const pick of releases.slice(0, 3)) {
      cand.pickedRelease = pick.rel;
      const dl = await http(pick.zip, {
        headers: { "User-Agent": SUBDL_UA, Referer: `https://subdl.com${cand.href}` },
        timeoutMs: 60000,
      });
      if (dl.status === 429 || dl.status === 406 ||
          (dl.status === 403 && !/\.zip$/.test(pick.zip))) {   // referer handled; leftover 403 ≈ cap
        throw Object.assign(new Error(`subdl daily cap reached (${dl.status})`), { quotaExhausted: true, providerId: "sd" });
      }
      if (!dl.ok) continue;
      const text = extractSrt(Buffer.from(await dl.arrayBuffer()), cand.meta);
      if (plausibleSub(Buffer.from(text))) return text.replace(/^﻿/, "");
    }
    throw new Error("no usable english file in top releases");
  }
}

const PROVIDER_CLASSES = { os: OpenSubtitlesProvider, a7: Addic7edProvider, sd: SubDlProvider, pn: PodnapisiProvider, gd: GestdownProvider, yts: YtsProvider };

// ---------------------------------------------------------------------------
// Scan + classification
// ---------------------------------------------------------------------------

export function scanRoots(cfg, onProgress) {
  const videos = [];
  if (!cfg.roots?.length) {
    console.error(RED("No library folders configured yet — run:  node subtitles-fetcher.mjs setup"));
    return videos;
  }
  for (const root of cfg.roots) {
    if (!fs.existsSync(root)) { console.error(RED(`Root unreachable: ${root}`)); continue; }
    const rels = fs.readdirSync(root, { recursive: true });
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
export function classify(videos, prior, sniffCache = {}) {
  const out = new Array(videos.length);
  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    let size = 0, mtime = 0;
    try { const s = fs.statSync(v); size = s.size; mtime = s.mtimeMs; } catch { /* vanished */ }
    out[i] = {
      video: v, size, mtime,
      existingSub: size > 0 ? findEnglishSub(v, sniffCache) : null,
      meta: guessMeta(v),
      prev: prior?.[keyOf(v)],
    };
  }
  return out;
}

function refreshInventory(cfg, state, { silent }) {
  const videos = scanRoots(cfg, silent ? null : (n, p) => process.stdout.write(`\r  found ${n}… ${DIM(p.slice(-70))}        `));
  if (!silent) console.log("\r" + " ".repeat(100) + "\r");
  const items = classify(videos, state.files, (state.sniffs ??= {}));

  const keep = new Set();
  for (const it of items) {
    const k = keyOf(it.video);
    keep.add(k);
    const missing = !it.existingSub;
    if (it.size === 0) continue;                                   // unreadable/vanished: leave prior entry untouched
    const p = it.prev;
    if (!p) {
      state.files[k] = { status: missing ? "pending" : "covered", size: it.size, mtime: it.mtime, coverMtime: it.mtime };
      continue;
    }
    // video file changed underneath us? re-evaluate
    if (p.coverMtime !== it.mtime) {
      if (missing && (p.status === "done" || p.status === "covered")) {
        state.files[k] = { status: "pending", size: it.size, mtime: it.mtime, coverMtime: it.mtime };
      } else {
        p.size = it.size; p.mtime = it.mtime; p.coverMtime = it.mtime;
        if (missing && p.status === "covered") p.status = "pending";
      }
    } else if (missing && p.status === "covered") p.status = "pending";
  }
  for (const k of Object.keys(state.files)) if (!keep.has(k)) delete state.files[k];
  state.scannedAt = Date.now();
  saveState(state);
  return items;
}

function summary(state) {
  const vals = Object.values(state.files);
  return {
    total: vals.length,
    covered: vals.filter(v => v.status === "covered" || v.status === "done").length,
    pending: vals.filter(v => v.status === "pending").length,
    failed: vals.filter(v => v.status === "failed").length,
    parked: vals.filter(v => v.status === "parked").length,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdScan(cfg) {
  openLog("scan");
  log(DIM("Scanning library (first run over SMB can take minutes)…"));
  const s = summary(refreshInventoryWrapper(cfg));
  log(`videos total : ${GRN(String(s.total))}`);
  log(`have EN subs : ${GRN(String(s.covered))}`);
  log(`missing      : ${YEL(String(s.pending + s.failed))}`);
  log(`parked       : ${DIM(String(s.parked))}`);
}
function refreshInventoryWrapper(cfg) {
  const state = loadState();
  refreshInventory(cfg, state, { silent: false });
  return state;
}

async function cmdDry(cfg, argv) {
  const nArg = argv.find(a => /^\d+$/.test(a));
  const state = loadState();

  // Fast path: a recent inventory already knows what's missing
  const ageH = (Date.now() - (state.scannedAt ?? 0)) / 3600e3;
  if (!state.scannedAt || ageH > 6) {
    console.log(DIM(state.scannedAt ? `Inventory ${ageH.toFixed(0)}h old — refreshing…` : "No inventory yet — scanning…"));
    refreshInventory(cfg, state, { silent: false });
  }
  const s = summary(state);
  console.log("");
  console.log(`videos: ${s.total} | need subs: ${YEL(String(s.pending + s.failed))}`);
  const queue = Object.entries(state.files)
    .filter(([, r]) => r.status === "pending" || r.status === "failed")
    .slice(0, nArg ? +nArg : 30);
  console.log(DIM(`next ${queue.length}:`));
  for (const [k] of queue) {
    const p = reconstructPath(k, cfg);
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
  const onlySub = onlyIdx >= 0 ? String(argv[onlyIdx + 1] ?? "").toLowerCase() : "";
  openLog("run");
  const started = Date.now();
  const forceScan = argv.includes("--rescan") || argv.includes("--no-skip-refresh");

  const state = loadState();
  const ageH = (Date.now() - (state.scannedAt ?? 0)) / 3600e3;
  if (forceScan || !state.scannedAt || ageH > 20) {
    console.log(DIM(forceScan ? "Refreshing inventory (--rescan)…" : state.scannedAt ? `Inventory ${ageH.toFixed(0)}h old — refreshing…` : "No inventory yet — building…"));
    refreshInventory(cfg, state, { silent: true });
  } else {
    console.log(DIM(`Using inventory scanned ${new Date(state.scannedAt).toLocaleString()} (${ageH.toFixed(1)}h ago; force with --rescan)`));
  }

  let entries = Object.entries(state.files)
    .filter(([, r]) => r.status === "pending" || r.status === "failed")
    .filter(([k]) => !onlySub || k.includes(onlySub))
    .map(([k, r]) => ({ k, ...r }));

  if (argv.includes("--oldest-last")) entries.reverse();  // undocumented convenience

  if (!entries.length) { log(GRN("✔ Nothing pending — whole library covered.")); return; }
  if (limit) entries = entries.slice(0, limit);

  // instantiate providers in configured order
  const provs = cfg.providers
    .map(id => PROVIDER_CLASSES[id])
    .filter(Boolean)
    .map(C => new C(cfg, state))
    .filter(p => p.enabled);

  if (!provs.length) {
    log(RED("No providers enabled. Configure apiKey first:  node subtitles-fetcher.mjs setup"));
    process.exitCode = 1;
    return;
  }
  if (!provs.some(p => p.id === "os") && cfg.providers.includes("os"))
    log(YEL("(opensubtitles.com skipped — no apiKey yet; falling back to keyless sources only)"));

  log(`queue: ${entries.length}${limit ? ` (limited run)` : ""} via [${provs.map(p => p.id).join(", ")}]\n`);

  const stats = { done: 0, missed: 0, perProvider: {} };
  const deadProviders = new Set();          // hit a daily cap during this run

  for (const e of entries) {
    if (deadProviders.size >= provs.length) {
      log(RED("⏸ Every configured source has hit its daily cap — stopping. Re-run tomorrow; queue preserved."));
      break;
    }

    const shortName = e.k.split("/").slice(-2).join("/");
    const meta = guessMeta(e.videoPath ?? reconstructPath(e.k, cfg));
    const ctx = {};

    let gotText = null, usedProv = null, candInfo = null, lastFailNote = "";

    /** remember the most informative failure reason for state.json */
    const noteFail = (msg) => { if (msg) lastFailNote = String(msg).slice(0, 180); };
    const vPath = reconstructPath(e.k, cfg);
    const videoBaseName = BASE(path.basename(vPath));

    for (const prov of provs) {
      if (deadProviders.has(prov.id)) continue;
      if (prov.id === "os" && prov.quotaLeft <= 0) { deadProviders.add("os"); continue; }
      let cands = [];
      try {
        cands = (await prov.search(ctx, meta)).slice(0, 4);
      } catch (err) {
        if (err.fatal) { log(RED(`⛔ ${err.message}`)); process.exitCode = 2; return finish(); }
        log(DIM(`   ${prov.id}: ${err.message}`));
        noteFail(`${prov.id}: ${err.message}`);
        if (err.quotaExhausted) { deadProviders.add(err.providerId ?? prov.id); log(RED(`   ↳ ${prov.id} daily cap reached — skipping it for the rest of this run.`)); }
        continue;
      }
      for (const cand of cands) {
        cand.meta = meta;
        cand.videoBase = videoBaseName;
        try {
          gotText = await prov.fetchCandidate(ctx, cand);
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
      const dest = `${BASE(reconstructPath(e.k, cfg))}.en.srt`;
      try {
        fs.writeFileSync(dest, "﻿" + gotText);
        state.files[e.k] = { ...(state.files[e.k] ?? {}), status: "done", provider: usedProv, when: new Date().toISOString(),
                              rel: String(candInfo?.pickedRelease ?? "").slice(0, 80) || undefined,
                              hi: !!candInfo?.hi, ai: !!candInfo?.ai };
        stats.done++; stats.perProvider[usedProv] = (stats.perProvider[usedProv] ?? 0) + 1;
        const tag = candInfo?.pickedRelease ? DIM(`  « ${String(candInfo.pickedRelease).slice(0, 58)} »`) : "";
        log(GRN(` ✔ ${shortName}${tag}`));
      } catch (wErr) {
        const rec = state.files[e.k] ?? {};
        rec.attempts = (rec.attempts ?? 0) + 1; rec.lastError = `write failed: ${wErr.message}`;
        rec.status = rec.attempts >= cfg.attemptsBeforePark ? "parked" : "failed"; rec.when = new Date().toISOString();
        state.files[e.k] = rec;
        log(RED(` ! write failed ${shortName}: ${wErr.message}`));
        stats.missed++;
      }
    } else {
      const rec = state.files[e.k] ?? {};
      rec.attempts = (rec.attempts ?? 0) + 1;
      rec.lastError = lastFailNote || "no provider had it";
      rec.when = new Date().toISOString();
      rec.status = rec.attempts >= cfg.attemptsBeforePark ? "parked" : "failed";
      state.files[e.k] = rec;
      stats.missed++;
      log(DIM(` ✖ ${shortName}`));
    }

    if ((stats.done + stats.missed) % 5 === 0) saveState(state);
  }

  function finish() {
    saveState(state);
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    log("\n──── summary ────");
    log(` downloaded : ${GRN(String(stats.done))} ${JSON.stringify(stats.perProvider)}`);
    log(` missed     : ${stats.missed}`);
    const left = summary(loadState());
    log(` still queued: ${left.pending + left.failed} ${DIM(`(${mins} min)`)}`);

    // self-documenting failures: this run's misses with their reasons
    if (stats.missed > 0 && stats.missed <= 60) {
      const failDetails = Object.entries(state.files)
        .filter(([, r]) => r.status === "failed" && r.when && Date.now() - Date.parse(r.when) < mins * 60000 + 5000)
        .slice(0, 60);
      if (failDetails.length) {
        log(DIM("─── this run's failures ───"));
        for (const [k, r] of failDetails)
          log(DIM(` ✖ …${k.split("/").slice(-2).join("/")} — ${r.lastError ?? "?"} (attempt ${r.attempts})`));
      }
    } else if (stats.missed > 60) {
      log(DIM(`(${stats.missed} misses — per-item reasons in state.json / dim lines above)`));
    }
    logStream?.end();
  }
  finish();
}

/** keys are lowercase-normalized; rebuild a working absolute path from cfg.roots.
 *  Windows/UNC paths are case-insensitive, so lowercase remainder resolves fine. */
function reconstructPath(key, cfg) {
  for (const r of cfg.roots) {
    const rk = norm(r).toLowerCase();
    if (key.toLowerCase().startsWith(rk)) return norm(r) + key.slice(rk.length);
  }
  return key;
}

function guessSeasonFromEpisode(seg) {
  return /\bs(\d{1,2})\b/i.exec(seg ?? "")?.[1] ?? null;
}

async function cmdStatus() {
  const s = summary(loadState());
  console.log(`videos total : ${s.total}`);
  console.log(` have EN subs: ${GRN(String(s.covered))}`);
  console.log(` missing     : ${YEL(String(s.pending + s.failed))} (queued ${s.pending}, retrying ${s.failed})`);
  console.log(` parked      : ${DIM(String(s.parked))}`);
  const st = loadState();
  if (typeof st.osRemaining === "number")
    console.log(` OS quota left: ${st.osRemaining === 0 ? RED("0 (resets daily)") : st.osRemaining}`);
}

async function cmdRetry(cfg, substr) {
  if (!substr) { console.log("usage: retry <substring-of-path>"); return; }
  const needle = substr.toLowerCase();
  const state = loadState();
  let hits = 0;
  for (const [k, rec] of Object.entries(state.files)) {
    if (!k.includes(needle)) continue;
    if (["failed", "parked"].includes(rec.status)) { rec.status = "pending"; rec.attempts = 0; }
    if (rec.status === "done") { /* force re-fetch: remove sidecar check happens next scan */ rec.status = "pending"; rec.attempts = 0; }
    if (rec.status === "pending") hits++;
  }
  saveState(state);
  console.log(`${hits} matching entries queued for '${substr}'…`);
  await cmdRun(cfg, ["--limit", String(hits || 1), "--only", needle]);
}

async function cmdProbe(cfg, target) {
  if (!target) { console.log("usage: probe <full-or-relative-video-path>"); return; }
  let p = norm(target);
  if (!p.startsWith("//")) {
    for (const r of cfg.roots) {
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
  const roots = [];
  if (cfg.roots?.length) for (const r of cfg.roots) roots.push(r);
  while (true) {
    const line = (await ask(` folder ${roots.length + 1} ${roots.length ? DIM("(blank = done)") : ""}: `)).trim();
    if (!line && roots.length) break;
    if (!line) continue;
    roots.push(line.replace(/^"(.*)"$/, "$1"));
  }
  cfg.roots = roots;

  console.log(DIM(`
② Sources — subdl.com works anonymously (~300 downloads/day per IP).
   Adding a FREE opensubtitles.com key adds hash-perfect fallback:
     register https://www.opensubtitles.com → Dashboard → API Keys.`));
  cfg.apiKey = (await ask(YEL(" OpenSubtitles API key (blank to skip): "))).trim() || cfg.apiKey;
  if (cfg.apiKey) {
    cfg.username = (await ask(" OpenSubtitles username : ")).trim();
    cfg.password = (await ask(" OpenSubtitles password : ")).trim();
  }
  const pv = (await ask(` providers [${cfg.providers.join(",") ?? "sd,os"}]: `)).trim();
  if (pv) cfg.providers = pv.split(",").map(s => s.trim()).filter(Boolean);

  console.log(DIM("\n③ Automation — registers a daily run"));
  const schedQ = (await ask(YEL(" schedule daily? time like 13:05 (blank = skip): "))).trim();
  saveConfig(cfg);
  console.log(GRN("\n✔ config.json saved"));
  rl.close();

  if (/^\d{1,2}[:.]?\d{2}$/.test(schedQ)) {
    await cmdSchedule(cfg, [schedQ]);
  } else {
    console.log(DIM("\nYou can enable automation later with:"));
    console.log(`  node subtitles-fetcher.mjs schedule 13:05`);
  }
  console.log(GRN("\nNext: node subtitles-fetcher.mjs dry   (preview)\n      node subtitles-fetcher.mjs run    (first fetch)\n"));
}

async function cmdSchedule(cfg, args) {
  const tm = /^(\d{1,2})[:.]?(\d{2})$/.exec(args.find(a => /^\d/.test(a)) ?? cfg.taskTime);
  if (tm) cfg.taskTime = `${tm[1].padStart(2, "0")}:${tm[2]}`;
  saveConfig(cfg);

  if (process.platform === "win32") {
    if (args.includes("--remove")) {
      try { execSync('schtasks /Delete /TN "SubtitleFetcherDaily" /F', { stdio: "inherit" }); }
      catch { console.log("task was not registered"); }
      return;
    }
    // A one-line .cmd launcher sidesteps every schtasks quoting trap
    const bat = path.join(SCRIPT_DIR, "run-daily.cmd");
    fs.writeFileSync(bat,
      `@echo off\r\ncd /d "${SCRIPT_DIR}"\r\nif not exist logs mkdir logs\r\n"${process.execPath}" subtitles-fetcher.mjs run >> logs\\task.log 2>&1\r\n`);
    execSync(`schtasks /Create /F /SC DAILY /ST ${cfg.taskTime} /TN "SubtitleFetcherDaily" /TR "'${bat}'"`,
      { stdio: "pipe", timeout: 20000 });
    console.log(GRN(`✔ daily Windows task registered for ${cfg.taskTime} (log: logs\\task.log)`));
    return;
  }

  // ---- Linux / macOS: crontab ----
  const MARK = "# subtitle-fetcher";
  const list = () => execSync("crontab -l 2>/dev/null", { encoding: "utf8", timeout: 10000 }).trim();
  if (args.includes("--remove")) {
    try {
      execSync(`crontab -l 2>/dev/null | grep -v '${MARK}' | crontab -`, { shell: "/bin/sh", timeout: 10000 });
      console.log(GRN("✔ cron entries removed"));
    } catch { console.log(YEL("no cron entries found")); }
    return;
  }
  const [hh, mm] = cfg.taskTime.split(":");
  const node = process.execPath;                       // absolute → survives nvm/volta PATH quirks in cron
  const line = `${mm} ${hh} * * * cd '${SCRIPT_DIR}' && ${node} subtitles-fetcher.mjs run >> logs/task.log 2>&1 ${MARK}`;
  let cur = "";
  try { cur = list(); } catch {}                        // empty crontab
  const kept = cur.split("\n").filter(l => !l.includes(MARK) && l.trim());
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const tmp = path.join(LOG_DIR, ".crontab.tmp");
  fs.writeFileSync(tmp, [...kept, line, ""].join("\n") + "\n");
  execSync(`crontab '${tmp}'`, { timeout: 10000 });
  fs.rmSync(tmp, { force: true });
  void hh;
  console.log(GRN(`✔ daily cron entry installed for ${cfg.taskTime} (verify: crontab -l | grep subtitle)`));
}

const fmtSize = n => n > 1e9 ? (n / 1e9).toFixed(2) + " GB" : n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : n / 1e3 + " KB";

// ---------------------------------------------------------------------------
// CLI dispatch — only when executed directly (not when imported as a module)
// ---------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  const [, , command = "run", ...rest] = process.argv;
  const cfg = loadConfig();

  try {
    switch (command) {
      case "scan": await cmdScan(cfg); break;
      case "dry": await cmdDry(cfg, rest); break;
      case "run": await cmdRun(cfg, process.argv); break;
      case "status": await cmdStatus(); break;
      case "retry": await cmdRetry(cfg, rest.join(" ")); break;
      case "probe": await cmdProbe(cfg, rest.join(" ")); break;
      case "setup": await cmdSetup(cfg); break;
      case "schedule": await cmdSchedule(cfg, rest); break;
      default:
        console.log(`Unknown command '${command}'. Try: scan | dry | run | status | retry | probe | setup | schedule`);
    }
  } catch (e) {
    console.error(RED("Fatal: " + (e?.stack ?? e)));
    process.exitCode = 1;
  }
}
