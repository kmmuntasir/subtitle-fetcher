// Subtitle payload handling: zip/gzip decoding, archive member selection,
// and plausibility checks. Shared by every provider.

import zlib from "node:zlib";

export function plausibleSub(buf) {
  if (!buf || buf.length < 80) return false;
  const head = buf.subarray(0, 40000).toString("latin1");
  return (head.match(/-->/g) ?? []).length >= 2;      // needs ≥2 cue timings to pass
}

export function decodeToText(buf) {
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
export function extractSrt(buf, meta = null) {
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
