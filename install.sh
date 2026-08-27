#!/usr/bin/env bash
# Subtitle Fetcher — Linux/macOS installer wrapper
set -e
command -v node >/dev/null 2>&1 || { echo "[!] Node.js v18+ required: https://nodejs.org"; exit 1; }
cd "$(dirname "$0")"
exec node subtitles-fetcher.mjs setup
