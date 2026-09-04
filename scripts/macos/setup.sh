#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WAILS_VERSION="v3.0.0-beta.11"

missing=()
for command_name in git go node npm; do
    command -v "$command_name" >/dev/null 2>&1 || missing+=("$command_name")
done

if ((${#missing[@]})); then
    echo "다음 개발 도구가 필요합니다: ${missing[*]}" >&2
    echo "Homebrew 사용 시: brew install git go node" >&2
    echo "Xcode Command Line Tools가 없다면: xcode-select --install" >&2
    exit 1
fi

if ! xcode-select -p >/dev/null 2>&1; then
    echo "Xcode Command Line Tools가 필요합니다. 다음 명령을 실행한 뒤 다시 시도하세요: xcode-select --install" >&2
    exit 1
fi

WAILS_BIN="$(go env GOPATH)/bin/wails3"
if [[ ! -x "$WAILS_BIN" ]] || ! "$WAILS_BIN" version 2>&1 | grep -q "$WAILS_VERSION"; then
    echo "Wails $WAILS_VERSION CLI를 준비합니다…"
    go install "github.com/wailsapp/wails/v3/cmd/wails3@$WAILS_VERSION"
fi

export PATH="$(dirname "$WAILS_BIN"):$PATH"
echo "프런트엔드 의존성을 준비합니다…"
npm install --prefix "$ROOT_DIR/frontend" --no-audit --no-fund

echo
echo "Wails 환경을 확인합니다…"
"$WAILS_BIN" doctor
echo
echo "준비가 완료되었습니다. 개발 실행: ./scripts/macos/dev.sh"
