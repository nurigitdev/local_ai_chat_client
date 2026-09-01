package main

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

const (
	profileDirectory    = "profiles"
	defaultProfileFile  = "last-used.md"
	defaultProfileTitle = "마지막 연결"
)

// SavedConnectionProfile deliberately excludes the API key and model. The API
// key exists only in memory, and models are fetched again when a user connects.
type SavedConnectionProfile struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	BaseURL string `json:"baseURL"`
}

type connectionProfileStore struct {
	root string
	mu   sync.Mutex
}

func newConnectionProfileStore(root string) *connectionProfileStore {
	return &connectionProfileStore{root: root}
}

// Load returns the last server URL used by the app. It is deliberately kept
// separate from named profiles so typing a new URL never creates a profile.
func (s *connectionProfileStore) Load() (SavedConnectionProfile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	path, err := s.lastUsedPath()
	if err != nil {
		return SavedConnectionProfile{}, err
	}
	contents, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return SavedConnectionProfile{}, nil
	}
	if err != nil {
		return SavedConnectionProfile{}, fmt.Errorf("저장된 연결 정보를 읽을 수 없습니다: %w", err)
	}
	profile, err := parseSavedConnectionProfile(contents)
	if err != nil {
		return SavedConnectionProfile{}, fmt.Errorf("저장된 연결 정보 형식이 올바르지 않습니다: %w", err)
	}
	return profile, nil
}

// Save updates only the last-used URL. Call SaveNamed to create or update a
// reusable profile.
func (s *connectionProfileStore) Save(profile SavedConnectionProfile) (SavedConnectionProfile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	profile = SavedConnectionProfile{BaseURL: strings.TrimSpace(profile.BaseURL)}
	if err := validateSavedConnectionProfile(profile); err != nil {
		return SavedConnectionProfile{}, err
	}

	path, err := s.lastUsedPath()
	if err != nil {
		return SavedConnectionProfile{}, err
	}
	if err := writeProfileFile(path, marshalLastUsedConnectionProfile(profile)); err != nil {
		return SavedConnectionProfile{}, err
	}
	return profile, nil
}

func (s *connectionProfileStore) List() ([]SavedConnectionProfile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	directory, err := s.directory()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, fmt.Errorf("연결 프로필 목록을 읽을 수 없습니다: %w", err)
	}

	profiles := make([]SavedConnectionProfile, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || entry.Name() == defaultProfileFile || filepath.Ext(entry.Name()) != ".md" {
			continue
		}
		contents, err := os.ReadFile(filepath.Join(directory, entry.Name()))
		if err != nil {
			return nil, fmt.Errorf("연결 프로필을 읽을 수 없습니다: %w", err)
		}
		profile, err := parseNamedConnectionProfile(contents)
		if err != nil {
			return nil, fmt.Errorf("연결 프로필 %q의 형식이 올바르지 않습니다: %w", entry.Name(), err)
		}
		if entry.Name() != profile.ID+".md" {
			return nil, fmt.Errorf("연결 프로필 %q의 ID가 일치하지 않습니다", entry.Name())
		}
		profiles = append(profiles, profile)
	}

	sort.Slice(profiles, func(i, j int) bool {
		return profiles[i].Name < profiles[j].Name
	})
	return profiles, nil
}

func (s *connectionProfileStore) SaveNamed(profile SavedConnectionProfile) (SavedConnectionProfile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	profile.ID = strings.TrimSpace(profile.ID)
	profile.Name = normalizeProfileName(profile.Name)
	profile.BaseURL = strings.TrimSpace(profile.BaseURL)
	if profile.ID == "" {
		profile.ID = newConnectionProfileID()
	}
	if err := validateNamedConnectionProfile(profile); err != nil {
		return SavedConnectionProfile{}, err
	}

	directory, err := s.directory()
	if err != nil {
		return SavedConnectionProfile{}, err
	}
	if err := writeProfileFile(filepath.Join(directory, profile.ID+".md"), marshalNamedConnectionProfile(profile)); err != nil {
		return SavedConnectionProfile{}, err
	}
	return profile, nil
}

func (s *connectionProfileStore) DeleteNamed(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !isSafeConnectionProfileID(id) {
		return errors.New("올바르지 않은 연결 프로필 ID입니다")
	}
	directory, err := s.directory()
	if err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(directory, id+".md")); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return errors.New("연결 프로필을 찾을 수 없습니다")
		}
		return fmt.Errorf("연결 프로필을 삭제할 수 없습니다: %w", err)
	}
	return nil
}

func (s *connectionProfileStore) directory() (string, error) {
	root, err := applicationDataDirectory(s.root)
	if err != nil {
		return "", err
	}
	directory := filepath.Join(root, profileDirectory)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", fmt.Errorf("연결 정보 저장 폴더를 만들 수 없습니다: %w", err)
	}
	return directory, nil
}

func (s *connectionProfileStore) lastUsedPath() (string, error) {
	directory, err := s.directory()
	if err != nil {
		return "", err
	}
	return filepath.Join(directory, defaultProfileFile), nil
}

func applicationDataDirectory(root string) (string, error) {
	if root != "" {
		return root, nil
	}
	configDirectory, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("사용자 설정 폴더를 찾을 수 없습니다: %w", err)
	}
	return filepath.Join(configDirectory, "Agent Chat"), nil
}

func writeProfileFile(path string, contents []byte) error {
	temporary, err := os.CreateTemp(filepath.Dir(path), ".profile-*")
	if err != nil {
		return fmt.Errorf("연결 정보 임시 파일을 만들 수 없습니다: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("연결 정보 파일 권한을 설정할 수 없습니다: %w", err)
	}
	if _, err := temporary.Write(contents); err != nil {
		temporary.Close()
		return fmt.Errorf("연결 정보를 저장할 수 없습니다: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("연결 정보를 저장할 수 없습니다: %w", err)
	}
	if err := os.Rename(temporaryName, path); err != nil {
		return fmt.Errorf("연결 정보 파일을 교체할 수 없습니다: %w", err)
	}
	return nil
}

func validateSavedConnectionProfile(profile SavedConnectionProfile) error {
	if profile.BaseURL == "" {
		return errors.New("서버 URL이 없습니다")
	}
	if strings.ContainsAny(profile.BaseURL, "\r\n") {
		return errors.New("연결 정보에 줄바꿈을 포함할 수 없습니다")
	}
	parsed, err := url.Parse(profile.BaseURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return errors.New("http 또는 https 서버 URL을 입력해 주세요")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("API 키나 토큰이 포함될 수 있는 URL 형식은 저장할 수 없습니다")
	}
	return nil
}

func validateNamedConnectionProfile(profile SavedConnectionProfile) error {
	if !isSafeConnectionProfileID(profile.ID) {
		return errors.New("올바르지 않은 연결 프로필 ID입니다")
	}
	if profile.Name == "" {
		return errors.New("연결 프로필 이름을 입력해 주세요")
	}
	return validateSavedConnectionProfile(profile)
}

func marshalLastUsedConnectionProfile(profile SavedConnectionProfile) []byte {
	return []byte("---\nbase_url: " + profile.BaseURL + "\n---\n\n# " + defaultProfileTitle + "\n")
}

func marshalNamedConnectionProfile(profile SavedConnectionProfile) []byte {
	return []byte("---\nid: " + profile.ID + "\nbase_url: " + profile.BaseURL + "\n---\n\n# " + profile.Name + "\n")
}

func parseSavedConnectionProfile(contents []byte) (SavedConnectionProfile, error) {
	values, _, err := parseProfileDocument(contents)
	if err != nil {
		return SavedConnectionProfile{}, err
	}
	profile := SavedConnectionProfile{BaseURL: values["base_url"]}
	if err := validateSavedConnectionProfile(profile); err != nil {
		return SavedConnectionProfile{}, err
	}
	return profile, nil
}

func parseNamedConnectionProfile(contents []byte) (SavedConnectionProfile, error) {
	values, title, err := parseProfileDocument(contents)
	if err != nil {
		return SavedConnectionProfile{}, err
	}
	profile := SavedConnectionProfile{ID: values["id"], Name: normalizeProfileName(title), BaseURL: values["base_url"]}
	if err := validateNamedConnectionProfile(profile); err != nil {
		return SavedConnectionProfile{}, err
	}
	return profile, nil
}

func parseProfileDocument(contents []byte) (map[string]string, string, error) {
	text := string(contents)
	if !strings.HasPrefix(text, "---\n") {
		return nil, "", errors.New("frontmatter가 없습니다")
	}
	frontmatterEnd := strings.Index(text[4:], "\n---\n")
	if frontmatterEnd < 0 {
		return nil, "", errors.New("frontmatter가 닫히지 않았습니다")
	}
	frontmatterEnd += 4
	values := make(map[string]string)
	for _, line := range strings.Split(text[4:frontmatterEnd], "\n") {
		key, value, ok := strings.Cut(line, ": ")
		if ok {
			values[key] = value
		}
	}
	body := text[frontmatterEnd+5:]
	title := ""
	if strings.HasPrefix(body, "\n# ") {
		if titleEnd := strings.Index(body[3:], "\n"); titleEnd >= 0 {
			title = strings.TrimSpace(body[3 : titleEnd+3])
		}
	}
	return values, title, nil
}

func normalizeProfileName(name string) string {
	runes := []rune(strings.Join(strings.Fields(name), " "))
	if len(runes) > 48 {
		return string(runes[:48]) + "…"
	}
	return string(runes)
}

func isSafeConnectionProfileID(id string) bool {
	return isSafeConversationID(id)
}

func newConnectionProfileID() string {
	return newConversationID()
}
