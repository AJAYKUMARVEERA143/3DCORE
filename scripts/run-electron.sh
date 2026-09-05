#!/bin/bash
# Runs the desktop (Electron) build in dev mode -- the browser-mode
# scripts/run.sh is untouched and still works exactly as before; this is
# additive, not a replacement. Requires `npm install` once first.
ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"
echo "Starting 3D Core Studio (Electron desktop build)"
exec npx electron .
