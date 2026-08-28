// opensubtitles.com REST API v1 — the hash-exact fallback. Needs a free
// personal Api-Key; logging in with the account raises the daily download
// allowance. The API reports exact remaining quota on every download, which
// we mirror into state (state.osRemaining) and surface in the web UI.

import { http } from "../http.mjs";
import { sleep } from "../utils.mjs";
import { extractSrt, plausibleSub } from "./subtitle-file.mjs";

export class OpenSubtitlesProvider {
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
  }

  /** ranked search: exact-file hash match first, then textual fallback */
  async search(ctx, meta) {
    await this.ensureLogin();
    const langs = this.cfg.language ?? "en";
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
        { quotaExhausted: true, providerId: "os" });
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
    const text = extractSrt(buf, ctx.meta);
    if (!plausibleSub(Buffer.from(text))) throw new Error("not a usable .srt");
    return text.replace(/^﻿/, "");
  }
}
