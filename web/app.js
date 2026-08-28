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
async function loadDashboard() {
  const st = await api("status");
  $("#engineDot").className = "dot " + (st.engine.running ? "busy" : "on");
  $("#enginePhase").textContent = st.engine.running ? st.engine.phase + (st.engine.current ? " · " + st.engine.current.label : "") : "idle";
  $("#btnStop").hidden = !st.engine.running;
  $("#btnRun").disabled = st.engine.running;
  $("#btnScan").disabled = st.engine.running;

  const t = st.totals;
  $("#tiles").innerHTML = [
    tile(t.total, "videos", ""), tile(t.covered, "have EN subs", "ok"),
    tile(t.pending, "pending", "warn"), tile(t.failed, "failed", "bad"), tile(t.parked, "parked", ""),
    tile(st.sdDownloadsToday, "subdl today", "warn"),
  ].join("");

  $("#providers").innerHTML = st.providers.map(p =>
    `<span class="pill ${p.quotaLeft === 0 ? "bad" : "ok"}"><b>${p.id}</b>${p.quotaLeft === null ? "ready" : p.quotaLeft + " left"}</span>`).join("")
    + `<span class="pill">sd used today: <b>${st.sdDownloadsToday}</b></span>`;

  $("#lastRun").textContent = st.engine.lastResult
    ? `${st.engine.lastResult.done} downloaded · ${st.engine.lastResult.missed} missed · ${st.engine.lastResult.minutes} min (${st.engine.lastResult.at.slice(0, 16).replace("T", " ")})`
    : "no run yet this session";
  if (st.scannedAt) $("#lastRun").textContent += ` · scan ${st.scannedAt.slice(0, 16).replace("T", " ")}`;
  if (st.lan) $("#lanUrl").innerHTML = `<a href="${esc(st.lan.url)}/?token=${encodeURIComponent(st.lan.token)}">${esc(st.lan.url)}</a>`;

  if (!feedEl.dataset.backfilled) { feedEl.dataset.backfilled = "1"; feedBackfill(); }
  loadChart().catch(() => {});
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
    feedAppend(renderEvent(e));
  };
} catch { /* SSE optional */ }

function esc(s) { return String(s ?? "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }
function renderEvent(e) {
  const t = (e.t ?? new Date().toISOString()).slice(11, 19);
  if (e.line) return `<span class="miss">${esc(t)} ${esc(e.line)}</span>`;
  switch (e.ev) {
    case "item_start": return `${esc(t)} → searching ${esc(e.label ?? e.key)}`;
    case "download": return `<span class="dl">${esc(t)} ✔ ${esc(e.label)} <b>${esc(e.provider)}</b> «${esc(e.release)}»${e.hi ? " [HI]" : ""}${e.ai ? " [AI]" : ""}</span>`;
    case "miss": return `<span class="miss">${esc(t)} ✖ ${esc(e.label)} — ${esc(e.reason ?? "")}</span>`;
    case "quota": return `<span class="warn2">${esc(t)} ⛔ quota: ${esc(e.provider ?? e.detail ?? "")}</span>`;
    case "replace": return `<span class="dl">${esc(t)} ⇄ swapped ${esc(e.key.split("/").pop())} → ${esc(e.release)}</span>`;
    case "scan": return `<span class="warn2">${esc(t)} ⚙ scan: ${e.total ?? "?"} videos, ${e.pending ?? "?"} pending</span>`;
    case "run_start": return `<span class="warn2">${esc(t)} ▶ run started (${e.queue} queued)</span>`;
    case "run_end": return `<span class="warn2">${esc(t)} ■ run finished: ${e.done} down, ${e.missed} missed</span>`;
    case "log": return esc(t) + " " + esc(e.line ?? "");
    default: return esc(t) + " " + esc(JSON.stringify(e).slice(0, 160));
  }
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.hidden = true, 4000);
}
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
  $("#qCount").textContent = `${d.total} items`;
  $("#qTable tbody").innerHTML = d.items.map(it => `<tr>
    <td><span class="st ${it.status}">${it.status}</span></td>
    <td class="path">${esc(it.key.split("/").slice(-2).join("/"))}</td>
    <td class="path">${esc(it.rel ?? it.lastError ?? "")}</td>
    <td>${it.attempts ?? 0}</td>
    <td><button data-k="${esc(it.key)}" class="ghost qitem">detail</button></td>
  </tr>`).join("");
  $$("#qTable .qitem").forEach(b => b.onclick = () => itemModal(b.dataset.k));
}

async function itemModal(key) {
  const it = await api("items/" + encodeURIComponent(key));
  $("#modal").hidden = false;
  $("#modalBody").innerHTML = `
    <h3>${esc(it.key.split("/").pop())}</h3>
    <p class="path">${esc(it.key)}</p>
    <p><span class="st ${it.status}">${it.status}</span> attempts: ${it.attempts ?? 0}
       ${it.provider ? `· provider <b>${esc(it.provider)}</b>` : ""} ${it.rel ? `· «${esc(it.rel)}»` : ""}</p>
    ${it.lastError ? `<p class="muted">last error: ${esc(it.lastError)}</p>` : ""}
    <div class="row">
      <button id="mRetry" class="primary">Re-queue</button>
      <button id="mPark" class="ghost">${it.status === "parked" ? "Un-park" : "Park"}</button>
      <button id="mAlts">Find alternatives…</button>
    </div>
    ${it.history?.length ? `<div class="hist"><b style="font-size:12px">history</b>${it.history.slice().reverse().map(h =>
      `<div>${esc(h.at?.slice(0, 16).replace("T", " ") ?? "")} · ${esc(h.provider ?? "?")} · «${esc(h.release ?? "?")}» · ${esc(h.outcome ?? "")}</div>`).join("")}</div>` : ""}
    <div id="alts"></div>`;
  $("#modalClose").onclick = () => $("#modal").hidden = true;
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
$("#libToggle").onclick = () => { libMode = libMode === "tv" ? "movie" : "tv"; loadLibrary(); };
async function loadLibrary() {
  const d = await api("library?type=" + libMode);
  $("#libTitle").textContent = libMode === "tv" ? "TV shows" : "Movies";
  $("#libToggle").textContent = libMode === "tv" ? "switch to movies" : "switch to TV";
  $("#libShows").hidden = libMode !== "tv";
  $("#libMovies").hidden = libMode !== "movie";
  if (libMode === "movie") {
    $("#libMovieRows").innerHTML = d.movies.map(m => `<tr>
      <td>${esc(m.title)}</td><td>${esc(m.year ?? "")}</td>
      <td><span class="st ${m.status}">${m.status}</span></td><td class="path">${esc(m.rel ?? "")}</td></tr>`).join("");
    return;
  }
  $("#libShows").innerHTML = d.tv.map(sh => {
    const pct = sh.total ? Math.round(100 * sh.covered / sh.total) : 0;
    return `<details class="show"><summary><b>${esc(sh.show)}</b>
      <span class="bar"><i style="width:${pct}%"></i></span> ${sh.covered}/${sh.total} (${pct}%)</summary>
      ${sh.seasons.map(se => `<div class="eps"><div class="muted" style="margin:4px 0 2px">Season ${se.season}</div>` +
        se.episodes.map(ep => `<span class="ep ${ep.status === "done" || ep.status === "covered" ? "ok" : ""}"
          data-k="${esc(ep.key)}">E${String(ep.episode).padStart(2, "0")} ${ep.status === "done" || ep.status === "covered" ? "✓" : "✗"}</span>`).join("") + `</div>`).join("")}
    </details>`;
  }).join("");
  $$("#libShows .ep").forEach(el => el.onclick = () => itemModal(el.dataset.k));
}

// ---- logs --------------------------------------------------------------------------
async function loadLogList() {
  const files = await api("logs");
  $("#logFile").innerHTML = files.map(f => `<option>${esc(f)}</option>`).join("");
  $("#btnLogGo").onclick = loadLog;
  loadLog();
}
async function loadLog() {
  const f = $("#logFile").value;
  if (!f) return;
  const d = await api(`log?file=${encodeURIComponent(f)}&bytes=12000`);
  $("#logView").textContent = d.text;
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
}
$("#btnSaveSettings").onclick = async () => {
  const body = {
    providers: $("#sProviders").value.split(",").map(s => s.trim()).filter(Boolean),
    hearingImpairedOk: $("#sHI").checked,
    aiTranslatedOk: $("#sAI").checked,
    attemptsBeforePark: +$("#sPark").value || 3,
    schedule: { enabled: $("#sSchedOn").checked, time: $("#sSchedTime").value.trim() || "13:05" },
    opensubtitles: { apiKey: $("#sOsKey").value.trim(), username: $("#sOsUser").value.trim(), password: $("#sOsPass").value },
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
