// Subtitle Fetcher web UI — vanilla JS, no build step.
// Token: taken from ?token=… once, then kept in localStorage.

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---- token + fetch helper ---------------------------------------------------
let TOKEN = new URLSearchParams(location.search).get("token") || localStorage.getItem("sf_token") || "";
if (new URLSearchParams(location.search).get("token")) {
  localStorage.setItem("sf_token", TOKEN);
  history.replaceState(null, "", location.pathname);        // clean the address bar
}

async function api(path, opts = {}) {
  const res = await fetch(`/api/${path}`, {
    ...opts,
    headers: { "X-Auth-Token": TOKEN, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (res.status === 401) { document.body.innerHTML = `<div style="padding:40px;font-family:system-ui">🔒 Unauthorized — open this page with <code>?token=…</code> (see service startup log).</div>`; throw new Error("unauthorized"); }
  const j = await res.json().catch(() => ({ ok: false, error: "bad json" }));
  if (!j.ok) throw new Error(j.error || res.statusText);
  return j.data;
}
const post = (p, body) => api(p, { method: "POST", body: JSON.stringify(body ?? {}) });

// ---- tabs ---------------------------------------------------------------------
function showTab(name) {
  $$(".tab").forEach(t => t.hidden = t.id !== "tab-" + name);
  $$("nav a").forEach(a => a.classList.toggle("active", a.hash === "#/" + name));
  if (name === "dashboard") loadDashboard();
  if (name === "folders") loadFolders();
  if (name === "queue") loadQueue();
  if (name === "library") loadLibrary();
  if (name === "logs") loadLogList();
  if (name === "settings") loadSettings();
}
addEventListener("hashchange", () => showTab(location.hash.slice(2) || "dashboard"));

// ---- dashboard -------------------------------------------------------------------
let lastChartKey = "";
function renderDashboard(st) {
  $("#engineDot").className = "dot " + (st.engine.running ? "busy" : "on");
  $("#enginePhase").textContent = st.engine.running ? st.engine.phase + (st.engine.current ? " · " + st.engine.current.label : "") : "idle";
  $("#btnStop").hidden = !st.engine.running;
  $("#btnRun").disabled = st.engine.running;
  $("#btnScan").disabled = st.engine.running;

  const t = st.totals;
  $("#tiles").innerHTML = [
    tile(t.total, "Videos", ""), tile(t.covered, "Subtitled", "ok"),
    tile(t.pending, "Pending", "warn"), tile(t.failed, "Failed", "bad"), tile(t.parked, "Parked", ""),
    tile(st.sdDownloadsToday, "SubDL today", "warn"),
  ].join("");

  $("#providers").innerHTML = st.providers.map(p =>
    `<span class="pill ${p.quotaLeft === 0 ? "bad" : "ok"}"><b>${p.id}</b>${p.quotaLeft === null ? "ready" : p.quotaLeft + " left"}</span>`).join("")
    + `<span class="pill">sd used today: <b>${st.sdDownloadsToday}</b></span>`;

  $("#lastRun").textContent = st.engine.lastResult
    ? `${st.engine.lastResult.done} downloaded · ${st.engine.lastResult.missed} missed · ${st.engine.lastResult.minutes} min (${st.engine.lastResult.at.slice(0, 16).replace("T", " ")})`
    : "no run yet this session";
  if (st.scannedAt) $("#lastRun").textContent += ` · scan ${st.scannedAt.slice(0, 16).replace("T", " ")}`;
  if (st.lan) $("#lanUrl").innerHTML = `<a href="${esc(st.lan.url)}/?token=${encodeURIComponent(st.lan.token)}">${esc(st.lan.url)}</a>`;

  // re-pull the 14-day chart only when the covered count actually moved
  const ck = `${t.covered}/${t.total}`;
  if (ck !== lastChartKey) { lastChartKey = ck; loadChart().catch(() => {}); }
}
async function loadDashboard() {
  const st = await api("status");
  renderDashboard(st);
  if (!feedEl.dataset.backfilled) { feedEl.dataset.backfilled = "1"; feedBackfill(); }
}
async function loadChart() {
  const r = await api("report?days=14");
  const days = r.downloadsPerDay;
  const max = Math.max(1, ...days.map(([, n]) => n));
  const map = Object.fromEntries(days);
  const cols = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10);
    const n = map[d] ?? 0;
    cols.push(`<div class="col"><div class="num">${n || ""}</div><div class="bar" style="height:${Math.round(84 * n / max)}px"></div><div class="day">${d.slice(5)}</div></div>`);
  }
  $("#chart").innerHTML = cols.join("");
  const total = r.byProvider.reduce((a, [, n]) => a + n, 0) || 1;
  $("#provShare").innerHTML = r.byProvider.map(([p, n]) =>
    `<span class="pill"><b>${esc(p)}</b>${n} (${Math.round(100 * n / total)}%)</span>`).join("") || `<span class="muted">no downloads in window yet</span>`;
}
const tile = (num, lbl, cls) => `<div class="tile ${cls}"><div class="num">${num ?? 0}</div><div class="lbl">${lbl}</div></div>`;

// SSE live feed — append-only; autoscrolls ONLY while you're pinned to bottom
const feedEl = $("#feed");
function feedAppend(html) {
  const atBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 48;
  const div = document.createElement("div");
  div.className = "line";
  div.innerHTML = html;
  feedEl.appendChild(div);
  while (feedEl.children.length > 300) feedEl.removeChild(feedEl.firstChild);
  if (atBottom) feedEl.scrollTop = feedEl.scrollHeight;
}
async function feedBackfill() {
  try {
    const items = await api("activity?limit=60");        // newest-first → append oldest first
    for (const line of items.reverse()) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      feedAppend(renderEvent(e));
    }
    feedEl.scrollTop = feedEl.scrollHeight;              // start pinned
  } catch { /* service may be busy */ }
}
try {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(TOKEN)}`);
  es.onmessage = (m) => {
    let e; try { e = JSON.parse(m.data); } catch { return; }
    if (e.ev === "hello") return;
    if (e.ev === "status") { renderDashboard(e.data); return; }   // live tile updates
    feedAppend(renderEvent(e));
  };
} catch { /* SSE optional */ }

function esc(s) { return String(s ?? "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }
const STATUS_LABEL = { done: "Done", covered: "Covered", pending: "Pending", failed: "Failed", parked: "Parked" };
const fmtStatus = (s) => STATUS_LABEL[s] ?? s;
const chip = (s) => `<span class="st ${s}">${fmtStatus(s)}</span>`;
const fmtOutcome = (o) => ({ kept: "Kept", replaced: "Replaced", rejected: "Rejected" }[o] ?? o ?? "");
const field = (label, value) => value ? `<div class="f"><span>${label}</span><b>${value}</b></div>` : "";
function renderEvent(e) {
  const t = new Date(e.t ?? Date.now()).toLocaleTimeString("en-GB", { hour12: false });   // viewer-local
  if (e.line) return `<span class="miss">${esc(t)} ${esc(e.line)}</span>`;
  switch (e.ev) {
    case "item_start": return `${esc(t)} Searching — ${esc(e.label ?? e.key)}`;
    case "download": return `<span class="dl">${esc(t)} Downloaded — ${esc(e.label)} · ${esc(e.provider)} · ${esc(e.release ?? "")}${e.hi ? " · Hearing impaired" : ""}${e.ai ? " · AI translated" : ""}</span>`;
    case "miss": return `<span class="miss">${esc(t)} No match — ${esc(e.label)}${e.reason ? ` (${esc(e.reason)})` : ""}</span>`;
    case "quota": return `<span class="warn2">${esc(t)} Quota reached — ${esc(e.provider ?? e.detail ?? "")}</span>`;
    case "replace": return `<span class="dl">${esc(t)} Subtitle replaced — ${esc(e.key.split("/").pop())} → ${esc(e.release)}</span>`;
    case "priority": return `<span class="warn2">${esc(t)} Priority requested — ${esc(e.key.split("/").pop())}</span>`;
    case "scan": return `<span class="warn2">${esc(t)} Scan complete — ${e.total ?? "?"} videos, ${e.pending ?? "?"} pending</span>`;
    case "scan_start": return `${esc(t)} Scan started — walking the library…`;
    case "scan_walk": {
      const segs = String(e.path ?? "").split(/[\\/]+/).filter(Boolean);
      return `${esc(t)} Scanning — …${esc(segs.slice(-3).join(" › "))}`;
    }
    case "scan_progress": return `${esc(t)} Scan — ${e.n ?? "?"}/${e.total ?? "?"} files`;
    case "streak_stop": return `<span class="warn2">${esc(t)} Run paused — ${e.misses ?? "?"} misses in a row; retrying after backoff</span>`;
    case "park": return `<span class="miss">${esc(t)} Parked — ${esc((e.key ?? "").split("/").pop())}</span>`;
    case "error": return `<span class="warn2">${esc(t)} Error — ${esc(e.message ?? e.detail ?? "")}</span>`;
    case "config": return `${esc(t)} Settings updated`;
    case "art_saved": return `${esc(t)} Poster saved into library`;
    case "run_start": return `<span class="warn2">${esc(t)} Run started — ${e.queue} items queued</span>`;
    case "run_end": return `<span class="warn2">${esc(t)} Run finished — ${e.done} downloaded, ${e.missed} unmatched</span>`;
    case "log": return esc(t) + " " + esc(e.line ?? "");
    default: {
      const name = String(e.ev ?? "event").replace(/_/g, " ");
      return `${esc(t)} ${name.charAt(0).toUpperCase() + name.slice(1)}`;
    }
  }
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.hidden = true, 4000);
}
addEventListener("error", (e) => toast("⚠ " + (e.message ?? "script error")));
addEventListener("unhandledrejection", (e) => toast("⚠ " + (e.reason?.message ?? e.reason ?? "async error")));
const guarded = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast("⚠ " + e.message); } };

$("#btnScan").onclick = guarded(async () => { await post("scan"); showTab("dashboard"); });
$("#btnRun").onclick = guarded(async () => { await post("run"); showTab("dashboard"); });
$("#btnStop").onclick = guarded(async () => { await post("stop"); setTimeout(loadDashboard, 400); });

// ---- folders ---------------------------------------------------------------------
async function loadFolders() {
  const [cfg, st] = await Promise.all([api("config"), api("status")]);
  const stats = Object.fromEntries((st.perRoot ?? []).map(r => [r.path, r]));
  const roots = (cfg.roots ?? []).map(r => typeof r === "string" ? { path: r, type: "auto" } : r);
  $("#rootList").innerHTML = roots.length
    ? roots.map((r, i) => {
        const s = stats[r.path];
        const dot = !s ? "·" : s.reachable ? "🟢" : "🔴";
        const counts = s ? `${s.done}/${s.total} covered${s.pending ? `, ${s.pending} queued` : ""}` : "not scanned yet";
        return `<div class="root"><span>${dot}</span> <span class="st">${r.type ?? "auto"}</span>
        <span><span class="path">${esc(r.path)}</span><br><span class="muted" style="font-size:12px">${counts}</span></span>
        <button data-del="${i}" class="danger" style="margin-left:auto">remove</button></div>`;
      }).join("")
    : `<div class="muted">No folders yet — browse or type a path below.</div>`;
  $$("#rootList [data-del]").forEach(b => b.onclick = async () => {
    roots.splice(+b.dataset.del, 1);
    await api("config", { method: "PUT", body: JSON.stringify({ roots }) });
    loadFolders();
  });
}

let browserPath = "";
$("#btnBrowse").onclick = async () => { $("#browser").hidden = false; browse(""); };
async function browse(p) {
  const d = await api("fs?path=" + encodeURIComponent(p));
  browserPath = d.path;
  $("#crumbs").innerHTML = d.parent !== undefined && d.parent !== null
    ? `◀ <a href="#" onclick="browse(${JSON.stringify(d.parent)});return false">${esc(d.parent)}</a> <b>${esc(d.path)}</b>`
    : `<b>${esc(d.path || "root")}</b>`;
  $("#dirList").innerHTML = (d.dirs ?? []).map(x =>
    `<div onclick="browse(${JSON.stringify(x)})">${esc(x.split(/[\\/]/).filter(Boolean).pop() || x)}</div>`).join("") || "<div class='muted'>(no subfolders)</div>";
  $("#pickLabel").textContent = "selected: " + d.path;
  $("#btnPick").disabled = !d.path;
}
window.browse = browse;

$("#btnPick").onclick = () => { $("#manualPath").value = browserPath; };
$("#btnAddRoot").onclick = async () => {
  const p = $("#manualPath").value.trim();
  if (!p) return;
  const cfg = await api("config");
  const roots = (cfg.roots ?? []).map(r => typeof r === "string" ? { path: r, type: "auto" } : r);
  roots.push({ path: p, type: $("#rootType").value });
  await api("config", { method: "PUT", body: JSON.stringify({ roots }) });
  $("#manualPath").value = "";
  loadFolders();
};

// ---- queue -------------------------------------------------------------------------
let qPage = 1;
$("#btnQGo").onclick = () => { qPage = 1; loadQueue(); };
$("#qPrev").onclick = () => { qPage = Math.max(1, qPage - 1); loadQueue(); };
$("#qNext").onclick = () => { qPage++; loadQueue().catch(() => qPage--); };

async function loadQueue() {
  const sp = new URLSearchParams({
    status: $("#qStatus").value, type: $("#qType").value,
    q: $("#qSearch").value.trim(), page: qPage, per: 60,
  });
  const d = await api("queue?" + sp);
  $("#qCount").textContent = `${d.total.toLocaleString()} items`;
  const y = window.scrollY;
  $("#qTable tbody").innerHTML = d.items.map(it => `<tr>
    <td>${chip(it.status)}</td>
    <td>${esc(it.name ?? it.key.split("/").slice(-2).join("/"))}</td>
    <td class="path">${esc(it.rel ?? it.lastError ?? "")}</td>
    <td>${it.attempts ?? 0}</td>
    <td><button data-k="${esc(it.key)}" class="ghost qitem">Detail</button></td>
  </tr>`).join("");
  $$("#qTable .qitem").forEach(b => b.onclick = () => itemModal(b.dataset.k));
  window.scrollTo(0, y);
}
// keep the queue list current while its tab is open (statuses shift on every
// engine event); preserves filters, page and scroll position
setInterval(() => {
  if (!$("#tab-queue") || $("#tab-queue").hidden) return;
  loadQueue().catch(() => {});
}, 10000);

async function itemModal(key, backShow = null) {
  const it = await api("items/" + encodeURIComponent(key));
  $("#modal").hidden = false;
  const kind = it.meta?.kind === "episode" ? "tv" : "movie";
  $("#modalBody").innerHTML = `
    ${backShow ? `<button id="mBackShow" class="ghost" style="margin-bottom:8px">← ${esc(backShow)}</button>` : ""}
    <div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap">
      ${artImg(it.key, it.meta?.title ?? it.meta?.show ?? "", "thumb")}
      <div style="flex:1;min-width:260px">
        <h3 style="margin:0 0 4px">${esc(it.meta?.title ?? it.meta?.show ?? it.key.split("/").pop())}</h3>
        <p class="path" style="margin:0 0 10px">${esc(it.key)}</p>
        <div class="fields">
          ${field("Status", chip(it.status))}
          ${field("Attempts", String(it.attempts ?? 0))}
          ${field("Source", it.provider ? esc(it.provider) : "")}
          ${field("Release", it.rel ? esc(it.rel) : "")}
          ${field("Downloaded", it.when ? esc(it.when.slice(0, 16).replace("T", " ")) : "")}
          ${field("Flags", [it.hi ? "Hearing impaired" : "", it.ai ? "AI translated" : ""].filter(Boolean).join(", "))}
          ${field("Last error", it.lastError ? esc(it.lastError) : "")}
        </div>
      </div>
    </div>
    <div class="row">
      <button id="mRetry" class="primary">Requeue</button>
      <button id="mPrio" class="primary">${icon("zap")} Fetch Now · Priority</button>
      <button id="mAlts">${icon("search")} Find Alternatives</button>
      <button id="mPark" class="ghost">${it.status === "parked" ? "Unpark" : "Park"}</button>
    </div>
    ${it.history?.length ? `<div class="hist"><b style="font-size:12px">History</b>${it.history.slice().reverse().map(h =>
      `<div>${esc(h.at?.slice(0, 16).replace("T", " ") ?? "")} · ${esc(h.provider ?? "?")} · ${esc(h.release ?? "?")} · ${fmtOutcome(h.outcome)}</div>`).join("")}</div>` : ""}
    <div id="alts"></div>`;
  $("#modalClose").onclick = () => $("#modal").hidden = true;
  if (backShow) $("#mBackShow").onclick = () => showModal(backShow);
  $("#mPrio").onclick = async () => {
    const r = await post(`items/${encodeURIComponent(key)}/priority`);
    $("#mPrio").disabled = true;
    $("#mPrio").textContent = r.note ? "has subtitle — swap below" : r.mode === "next-in-run" ? "⏩ next in current run" : "⏩ queued";
    if (!r.note && $("#btnRun").disabled) loadDashboard();
  };
  $("#mRetry").onclick = async () => { await post(`items/${encodeURIComponent(key)}/retry`); $("#modal").hidden = true; loadQueue(); };
  $("#mPark").onclick = async () => {
    const r = await post(`items/${encodeURIComponent(key)}/park`);
    $("#modal").hidden = true; loadQueue(); if (r.status === "pending") itemModal(key);
  };
  $("#mAlts").onclick = async () => {
    $("#alts").innerHTML = "<div class='muted'>searching providers…</div>";
    try {
      const d = await api(`items/${encodeURIComponent(key)}/candidates`);
      const good = d.candidates.filter(c => !c.error);
      $("#alts").innerHTML = good.length ? `<table class="grid"><thead><tr><th>provider</th><th>release</th><th></th></tr></thead><tbody>` +
        good.map((c, i) => `<tr><td><b>${esc(c.provider)}</b>${c.hi ? " [HI]" : ""}${c.ai ? " [AI]" : ""}</td>
          <td class="path">${esc(c.release)}</td>
          <td><button data-i="${c.idx}" class="primary swapbtn">use this</button></td></tr>`).join("") + "</tbody></table>"
        : "<div class='muted'>no candidates found right now.</div>";
      $$(".swapbtn").forEach(b => b.onclick = async () => {
        b.disabled = true; b.textContent = "downloading…";
        try {
          const r = await post(`items/${encodeURIComponent(key)}/candidates/${b.dataset.i}`);
          $("#alts").innerHTML = `<div class="dl">✔ swapped to «${esc(r.release)}»${r.backup ? " (old kept as .srt.1)" : ""}</div>`;
        } catch (e) { $("#alts").innerHTML = `<div class="miss">✖ ${esc(e.message)}</div>`; b.disabled = false; b.textContent = "use this"; }
      });
    } catch (e) { $("#alts").innerHTML = `<div class="miss">✖ ${esc(e.message)}</div>`; }
  };
}
$("#modalClose").onclick = () => $("#modal").hidden = true;
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("#modal").hidden = true; });
addEventListener("keydown", (e) => { if (e.key === "Escape") $("#modal").hidden = true; });

// ---- library ----------------------------------------------------------------------
let libMode = "tv";
let libData = { tv: [], movies: [] };
function initLibraryTabs() {
  $$("#libTabs [data-lib]").forEach(b => b.addEventListener("click", () => {
    libMode = b.dataset.lib;
    $$("#libTabs [data-lib]").forEach(x => x.classList.toggle("active", x === b));
    renderLibrary().catch(e => toast("Library error: " + e.message));
  }));
  $("#libSearch").addEventListener("input", () =>
    renderLibrary().catch(e => toast("Library error: " + e.message)));
}
initLibraryTabs();

const icon = (name) => ({
  search: `<svg class="icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  film: `<svg class="icon" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>`,
  tv: `<svg class="icon" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>`,
  zap: `<svg class="icon" viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  alert: `<svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
}[name] ?? "");

function artImg(key, title, cls = "art", kind = "movie") {
  const initials = (title ?? "?").split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? "").join("");
  const bust = `&_=${Date.now().toString(36)}`;
  return `<img class="${cls}" loading="lazy" alt="" src="/api/img?key=${encodeURIComponent(key)}&kind=${kind}&token=${encodeURIComponent(TOKEN)}${bust}"
    onerror="if(!this.dataset.r){this.dataset.r='1';this.src=this.src.split('&_')[0]+'&_='+Date.now().toString(36)}else{this.outerHTML='<div class=&quot;${cls} noart&quot;>${esc(initials)}</div>'}">`;
}

async function loadLibrary() { renderLibrary().catch(e => toast("Library error: " + e.message)); }
async function renderLibrary() {
  const q = $("#libSearch").value.trim().toLowerCase();
  if (libMode === "movie") {
    if (!libData.movies.length) libData.movies = (await api("library?type=movie")).movies;
    const list = q ? libData.movies.filter(m => (m.label ?? m.title ?? "").toLowerCase().includes(q)) : libData.movies;
    $("#libShows").hidden = true; $("#libMovies").hidden = false;
    $("#libMovies").innerHTML = list.slice(0, 500).map(m => `
      <div class="pcard" data-k="${esc(m.key)}">
        ${artImg(m.key, m.title, "art", "movie")}
        <div class="meta"><div class="t">${esc(m.label ?? m.title)}</div>
          <div class="y"><span class="st ${m.status}" style="margin-left:auto">${m.status === "done" || m.status === "covered" ? "✓" : m.status}</span></div></div>
      </div>`).join("") + (list.length > 500 ? `<div class="muted">…${list.length - 500} more — refine search</div>` : "");
    bindCardClicks();
    return;
  }
  if (!libData.tv.length) libData.tv = (await api("library?type=tv")).tv;
  const list = q ? libData.tv.filter(x => (x.label ?? x.show).toLowerCase().includes(q)) : libData.tv;
  $("#libMovies").hidden = true; $("#libShows").hidden = false;
  $("#libShows").className = "cards";
  $("#libShows").innerHTML = list.slice(0, 400).map(sh => {
    const pct = sh.total ? Math.round(100 * sh.covered / sh.total) : 0;
    const anyKey = sh.seasons[0]?.episodes[0]?.key ?? "";
    return `<div class="pcard" data-show="${esc(sh.show)}" data-k="${esc(anyKey)}">
      ${artImg(anyKey, sh.show, "art", "tv")}
      <div class="meta"><div class="t">${icon("tv")} ${esc(sh.label ?? sh.show)}</div>
        <div class="y"><span class="bar" style="display:inline-block;width:52px;height:5px;background:var(--panel2);border-radius:3px;vertical-align:middle"><i style="display:block;height:100%;width:${pct}%;background:var(--ok);border-radius:3px"></i></span> ${sh.covered}/${sh.total}</div></div>
    </div>`;
  }).join("") + (list.length > 400 ? `<div class="muted">…${list.length - 400} more — refine search</div>` : "");
  $$("#libShows .pcard").forEach(c => c.onclick = () => showModal(c.dataset.show));
}

function showModal(showName) {
  const sh = libData.tv.find(x => x.show === showName);
  if (!sh) return;
  const pct = sh.total ? Math.round(100 * sh.covered / sh.total) : 0;
  const anyKey = sh.seasons[0]?.episodes[0]?.key ?? "";
  $("#modal").hidden = false;
  $("#modalBody").innerHTML = `
    <div style="display:flex;gap:16px;align-items:flex-start">
      ${artImg(anyKey, sh.show, "thumb", "tv")}
      <div style="flex:1">
        <h3 style="margin:0 0 6px">${icon("tv")} ${esc(sh.show)}</h3>
        <p class="muted" style="margin:0 0 4px"><span class="bar" style="display:inline-block;width:120px;height:6px;background:var(--panel2);border-radius:3px;vertical-align:middle"><i style="display:block;height:100%;width:${pct}%;background:var(--ok);border-radius:3px"></i></span> ${sh.covered}/${sh.total} episodes subtitled (${pct}%)</p>
        <div class="row">
          <button id="mPrioShow" class="primary">${icon("zap")} Fetch missing (priority)</button>
          <button id="mBack" class="ghost">← Back to Library</button>
        </div>
      </div>
    </div>
    ${sh.seasons.map(se => `<div class="eps"><div class="muted" style="margin:10px 0 4px">Season ${se.season}</div>` +
      se.episodes.map(ep => `<span class="ep ${ep.status === "done" || ep.status === "covered" ? "ok" : ""}"
        data-k="${esc(ep.key)}" title="${esc(ep.rel ?? ep.status)}">E${String(ep.episode).padStart(2, "0")} ${ep.status === "done" || ep.status === "covered" ? "✓" : "✗"}</span>`).join("") + `</div>`).join("")}
    <div class="muted" style="margin-top:8px">Click an episode for details, alternatives and subtitle swapping.</div>`;
  $("#modalClose").onclick = () => $("#modal").hidden = true;
  $("#mBack").onclick = () => $("#modal").hidden = true;
  $("#mPrioShow").onclick = async (e) => {
    e.target.disabled = true;
    let n = 0;
    for (const se of sh.seasons) for (const ep of se.episodes)
      if (ep.status !== "done" && ep.status !== "covered") { await post(`items/${encodeURIComponent(ep.key)}/priority`); n++; }
    e.target.textContent = `⏩ ${n} episodes queued`;
    libData.tv = [];                       // refresh coverage next render
  };
  $$("#modalBody .ep").forEach(el => el.onclick = () => itemModal(el.dataset.k, showName));
}

function bindCardClicks() {
  $$("#libMovies .pcard").forEach(c => c.onclick = () => itemModal(c.dataset.k));
}

// ---- logs --------------------------------------------------------------------------
async function loadLogList() {
  const files = await api("logs");                                  // [{file,size,mtime}] newest first
  $("#logFile").innerHTML = files.map(f =>
    `<option value="${esc(f.file)}">${esc(f.file)} — ${f.size > 1048576 ? (f.size / 1048576).toFixed(1) + " MB" : Math.round(f.size / 1024) + " KB"}</option>`).join("")
    || `<option value="">(no log files yet)</option>`;
  $("#btnLogGo").onclick = loadLog;
  loadLog();
}
async function loadLog() {
  const f = $("#logFile").value;
  if (!f) { $("#logView").textContent = "No log files yet — they appear after the first scan/run."; return; }
  try {
    const d = await api(`log?file=${encodeURIComponent(f)}&bytes=16000`);
    $("#logView").textContent = d.size === 0
      ? "(this file is empty — it fills when its command runs)"
      : d.text;
  } catch (e) { $("#logView").textContent = "⚠ " + e.message; }
  if ($("#logFollow").checked) $("#logView").scrollTop = 1e9;
}
setInterval(() => { if (location.hash.endsWith("logs") && $("#logFollow").checked) loadLog(); }, 4000);

// ---- settings ----------------------------------------------------------------------
async function loadSettings() {
  const c = await api("config");
  $("#sProviders").value = (c.providers ?? []).join(",");
  $("#sHI").checked = !!c.hearingImpairedOk;
  $("#sAI").checked = !!c.aiTranslatedOk;
  $("#sPark").value = c.attemptsBeforePark ?? 3;
  $("#sSchedOn").checked = !!c.schedule?.enabled;
  $("#sSchedTime").value = c.schedule?.time ?? "13:05";
  $("#sOsKey").value = c.opensubtitles?.apiKey ?? c.apiKey ?? "";
  $("#sOsUser").value = c.opensubtitles?.username ?? c.username ?? "";
  $("#sOmdb").value = c.images?.omdbApiKey ?? "";
}
$("#btnSaveSettings").onclick = async () => {
  const body = {
    providers: $("#sProviders").value.split(",").map(s => s.trim()).filter(Boolean),
    hearingImpairedOk: $("#sHI").checked,
    aiTranslatedOk: $("#sAI").checked,
    attemptsBeforePark: +$("#sPark").value || 3,
    schedule: { enabled: $("#sSchedOn").checked, time: $("#sSchedTime").value.trim() || "13:05" },
    opensubtitles: { apiKey: $("#sOsKey").value.trim(), username: $("#sOsUser").value.trim(), password: $("#sOsPass").value },
    images: { omdbApiKey: $("#sOmdb").value.trim() },
  };
  await api("config", { method: "PUT", body: JSON.stringify(body) });
  $("#saveMsg").textContent = "saved ✔";
  setTimeout(() => $("#saveMsg").textContent = "", 2500);
};

// token management
$("#btnSaveSettings").insertAdjacentHTML("afterend", `
  <div class="card" style="margin-top:14px">
    <h3>Access token</h3>
    <div class="row"><input id="sToken" style="flex:1"><button id="btnTokGen">Generate new</button><button id="btnTokSave" class="primary">Save token</button></div>
    <div class="muted">After saving, re-open the app with the new token (old one stays valid until the service restarts). The LAN URL is shown on the dashboard.</div>
  </div>`);
setTimeout(() => {
  const stReady = api("status").then(st => { $("#sToken").value = st.lan?.token ?? ""; });
  $("#btnTokGen").onclick = () => {
    const b = new Uint8Array(12); crypto.getRandomValues(b);
    $("#sToken").value = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
  };
  $("#btnTokSave").onclick = async () => {
    await api("config", { method: "PUT", body: JSON.stringify({ server: { token: $("#sToken").value.trim() } }) });
    localStorage.setItem("sf_token", $("#sToken").value.trim());
    $("#saveMsg").textContent = "token saved — reuse your bookmark with the new token";
  };
}, 0);

// ---- boot -------------------------------------------------------------------------
showTab(location.hash.slice(2) || "dashboard");
