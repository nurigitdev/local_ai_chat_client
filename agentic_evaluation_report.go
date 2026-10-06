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
	agenticEvaluationReportFormatVersion = 1
	// A rendered report contains both readable trace text and a base64 payload,
	// so it can be roughly three times larger than its stored evaluation record.
	maxAgenticEvaluationReportBytes = maxAgenticEvaluationRecordBytes * 3
)

var agenticEvaluationReportMarker = regexp.MustCompile(`<!-- agent-chat-agentic-evaluation-report-v1 ([A-Za-z0-9+/]+={0,2}) -->`)

// AgenticEvaluationImportResult describes whether a report added a new result
// or matched an equivalent record already kept in local history.
type AgenticEvaluationImportResult struct {
	Evaluation AgenticEvaluation `json:"evaluation"`
	Duplicate  bool              `json:"duplicate"`
}

type agenticEvaluationReportPayload struct {
	Version    int               `json:"version"`
	Evaluation AgenticEvaluation `json:"evaluation"`
}

func (s *agenticEvaluationStore) ImportReport(path string) (AgenticEvaluationImportResult, error) {
	evaluation, err := readAgenticEvaluationReport(path)
	if err != nil {
		return AgenticEvaluationImportResult{}, err
	}
	return s.importEvaluation(evaluation)
}

func readAgenticEvaluationReport(path string) (AgenticEvaluation, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return AgenticEvaluation{}, errors.New("가져올 보고서를 선택해 주세요")
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".html", ".md":
	default:
		return AgenticEvaluation{}, errors.New("HTML 또는 Markdown 에이전트 실험 보고서만 가져올 수 있습니다")
	}

	info, err := os.Stat(path)
	if err != nil {
		return AgenticEvaluation{}, fmt.Errorf("보고서 파일을 확인할 수 없습니다: %w", err)
	}
	if info.IsDir() {
		return AgenticEvaluation{}, errors.New("보고서 파일을 선택해 주세요")
	}
	if info.Size() > maxAgenticEvaluationReportBytes {
		return AgenticEvaluation{}, errors.New("보고서 파일이 너무 큽니다")
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		return AgenticEvaluation{}, fmt.Errorf("보고서 파일을 읽을 수 없습니다: %w", err)
	}

	if match := agenticEvaluationReportMarker.FindSubmatch(contents); len(match) == 2 {
		return parseAgenticEvaluationReportPayload(match[1])
	}

	// Local history records are Markdown files too. Accepting their embedded
	// evaluation preserves portability for records written before report export.
	evaluation, err := parseAgenticEvaluation(contents)
	if err != nil {
		if errors.Is(err, errLegacyAgenticEvaluation) {
			return AgenticEvaluation{}, errLegacyAgenticEvaluation
		}
		return AgenticEvaluation{}, errors.New("이 파일에는 가져올 수 있는 에이전트 실험 결과가 없습니다. Agent Chat 보고서를 선택해 주세요")
	}
	if evaluation.Status == "running" {
		return AgenticEvaluation{}, errors.New("실행 중인 에이전트 실험 결과는 가져올 수 없습니다")
	}
	return evaluation, nil
}

func parseAgenticEvaluationReportPayload(encoded []byte) (AgenticEvaluation, error) {
	payloadBytes, err := base64.StdEncoding.DecodeString(string(encoded))
	if err != nil {
		return AgenticEvaluation{}, errors.New("보고서의 가져오기 정보가 손상되었습니다")
	}
	var payload agenticEvaluationReportPayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return AgenticEvaluation{}, errors.New("보고서의 가져오기 정보 형식이 올바르지 않습니다")
	}
	if payload.Version != agenticEvaluationReportFormatVersion {
		return AgenticEvaluation{}, errors.New("지원하지 않는 에이전트 실험 보고서 버전입니다")
	}
	evaluation := normalizeAgenticEvaluation(payload.Evaluation)
	if evaluation.MaxAttempts == 0 {
		return AgenticEvaluation{}, errLegacyAgenticEvaluation
	}
	if err := validateAgenticEvaluation(evaluation); err != nil {
		return AgenticEvaluation{}, fmt.Errorf("보고서의 에이전트 실험 결과가 올바르지 않습니다: %w", err)
	}
	if evaluation.Status == "running" {
		return AgenticEvaluation{}, errors.New("실행 중인 에이전트 실험 결과는 가져올 수 없습니다")
	}
	return evaluation, nil
}

func (s *agenticEvaluationStore) importEvaluation(evaluation AgenticEvaluation) (AgenticEvaluationImportResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	evaluation = normalizeAgenticEvaluation(evaluation)
	if err := validateAgenticEvaluation(evaluation); err != nil {
		return AgenticEvaluationImportResult{}, err
	}
	if evaluation.Status == "running" {
		return AgenticEvaluationImportResult{}, errors.New("실행 중인 에이전트 실험 결과는 가져올 수 없습니다")
	}
	incomingFingerprint, err := agenticEvaluationFingerprint(evaluation)
	if err != nil {
		return AgenticEvaluationImportResult{}, err
	}

	directory, err := s.directory()
	if err != nil {
		return AgenticEvaluationImportResult{}, err
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return AgenticEvaluationImportResult{}, fmt.Errorf("에이전트 실험 기록을 읽을 수 없습니다: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".md" {
			continue
		}
		contents, readErr := os.ReadFile(filepath.Join(directory, entry.Name()))
		if readErr != nil {
			return AgenticEvaluationImportResult{}, fmt.Errorf("에이전트 실험 기록을 읽을 수 없습니다: %w", readErr)
		}
		existing, parseErr := parseAgenticEvaluation(contents)
		if parseErr != nil {
			if errors.Is(parseErr, errLegacyAgenticEvaluation) {
				continue
			}
			return AgenticEvaluationImportResult{}, fmt.Errorf("에이전트 실험 기록 %q의 형식이 올바르지 않습니다: %w", entry.Name(), parseErr)
		}
		existingFingerprint, fingerprintErr := agenticEvaluationFingerprint(existing)
		if fingerprintErr != nil {
			return AgenticEvaluationImportResult{}, fingerprintErr
		}
		if existingFingerprint == incomingFingerprint {
			return AgenticEvaluationImportResult{Evaluation: existing, Duplicate: true}, nil
		}
	}

	if _, err := os.Stat(filepath.Join(directory, evaluation.ID+".md")); err == nil {
		for {
			candidate := newConversationID()
			if _, statErr := os.Stat(filepath.Join(directory, candidate+".md")); errors.Is(statErr, os.ErrNotExist) {
				evaluation.ID = candidate
				break
			} else if statErr != nil {
				return AgenticEvaluationImportResult{}, fmt.Errorf("에이전트 실험 기록을 확인할 수 없습니다: %w", statErr)
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return AgenticEvaluationImportResult{}, fmt.Errorf("에이전트 실험 기록을 확인할 수 없습니다: %w", err)
	}

	if err := s.pruneCompletedLocked(); err != nil {
		return AgenticEvaluationImportResult{}, err
	}
	if err := s.saveLocked(evaluation); err != nil {
		return AgenticEvaluationImportResult{}, err
	}
	return AgenticEvaluationImportResult{Evaluation: evaluation}, nil
}

func agenticEvaluationFingerprint(evaluation AgenticEvaluation) ([sha256.Size]byte, error) {
	evaluation = normalizeAgenticEvaluation(evaluation)
	// Import collisions may need a new local ID. The fingerprint intentionally
	// ignores it so an already imported report is still recognised as a duplicate.
	evaluation.ID = ""
	payload, err := json.Marshal(evaluation)
	if err != nil {
		return [sha256.Size]byte{}, fmt.Errorf("에이전트 실험 결과를 비교할 수 없습니다: %w", err)
	}
	return sha256.Sum256(payload), nil
}
