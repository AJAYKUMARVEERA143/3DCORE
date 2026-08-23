#!/bin/bash
ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"
echo "Starting 3D Core Studio at http://127.0.0.1:8000"
exec python3 server.py
