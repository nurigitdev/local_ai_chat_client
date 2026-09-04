#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_BUNDLE="$ROOT_DIR/bin/agent-chat-desktop.app"

if [[ ! -d "$APP_BUNDLE" ]]; then
  "$ROOT_DIR/scripts/macos/build.sh"
fi

open "$APP_BUNDLE"
