#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETUP_SCRIPT="$ROOT_DIR/scripts/macos/setup.sh"

if ! command -v go >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 || ! xcode-select -p >/dev/null 2>&1; then
    "$SETUP_SCRIPT"
fi

WAILS_BIN="$(go env GOPATH)/bin/wails3"
if [[ ! -d "$ROOT_DIR/frontend/node_modules" ]] || [[ ! -x "$WAILS_BIN" ]]; then
    "$SETUP_SCRIPT"
fi

export PATH="$(dirname "$WAILS_BIN"):$PATH"
if [[ "${1:-}" == "--dmg" ]]; then
    exec "$WAILS_BIN" task darwin:package:dmg
fi
exec "$WAILS_BIN" task package
