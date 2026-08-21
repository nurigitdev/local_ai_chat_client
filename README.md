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

### 사전 준비

다음 도구가 필요합니다.

- Go 1.25 이상
- Node.js와 npm
- Wails 3 CLI

저장소를 내려받고 프로젝트 디렉터리로 이동합니다.

```shell
git clone https://github.com/taengson/agent-chat-desktop.git
cd agent-chat-desktop
```

Wails 3 CLI와 프런트엔드 의존성을 설치합니다.

```shell
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.11
export PATH="$(go env GOPATH)/bin:$PATH"
npm install --prefix frontend
```

### 개발 모드로 실행

소스 변경을 자동 반영하는 개발 모드로 앱을 실행합니다.

```shell
wails3 task dev
```

명령을 찾을 수 없다는 메시지가 나오면 Wails 실행 파일을 직접 지정할 수 있습니다.

```shell
"$(go env GOPATH)/bin/wails3" task dev
```

### macOS 앱으로 실행

배포용 `.app`을 생성하고 실행합니다.

```shell
wails3 task package
open bin/agent-chat-desktop.app
```

이미 앱이 실행 중이라면 기존 프로세스를 완전히 종료한 후 새로 패키징한 앱을 실행해야 변경 사항이 적용됩니다. 현재 연결 정보와 대화는 아직 메모리에만 있으므로 앱을 종료하면 초기화됩니다.

실행 파일만 빌드하려면 다음 명령을 사용합니다.

```shell
wails3 build
```

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
