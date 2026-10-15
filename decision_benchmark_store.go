package main

import (
	"bytes"
	"encoding/base64"
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

const maxDecisionRecordBytes = 64 * 1024 * 1024
const decisionRecordMarker = "<!-- decision-benchmark-v1 "

type decisionBenchmarkStore struct {
	root string
	mu   sync.Mutex
}

func (s *decisionBenchmarkStore) directory() (string, error) {
	root, err := applicationDataDirectory(s.root)
	if err != nil {
		return "", err
	}
	d := filepath.Join(root, "decision-benchmarks-v2")
	return d, os.MkdirAll(d, 0700)
}
func decisionReport(b DecisionBenchmark, format string) (string, error) {
	payload, err := json.Marshal(b)
	if err != nil {
		return "", err
	}
	if len(payload) > maxDecisionRecordBytes*3/4 {
		return "", errors.New("실행 기록이 64MiB 한도를 넘었습니다")
	}
	var text strings.Builder
	title := b.ExperimentName
	if title == "" {
		title = b.Suite.Name
	}
	fmt.Fprintf(&text, "# Decision Benchmark — %s\n\n상태: %s\n\n세트 버전: %s · 채점: %s\n\n출처: %s\n\n검토 상태: %s\n\n언어: 한국어\n\n", neutralDecisionText(title), b.Status, b.Suite.Revision, neutralDecisionText(b.ScoringVersion), neutralDecisionText(b.Suite.SourceDocument), b.Suite.ReviewStatus)
	for _, t := range b.Targets {
		fmt.Fprintf(&text, "대상: %s · %s · %s\n환경: %s (미기재 정보는 미확인)\n\n", t.Name, t.Model, t.BaseURL, t.Environment)
	}
	fmt.Fprintf(&text, "요청 제한: %d초 · 순차 실행 · 측정 재시도 없음 · 왕복 시간(네트워크 포함)\n\n", b.TimeoutSeconds)
	for _, s := range b.Summaries {
		fmt.Fprintf(&text, "## %s / %s\n\n시도 %d · 완료 %d · 라벨 채점 %d · 확률 채점 %d · 정답 %d · 오류 %d · 잘림 제외 %d\n\n", s.TargetID, s.TaskID, s.Attempted, s.Completed, s.Scorable, s.ProbabilityCount, s.Correct, s.Errors, s.Truncated)
		metrics, _ := json.MarshalIndent(s, "", "  ")
		text.WriteString("~~~json\n" + string(metrics) + "\n~~~\n\n")
	}
	text.WriteString("지표: 정확도=정답/라벨 채점 가능 수. Brier=문항별 전체 클래스 제곱 오차 합의 평균. ECE=최고 확률 기준 동일 너비 10구간. null은 평가 불가. 시간 p50/p95는 nearest-rank. 준비 요청은 집계 제외. 다른 환경의 속도는 참고값. 원본과 복원용 데이터는 아래 메타데이터에 포함됩니다.\n")
	text.WriteString("\n테스트셋: " + neutralDecisionText(b.Suite.Name) + "\n")
	body := neutralDecisionText(text.String())
	if format == "html" {
		body = decisionHTMLReport([]DecisionBenchmark{b}, "Decision Benchmark 결과 보고서", "같은 질문과 기준으로 모델의 판단 결과를 확인합니다.")
	}
	report := body + "\n" + decisionRecordMarker + base64.StdEncoding.EncodeToString(payload) + " -->\n"
	if len(report) > maxDecisionRecordBytes {
		return "", errors.New("보고서가 64MiB 한도를 넘었습니다")
	}
	return report, nil
}
func decodeDecisionRecord(data []byte) (DecisionBenchmark, error) {
	var b DecisionBenchmark
	if len(data) > maxDecisionRecordBytes {
		return b, errors.New("기록 크기 제한 초과")
	}
	start := bytes.Index(data, []byte(decisionRecordMarker))
	if start < 0 {
		return b, errors.New("Decision 복원 데이터가 없습니다")
	}
	part := data[start+len(decisionRecordMarker):]
	end := bytes.Index(part, []byte(" -->"))
	if end < 0 {
		return b, errors.New("기록 형식 오류")
	}
	raw, e := base64.StdEncoding.DecodeString(string(part[:end]))
	if e != nil {
		return b, e
	}
	if e = json.Unmarshal(raw, &b); e != nil {
		return b, e
	}
	if b.SchemaVersion != 1 || b.ScoringVersion != decisionScoringVersion || !isSafeConversationID(b.ID) {
		return b, errors.New("지원하지 않는 기록 버전·ID")
	}
	if e = validateDecisionSuite(b.Suite); e != nil {
		return b, e
	}
	if b.Fingerprint != decisionFingerprintForVersion(b.Suite, b.Types, b.ScoringVersion) {
		return b, errors.New("세트 지문이 일치하지 않습니다")
	}
	if e = validateDecisionRecord(b); e != nil {
		return b, e
	}
	b.Summaries = summarizeDecision(b)
	return b, nil
}
func (s *decisionBenchmarkStore) save(b DecisionBenchmark) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveLocked(b)
}
func (s *decisionBenchmarkStore) saveLocked(b DecisionBenchmark) error {
	if !isSafeConversationID(b.ID) {
		return errors.New("올바르지 않은 기록 ID")
	}
	d, e := s.directory()
	if e != nil {
		return e
	}
	report, e := decisionReport(b, "md")
	if e != nil {
		return e
	}
	if len(report) > maxDecisionRecordBytes {
		return errors.New("기록 크기 제한 초과")
	}
	tmp, e := os.CreateTemp(d, ".decision-*.tmp")
	if e != nil {
		return e
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, e = tmp.WriteString(report); e != nil {
		tmp.Close()
		return e
	}
	if e = tmp.Sync(); e != nil {
		tmp.Close()
		return e
	}
	if e = tmp.Close(); e != nil {
		return e
	}
	return os.Rename(name, filepath.Join(d, b.ID+".md"))
}
func (s *decisionBenchmarkStore) open(id string) (DecisionBenchmark, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.openLocked(id)
}
func (s *decisionBenchmarkStore) openLocked(id string) (DecisionBenchmark, error) {
	if !isSafeConversationID(id) {
		return DecisionBenchmark{}, errors.New("올바르지 않은 기록 ID")
	}
	d, e := s.directory()
	if e != nil {
		return DecisionBenchmark{}, e
	}
	p := filepath.Join(d, id+".md")
	info, e := os.Stat(p)
	if e != nil {
		return DecisionBenchmark{}, e
	}
	if info.Size() > maxDecisionRecordBytes {
		return DecisionBenchmark{}, errors.New("기록 크기 제한 초과")
	}
	data, e := os.ReadFile(p)
	if e != nil {
		return DecisionBenchmark{}, e
	}
	b, e := decodeDecisionRecord(data)
	if e == nil && b.ID != id {
		return b, errors.New("기록 ID 불일치")
	}
	return b, e
}
func (s *decisionBenchmarkStore) list() ([]DecisionBenchmark, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.listLocked()
}
func (s *decisionBenchmarkStore) listLocked() ([]DecisionBenchmark, error) {
	d, e := s.directory()
	if e != nil {
		return nil, e
	}
	entries, e := os.ReadDir(d)
	if e != nil {
		return nil, e
	}
	out := []DecisionBenchmark{}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".md" {
			continue
		}
		b, e := s.openLocked(strings.TrimSuffix(entry.Name(), ".md"))
		if e != nil {
			return nil, e
		}
		out = append(out, b)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out, nil
}
func (s *decisionBenchmarkStore) prepare() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	records, e := s.listLocked()
	if e != nil {
		return e
	}
	d, e := s.directory()
	if e != nil {
		return e
	}
	ended := 0
	for _, b := range records {
		if b.Status == "running" {
			continue
		}
		ended++
		if ended >= 80 {
			if e = os.Remove(filepath.Join(d, b.ID+".md")); e != nil {
				return e
			}
		}
	}
	return nil
}
func (s *decisionBenchmarkStore) markInterrupted() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	records, e := s.listLocked()
	if e != nil {
		return e
	}
	for _, b := range records {
		if b.Status != "running" {
			continue
		}
		b.Status = "interrupted"
		b.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		for i := range b.Results {
			if b.Results[i].Status == "pending" {
				b.Results[i].Status = "skipped"
			}
		}
		if e = s.saveLocked(b); e != nil {
			return e
		}
	}
	return nil
}
func (s *decisionBenchmarkStore) delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, e := s.openLocked(id)
	if e != nil {
		return e
	}
	if b.Status == "running" {
		return errors.New("실행 중인 기록은 삭제할 수 없습니다")
	}
	d, e := s.directory()
	if e != nil {
		return e
	}
	return os.Remove(filepath.Join(d, id+".md"))
}

var decisionBrandPattern = regexp.MustCompile("(?i)mybee")

func neutralDecisionText(text string) string {
	return decisionBrandPattern.ReplaceAllString(text, "업무영역")
}
