// subdl.com — anonymous site scraping: search → subtitle detail pages carry
// per-language sections; every release row links a direct dl.subdl.com zip.
// Anonymous downloads are capped (~300/day/IP per community reports). The cap
// manifests two ways (both observed 2026-08):
//   • hard: zip fetch returns 403/406/429 after the referer is present
//   • soft: search pages return 200 with result lists silently stripped
// The engine tracks a per-UTC-day download counter to anticipate the soft block.

import { http } from "../http.mjs";
import { extractSrt, plausibleSub } from "./subtitle-file.mjs";

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
