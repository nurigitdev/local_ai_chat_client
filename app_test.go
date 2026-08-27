package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
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

	if err := store.Delete(saved.ID); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if _, err := store.Open(saved.ID); err == nil {
		t.Fatal("Open() succeeded after Delete()")
	}
	summaries, err = store.List()
	if err != nil {
		t.Fatalf("List() after Delete() error = %v", err)
	}
	if len(summaries) != 0 {
		t.Fatalf("List() after Delete() = %#v", summaries)
	}
}

func TestConversationStoreRejectsUnsafeConversationID(t *testing.T) {
	store := newConversationStore(t.TempDir())
	if _, err := store.Open("../outside"); err == nil {
		t.Fatal("Open() accepted an unsafe ID")
	}
	if err := store.Delete("../outside"); err == nil {
		t.Fatal("Delete() accepted an unsafe ID")
	}
}

func TestConnectionProfileStoreSavesOnlyServerURL(t *testing.T) {
	root := t.TempDir()
	store := newConnectionProfileStore(root)
	profile := SavedConnectionProfile{BaseURL: "http://localhost:8000/v1"}

	saved, err := store.Save(profile)
	if err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if saved != profile {
		t.Fatalf("Save() = %#v, want %#v", saved, profile)
	}

	contents, err := os.ReadFile(filepath.Join(root, profileDirectory, defaultProfileFile))
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if strings.Contains(strings.ToLower(string(contents)), "api") || strings.Contains(string(contents), "key") || strings.Contains(string(contents), "model") {
		t.Fatalf("saved profile contains more than a server URL: %q", contents)
	}

	loaded, err := store.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if loaded != profile {
		t.Fatalf("Load() = %#v, want %#v", loaded, profile)
	}
}

func TestConnectionProfileStoreRejectsURLsThatMayContainCredentials(t *testing.T) {
	store := newConnectionProfileStore(t.TempDir())
	for _, baseURL := range []string{
		"https://token@example.com/v1",
		"https://example.com/v1?api_key=secret",
		"https://example.com/v1#access-token",
		"ftp://example.com",
	} {
		t.Run(baseURL, func(t *testing.T) {
			if _, err := store.Save(SavedConnectionProfile{BaseURL: baseURL}); err == nil {
				t.Fatal("Save() accepted an unsafe URL")
			}
		})
	}
}
