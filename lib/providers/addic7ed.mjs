// addic7ed.com — community TV subtitles. Anonymous downloads work but the
// site throttles aggressively: all requests pass through a global pacer and
// throttle pages trigger cooldowns.
// Markup verified live 2026-08. Two search modes handled:
//   • unique match  → 302 redirect straight to the episode page
//   • multi match   → HTML results list with serie/<slug>/<S>/<E>/ links

import { http } from "../http.mjs";
import { sleep } from "../utils.mjs";
import { log, DIM } from "../logger.mjs";
import { plausibleSub } from "./subtitle-file.mjs";

const A7_URL = "https://www.addic7ed.com";
const A7_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
let _a7last = 0;
let _a7gap = 3200;

export function setA7Gap(ms) { if (ms > 0) _a7gap = ms; }

async function a7Pace() {
  const wait = _a7last + _a7gap - Date.now();
  if (wait > 0) await sleep(wait);
  _a7last = Date.now();
}

export class Addic7edProvider {
  constructor(cfg) {
    this.id = "a7";
    this.enabled = true;
    this.cfg = cfg;
    setA7Gap(cfg?.fetch?.politenessMs?.a7);
  }

  async search(_ctx, meta) {
    if (meta.kind !== "episode") return [];                       // TV specialist
    const ss = String(meta.season).padStart(2, "0");
    const ee = String(meta.episode).padStart(2, "0");
    // first term as-is; fallback drops a trailing year ("… 2005") which the
    // site's show titles never carry
    const terms = [`${meta.show} S${ss}E${ee}`];
    const noYear = meta.show.replace(/\s+\b(?:19|20)\d{2}\b\s*$/i, "").trim();
    if (noYear && noYear !== meta.show) terms.push(`${noYear} S${ss}E${ee}`);

    let linkPath = null;
    for (const term of terms) {
      await a7Pace();
      const res = await http(`${A7_URL}/srch.php?search=${encodeURIComponent(term)}&Submit=Search`,
        { headers: { "User-Agent": A7_UA }, timeoutMs: 25000, redirect: "manual" });

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        // unique match: site redirects straight to the episode page
        const loc = String(res.headers.get("location") ?? "").replace(/^https?:\/\/[^/]+/, "");
        if (!/^\/?serie\/[^/]+\/\d+\/\d+\/?/i.test(loc))
          throw new Error(`a7: unexpected redirect ${loc || "(none)"}`);
        linkPath = loc.replace(/^\//, "");
        break;
      }
      if (!res.ok) throw new Error(`a7 search ${res.status}`);
      const html = await res.text();
      const linkRx = new RegExp(`href="(serie\\/[^"']+\\/${meta.season}\\/${meta.episode}\\/[^"]*)"`, "i");
      linkPath = linkRx.exec(html)?.[1] ?? null;
      if (linkPath) break;                                        // else try next term variant
    }
    if (!linkPath) return [];

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
      if (plausibleSub(buf) || (text.match(/-->/g) ?? []).length >= 2) {
        cand.pickedRelease = cand.team ? `addic7ed ${cand.team}${cand.hi ? " (HI)" : ""}` : `addic7ed ${cand.href}`;
        return text;
      }
      throw new Error(`not-srt (${res.status}, ${head.slice(30, 90)})`);
    }
    throw new Error("unreachable");
  }
}
