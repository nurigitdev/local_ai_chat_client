# Agent Chat Desktop

로컬 또는 원격의 OpenAI 호환 AI 서버와 연결하는 Wails 데스크톱 채팅 클라이언트입니다. 연결 프로필, 문서 첨부, 모델 벤치마크와 결과 비교를 제공합니다.

## 주요 기능

- OpenAI 호환 API·vLLM 서버 연결과 스트리밍 채팅
- 텍스트·코드·PDF 첨부 내용을 참고하는 대화
- 연결 프로필과 모델별 응답 시간·토큰 사용량 확인
- 질문지 프로필 기반 모델 벤치마크, 누적 결과, 최대 세 기록 비교
- Markdown 기반의 로컬 대화·벤치마크 기록 저장

## 빠른 시작

소스에서 실행하려면 Git, Go 1.25 이상, Node.js 20.19 이상 또는 22.12 이상이 필요합니다. macOS에는 Xcode Command Line Tools, Linux에는 GTK4·WebKitGTK 6.0 개발 패키지가 추가로 필요합니다.

| 운영체제 | 최초 준비 | 개발 실행 | 빌드 | 빌드 결과 실행 |
|---|---|---|---|---|
| macOS | `./scripts/macos/setup.sh` | `./scripts/macos/dev.sh` | `./scripts/macos/build.sh` | `./scripts/macos/run.sh` |
| Windows PowerShell | `powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup.ps1` | `powershell -ExecutionPolicy Bypass -File .\scripts\windows\dev.ps1` | `powershell -ExecutionPolicy Bypass -File .\scripts\windows\build.ps1` | `powershell -ExecutionPolicy Bypass -File .\scripts\windows\run.ps1` |
| Linux | `./scripts/linux/setup.sh` | `./scripts/linux/dev.sh` | `./scripts/linux/build.sh` | `./scripts/linux/run.sh` |

macOS에서 DMG를 만들려면 `./scripts/macos/build.sh --dmg`를 사용합니다. Linux에서 설치 패키지까지 만들려면 `./scripts/linux/build.sh --package`, Windows에서 NSIS 설치 프로그램을 만들려면 `powershell -ExecutionPolicy Bypass -File .\scripts\windows\build.ps1 -Package`를 사용하세요.

스크립트는 프로젝트에 필요한 Wails CLI와 프런트엔드 의존성을 준비하고 환경을 검사합니다. 시스템 도구는 임의로 설치하지 않으며, 빠진 항목과 설치 방법을 알려 줍니다.

## 에이전트에게 맡길 때

에이전트로 설치·빌드·실행 작업을 맡기는 경우 다음 파일을 먼저 읽도록 지시하세요.

> `docs/agent-setup.md`

이 문서에는 운영체제별 필수 도구, 권한이 필요한 설치 작업, 스크립트 사용 순서, 검증 방법과 자주 발생하는 문제의 해결 절차가 정리되어 있습니다.

## 문서

- [에이전트 설치·빌드 안내](docs/agent-setup.md)
- [상세 아키텍처](docs/architecture.md)
- [개발 진행 현황](docs/progress.md)

## 로컬 AI 서버 연결

1. vLLM 등 OpenAI 호환 API 서버를 실행합니다.
2. 앱에서 서버 URL과 필요한 경우 API 키를 입력합니다.
3. **모델 불러오기**로 모델을 선택합니다.
4. 채팅을 시작하거나 **모델 실험실**에서 저장된 연결 프로필로 벤치마크를 실행합니다.

대화와 벤치마크 결과는 사용자 설정 폴더에 Markdown 파일로 저장됩니다. API 키는 저장하지 않습니다.
