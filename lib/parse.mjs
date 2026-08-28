// Filename intelligence: extract movie/episode metadata from library paths.
// Pure functions — no filesystem access — so they're trivially testable.

import { norm } from "./utils.mjs";

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
  // leading folder numbering ("001 Puss Gets The Boot" → "Puss Gets The Boot"),
  // but keep genuine numeric titles ("1", "10", "21") — only strip when the
  // number is zero-padded or clearly a label before multiple words.
  const num = /^(\d{1,4})[\s._-]+(\S.*)$/.exec(t);
  if (num && (/^0/.test(num[1]) || num[2].trim().split(/\s+/).length >= 2)) t = num[2];
  t = t.replace(/^[\s\-–_.]+/, "").replace(/[\s\-–_.]+$/, "");
  t = t.replace(/\s{2,}/g, " ").trim();
  return t.trim();
}

function cleanYearish(s) {
  return String(s).replace(/^(?:19|20)\d{2}(?:\s|$)+/, "");   // folders that START with a year aren't a year-stamp of nothing
}

function guessSeasonFromEpisode(seg) {
  return /\bs(\d{1,2})\b/i.exec(seg ?? "")?.[1] ?? null;
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
    const eEp = /(?:^|[\s._-])(?:ep\b|e)(?![a-z])[\s._-]{0,2}(\d{1,4})\b(?!\d)/i.exec(fname.replace(/\.[^.]+$/, ""));
    const eWord = /\bepisode[s]?[\s._-]{0,2}(\d{1,4})\b/i.exec(fname);
    const bareNum = /^[\[(]?\s*(\d{1,4})\s*[\])]?(?:\s*[-–_.].*)?$/.exec(fname.replace(/\.[^.]+$/, ""));
    if (eEp || eWord || bareNum) {
      m = [null, seasonHint ?? (eEp ? guessSeasonFromEpisode(segs[segs.length - 2]) : null) ?? "1",
           (eWord ?? eEp ?? bareNum)[1]];
      // bare numbers with a real word title are ambiguous; only trust them inside a Season-labeled path
      if (!seasonHint && bareNum && !eEp && !eWord) m = null;
    }
  }

  // Find show-name segment: the first meaningful dir under "TV Series".
  // Junk intermediates ("720p", "tv", season packs…) are skipped.
  const JUNK_SEG = /^(?:720p|1080p|2160p|480p|4k|tv|movies|series|shows|all.?shows|completed|offline|x265|hevc|x264|aac\d?\.?0?|web-?dl|bluray|brrip|bdrip|hdrip|dvdrip|10bit|8bit|dual.?audio|esubs?|hindi|english|dubbed|techcrackr.?only|mkv.?cinemas.?only|pahe\.?in|galaxytv|tgx|rarbg|yts.*|me?ga|pack|new|done)$/i;
  const tvIdx = segs.findIndex(s => /^tv[\s._-]*series$/i.test(s));
  let showSeg = parentDir;
  if (underTv) {
    for (let i = tvIdx + 1; i < segs.length - 1; i++) {      // last seg is the file
      if (!JUNK_SEG.test(segs[i])) { showSeg = segs[i]; break; }
    }
    if (JUNK_SEG.test(showSeg)) showSeg = segs[segs.length - 2] ?? parentDir;
  }

  if (m) {
    const season = parseInt(m[1], 10);
    const episode = parseInt(m[2], 10);
    const show = cleanShowName(showSeg);
    // capture air-year / year-range for the library UI ("Friends (1994 - 2004)")
    const ym = /\(\s*((?:19|20)\d{2})(?:\s*[-–—]\s*((?:19|20)\d{2}))?\s*\)/.exec(showSeg)
            ?? /\b((?:19|20)\d{2})\s*[-–—]\s*((?:19|20)\d{2})\b/.exec(showSeg);
    const years = ym ? [parseInt(ym[1], 10), ym[2] ? parseInt(ym[2], 10) : null] : null;
    return { kind: "episode", show, title: show, season, episode, years };
  }

  // ---- movie -----------------------------------------------------------
  const yParent = /\b(19|20)\d{2}\b/.exec(cleanYearish(parentDir));
  const yName = /\b(19|20)\d{2}\b/.exec(fname);
  const year = yName ? parseInt(yName[0], 10) : yParent ? parseInt(yParent[0], 10) : null;

  let title;
  if (underMovies) {
    const mvIdx = segs.findIndex(s => /^movies$/i.test(s));
    const movieSeg = segs[mvIdx + 1] ?? parentDir;
    title = cleanMovieTitle(movieSeg) || cleanMovieTitle(fname.replace(/\.[^.]+$/, ""));
  } else {
    title = cleanMovieTitle(fname.replace(/\.[^.]+$/, "")) || cleanMovieTitle(parentDir);
  }
  return { kind: "movie", title, year };
}
