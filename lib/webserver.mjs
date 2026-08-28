// HTTP layer for the LAN service: static web/ files + JSON API + SSE.
// Auth: every /api* route requires the token (X-Auth-Token header or
// ?token= query — EventSource can't set headers). Static files are open;
// without a valid token they're inert because every API call 401s.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".json": "application/json", ".webp": "image/webp",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
};

export class WebServer {
  /**
   * @param opts {port, bind, token, statePath, configPath, logDir, scriptDir,
   *              getState(), getConfig(), saveConfig(), api: {status, scan,
   *              run, stop, queue, item, candidates, swapCandidate, retryItem,
   *              fsList, logs, tailLog, library, report, activity, configPut}}
   */
  constructor(opts) {
    this.opts = opts;
    this.sseClients = new Set();
    this.server = null;
  }

  broadcast(evt) {
    const frame = `data: ${JSON.stringify(evt)}\n\n`;
    for (const res of this.sseClients) {
      try { res.write(frame); } catch { this.sseClients.delete(res); }
    }
  }

  authOk(req, url) {
    const header = req.headers["x-auth-token"];
    const q = url.searchParams.get("token");
    const t = typeof this.opts.token === "function" ? this.opts.token() : this.opts.token;
    const prev = typeof this.opts.tokenPrev === "function" ? this.opts.tokenPrev() : this.opts.tokenPrev;
    return header === t || q === t || (prev && (header === prev || q === prev));
  }

  start() {
    const { port, bind } = this.opts;
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.route(req, res));
      this.server.on("error", (e) => {
        if (e.code === "EADDRINUSE") reject(new Error(`Port ${port} in use — is another instance running?`));
        else reject(e);
      });
      this.server.listen(port, bind, () => resolve(this.server));
    });
  }

  stop() {
    for (const res of this.sseClients) { try { res.end(); } catch {} }
    this.sseClients.clear();
    return new Promise(r => this.server?.close(() => r()));
  }

  route(req, res) {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;

    if (p === "/api/events") {
      if (!this.authOk(req, url)) return this.text(res, 401, "unauthorized");
      res.writeHead(200, {
        "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
        Connection: "keep-alive", "Access-Control-Allow-Origin": "*",
      });
      res.write(`data: ${JSON.stringify({ ev: "hello" })}\n\n`);
      this.sseClients.add(res);
      req.on("close", () => this.sseClients.delete(res));
      return;
    }

    if (p.startsWith("/api/")) {
      if (!this.authOk(req, url)) return this.json(res, 401, { ok: false, error: "unauthorized" });
      return this.api(req, res, url).catch(e => this.json(res, 500, { ok: false, error: e.message }));
    }

    // static files
    if (p === "/favicon.ico") { res.writeHead(204); return res.end(); }
    let rel = p === "/" ? "index.html" : p.slice(1);
    const abs = path.normalize(path.join(WEB_DIR, rel));
    if (!abs.startsWith(WEB_DIR)) return this.text(res, 403, "forbidden");
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return this.text(res, 404, "not found");
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(abs)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",          // git pull = refresh; no stale dashboards
    });
    fs.createReadStream(abs).pipe(res);
  }

  async api(req, res, url) {
    const p = url.pathname.slice(5); // after /api/
    const A = this.opts.api;
    const body = await readBody(req);

    if (req.method === "GET" && p === "status") return this.json(res, 200, { ok: true, data: await A.status() });
    if (req.method === "GET" && p === "activity") return this.json(res, 200, { ok: true, data: A.activity(+url.searchParams.get("limit") || 100) });
    if (req.method === "POST" && p === "scan") { A.scan().catch(e => this.broadcast({ ev: "error", detail: e.message })); return this.json(res, 200, { ok: true, data: "scan started" }); }
    if (req.method === "POST" && p === "run") { A.run(body?.limit ?? null, body?.only ?? "").catch(e => this.broadcast({ ev: "error", detail: e.message })); return this.json(res, 200, { ok: true, data: "run started" }); }
    if (req.method === "POST" && p === "stop") { A.stop(); return this.json(res, 200, { ok: true, data: "stop requested" }); }
    if (req.method === "GET" && p === "queue") return this.json(res, 200, { ok: true, data: A.queue(url.searchParams) });
    if (req.method === "GET" && p === "library") return this.json(res, 200, { ok: true, data: A.library(url.searchParams) });
    if (req.method === "GET" && p === "report") return this.json(res, 200, { ok: true, data: A.report(+(url.searchParams.get("days") || 7)) });
    if (req.method === "GET" && p === "logs") return this.json(res, 200, { ok: true, data: A.logs() });
    if (req.method === "GET" && p === "log") return this.json(res, 200, { ok: true, data: A.tailLog(url.searchParams.get("file"), +(url.searchParams.get("bytes") || 8000)) });
    if (req.method === "GET" && p === "img") {
      try {
        const r = await A.img(url.searchParams);
        if (r?.redirect) { res.writeHead(302, { Location: r.redirect, "Cache-Control": "max-age=604800" }); return res.end(); }
        if (r?.file) {
          res.writeHead(200, { "Content-Type": MIME[path.extname(r.file).toLowerCase()] ?? "image/jpeg", "Cache-Control": "max-age=86400" });
          return fs.createReadStream(r.file).pipe(res);
        }
      } catch { /* fallthrough to 404 */ }
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("no image");
    }
    if (req.method === "GET" && p === "fs") return this.json(res, 200, { ok: true, data: A.fsList(url.searchParams.get("path") ?? "") });

    let m;
    if ((m = p.match(/^items\/(.+)\/candidates$/)) && req.method === "GET") {
      return this.json(res, 200, { ok: true, data: await A.candidates(decodeURIComponent(m[1])) });
    }
    if ((m = p.match(/^items\/(.+)\/candidates\/(\d+)$/)) && req.method === "POST") {
      return this.json(res, 200, { ok: true, data: await A.swapCandidate(decodeURIComponent(m[1]), +m[2]) });
    }
    if ((m = p.match(/^items\/(.+)\/retry$/)) && req.method === "POST") {
      return this.json(res, 200, { ok: true, data: A.retryItem(decodeURIComponent(m[1])) });
    }
    if ((m = p.match(/^items\/(.+)\/park$/)) && req.method === "POST") {
      return this.json(res, 200, { ok: true, data: A.parkItem(decodeURIComponent(m[1])) });
    }
    if ((m = p.match(/^items\/(.+)\/priority$/)) && req.method === "POST") {
      return this.json(res, 200, { ok: true, data: A.priorityItem(decodeURIComponent(m[1])) });
    }
    if ((m = p.match(/^items\/(.+)$/)) && req.method === "GET") {
      return this.json(res, 200, { ok: true, data: A.item(decodeURIComponent(m[1])) });
    }
    if (p === "config") {
      if (req.method === "GET") return this.json(res, 200, { ok: true, data: this.redactConfig() });
      if (req.method === "PUT") return this.json(res, 200, { ok: true, data: A.configPut(body) });
    }
    this.json(res, 404, { ok: false, error: "unknown endpoint" });
  }

  redactConfig() {
    const c = structuredClone(this.opts.getConfig());
    if (c.opensubtitles?.password) c.opensubtitles.password = "•••";
    if (c.password) c.password = "•••";
    return c;
  }

  json(res, code, obj) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  }
  text(res, code, s) {
    res.writeHead(code, { "Content-Type": "text/plain" });
    res.end(s);
  }
}

function readBody(req) {
  return new Promise(resolve => {
    let b = "";
    req.on("data", c => b += c);
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

export function newToken() {
  return crypto.randomBytes(12).toString("hex");
}
