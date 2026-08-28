// Dormant keyless providers: podnapisi.net, gestdown.tv, yifysubtitles.
// Their domains are DNS-blocked on some networks (notably ours, probed
// 2026-08). Adapters kept intact so they activate the moment they resolve.

import { http } from "../http.mjs";
import { extractSrt, plausibleSub } from "./subtitle-file.mjs";

/* ---- podnapisi ---------------------------------------------------------- */

export class PodnapisiProvider {
  constructor(cfg) { this.id = "pn"; this.enabled = true; this.cfg = cfg; }

  async search(ctx, meta) {
    const q = new URLSearchParams({ language: this.cfg.language ?? "en" });
    void ctx;
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

/* ---- gestdown (TV only) --------------------------------------------------- */

export class GestdownProvider {
  constructor(cfg) { this.id = "gd"; this.enabled = true; this.cfg = cfg; }

  async search(ctx, meta) {
    if (meta.kind !== "episode") return [];
    void ctx;
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
      .map(s => ({ id: s.subtitleId ?? s.id, lang: s.language, released: s.released, version: s.version }))
      .map(x => ({ ...x, score: 10 }))
      .slice(0, 5);
  }

  async fetchCandidate(_ctx, cand) {
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

/* ---- YIFY subtitles -------------------------------------------------------- */

export class YtsProvider {
  constructor(cfg) { this.id = "yts"; this.enabled = true; this.cfg = cfg; }

  async search(ctx, meta) {
    if (meta.kind !== "movie" || !meta.title) return [];
    void ctx;
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

  async fetchCandidate(_ctx, cand) {
    const dl = await http(`https://yifysubtitles.com/subtitle/${cand.zip}`, { timeoutMs: 60000 });
    if (!dl.ok) throw new Error(`yts dl ${dl.status}`);
    const text = extractSrt(Buffer.from(await dl.arrayBuffer()));
    if (!plausibleSub(Buffer.from(text))) throw new Error("yts not srt");
    return text.replace(/^﻿/, "");
  }
}
