// Resilient HTTP with retries and timeout — one place so providers and the
// web layer share redirect/UA/timeout behavior.

import { sleep } from "./utils.mjs";

export async function http(url, opts = {}, tries = 3) {
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
