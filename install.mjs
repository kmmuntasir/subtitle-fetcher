#!/usr/bin/env node
// One-command installer for the Subtitle Fetcher service.
//   node install.mjs                interactive
//   node install.mjs --yes --port 8097 --token X --user media
//   node install.mjs --uninstall
//
// Linux  : systemd unit (enable + start)          [needs sudo for that step]
// Windows: ONSTART scheduled task + StartWhenAvailable

import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, newTokenSafe } from "./lib/install-util.mjs";

const SCRIPT_DIR = path.dirname(path.resolve(fileURLToPath(import.meta.url)));
const SVC = "SubtitleFetcher";
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const CONFIG_PATH = path.join(SCRIPT_DIR, "config.json");

const isWin = process.platform === "win32";
const run = (cmd, opts = {}) => execSync(cmd, { stdio: "pipe", timeout: 30000, ...opts }).toString().trim();

if (flag("--uninstall")) { uninstall(); process.exit(0); }

console.log(`
  Subtitle Fetcher installer
  ──────────────────────────`);

// 1. node version
const major = +process.versions.node.split(".")[0];
if (major < 20) { console.error(`✖ Node v20+ required (you have ${process.versions.node}).`); process.exit(1); }
console.log(`✔ Node ${process.versions.node}`);

// 2. config
let cfg;
if (fs.existsSync(CONFIG_PATH)) {
  cfg = loadConfig(CONFIG_PATH);
  console.log("✔ existing config.json kept");
} else {
  cfg = loadConfig(CONFIG_PATH);                       // defaults + generated token
  saveConfig(CONFIG_PATH, cfg);
  console.log("✔ wrote config.json (token generated)");
}
if (argOf("--port")) cfg.server.port = +argOf("--port");
if (argOf("--token")) cfg.server.token = argOf("--token");
if (flag("--yes") && argOf("--folders")) {
  cfg.roots = argOf("--folders").split(",").map(p => p.trim()).filter(Boolean);
}
saveConfig(CONFIG_PATH, cfg);

// 3. port + service registration
const port = cfg.server.port;
const token = cfg.server.token;
let user = argOf("--user") ?? cfg.serviceUser ?? null;

if (isWin) {
  const nodeExe = process.execPath;
  const tr = `'${nodeExe}' '${path.join(SCRIPT_DIR, "service.mjs")}' --port ${port}`;
  try { run(`schtasks /Delete /TN "${SVC}" /F`); } catch {}
  run(`schtasks /Create /F /SC ONSTART /DELAY 0001:00 /TN "${SVC}" /TR "${tr.replace(/'/g, '\\"')}" /RL HIGHEST`);
  try {
    run(`powershell -NoProfile -Command "$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1); Set-ScheduledTask -TaskName '${SVC}' -Settings $s | Out-Null"`);
  } catch {}
  console.log(`✔ Windows boot task "${SVC}" created`);
} else {
  const svcUser = user ?? process.env.SUDO_USER ?? process.env.USER ?? "media";
  const unit = `[Unit]
Description=Subtitle Fetcher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${SCRIPT_DIR}
ExecStart=${process.execPath} ${path.join(SCRIPT_DIR, "service.mjs")} --port ${port}
Restart=on-failure
RestartSec=10
User=${svcUser}

[Install]
WantedBy=multi-user.target
`;
  const unitPath = `/etc/systemd/system/${SVC.toLowerCase()}.service`;
  try {
    fs.writeFileSync(unitPath, unit);                    // works when run with sudo
    run("systemctl daemon-reload");
    run(`systemctl enable --now ${SVC.toLowerCase()}`);
    console.log(`✔ systemd unit installed & started (${unitPath}, user ${svcUser})`);
  } catch {
    fs.writeFileSync(path.join(SCRIPT_DIR, "subtitle-fetcher.service"), unit);
    console.log(`⚠ could not write ${unitPath} (need sudo). Unit saved next to the app.`);
    console.log("  Run:  sudo cp subtitle-fetcher.service /etc/systemd/system/ && sudo systemctl enable --now subtitle-fetcher");
  }
}

// 4. start now (foreground spawn detached so the installer can exit)
try {
  const health = await fetch(`http://127.0.0.1:${port}/api/status?token=${token}`, { signal: AbortSignal.timeout(2500) });
  if (health.ok) {
    console.log(`✔ service already healthy on port ${port}`);
    done();
  }
} catch {}
const child = spawn(process.execPath, [path.join(SCRIPT_DIR, "service.mjs"), "--port", String(port)],
  { detached: true, stdio: "ignore", windowsHide: true });
child.unref();

// 5. health check
let ok = false;
for (let i = 0; i < 10; i++) {
  await new Promise(r => setTimeout(r, 700));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status?token=${token}`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) { ok = true; break; }
  } catch {}
}
console.log(ok ? `✔ service healthy` : `⚠ could not reach service (check logs/) — it may still be starting`);
done();

function done() {
  console.log(`
  Open on your LAN:
    http://<this-machine-ip>:${port}/?token=${token}

  Uninstall:  node install.mjs --uninstall
`);
  process.exit(0);
}

function uninstall() {
  if (isWin) {
    try { run(`schtasks /Delete /TN "${SVC}" /F`); } catch {}
  } else {
    try {
      run(`systemctl disable --now ${SVC.toLowerCase()}`);
      fs.rmSync(`/etc/systemd/system/${SVC.toLowerCase()}.service`, { force: true });
      run("systemctl daemon-reload");
    } catch {}
  }
  try {
    const out = run(`netstat -ano | findstr :${cfg?.server?.port ?? 8097}`);
    const pid = out.trim().split(/\s+/).pop();
    if (pid) run(`taskkill /F /PID ${pid}`);
  } catch {}
  console.log("✔ service uninstalled (config.json kept)");
}
