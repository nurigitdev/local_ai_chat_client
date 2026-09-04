# 에이전트 설치·빌드·실행 안내

이 문서는 Agent Chat Desktop을 설치·실행·검증하는 에이전트를 위한 작업 지침입니다. 사람도 같은 순서로 사용할 수 있지만, 빠른 명령만 필요하면 [README](../README.md)를 우선 참고합니다.

## 작업 원칙

1. 먼저 대상 운영체제와 CPU 아키텍처를 확인합니다.
2. 시스템 전역 도구 설치, 관리자 권한, 패키지 관리자의 변경은 소유자의 승인을 받은 뒤에만 실행합니다.
3. 프로젝트의 `setup` 스크립트는 Wails CLI와 프런트엔드 의존성을 준비하고 진단하지만, Git·Go·Node.js·시스템 GUI 라이브러리를 자동 설치하지는 않습니다.
4. 개발 실행은 프런트엔드 서버 포트 `9245`를 사용하며, 실행 명령은 개발 서버가 유지되는 동안 끝나지 않는 것이 정상입니다.
5. 작업 완료 시 운영체제, 실행한 스크립트, `wails3 doctor` 결과, 테스트·빌드 결과와 생성 파일 위치를 보고합니다.

## 공통 순서

저장소를 받은 뒤 프로젝트 최상위 폴더에서 운영체제별 스크립트를 실행합니다.

```text
setup → dev 또는 build → run → 검증
```

`setup`은 프로젝트가 고정한 Wails `v3.0.0-beta.11`을 Go의 바이너리 폴더에 설치하고, `frontend/package-lock.json`에 따라 npm 의존성을 준비합니다. npm의 온라인 취약점 점검은 개발 실행을 지연시키지 않도록 건너뜁니다. 보안 점검이 필요하면 별도로 `cd frontend && npm audit`를 실행합니다.

## macOS

### 필수 항목

- Git, Go 1.25 이상, Node.js 20.19 이상 또는 22.12 이상
- Xcode Command Line Tools

누락된 경우에는 다음 설치 방법을 제안하고, 설치 전에는 소유자의 승인을 받습니다.

```bash
brew install git go node
xcode-select --install
```

Homebrew를 사용하지 않는 환경에서는 Git, Go, Node.js의 공식 설치 프로그램을 사용합니다.

### 명령

```bash
./scripts/macos/setup.sh
./scripts/macos/dev.sh
./scripts/macos/build.sh
./scripts/macos/run.sh
./scripts/macos/build.sh --dmg
```

기본 빌드는 `.app` 번들을 `bin/agent-chat-desktop.app`에 생성합니다. DMG도 `bin/`에 생성됩니다. 외부 배포에는 Apple Developer ID 서명과 공증이 별도로 필요합니다.

## Windows

### 필수 항목

- Git, Go 1.25 이상, Node.js LTS
- Windows 10/11의 WebView2 Runtime
- 설치 프로그램을 만들 때만 NSIS

관리자 설치가 승인된 경우 `winget`으로 필요한 도구를 설치할 수 있습니다.

```powershell
winget install --id Git.Git -e --source winget
winget install --id GoLang.Go -e --source winget
winget install --id OpenJS.NodeJS.LTS -e --source winget
winget install NSIS.NSIS
```

새 PowerShell 창을 열어 PATH를 반영한 뒤 진행합니다.

### 명령

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\windows\dev.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\windows\build.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\windows\run.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\windows\build.ps1 -Package
```

`-ExecutionPolicy Bypass`는 현재 실행에만 적용하며 시스템 정책을 바꾸지 않습니다. 기본 빌드는 `bin\agent-chat-desktop.exe`, 설치 패키지는 `bin\agent-chat-desktop-<ARCH>-installer.exe`에 생성됩니다.

## Linux와 WSL

기본 지원 기준은 Ubuntu 24.04 이상입니다. WSL에서는 Windows 실행 파일이 아니라 WSLg에서 동작하는 Linux 실행 파일을 빌드합니다. Windows 배포용 프로그램은 Windows에서 빌드합니다.

### 필수 항목

Git, Go, Node.js, npm과 GTK4·WebKitGTK 6.0 개발 라이브러리가 필요합니다. 시스템 패키지 설치는 승인 후 진행합니다.

Ubuntu/Debian:

```bash
sudo apt update
sudo apt install git golang-go nodejs npm build-essential pkg-config libgtk-4-dev libwebkitgtk-6.0-dev fontconfig fonts-noto-cjk
```

Fedora:

```bash
sudo dnf install git golang nodejs npm gcc pkg-config gtk4-devel webkitgtk6.0-devel fontconfig
```

Arch Linux:

```bash
sudo pacman -S git go nodejs npm base-devel pkgconf gtk4 webkitgtk-6.0 fontconfig
```

### 명령

```bash
./scripts/linux/setup.sh
./scripts/linux/dev.sh
./scripts/linux/build.sh
./scripts/linux/run.sh
./scripts/linux/build.sh --package
```

기본 빌드는 `bin/agent-chat-desktop` 실행 파일을 만듭니다. `--package`는 AppImage, DEB, RPM, Arch 패키지를 만들며 Git 작성자 정보와 플랫폼별 패키징 도구가 필요할 수 있습니다.

## 검증

변경이나 설치 후에는 다음 순서로 확인합니다.

```bash
go test ./...
npm run build --prefix frontend
wails3 build DEV=true
```

개발 실행 검증에서는 `wails3 task dev`의 로그에 다음 두 항목이 보여야 합니다.

```text
VITE ... ready
Connected to frontend dev server!
```

## 자주 발생하는 문제

### `wails3`을 찾을 수 없음

`setup` 스크립트는 `$(go env GOPATH)/bin/wails3`을 직접 사용합니다. 수동 실행에서는 해당 폴더를 PATH에 추가하거나 스크립트를 사용합니다.

### 개발 실행이 npm 설치에서 멈춤

프로젝트 태스크는 `npm install --no-audit --no-fund`을 사용합니다. 이는 외부 취약점 점검 API의 응답 지연이 개발 실행을 막지 않게 합니다. 의존성 잠금 파일은 그대로 사용합니다.

### `9245` 포트를 사용할 수 없음

이미 실행 중인 개발 서버를 종료하거나 다른 포트로 실행합니다.

```bash
WAILS_VITE_PORT=9246 wails3 task dev
```

Windows PowerShell에서는 다음처럼 설정합니다.

```powershell
$env:WAILS_VITE_PORT = 9246
wails3 task dev
```

### Linux에서 GUI 라이브러리 오류

`pkg-config`, GTK4, WebKitGTK 6.0 개발 패키지가 있는지 확인합니다. Ubuntu 22.04처럼 WebKitGTK 6.0이 없는 환경은 기본 지원 대상이 아닙니다.
