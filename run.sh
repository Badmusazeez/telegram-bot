#!/usr/bin/env bash
# Run from macOS / Linux / Git Bash / WSL terminal:
#   chmod +x run.sh
#   ./run.sh
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed (or not on PATH)."
  echo "Install Node 20+ from https://nodejs.org then reopen this terminal."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is not installed (or not on PATH)."
  exit 1
fi

exec npm run bot
