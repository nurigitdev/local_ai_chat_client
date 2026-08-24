# Agent Chat Desktop

Go와 Wails로 만드는 데스크톱 AI 채팅 클라이언트입니다. 우선 vLLM을 비롯한 OpenAI 호환 API와 연결되는 채팅 기능을 구현하고, 이후 A2A(Agent2Agent) 프로토콜을 이용해 여러 에이전트가 협업할 수 있는 애플리케이션으로 확장하는 것을 목표로 합니다.

## 목표

- 로컬 또는 원격 vLLM 서버 연결
- OpenAI 호환 API 기반의 다양한 AI 제공자 지원
- 실시간 스트리밍 채팅과 생성 중단
- 여러 서버와 모델을 관리할 수 있는 연결 프로필
- 로컬 대화 기록 및 설정 관리
- A2A Agent Card 탐색과 에이전트 호출
- 여러 에이전트의 작업 상태와 협업 흐름 시각화

## 기술 구성

```text
Wails Desktop Application
├── Frontend
│   ├── Chat UI
│   ├── Connection and model settings
│   └── Agent workflow visualization
└── Go Backend
    ├── Chat and streaming
    ├── AI provider adapters
    ├── Local storage
    └── A2A client and orchestration
```

- **Desktop framework:** Wails 3
- **Backend:** Go
- **Frontend:** React + TypeScript
- **Initial AI interface:** OpenAI-compatible API
- **Future agent interface:** A2A protocol

## 문서

- [상세 아키텍처](docs/architecture.md): 컴포넌트 책임, 데이터 흐름, 인터페이스, 보안 및 A2A 확장 설계
- [개발 진행 현황](docs/progress.md): 마일스톤 체크리스트, 현재 작업, 결정 사항 및 변경 이력

README는 프로젝트의 목표와 전체 방향을 설명합니다. 구현 수준의 설계와 진행 상태는 위 문서에서 별도로 관리합니다.

## 프로그램 실행 방법

### 공통 사전 준비

소스에서 빌드하려면 다음 개발 도구가 필요합니다. 이 도구들은 저장소에 포함되지 않으므로 처음 한 번 직접 설치해야 합니다.

| 도구 | 요구 버전 | 용도 | 확인 명령 |
|---|---:|---|---|
| Git | 최신 안정 버전 권장 | 저장소 복제 및 버전 관리 | `git --version` |
| Go | 1.25 이상 | 백엔드와 데스크톱 바이너리 빌드 | `go version` |
| Node.js | 20.19 이상 또는 22.12 이상 | React·Vite 프런트엔드 빌드 | `node --version` |
| npm | Node.js에 포함된 버전 | 프런트엔드 패키지 설치 | `npm --version` |
| Wails CLI | 3.0.0-beta.11 | 개발 실행 및 운영체제 패키징 | `wails3 version` |

#### macOS 개발 도구 설치

Homebrew가 설치되어 있다면 Git, Go 및 Node.js를 한 번에 설치할 수 있습니다.

```bash
brew install git go node
```

Homebrew를 사용하지 않는 경우 [Git 설치 페이지](https://git-scm.com/install/mac), [Go 공식 설치 파일](https://go.dev/dl/) 및 [Node.js LTS 설치 파일](https://nodejs.org/en/download)을 각각 설치합니다. Xcode Command Line Tools를 설치하면 Apple Git도 함께 제공됩니다.

```bash
xcode-select --install
git --version
go version
node --version
npm --version
```

#### Windows 개발 도구 설치

PowerShell에서 `winget`을 사용해 설치할 수 있습니다.

```powershell
winget install --id Git.Git -e --source winget
winget install --id GoLang.Go -e --source winget
winget install --id OpenJS.NodeJS.LTS -e --source winget
```

설치 후 PowerShell을 새로 열고 버전을 확인합니다.

```powershell
git --version
go version
node --version
npm --version
```

`winget`을 사용할 수 없다면 [Git for Windows](https://git-scm.com/install/windows), [Go 공식 설치 파일](https://go.dev/dl/) 및 [Node.js LTS 설치 파일](https://nodejs.org/en/download)을 이용합니다.

#### Linux 개발 도구 설치

Ubuntu와 Debian 계열:

```bash
sudo apt update
sudo apt install git golang-go nodejs npm
```

Fedora:

```bash
sudo dnf install git golang nodejs npm
```

Arch Linux:

```bash
sudo pacman -S git go nodejs npm
```

배포판 저장소의 Go 또는 Node.js가 요구 버전보다 오래됐을 수 있습니다. 설치 후 반드시 버전을 확인하고, 조건을 충족하지 않으면 [Go 공식 설치 안내](https://go.dev/doc/install)와 [Node.js LTS 설치 파일](https://nodejs.org/en/download)을 사용합니다.

```bash
git --version
go version
node --version
npm --version
```

#### Linux와 WSL의 GUI 의존성 및 한글 글꼴

이 프로젝트의 기본 Linux 지원 기준은 **Ubuntu 24.04 이상**입니다. 기본 빌드는 GTK4와 WebKitGTK 6.0을 사용합니다. Ubuntu 22.04와 같이 WebKitGTK 6.0을 제공하지 않는 환경은 기본 지원 대상이 아니며 별도의 GTK3 레거시 빌드 설정이 필요합니다.

Ubuntu 24.04 이상:

```bash
sudo apt update
sudo apt install build-essential pkg-config libgtk-4-dev libwebkitgtk-6.0-dev fontconfig
```

Fedora:

```bash
sudo dnf install gcc pkg-config gtk4-devel webkitgtk6.0-devel fontconfig
```

Arch Linux:

```bash
sudo pacman -S base-devel gtk4 webkitgtk-6.0 fontconfig
```

현재 앱은 운영체제의 시스템 글꼴을 사용합니다. 일반적인 Linux 데스크톱에는 한글 글꼴이 이미 설치되어 있을 수 있으므로 모든 환경에서 추가 설치가 필요한 것은 아닙니다. 다음 명령의 결과가 비어 있으면 한글 글꼴을 설치합니다.

```bash
fc-list :lang=ko family | head
```

Ubuntu, Debian 및 WSL의 Ubuntu 배포판:

```bash
sudo apt install fonts-noto-cjk
sudo fc-cache -fv
```

컬러 이모지 표시가 필요하면 `fonts-noto-color-emoji`도 설치할 수 있습니다.

```bash
sudo apt install fonts-noto-color-emoji
```

WSL은 글꼴을 지원하지 않는 환경이 아닙니다. WSLg에서 실행되는 앱은 Windows 글꼴이 아니라 WSL 배포판 내부의 Linux 글꼴을 사용하므로, 최소 설치 환경에는 한글 글꼴이 없을 수 있습니다. 글꼴 설치 후에도 반영되지 않으면 Windows PowerShell에서 WSL을 종료한 뒤 다시 시작합니다.

```powershell
wsl --shutdown
```

WSL에서 기본 빌드를 실행하면 Windows `.exe`가 아니라 WSLg에서 동작하는 Linux 실행 파일이 생성됩니다. Windows 배포용 프로그램은 Windows PowerShell 환경에서 빌드하는 것을 권장합니다.

#### Wails CLI와 프로젝트 설치

저장소를 내려받고 프로젝트 디렉터리로 이동합니다.

```shell
git clone https://github.com/taengson/agent-chat-desktop.git
cd agent-chat-desktop
```

프로젝트가 사용하는 Wails 3.0.0-beta.11 CLI와 프런트엔드 의존성을 설치합니다. `@latest` 대신 프로젝트와 동일한 버전을 지정해야 생성 코드와 빌드 도구의 차이를 피할 수 있습니다.

macOS와 Linux:

```bash
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.11
export PATH="$(go env GOPATH)/bin:$PATH"
npm install --prefix frontend
```

Windows PowerShell:

```powershell
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.11
$env:Path = "$(go env GOPATH)\bin;$env:Path"
npm install --prefix frontend
```

설치 상태와 운영체제별 시스템 의존성을 확인합니다.

```shell
wails3 version
wails3 doctor
```

자세한 최신 요구 사항은 [Wails 3 설치 문서](https://v3.wails.io/getting-started/installation/)에서 확인할 수 있습니다.

### 개발 모드 공통 실행

소스 변경을 자동 반영하는 개발 모드로 앱을 실행합니다.

```shell
wails3 task dev
```

`wails3` 명령을 찾지 못하면 Go 바이너리 디렉터리가 `PATH`에 포함됐는지 확인하고 터미널을 다시 시작합니다. macOS와 Linux에서는 다음과 같이 직접 실행할 수도 있습니다.

```bash
"$(go env GOPATH)/bin/wails3" task dev
```

### macOS

#### 빌드 환경

Xcode Command Line Tools가 필요합니다.

```bash
xcode-select --install
xcode-select -p
```

#### 패키지 생성

현재 CPU 아키텍처용 `.app` 번들을 생성합니다.

```bash
wails3 task package
```

결과는 `bin/agent-chat-desktop.app`입니다. Intel과 Apple Silicon을 함께 지원하는 Universal 앱 또는 DMG 설치 이미지는 다음과 같이 생성합니다.

```bash
wails3 task darwin:package:universal
wails3 task darwin:package:dmg
```

현재 `.app` 패키지는 ad-hoc 서명됩니다. 외부 배포에서는 Apple Developer ID 서명과 공증을 별도로 구성해야 합니다.

#### 설치 및 실행

빌드 디렉터리에서 바로 실행합니다.

```bash
open bin/agent-chat-desktop.app
```

일반 애플리케이션처럼 설치하려면 Finder에서 `.app`을 `/Applications`로 옮기거나 다음 명령을 사용합니다.

```bash
cp -R bin/agent-chat-desktop.app /Applications/
open -a "Agent Chat"
```

DMG를 생성했다면 파일을 열고 Agent Chat을 Applications 폴더로 드래그합니다. 서명·공증되지 않은 개발 빌드에 macOS 경고가 표시되면 Finder에서 앱을 Control-클릭한 뒤 **열기**를 선택합니다.

### Windows

#### 빌드 환경

Windows 10/11에 일반적으로 포함된 Microsoft WebView2 Runtime이 필요합니다. `wails3 doctor`로 설치 여부를 확인할 수 있습니다. 기본 NSIS 설치 프로그램을 만들려면 NSIS도 설치합니다.

```powershell
winget install NSIS.NSIS
wails3 doctor
```

#### 패키지 생성

PowerShell에서 Windows 실행 파일을 빌드합니다.

```powershell
wails3 build
```

결과는 `bin\agent-chat-desktop.exe`입니다. 직접 실행하려면 다음 명령을 사용합니다.

```powershell
.\bin\agent-chat-desktop.exe
```

NSIS 설치 프로그램은 다음 명령으로 생성합니다.

```powershell
wails3 task package
```

결과는 `bin\agent-chat-desktop-<ARCH>-installer.exe`입니다. 관리자 권한 없이 현재 사용자 영역에 설치하는 패키지가 필요하면 다음 변수를 지정합니다.

```powershell
wails3 task package INSTALL_SCOPE=user
```

#### 설치 및 실행

생성된 `agent-chat-desktop-<ARCH>-installer.exe`를 실행하고 설치 마법사를 완료합니다. 설치가 끝나면 시작 메뉴 또는 바탕 화면의 **Agent Chat** 바로 가기로 실행합니다. 서명되지 않은 개발 패키지는 Windows SmartScreen 경고가 표시될 수 있으므로 공개 배포 전에는 Authenticode 서명이 필요합니다.

### Linux

#### 빌드 환경

앞의 **Linux와 WSL의 GUI 의존성 및 한글 글꼴** 절에 따라 GTK4, WebKitGTK 6.0과 필요한 글꼴을 먼저 준비합니다. 설치가 끝나면 다음 명령으로 빌드 환경을 확인합니다.

```bash
wails3 doctor
```

배포판별 최신 의존성과 구형 GTK3 빌드 안내는 [Wails 3 Linux 패키징 문서](https://v3.wails.io/guides/build/linux/)를 참고합니다.

#### 패키지 생성

실행 파일만 빌드합니다.

```bash
wails3 build
./bin/agent-chat-desktop
```

AppImage, DEB, RPM 및 Arch Linux 패키지를 모두 생성합니다.

```bash
export GIT_COMMITTER_NAME="$(git config user.name)"
export GIT_COMMITTER_EMAIL="$(git config user.email)"
wails3 task package
```

필요한 형식만 생성할 수도 있습니다.

```bash
wails3 task linux:create:appimage
wails3 task linux:create:deb
wails3 task linux:create:rpm
wails3 task linux:create:aur
```

생성 파일은 `bin/` 디렉터리에 저장됩니다.

#### 설치 및 실행

AppImage:

```bash
chmod +x bin/*.AppImage
./bin/*.AppImage
```

Ubuntu와 Debian 계열의 DEB 패키지:

```bash
sudo apt install ./bin/*.deb
agent-chat-desktop
```

Fedora와 RHEL 계열의 RPM 패키지:

```bash
sudo dnf install ./bin/*.rpm
agent-chat-desktop
```

Arch Linux 패키지:

```bash
sudo pacman -U ./bin/*.pkg.tar.zst
agent-chat-desktop
```

설치 패키지는 실행 파일을 `/usr/local/bin/agent-chat-desktop`에 배치하고 데스크톱 애플리케이션 메뉴 항목을 등록합니다.

### 다른 운영체제용 빌드

가장 안정적인 방법은 대상 운영체제에서 직접 패키징하는 것입니다. 다른 운영체제에서 교차 빌드해야 한다면 Docker 기반 도구를 먼저 준비합니다.

```shell
wails3 task setup:docker
```

교차 빌드는 플랫폼별 패키징 도구와 코드 서명이 추가로 필요할 수 있습니다. Windows와 Linux 패키지는 Taskfile에 구성되어 있지만 현재 프로젝트에서 실제 패키징 및 실행 검증이 완료된 환경은 macOS입니다.

### 실행 시 주의 사항

이미 앱이 실행 중이라면 기존 프로세스를 완전히 종료한 후 새로 패키징한 앱을 실행해야 변경 사항이 적용됩니다. 현재 연결 정보와 대화는 아직 메모리에만 있으므로 앱을 종료하면 초기화됩니다.

### 로컬 LLM 연결

vLLM 또는 다른 OpenAI 호환 API 서버를 먼저 실행한 후 앱에서 다음 순서로 연결합니다.

1. 서버 URL에 vLLM 또는 OpenAI 호환 서버 주소를 입력합니다. 루트 주소와 `/v1`이 포함된 주소를 모두 사용할 수 있습니다.
2. 서버에서 인증을 요구할 때만 API 키를 입력합니다.
3. **모델 불러오기**를 누르고 사용할 모델을 선택합니다.
4. 메시지를 입력해 스트리밍 응답을 확인합니다. 생성 중에는 **중단** 버튼으로 요청을 취소할 수 있습니다.
5. 긴 대화는 휠이나 트랙패드로 이동할 수 있으며 **이전 메시지 ↑**, **최신 메시지 ↓** 버튼도 사용할 수 있습니다.

## 개발 단계

### 1. 기본 채팅

- Wails 애플리케이션 구성
- vLLM 서버 URL 및 모델 설정
- `/v1/models`를 이용한 모델 목록 조회
- `/v1/chat/completions` 기반 스트리밍 채팅
- 요청 취소와 기본 오류 처리

### 2. 데스크톱 클라이언트 기능

- 대화 생성, 전환 및 삭제
- 대화 기록의 로컬 저장
- 여러 API 연결 프로필
- Markdown과 코드 블록 표시
- API 키의 안전한 보관

### 3. Provider 확장

- 공통 Provider 인터페이스 정의
- OpenAI 호환 서비스 연결
- 서비스별 인증과 기능 차이 처리
- 도구 호출 및 구조화된 응답 지원

### 4. A2A 확장

- Agent Card 등록, 조회 및 캐시
- A2A 메시지와 장기 실행 Task 처리
- 진행 상태, 취소 및 Artifact 표시
- 여러 에이전트의 순차·병렬 실행
- 오케스트레이터와 에이전트 작업 흐름 시각화

## 보안 원칙

- API 키와 인증 정보는 Git에 커밋하지 않습니다.
- 로컬 전용 설정 파일은 버전 관리에서 제외합니다.
- 저장소에는 필요한 설정 항목만 설명하는 예제 파일을 제공합니다.
- 프런트엔드 코드에 API 키를 포함하지 않고 Go 백엔드에서 요청을 처리합니다.

## 프로젝트 상태

첫 번째 목표인 로컬 LLM 채팅 UI를 완료했습니다. Wails 데스크톱 앱에서 실제 OpenAI 호환 서버의 모델을 조회하고 선택한 모델과 스트리밍 방식으로 대화하는 흐름을 확인했습니다. 생성 중단도 구현되어 있으며, 다음 단계는 대화·연결 프로필의 로컬 저장과 API 키의 안전한 보관입니다.

## 라이선스

라이선스는 추후 결정합니다.
