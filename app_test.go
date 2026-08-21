package main

import (
	"errors"
	"testing"

	"github.com/taengson/agent-chat-desktop/internal/provider/openai"
)

func TestFriendlyErrorForAuthentication(t *testing.T) {
	err := friendlyError(&openai.APIError{StatusCode: 401, Message: "invalid token"})
	if got := err.Error(); got != "인증에 실패했습니다. API 키를 확인해 주세요" {
		t.Fatalf("friendlyError() = %q", got)
	}
}

func TestFriendlyErrorPreservesUnknownError(t *testing.T) {
	want := errors.New("unknown")
	if got := friendlyError(want); !errors.Is(got, want) {
		t.Fatalf("friendlyError() = %v, want %v", got, want)
	}
}
