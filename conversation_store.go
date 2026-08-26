package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	newConversationTitle  = "새 대화"
	conversationDirectory = "conversations"
)

var messageMarker = regexp.MustCompile(`(?m)^<!-- agent-chat-message (\{.*\}) -->\r?\n?`)

type ConversationMessage struct {
	ID      string `json:"id"`
	Role    string `json:"role"`
	Content string `json:"content"`
	Status  string `json:"status"`
}

type Conversation struct {
	ID        string                `json:"id"`
	Title     string                `json:"title"`
	CreatedAt string                `json:"createdAt"`
	UpdatedAt string                `json:"updatedAt"`
	Messages  []ConversationMessage `json:"messages"`
}

type ConversationSummary struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	UpdatedAt    string `json:"updatedAt"`
	MessageCount int    `json:"messageCount"`
}

type conversationStore struct {
	root string
	mu   sync.Mutex
}

func newConversationStore(root string) *conversationStore {
	return &conversationStore{root: root}
}

func (s *conversationStore) Create() (Conversation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UTC().Format(time.RFC3339Nano)
	conversation := Conversation{
		ID:        newConversationID(),
		Title:     newConversationTitle,
		CreatedAt: now,
		UpdatedAt: now,
		Messages:  []ConversationMessage{},
	}
	if err := s.saveLocked(conversation); err != nil {
		return Conversation{}, err
	}
	return conversation, nil
}

func (s *conversationStore) List() ([]ConversationSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	directory, err := s.directory()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, fmt.Errorf("대화 목록을 읽을 수 없습니다: %w", err)
	}

	summaries := make([]ConversationSummary, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".md" {
			continue
		}
		contents, err := os.ReadFile(filepath.Join(directory, entry.Name()))
		if err != nil {
			return nil, fmt.Errorf("대화 파일을 읽을 수 없습니다: %w", err)
		}
		conversation, err := parseConversation(contents)
		if err != nil {
			return nil, fmt.Errorf("대화 파일 %q의 형식이 올바르지 않습니다: %w", entry.Name(), err)
		}
		summaries = append(summaries, ConversationSummary{
			ID:           conversation.ID,
			Title:        conversation.Title,
			UpdatedAt:    conversation.UpdatedAt,
			MessageCount: len(conversation.Messages),
		})
	}

	sort.Slice(summaries, func(i, j int) bool {
		return summaries[i].UpdatedAt > summaries[j].UpdatedAt
	})
	return summaries, nil
}

func (s *conversationStore) Open(id string) (Conversation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !isSafeConversationID(id) {
		return Conversation{}, errors.New("올바르지 않은 대화 ID입니다")
	}
	directory, err := s.directory()
	if err != nil {
		return Conversation{}, err
	}
	contents, err := os.ReadFile(filepath.Join(directory, id+".md"))
	if errors.Is(err, os.ErrNotExist) {
		return Conversation{}, errors.New("대화를 찾을 수 없습니다")
	}
	if err != nil {
		return Conversation{}, fmt.Errorf("대화를 읽을 수 없습니다: %w", err)
	}
	conversation, err := parseConversation(contents)
	if err != nil {
		return Conversation{}, fmt.Errorf("대화 파일의 형식이 올바르지 않습니다: %w", err)
	}
	if conversation.ID != id {
		return Conversation{}, errors.New("대화 파일 ID가 일치하지 않습니다")
	}
	return conversation, nil
}

func (s *conversationStore) Save(conversation Conversation) (Conversation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !isSafeConversationID(conversation.ID) {
		return Conversation{}, errors.New("올바르지 않은 대화 ID입니다")
	}
	if strings.TrimSpace(conversation.CreatedAt) == "" {
		return Conversation{}, errors.New("대화 생성 시간이 없습니다")
	}
	for _, message := range conversation.Messages {
		if !isSafeConversationID(message.ID) {
			return Conversation{}, errors.New("올바르지 않은 메시지 ID입니다")
		}
		if message.Role != "user" && message.Role != "assistant" {
			return Conversation{}, errors.New("올바르지 않은 메시지 역할입니다")
		}
	}

	conversation.Title = conversationTitle(conversation.Title, conversation.Messages)
	conversation.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := s.saveLocked(conversation); err != nil {
		return Conversation{}, err
	}
	return conversation, nil
}

func (s *conversationStore) saveLocked(conversation Conversation) error {
	directory, err := s.directory()
	if err != nil {
		return err
	}
	contents, err := marshalConversation(conversation)
	if err != nil {
		return err
	}

	temporary, err := os.CreateTemp(directory, ".conversation-*")
	if err != nil {
		return fmt.Errorf("대화 임시 파일을 만들 수 없습니다: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("대화 파일 권한을 설정할 수 없습니다: %w", err)
	}
	if _, err := temporary.Write(contents); err != nil {
		temporary.Close()
		return fmt.Errorf("대화를 저장할 수 없습니다: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("대화를 저장할 수 없습니다: %w", err)
	}
	if err := os.Rename(temporaryName, filepath.Join(directory, conversation.ID+".md")); err != nil {
		return fmt.Errorf("대화 파일을 교체할 수 없습니다: %w", err)
	}
	return nil
}

func (s *conversationStore) directory() (string, error) {
	root := s.root
	if root == "" {
		configDirectory, err := os.UserConfigDir()
		if err != nil {
			return "", fmt.Errorf("사용자 설정 폴더를 찾을 수 없습니다: %w", err)
		}
		root = filepath.Join(configDirectory, "Agent Chat")
	}
	directory := filepath.Join(root, conversationDirectory)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", fmt.Errorf("대화 저장 폴더를 만들 수 없습니다: %w", err)
	}
	return directory, nil
}

func marshalConversation(conversation Conversation) ([]byte, error) {
	var builder strings.Builder
	builder.WriteString("---\n")
	builder.WriteString("id: ")
	builder.WriteString(conversation.ID)
	builder.WriteString("\ncreated_at: ")
	builder.WriteString(conversation.CreatedAt)
	builder.WriteString("\nupdated_at: ")
	builder.WriteString(conversation.UpdatedAt)
	builder.WriteString("\n---\n\n# ")
	builder.WriteString(conversation.Title)
	builder.WriteString("\n\n## Messages\n")

	for _, message := range conversation.Messages {
		marker, err := json.Marshal(struct {
			ID      string `json:"id"`
			Role    string `json:"role"`
			Status  string `json:"status"`
			Content int    `json:"contentBytes"`
		}{ID: message.ID, Role: message.Role, Status: message.Status, Content: len([]byte(message.Content))})
		if err != nil {
			return nil, fmt.Errorf("메시지 정보를 저장할 수 없습니다: %w", err)
		}
		builder.WriteString("\n<!-- agent-chat-message ")
		builder.Write(marker)
		builder.WriteString(" -->\n")
		builder.WriteString(message.Content)
		builder.WriteString("\n")
	}
	return []byte(builder.String()), nil
}

func parseConversation(contents []byte) (Conversation, error) {
	text := string(contents)
	if !strings.HasPrefix(text, "---\n") {
		return Conversation{}, errors.New("frontmatter가 없습니다")
	}
	frontmatterEnd := strings.Index(text[4:], "\n---\n")
	if frontmatterEnd < 0 {
		return Conversation{}, errors.New("frontmatter가 닫히지 않았습니다")
	}
	frontmatterEnd += 4
	frontmatter := text[4:frontmatterEnd]
	values := make(map[string]string)
	for _, line := range strings.Split(frontmatter, "\n") {
		key, value, ok := strings.Cut(line, ": ")
		if ok {
			values[key] = value
		}
	}
	if !isSafeConversationID(values["id"]) || values["created_at"] == "" || values["updated_at"] == "" {
		return Conversation{}, errors.New("필수 frontmatter 값이 없습니다")
	}

	body := text[frontmatterEnd+5:]
	title := newConversationTitle
	if strings.HasPrefix(body, "\n# ") {
		if titleEnd := strings.Index(body[3:], "\n"); titleEnd >= 0 {
			title = strings.TrimSpace(body[3 : titleEnd+3])
		}
	}
	matches := messageMarker.FindAllStringSubmatchIndex(body, -1)
	messages := make([]ConversationMessage, 0, len(matches))
	for index, match := range matches {
		var metadata struct {
			ID      string `json:"id"`
			Role    string `json:"role"`
			Status  string `json:"status"`
			Content *int   `json:"contentBytes"`
		}
		if err := json.Unmarshal([]byte(body[match[2]:match[3]]), &metadata); err != nil {
			return Conversation{}, errors.New("메시지 정보가 올바르지 않습니다")
		}
		if !isSafeConversationID(metadata.ID) || (metadata.Role != "user" && metadata.Role != "assistant") {
			return Conversation{}, errors.New("메시지 정보가 올바르지 않습니다")
		}
		contentEnd := len(body)
		if index+1 < len(matches) {
			contentEnd = matches[index+1][0]
		}
		contentStart := match[1]
		content := ""
		if metadata.Content != nil && *metadata.Content >= 0 && contentStart+*metadata.Content <= contentEnd {
			content = body[contentStart : contentStart+*metadata.Content]
		} else {
			// Older files and manually edited files do not carry a reliable byte length.
			content = strings.TrimRight(body[contentStart:contentEnd], "\n")
		}
		messages = append(messages, ConversationMessage{
			ID: metadata.ID, Role: metadata.Role, Status: metadata.Status, Content: content,
		})
	}

	return Conversation{
		ID: values["id"], Title: title, CreatedAt: values["created_at"], UpdatedAt: values["updated_at"], Messages: messages,
	}, nil
}

func conversationTitle(current string, messages []ConversationMessage) string {
	if current != "" && current != newConversationTitle {
		return truncateTitle(current)
	}
	for _, message := range messages {
		if message.Role == "user" && strings.TrimSpace(message.Content) != "" {
			return truncateTitle(strings.TrimSpace(message.Content))
		}
	}
	return newConversationTitle
}

func truncateTitle(title string) string {
	runes := []rune(strings.Join(strings.Fields(title), " "))
	if len(runes) > 48 {
		return string(runes[:48]) + "…"
	}
	return string(runes)
}

func isSafeConversationID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, character := range id {
		if !(character >= 'a' && character <= 'z') && !(character >= 'A' && character <= 'Z') && !(character >= '0' && character <= '9') && character != '-' && character != '_' {
			return false
		}
	}
	return true
}

func newConversationID() string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err == nil {
		return hex.EncodeToString(bytes)
	}
	return fmt.Sprintf("%d", time.Now().UnixNano())
}
