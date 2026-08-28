// State + activity store. state.json is the per-video ledger (format
// unchanged from v1); activity.jsonl is an append-only event log that powers
// the web UI's live feed and reports. A small ring buffer mirrors the tail.

import fs from "node:fs";
import path from "node:path";

export function loadState(statePath) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return { files: {}, totals: {}, osToken: null, sniffs: {}, scannedAt: 0, ...s };
  } catch {
    return { files: {}, totals: {}, osToken: null, sniffs: {}, scannedAt: 0 };
  }
}

export function saveState(statePath, state) {
  const tmp = statePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, statePath);
}

export function summary(state) {
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
// Activity log
// ---------------------------------------------------------------------------

const RING_MAX = 500;
const ring = [];
let activityPath = null;

export function initActivity(logDir) {
  fs.mkdirSync(logDir, { recursive: true });
  activityPath = path.join(logDir, "activity.jsonl");
}

/** append one engine/UI event: {ev:"download", key, provider, release, ...} */
export function pushActivity(evt) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...evt });
  ring.push(line);
  if (ring.length > RING_MAX) ring.shift();
  if (activityPath) {
    try { fs.appendFileSync(activityPath, line + "\n"); } catch { /* best effort */ }
  }
}

export function getActivity(limit = 100) {
  return ring.slice(-limit).reverse();
}
