// Scheduling helpers: Windows Task Scheduler (boot-safe daily task with a
// .cmd launcher to dodge quoting traps) and Linux/macOS crontab (marked line).

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export const TASK_NAME = "SubtitleFetcherDaily";
export const CRON_MARK = "# subtitle-fetcher";

/* ---------------- Windows ---------------- */

export function registerWindowsTask(scriptDir, time, { silent = false } = {}) {
  const bat = path.join(scriptDir, "run-daily.cmd");
  fs.writeFileSync(bat,
    `@echo off\r\ncd /d "${scriptDir}"\r\nif not exist logs mkdir logs\r\n"${process.execPath}" cli.mjs run >> logs\\task.log 2>&1\r\n`);
  execSync(`schtasks /Create /F /SC DAILY /ST ${time} /TN "${TASK_NAME}" /TR "'${bat}'"`,
    { stdio: "pipe", timeout: 20000 });
  // if the machine was off at the scheduled time, run at next boot
  try {
    execSync(
      `powershell -NoProfile -Command "$s = New-ScheduledTaskSettingsSet -StartWhenAvailable; Set-ScheduledTask -TaskName '${TASK_NAME}' -Settings $s | Out-Null"`,
      { stdio: "pipe", timeout: 30000 });
  } catch { /* best effort; task still works, just won't catch up */ }
  if (!silent) console.log(`✔ daily Windows task registered for ${time} (launcher: ${bat}, log: logs\\task.log)`);
}

export function unregisterWindowsTask() {
  try { execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: "pipe", timeout: 20000 }); return true; }
  catch { return false; }
}

/* ---------------- Linux / macOS ---------------- */

export function registerCron(scriptDir, time) {
  const [hh, mm] = time.split(":");
  const node = process.execPath;                       // absolute → survives nvm/volta PATH quirks
  const line = `${mm} ${hh} * * * cd '${scriptDir}' && ${node} cli.mjs run >> logs/task.log 2>&1 ${CRON_MARK}`;
  let cur = "";
  try { cur = execSync("crontab -l 2>/dev/null", { encoding: "utf8", timeout: 10000 }).trim(); } catch {}
  const kept = cur.split("\n").filter(l => !l.includes(CRON_MARK) && l.trim());
  const tmp = path.join(scriptDir, "logs", ".crontab.tmp");
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, [...kept, line, ""].join("\n") + "\n");
  execSync(`crontab '${tmp}'`, { timeout: 10000 });
  fs.rmSync(tmp, { force: true });
  console.log(`✔ daily cron entry installed for ${time} (verify: crontab -l | grep subtitle)`);
}

export function unregisterCron() {
  try {
    execSync(`crontab -l 2>/dev/null | grep -v '${CRON_MARK}' | crontab -`, { shell: "/bin/sh", timeout: 10000 });
    return true;
  } catch { return false; }
}

/** register on the current OS; returns a human description */
export function registerDaily(scriptDir, time) {
  if (process.platform === "win32") { registerWindowsTask(scriptDir, time); return "windows-task"; }
  registerCron(scriptDir, time); return "cron";
}

export function unregisterDaily() {
  const removed = process.platform === "win32" ? unregisterWindowsTask() : unregisterCron();
  console.log(removed ? "✔ schedule removed" : "no schedule found");
}
