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

func TestConversationStoreCreatesSavesAndOpensMarkdownConversation(t *testing.T) {
	store := newConversationStore(t.TempDir())

	conversation, err := store.Create()
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if conversation.Title != newConversationTitle {
		t.Fatalf("Create() title = %q, want %q", conversation.Title, newConversationTitle)
	}

	conversation.Messages = []ConversationMessage{
		{ID: "user-1", Role: "user", Content: "Markdown으로 저장해도 될까?", Status: "complete"},
		{ID: "assistant-1", Role: "assistant", Content: "\n네, 가능합니다.\n", Status: "complete"},
	}
	saved, err := store.Save(conversation)
	if err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if saved.Title != "Markdown으로 저장해도 될까?" {
		t.Fatalf("Save() title = %q", saved.Title)
	}

	summaries, err := store.List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(summaries) != 1 || summaries[0].MessageCount != 2 || summaries[0].ID != saved.ID {
		t.Fatalf("List() = %#v", summaries)
	}

	opened, err := store.Open(saved.ID)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	if opened.Title != saved.Title || len(opened.Messages) != 2 {
		t.Fatalf("Open() = %#v", opened)
	}
	if opened.Messages[0].Content != conversation.Messages[0].Content || opened.Messages[1].Content != conversation.Messages[1].Content {
		t.Fatalf("Open() messages = %#v", opened.Messages)
	}
}

func TestConversationStoreRejectsUnsafeConversationID(t *testing.T) {
	store := newConversationStore(t.TempDir())
	if _, err := store.Open("../outside"); err == nil {
		t.Fatal("Open() accepted an unsafe ID")
	}
}
