package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/taengson/agent-chat-desktop/internal/provider/openai"
	"github.com/wailsapp/wails/v3/pkg/application"
)

const chatEventName = "chat:event"

type ConnectionProfile struct {
	BaseURL string `json:"baseURL"`
	APIKey  string `json:"apiKey"`
}

type Model struct {
	ID      string `json:"id"`
	OwnedBy string `json:"ownedBy,omitempty"`
}

type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ChatRequest struct {
	RequestID string            `json:"requestID"`
	Profile   ConnectionProfile `json:"profile"`
	Model     string            `json:"model"`
	Messages  []ChatMessage     `json:"messages"`
}

type ChatEvent struct {
	RequestID string `json:"requestID"`
	Type      string `json:"type"`
	Delta     string `json:"delta,omitempty"`
	Error     string `json:"error,omitempty"`
}

type App struct {
	ctx context.Context

	mu      sync.Mutex
	cancels map[string]context.CancelFunc
}

func NewApp() *App {
	return &App{cancels: make(map[string]context.CancelFunc)}
}

func (a *App) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
	a.ctx = ctx
	return nil
}

func (a *App) ServiceShutdown() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	for id, cancel := range a.cancels {
		cancel()
		delete(a.cancels, id)
	}
	return nil
}

func (a *App) ListModels(profile ConnectionProfile) ([]Model, error) {
	client, err := openai.NewClient(profile.BaseURL, profile.APIKey, nil)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(a.applicationContext(), 15*time.Second)
	defer cancel()

	models, err := client.ListModels(ctx)
	if err != nil {
		return nil, friendlyError(err)
	}

	result := make([]Model, 0, len(models))
	for _, model := range models {
		result = append(result, Model{ID: model.ID, OwnedBy: model.OwnedBy})
	}
	return result, nil
}

func (a *App) StartChat(request ChatRequest) error {
	request.RequestID = strings.TrimSpace(request.RequestID)
	request.Model = strings.TrimSpace(request.Model)
	if request.RequestID == "" {
		return errors.New("요청 ID가 없습니다")
	}
	if request.Model == "" {
		return errors.New("사용할 모델을 선택해 주세요")
	}
	if len(request.Messages) == 0 {
		return errors.New("전송할 메시지가 없습니다")
	}

	client, err := openai.NewClient(request.Profile.BaseURL, request.Profile.APIKey, nil)
	if err != nil {
		return err
	}

	messages := make([]openai.Message, 0, len(request.Messages))
	for _, message := range request.Messages {
		if strings.TrimSpace(message.Content) == "" {
			continue
		}
		messages = append(messages, openai.Message{Role: message.Role, Content: message.Content})
	}
	if len(messages) == 0 {
		return errors.New("전송할 메시지가 없습니다")
	}

	ctx, cancel := context.WithCancel(a.applicationContext())
	if err := a.storeCancel(request.RequestID, cancel); err != nil {
		cancel()
		return err
	}

	go a.runChat(ctx, request.RequestID, client, request.Model, messages)
	return nil
}

func (a *App) CancelChat(requestID string) bool {
	a.mu.Lock()
	cancel, ok := a.cancels[requestID]
	a.mu.Unlock()
	if ok {
		cancel()
	}
	return ok
}

func (a *App) runChat(
	ctx context.Context,
	requestID string,
	client *openai.Client,
	model string,
	messages []openai.Message,
) {
	defer a.removeCancel(requestID)
	a.emit(ChatEvent{RequestID: requestID, Type: "started"})

	err := client.StreamChat(ctx, openai.ChatRequest{Model: model, Messages: messages}, func(delta string) {
		a.emit(ChatEvent{RequestID: requestID, Type: "delta", Delta: delta})
	})
	if err == nil {
		a.emit(ChatEvent{RequestID: requestID, Type: "completed"})
		return
	}
	if errors.Is(err, context.Canceled) {
		a.emit(ChatEvent{RequestID: requestID, Type: "cancelled"})
		return
	}
	a.emit(ChatEvent{RequestID: requestID, Type: "failed", Error: friendlyError(err).Error()})
}

func (a *App) storeCancel(requestID string, cancel context.CancelFunc) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, exists := a.cancels[requestID]; exists {
		return errors.New("같은 요청이 이미 실행 중입니다")
	}
	a.cancels[requestID] = cancel
	return nil
}

func (a *App) removeCancel(requestID string) {
	a.mu.Lock()
	delete(a.cancels, requestID)
	a.mu.Unlock()
}

func (a *App) emit(event ChatEvent) {
	if application.Get() != nil {
		application.Get().Event.Emit(chatEventName, event)
	}
}

func (a *App) applicationContext() context.Context {
	if a.ctx != nil {
		return a.ctx
	}
	return context.Background()
}

func friendlyError(err error) error {
	var apiErr *openai.APIError
	if errors.As(err, &apiErr) {
		switch apiErr.StatusCode {
		case 401, 403:
			return errors.New("인증에 실패했습니다. API 키를 확인해 주세요")
		case 404:
			return errors.New("API 경로나 모델을 찾을 수 없습니다")
		case 429:
			return errors.New("요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요")
		}
		if apiErr.Message != "" {
			return fmt.Errorf("AI 서버 오류: %s", apiErr.Message)
		}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return errors.New("AI 서버 응답 시간이 초과되었습니다")
	}
	return err
}
