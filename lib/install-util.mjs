// Shared bit for install.mjs (kept out of lib/config.mjs to stay dependency-light).

import crypto from "node:crypto";

export { loadConfig, saveConfig } from "./config.mjs";

export function newTokenSafe() {
  return crypto.randomBytes(12).toString("hex");
}
