// Logger: mirrors to console + an open log file, strips ANSI in the file.
// The service layer hooks into this to feed the activity ring buffer.

import fs from "node:fs";
import path from "node:path";

export const GRN = (s) => `\x1b[32m${s}\x1b[0m`;
export const YEL = (s) => `\x1b[33m${s}\x1b[0m`;
export const RED = (s) => `\x1b[31m${s}\x1b[0m`;
export const DIM = (s) => `\x1b[2m${s}\x1b[0m`;

let logStream = null;
let hook = null;                       // (line, plainLine) => void

export function setLogHook(fn) { hook = fn; }

export function log(msg) {
  console.log(msg);
  const plain = String(msg).replace(/\x1b\[[0-9;]*m/g, "");
  logStream?.write(plain + "\n");
  hook?.(msg, plain);
}

export function openLog(logDir, tag) {
  fs.mkdirSync(logDir, { recursive: true });
  logStream = fs.createWriteStream(path.join(logDir, `${tag}-${new Date().toISOString().slice(0, 10)}.log`), { flags: "a" });
  return logStream;
}

export function closeLog() { logStream?.end(); logStream = null; }

/** default logger for engine hooks when none supplied */
export const consoleLog = log;
