#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_BINARY="$ROOT_DIR/bin/agent-chat-desktop"

if [[ ! -x "$APP_BINARY" ]]; then
  "$ROOT_DIR/scripts/linux/build.sh"
fi

exec "$APP_BINARY"
