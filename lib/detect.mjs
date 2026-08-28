// Subtitle presence detection: decides whether a video is already covered.
// Handles the real-world traps: bundled `Subs/` packs, foreign-only packs,
// fake stub `.srt` files (saved HTML error pages), language-tagged sidecars.

import fs from "node:fs";
import path from "node:path";
import { SUB_EXTS } from "./consts.mjs";
import { BASE, keyOf } from "./utils.mjs";

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

export function langFromFilename(stem) {
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
export function inspectSubFile(filePath, cache) {
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
    // share of letters NOT in Latin script (covers Cyrillic/Arabic/CJK/Devanagari…)
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
