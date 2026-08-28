# Agent Chat Desktop 아키텍처

## 1. 문서 목적

이 문서는 Agent Chat Desktop의 구현 기준을 정의합니다. 프로젝트가 성장하더라도 채팅 기능, AI Provider, 로컬 저장소 및 A2A 에이전트 기능이 서로 강하게 결합되지 않도록 책임과 경계를 명확히 하는 것이 목적입니다.

현재 확정되지 않은 선택은 **제안**으로 표시합니다. 제안은 구현 전에 검증하고 결정되면 이 문서와 진행 현황 문서에 반영합니다.

## 2. 시스템 목표

1. vLLM을 포함한 OpenAI 호환 API와 스트리밍 방식으로 대화한다.
2. 사용자가 여러 서버와 모델을 연결 프로필로 관리한다.
3. UI와 특정 AI 서비스의 API 형식을 분리한다.
4. 대화와 설정을 로컬에서 관리하고 인증 정보를 안전하게 취급한다.
5. 이후 A2A 프로토콜을 통해 독립적인 에이전트를 발견하고 호출한다.
6. 장기 실행 Task, 진행 상태, 취소 및 Artifact를 데스크톱 UI에서 표현한다.

## 3. 범위

### 초기 범위

- 단일 사용자용 데스크톱 애플리케이션
- OpenAI 호환 모델 목록 조회
- 텍스트 기반 스트리밍 채팅
- 생성 중단과 오류 처리
- Markdown 파일 기반 대화 기록의 로컬 저장

### 후속 범위

- 이미지와 파일을 포함한 멀티모달 메시지
- 도구 호출과 구조화된 응답
- 여러 AI Provider 어댑터
- A2A Agent Card, Message, Task 및 Artifact
- 여러 에이전트의 순차·병렬 오케스트레이션

### 현재 범위에서 제외

- 중앙 사용자 계정과 클라우드 동기화
- 팀 단위 권한 관리
- 자체 모델 추론 서버 구현
- 자체 에이전트 런타임 구현

## 4. 상위 구조

```text
┌──────────────────────────────────────────────────────┐
│ Wails Desktop Application                            │
│                                                      │
│  Frontend                                            │
│  ├─ Chat and conversation UI                         │
│  ├─ Connection and model settings                    │
│  ├─ Streaming state and error presentation           │
│  └─ Agent task and workflow UI                       │
│                │ commands / events                   │
│                ▼                                     │
│  Go Application Layer                                │
│  ├─ Chat service                                     │
│  ├─ Profile service                                  │
│  ├─ Conversation service                             │
│  └─ Agent orchestration service                      │
│                │                                     │
│  Infrastructure                                     │
│  ├─ AI provider adapters ─── HTTP/SSE ── AI APIs     │
│  ├─ A2A adapter ──────────── HTTP/SSE ── Agents      │
│  ├─ Local Markdown conversation files                │
│  └─ Secret storage                                   │
└──────────────────────────────────────────────────────┘
```

프런트엔드는 화면 상태와 사용자 상호작용을 담당합니다. 외부 API 호출, 인증 정보 처리, 영속화 및 요청 취소는 Go 백엔드가 담당합니다.

## 5. 컴포넌트 책임

### Frontend

- 대화 및 메시지 목록 표시
- 연결 프로필과 모델 선택
- 사용자 입력과 생성 중단 요청
- 스트리밍 델타를 수신해 응답 갱신
- 오류, 재연결 및 작업 상태 표시
- 향후 A2A Task와 Artifact 시각화

프런트엔드는 vLLM이나 특정 Provider의 HTTP 스키마를 직접 다루지 않습니다.

### Wails API

- 프런트엔드가 호출할 명령 제공
- Go 도메인 타입에서 생성된 프런트엔드 타입 제공
- 스트리밍 및 작업 상태 이벤트 전달
- 스트리밍 완료 시점의 토큰 사용량 전달
- 애플리케이션 시작과 종료 수명 주기 관리

공개 메서드는 작게 유지하고 실제 로직을 서비스 계층에 위임합니다.

### Chat Service

- 사용자 메시지를 대화에 추가
- 선택된 연결 프로필과 Provider 결정
- 스트리밍 요청 시작과 취소
- 수신 이벤트를 공통 채팅 이벤트로 변환
- 완료 또는 실패한 응답을 대화 기록에 반영

### Provider Layer

- 모델 목록 조회
- 채팅 요청 전송
- 스트리밍 응답 파싱
- 서비스 오류를 공통 오류로 변환
- Provider별 인증과 옵션 처리
- Provider가 제공하는 토큰 사용량을 공통 형식으로 변환

vLLM은 별도 도메인 구현이 아니라 OpenAI 호환 Provider의 연결 대상 중 하나로 취급합니다.

### Storage Layer

- 대화와 메시지를 사용자 설정 폴더의 Markdown 파일로 저장
- 대화 목록용 제목과 요약 메타데이터를 Markdown 파일에서 조회
- 마지막으로 사용한 LLM 서버 URL을 별도 Markdown 파일에 저장
- 애플리케이션 설정 저장
- 향후 저장 형식 변경을 위한 마이그레이션 관리

API 키와 토큰은 일반 데이터베이스 또는 JSON 설정에 평문으로 저장하지 않습니다.

### A2A Layer

- Agent Card 조회와 검증
- A2A 메시지 전송
- Task 상태와 스트리밍 이벤트 처리
- 취소 및 Artifact 수신
- 여러 에이전트 실행 결과 취합

A2A 기능은 Provider Layer와 분리합니다. AI Provider는 모델 추론 API이고, A2A는 독립 에이전트 간 작업 위임 프로토콜이기 때문입니다.

## 6. 제안 디렉터리 구조

```text
agent-chat-desktop/
├─ frontend/
│  └─ src/
│     ├─ components/
│     ├─ features/
│     │  ├─ chat/
│     │  ├─ profiles/
│     │  └─ agents/
│     ├─ stores/
│     └─ types/
├─ internal/
│  ├─ domain/
│  ├─ chat/
│  ├─ provider/
│  │  └─ openai/
│  ├─ storage/
│  ├─ secrets/
│  └─ a2a/
├─ docs/
├─ app.go
├─ main.go
├─ go.mod
└─ wails.json
```

초기에는 필요한 패키지만 만들고, 아직 구현하지 않는 기능을 위한 빈 패키지는 생성하지 않습니다.

## 7. 핵심 도메인 모델

```go
type ConnectionProfile struct {
    ID           string
    Name         string
    ProviderType string
    BaseURL      string
    Model        string
    SecretRef    string
}

type Message struct {
    ID             string
    ConversationID string
    Role           string
    Parts          []MessagePart
    Status         string
    CreatedAt      time.Time
}

type MessagePart struct {
    Type     string
    Text     string
    MIMEType string
    URI      string
}
```

`MessagePart`를 사용해 텍스트로 시작하되 이후 이미지, 파일, 도구 호출 및 A2A Artifact로 확장할 수 있게 합니다. 실제 필드와 타입은 첫 구현에서 Go 타입으로 검증한 뒤 확정합니다.

## 8. Provider 인터페이스

Provider는 외부 AI 서비스의 차이를 애플리케이션에서 숨깁니다.

```go
type Provider interface {
    ListModels(ctx context.Context, profile ConnectionProfile) ([]Model, error)
    StreamChat(ctx context.Context, request ChatRequest) (<-chan ChatEvent, error)
}
```

공통 `ChatEvent`는 최소한 다음 상태를 표현합니다.

- `started`: 요청이 시작됨
- `delta`: 응답 일부를 수신함
- `completed`: 정상 완료됨
- `failed`: 오류로 종료됨
- `cancelled`: 사용자 요청으로 취소됨

`usage`는 선택적 보조 이벤트로, Provider가 최종 스트림 청크에 포함한 입력·출력·합계 토큰을 전달합니다. `metrics`는 앱이 측정한 총 응답 시간과 첫 토큰 도착 시간을 전달합니다. 사용량을 제공하지 않는 호환 서버도 채팅 완료 자체는 정상 처리합니다.

채널 종료만으로 완료와 실패를 구분하지 않고 명시적인 종료 이벤트를 전달합니다.

## 9. 채팅 요청 흐름

```text
사용자 전송
  → Frontend가 SendMessage 호출
  → Chat Service가 사용자 메시지 저장
  → Provider가 HTTP 요청 시작
  → Go가 스트리밍 응답 파싱
  → Wails 이벤트로 delta 전달
  → 최종 usage 이벤트로 토큰 사용량 전달
  → 완료 이벤트로 응답 시간 전달
  → Frontend가 응답 메시지 갱신
  → 완료 상태와 최종 메시지 저장
```

각 생성 요청은 고유한 ID와 `context.CancelFunc`를 갖습니다. 사용자가 중단하면 요청 ID에 대응하는 컨텍스트를 취소하고, 부분 응답은 `cancelled` 상태로 보존합니다.

## 10. 오류 처리

UI에는 내부 오류 문자열을 그대로 전달하지 않고 다음과 같은 공통 오류 코드와 사용자용 메시지를 전달합니다.

- 잘못된 서버 URL
- 연결 실패 또는 시간 초과
- 인증 실패
- 모델을 찾을 수 없음
- 요청 제한
- 잘못된 API 응답
- 스트리밍 중 연결 종료
- 사용자 취소

진단에 필요한 기술 정보는 민감한 헤더와 API 키를 제거한 뒤 로그에 기록합니다.

## 11. 저장소와 보안

- 대화와 메시지는 사용자 설정 폴더의 대화별 Markdown 파일로 저장합니다. 파일의 frontmatter에는 ID와 생성·수정 시각을 두고, 본문에는 사람이 읽을 수 있는 메시지를 기록합니다.
- 앱 시작 시 대화 목록을 표시하고 사용자가 선택한 대화만 채팅 화면에 적용합니다. 새 대화 생성은 별도의 목록 UI 동작으로 제공합니다.
- 사용자가 활성 대화의 삭제를 확인하면 해당 대화 Markdown 파일 하나만 삭제합니다. 마지막으로 열었던 대화의 자동 복원은 현재 제공하지 않습니다.
- 마지막 LLM 서버 URL은 `profiles/last-used.md`에 저장하고 앱 시작 시 복원합니다. 모델은 서버에서 다시 조회하므로 저장하지 않습니다.
- API 키는 저장·복원하지 않고 앱 실행 중 메모리에서만 사용합니다. URL의 사용자 정보, 쿼리 문자열, 프래그먼트는 API 키나 토큰을 포함할 수 있어 저장하지 않습니다.
- 프런트엔드에는 API 키 원문을 반환하지 않습니다.
- 로그에 Authorization 헤더, 전체 요청 헤더 및 비밀 값이 기록되지 않게 합니다.
- 로컬 HTTP 서버 연결을 허용하되 원격 평문 HTTP 연결에는 경고를 표시하는 방안을 검토합니다.

## 12. A2A 확장 설계

초기 채팅 기능 이후 다음 타입을 추가합니다.

```text
AgentProfile
├─ Agent Card URL
├─ Cached capabilities
├─ Authentication reference
└─ Connection state

AgentRun
├─ Agent and task identifiers
├─ Parent run identifier
├─ State and progress
├─ Input messages
└─ Output artifacts
```

오케스트레이터는 외부에서 하나의 에이전트로 동작하면서 내부적으로 여러 원격 에이전트를 호출할 수 있습니다. 각 하위 실행은 독립적인 `AgentRun`으로 기록하여 순차 실행, 병렬 실행, 부분 실패 및 취소 전파를 표현합니다.

Provider의 `ChatEvent`와 A2A의 Task 이벤트는 UI 이벤트 계층에서는 유사하게 보일 수 있지만 도메인 타입은 합치지 않습니다. 변환은 애플리케이션 서비스에서 수행합니다.

## 13. 테스트 전략

- Provider 스트리밍 파서 단위 테스트
- 오류 응답과 비정상 스트림 테스트
- 요청 취소 및 경쟁 상태 테스트
- 저장소 마이그레이션 테스트
- 사용자 정의 HTTP `RoundTripper`를 사용한 OpenAI 호환 API 테스트
- 프런트엔드 상태와 주요 사용자 흐름 테스트
- 향후 A2A Task 상태 전이와 부분 실패 테스트

실제 vLLM 서버를 요구하는 검증은 선택적 통합 테스트로 분리합니다.

## 14. 확정 및 제안 사항

| 항목 | 상태 | 내용 |
|---|---|---|
| 데스크톱 프레임워크 | 확정 | Wails 3.0.0-beta.11. macOS 26 및 Go 1.27 환경 호환성을 위해 Wails 2 대신 선택 |
| 백엔드 | 확정 | Go |
| 초기 API | 확정 | OpenAI 호환 API, 우선 vLLM |
| 외부 API 호출 위치 | 확정 | Go 백엔드 |
| Provider 추상화 | 확정 | 공통 인터페이스와 어댑터 구조 |
| A2A 경계 | 확정 | Provider와 분리된 별도 계층 |
| 프런트엔드 프레임워크 | 확정 | React + TypeScript |
| 로컬 데이터베이스 | 제안 | SQLite |
| 비밀 정보 저장소 | 제안 | 운영체제 보안 저장소 |
| A2A SDK와 프로토콜 버전 | 미정 | A2A 구현 시작 시 공식 호환성 확인 |

## 15. 현재 구현 기준선

2026-08-21 기준 첫 번째 목표인 로컬 LLM 기본 채팅이 동작합니다.

- React UI에서 서버 URL과 선택적 API 키를 입력하고 `/v1/models`의 모델을 선택합니다.
- Go 백엔드의 OpenAI 호환 어댑터가 `/v1/chat/completions`에 스트리밍 요청을 보냅니다.
- SSE 델타는 Wails의 `chat:event` 이벤트로 전달되며 UI가 응답을 실시간으로 갱신합니다.
- 각 요청은 요청 ID와 취소 컨텍스트를 사용합니다. 프런트엔드의 중단 요청은 해당 HTTP 요청으로 전파됩니다.
- 메시지 목록은 독립적인 스크롤 영역이며, macOS WebView에서도 동작하도록 휠 입력을 직접 처리하고 이전·최신 메시지 이동 수단을 제공합니다.
- 서버 주소는 루트 경로 또는 `/v1` 경로를 받을 수 있으며 백엔드가 API 엔드포인트를 정규화합니다.
- 모델 조회 및 스트리밍 파서에는 모의 HTTP 응답 기반 테스트가 있습니다.
- 실제 로컬 LLM 서버에서 모델 조회와 스트리밍 대화를 확인했습니다.

현재 연결 정보와 대화 메시지는 실행 중 메모리에만 존재하며 앱 재시작 후 복원되지 않습니다. `Chat Service`, `Storage Layer`, 공통 `Provider` 인터페이스와 도메인 패키지는 목표 구조이며, 다음 단계에서 영속화 경계를 구현하면서 구체화합니다.

## 16. 문서 관리 원칙

- 구현이 설계와 달라지면 같은 변경에서 이 문서를 갱신합니다.
- 중요한 기술 선택은 상태와 근거를 기록합니다.
- 완료 여부와 날짜별 작업 기록은 [개발 진행 현황](progress.md)에 작성합니다.
- 상세 구현이 복잡해지면 Architecture Decision Record를 `docs/decisions/`에 추가합니다.
