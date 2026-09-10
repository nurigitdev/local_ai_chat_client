package main

import (
	"crypto/sha256"
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

// ModelBenchmarkImportResult describes the records added from a report and
// how many matching records were already in the local history.
type ModelBenchmarkImportResult struct {
	Imported       []ModelBenchmark `json:"imported"`
	DuplicateCount int              `json:"duplicateCount"`
}

func (s *modelBenchmarkStore) ImportReport(path string) (ModelBenchmarkImportResult, error) {
	records, err := readBenchmarkReport(path)
	if err != nil {
		return ModelBenchmarkImportResult{}, err
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

func (s *modelBenchmarkStore) importRecords(records []ModelBenchmark) (ModelBenchmarkImportResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(records) == 0 {
		return ModelBenchmarkImportResult{}, errors.New("가져올 벤치마크 결과가 없습니다")
	}
	directory, err := s.directory()
	if err != nil {
		return ModelBenchmarkImportResult{}, err
	}

	fingerprints, err := benchmarkImportFingerprints(directory)
	if err != nil {
		return ModelBenchmarkImportResult{}, err
	}

	prepared := make([]ModelBenchmark, 0, len(records))
	usedIDs := make(map[string]struct{}, len(records))
	result := ModelBenchmarkImportResult{Imported: prepared}
	for index, record := range records {
		record = normalizeModelBenchmark(record)
		record.Imported = true
		if err := validateModelBenchmark(record); err != nil {
			return ModelBenchmarkImportResult{}, fmt.Errorf("%d번째 벤치마크 결과를 가져올 수 없습니다: %w", index+1, err)
		}
		fingerprint, err := benchmarkImportFingerprint(record)
		if err != nil {
			return ModelBenchmarkImportResult{}, fmt.Errorf("%d번째 벤치마크 결과를 확인할 수 없습니다: %w", index+1, err)
		}
		if _, exists := fingerprints[fingerprint]; exists {
			result.DuplicateCount++
			continue
		}
		for benchmarkIDInUse(directory, record.ID, usedIDs) {
			record.ID = newConversationID()
		}
		usedIDs[record.ID] = struct{}{}
		fingerprints[fingerprint] = struct{}{}
		prepared = append(prepared, record)
	}

	for _, record := range prepared {
		if err := s.saveLocked(record); err != nil {
			return ModelBenchmarkImportResult{}, err
		}
	}
	result.Imported = prepared
	return result, nil
}

func benchmarkImportFingerprints(directory string) (map[[sha256.Size]byte]struct{}, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, fmt.Errorf("저장된 벤치마크 결과를 확인할 수 없습니다: %w", err)
	}

	fingerprints := make(map[[sha256.Size]byte]struct{}, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || strings.ToLower(filepath.Ext(entry.Name())) != ".md" {
			continue
		}
		contents, err := os.ReadFile(filepath.Join(directory, entry.Name()))
		if err != nil {
			return nil, fmt.Errorf("저장된 벤치마크 결과를 읽을 수 없습니다: %w", err)
		}
		benchmark, err := parseModelBenchmark(contents)
		if err != nil {
			return nil, fmt.Errorf("저장된 벤치마크 결과를 읽을 수 없습니다: %w", err)
		}
		fingerprint, err := benchmarkImportFingerprint(benchmark)
		if err != nil {
			return nil, fmt.Errorf("저장된 벤치마크 결과를 확인할 수 없습니다: %w", err)
		}
		fingerprints[fingerprint] = struct{}{}
	}
	return fingerprints, nil
}

func benchmarkImportFingerprint(benchmark ModelBenchmark) ([sha256.Size]byte, error) {
	benchmark = normalizeModelBenchmark(benchmark)
	benchmark.ID = ""
	benchmark.Imported = false
	payload, err := json.Marshal(benchmark)
	if err != nil {
		return [sha256.Size]byte{}, err
	}
	return sha256.Sum256(payload), nil
}

func benchmarkIDInUse(directory, id string, usedIDs map[string]struct{}) bool {
	if _, exists := usedIDs[id]; exists {
		return true
	}
	_, err := os.Stat(filepath.Join(directory, id+".md"))
	return err == nil
}
