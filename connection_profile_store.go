package main

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const (
	profileDirectory    = "profiles"
	defaultProfileFile  = "last-used.md"
	defaultProfileTitle = "마지막 연결"
)

// SavedConnectionProfile deliberately contains only the server URL. Models are
// fetched from that server when the user chooses to load them, and API keys
// remain in memory only.
type SavedConnectionProfile struct {
	BaseURL string `json:"baseURL"`
}

type connectionProfileStore struct {
	root string
	mu   sync.Mutex
}

func newConnectionProfileStore(root string) *connectionProfileStore {
	return &connectionProfileStore{root: root}
}

func (s *connectionProfileStore) Load() (SavedConnectionProfile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	path, err := s.profilePath()
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

func (s *connectionProfileStore) Save(profile SavedConnectionProfile) (SavedConnectionProfile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	profile.BaseURL = strings.TrimSpace(profile.BaseURL)
	if err := validateSavedConnectionProfile(profile); err != nil {
		return SavedConnectionProfile{}, err
	}

	path, err := s.profilePath()
	if err != nil {
		return SavedConnectionProfile{}, err
	}
	contents := marshalSavedConnectionProfile(profile)
	temporary, err := os.CreateTemp(filepath.Dir(path), ".profile-*")
	if err != nil {
		return SavedConnectionProfile{}, fmt.Errorf("연결 정보 임시 파일을 만들 수 없습니다: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return SavedConnectionProfile{}, fmt.Errorf("연결 정보 파일 권한을 설정할 수 없습니다: %w", err)
	}
	if _, err := temporary.Write(contents); err != nil {
		temporary.Close()
		return SavedConnectionProfile{}, fmt.Errorf("연결 정보를 저장할 수 없습니다: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return SavedConnectionProfile{}, fmt.Errorf("연결 정보를 저장할 수 없습니다: %w", err)
	}
	if err := os.Rename(temporaryName, path); err != nil {
		return SavedConnectionProfile{}, fmt.Errorf("연결 정보 파일을 교체할 수 없습니다: %w", err)
	}
	return profile, nil
}

func (s *connectionProfileStore) profilePath() (string, error) {
	root, err := applicationDataDirectory(s.root)
	if err != nil {
		return "", err
	}
	directory := filepath.Join(root, profileDirectory)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", fmt.Errorf("연결 정보 저장 폴더를 만들 수 없습니다: %w", err)
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

func marshalSavedConnectionProfile(profile SavedConnectionProfile) []byte {
	return []byte("---\nbase_url: " + profile.BaseURL + "\n---\n\n# " + defaultProfileTitle + "\n")
}

func parseSavedConnectionProfile(contents []byte) (SavedConnectionProfile, error) {
	text := string(contents)
	if !strings.HasPrefix(text, "---\n") {
		return SavedConnectionProfile{}, errors.New("frontmatter가 없습니다")
	}
	frontmatterEnd := strings.Index(text[4:], "\n---\n")
	if frontmatterEnd < 0 {
		return SavedConnectionProfile{}, errors.New("frontmatter가 닫히지 않았습니다")
	}
	frontmatterEnd += 4
	values := make(map[string]string)
	for _, line := range strings.Split(text[4:frontmatterEnd], "\n") {
		key, value, ok := strings.Cut(line, ": ")
		if ok {
			values[key] = value
		}
	}
	profile := SavedConnectionProfile{BaseURL: values["base_url"]}
	if err := validateSavedConnectionProfile(profile); err != nil {
		return SavedConnectionProfile{}, err
	}
	return profile, nil
}
