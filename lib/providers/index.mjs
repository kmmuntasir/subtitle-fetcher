// Provider registry. `id` order in config.providers is the per-item fallback
// order. Add new sources by implementing search(ctx, meta) → [candidates]
// and fetchCandidate(ctx, cand) → subtitle text.

import { Addic7edProvider } from "./addic7ed.mjs";
import { SubDlProvider } from "./subdl.mjs";
import { OpenSubtitlesProvider } from "./opensubtitles.mjs";
import { PodnapisiProvider, GestdownProvider, YtsProvider } from "./dormant.mjs";

export const PROVIDER_CLASSES = {
  a7: Addic7edProvider,
  sd: SubDlProvider,
  os: OpenSubtitlesProvider,
  pn: PodnapisiProvider,
  gd: GestdownProvider,
  yts: YtsProvider,
};

/** instantiate the enabled provider chain in configured order */
export function buildProviders(cfg, state) {
  return (cfg.providers ?? [])
    .map(id => [id, PROVIDER_CLASSES[id]])
    .filter(([, C]) => C)
    .map(([id, C]) => new C(cfg, state))
    .filter(p => p.enabled !== false);
}
