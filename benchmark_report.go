package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	benchmarkReportFormatVersion = 1
	maxBenchmarkReportSize       = 50 << 20
)

var benchmarkReportMarker = regexp.MustCompile(`<!-- agent-chat-benchmark-report-v1 ([A-Za-z0-9+/]+={0,2}) -->`)

// benchmarkReportPayload is stored in an HTML comment in exported Markdown
// and HTML reports. It keeps the report readable while retaining the exact
// measurements needed to import it into the benchmark workspace.
type benchmarkReportPayload struct {
	Version int              `json:"version"`
	Records []ModelBenchmark `json:"records"`
}

func (s *modelBenchmarkStore) ImportReport(path string) ([]ModelBenchmark, error) {
	records, err := readBenchmarkReport(path)
	if err != nil {
		return nil, err
	}
	return s.importRecords(records)
}

func readBenchmarkReport(path string) ([]ModelBenchmark, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("가져올 보고서를 선택해 주세요")
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".html", ".md":
	default:
		return nil, errors.New("HTML 또는 Markdown 벤치마크 보고서만 가져올 수 있습니다")
	}

	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("보고서 파일을 읽을 수 없습니다: %w", err)
	}
	if info.IsDir() {
		return nil, errors.New("보고서 파일을 선택해 주세요")
	}
	if info.Size() > maxBenchmarkReportSize {
		return nil, errors.New("보고서 파일이 너무 큽니다")
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("보고서 파일을 읽을 수 없습니다: %w", err)
	}

	if match := benchmarkReportMarker.FindSubmatch(contents); len(match) == 2 {
		return parseBenchmarkReportPayload(match[1])
	}

	// A benchmark's original local Markdown record already contains its full
	// payload. Accepting it makes older locally saved records portable too.
	if benchmark, err := parseModelBenchmark(contents); err == nil {
		return []ModelBenchmark{benchmark}, nil
	}
	return nil, errors.New("이 파일에는 가져올 수 있는 벤치마크 결과가 없습니다. 최신 Agent Chat 보고서를 선택해 주세요")
}

func parseBenchmarkReportPayload(encoded []byte) ([]ModelBenchmark, error) {
	payloadBytes, err := base64.StdEncoding.DecodeString(string(encoded))
	if err != nil {
		return nil, errors.New("보고서의 가져오기 정보가 손상되었습니다")
	}
	var payload benchmarkReportPayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return nil, errors.New("보고서의 가져오기 정보 형식이 올바르지 않습니다")
	}
	if payload.Version != benchmarkReportFormatVersion {
		return nil, errors.New("지원하지 않는 벤치마크 보고서 버전입니다")
	}
	if len(payload.Records) == 0 {
		return nil, errors.New("보고서에 벤치마크 결과가 없습니다")
	}
	if len(payload.Records) > 3 {
		return nil, errors.New("보고서에는 최대 3개의 벤치마크 결과만 포함할 수 있습니다")
	}
	for index := range payload.Records {
		payload.Records[index] = normalizeModelBenchmark(payload.Records[index])
		if err := validateModelBenchmark(payload.Records[index]); err != nil {
			return nil, fmt.Errorf("보고서의 %d번째 벤치마크 결과를 가져올 수 없습니다: %w", index+1, err)
		}
	}
	return payload.Records, nil
}

func (s *modelBenchmarkStore) importRecords(records []ModelBenchmark) ([]ModelBenchmark, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(records) == 0 {
		return nil, errors.New("가져올 벤치마크 결과가 없습니다")
	}
	directory, err := s.directory()
	if err != nil {
		return nil, err
	}

	prepared := make([]ModelBenchmark, len(records))
	usedIDs := make(map[string]struct{}, len(records))
	for index, record := range records {
		record = normalizeModelBenchmark(record)
		record.Imported = true
		if err := validateModelBenchmark(record); err != nil {
			return nil, fmt.Errorf("%d번째 벤치마크 결과를 가져올 수 없습니다: %w", index+1, err)
		}
		for benchmarkIDInUse(directory, record.ID, usedIDs) {
			record.ID = newConversationID()
		}
		usedIDs[record.ID] = struct{}{}
		prepared[index] = record
	}

	for _, record := range prepared {
		if err := s.saveLocked(record); err != nil {
			return nil, err
		}
	}
	return prepared, nil
}

func benchmarkIDInUse(directory, id string, usedIDs map[string]struct{}) bool {
	if _, exists := usedIDs[id]; exists {
		return true
	}
	_, err := os.Stat(filepath.Join(directory, id+".md"))
	return err == nil
}
