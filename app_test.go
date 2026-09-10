package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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

func TestResponseMetrics(t *testing.T) {
	startedAt := time.Now().Add(-2 * time.Second)
	firstTokenAt := startedAt.Add(450 * time.Millisecond)
	metrics := responseMetrics(startedAt, firstTokenAt)
	if metrics.FirstTokenDurationMs != 450 {
		t.Fatalf("FirstTokenDurationMs = %d, want 450", metrics.FirstTokenDurationMs)
	}
	if metrics.TotalDurationMs < 2_000 {
		t.Fatalf("TotalDurationMs = %d, want at least 2000", metrics.TotalDurationMs)
	}
}

func TestSaveBenchmarkExportWritesOnlySupportedReportFiles(t *testing.T) {
	app := NewApp()
	path := filepath.Join(t.TempDir(), "benchmark-report.md")

	if err := app.SaveBenchmarkExport(path, "# Benchmark report\n"); err != nil {
		t.Fatalf("SaveBenchmarkExport() error = %v", err)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if got, want := string(contents), "# Benchmark report\n"; got != want {
		t.Fatalf("export contents = %q, want %q", got, want)
	}

	if err := app.SaveBenchmarkExport(filepath.Join(t.TempDir(), "benchmark-report.txt"), "report"); err == nil {
		t.Fatal("SaveBenchmarkExport() accepted an unsupported extension")
	}
}

func TestSaveChatShareWritesOnlySupportedShareFiles(t *testing.T) {
	app := NewApp()
	path := filepath.Join(t.TempDir(), "chat-share.html")

	if err := app.SaveChatShare(path, "<h1>Shared response</h1>"); err != nil {
		t.Fatalf("SaveChatShare() error = %v", err)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if got, want := string(contents), "<h1>Shared response</h1>"; got != want {
		t.Fatalf("share contents = %q, want %q", got, want)
	}

	if err := app.SaveChatShare(filepath.Join(t.TempDir(), "chat-share.txt"), "response"); err == nil {
		t.Fatal("SaveChatShare() accepted an unsupported extension")
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
		{
			ID:      "user-1",
			Role:    "user",
			Content: "Markdown으로 저장해도 될까?",
			Status:  "complete",
			Attachments: []ChatAttachment{{
				Name: "example.ts", Size: 42, Content: "export const answer = 42;",
			}},
		},
		{
			ID: "assistant-1", Role: "assistant", Content: "\n네, 가능합니다.\n", Status: "complete",
			Usage:   &TokenUsage{PromptTokens: 21, CompletionTokens: 8, TotalTokens: 29},
			Metrics: &ResponseMetrics{TotalDurationMs: 1_250, FirstTokenDurationMs: 340},
		},
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
	if len(opened.Messages[0].Attachments) != 1 || opened.Messages[0].Attachments[0] != conversation.Messages[0].Attachments[0] {
		t.Fatalf("Open() attachments = %#v", opened.Messages[0].Attachments)
	}
	if opened.Messages[1].Usage == nil || *opened.Messages[1].Usage != (TokenUsage{PromptTokens: 21, CompletionTokens: 8, TotalTokens: 29}) {
		t.Fatalf("Open() usage = %#v", opened.Messages[1].Usage)
	}
	if opened.Messages[1].Metrics == nil || *opened.Messages[1].Metrics != (ResponseMetrics{TotalDurationMs: 1_250, FirstTokenDurationMs: 340}) {
		t.Fatalf("Open() metrics = %#v", opened.Messages[1].Metrics)
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

func TestValidateAttachmentsAllowsLargeSourceWhenExtractedTextIsLimited(t *testing.T) {
	attachment := ChatAttachment{
		Name:      "large-document.pdf",
		Size:      2 * 1024 * 1024,
		Content:   strings.Repeat("가", 70_000),
		Truncated: true,
	}
	if err := validateAttachments([]ChatAttachment{attachment}); err != nil {
		t.Fatalf("validateAttachments() error = %v", err)
	}
}

func TestValidateAttachmentsRejectsOversizedSourceFile(t *testing.T) {
	attachment := ChatAttachment{
		Name:    "too-large.txt",
		Size:    maxAttachmentFileSize + 1,
		Content: "excerpt",
	}
	if err := validateAttachments([]ChatAttachment{attachment}); err == nil {
		t.Fatal("validateAttachments() error = nil, want oversized source rejection")
	}
}

func TestValidateAttachmentsRejectsOversizedSelectionSummary(t *testing.T) {
	attachment := ChatAttachment{
		Name:             "excerpt.txt",
		Size:             1,
		Content:          "excerpt",
		SelectionSummary: strings.Repeat("가", 161),
	}
	if err := validateAttachments([]ChatAttachment{attachment}); err == nil {
		t.Fatal("validateAttachments() error = nil, want oversized selection summary rejection")
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

func TestConnectionProfileStoreSavesListsAndDeletesNamedProfiles(t *testing.T) {
	store := newConnectionProfileStore(t.TempDir())
	first, err := store.SaveNamed(SavedConnectionProfile{
		Name:    "로컬 vLLM",
		BaseURL: "http://localhost:8000",
	})
	if err != nil {
		t.Fatalf("SaveNamed() error = %v", err)
	}
	if first.ID == "" || first.Name != "로컬 vLLM" {
		t.Fatalf("SaveNamed() = %#v", first)
	}
	second, err := store.SaveNamed(SavedConnectionProfile{
		Name:    "회사 서버",
		BaseURL: "https://models.example.com/v1",
	})
	if err != nil {
		t.Fatalf("SaveNamed() error = %v", err)
	}

	profiles, err := store.List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(profiles) != 2 {
		t.Fatalf("List() = %#v", profiles)
	}

	updated, err := store.SaveNamed(SavedConnectionProfile{
		ID:      first.ID,
		Name:    "내 로컬 서버",
		BaseURL: "http://127.0.0.1:8000/v1",
	})
	if err != nil {
		t.Fatalf("SaveNamed() update error = %v", err)
	}
	if updated.ID != first.ID || updated.Name != "내 로컬 서버" {
		t.Fatalf("SaveNamed() update = %#v", updated)
	}

	if err := store.DeleteNamed(second.ID); err != nil {
		t.Fatalf("DeleteNamed() error = %v", err)
	}
	profiles, err = store.List()
	if err != nil {
		t.Fatalf("List() after DeleteNamed() error = %v", err)
	}
	if len(profiles) != 1 || profiles[0] != updated {
		t.Fatalf("List() after DeleteNamed() = %#v", profiles)
	}
}

func TestChatCancellationEmitsCancelledAfterStreamingStarts(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "text/event-stream")
		flusher, ok := writer.(http.Flusher)
		if !ok {
			t.Error("ResponseWriter does not support flushing")
			return
		}
		_, _ = fmt.Fprint(writer, "data: {\"choices\":[{\"delta\":{\"content\":\"첫 응답\"}}]}\n\n")
		flusher.Flush()
		<-request.Context().Done()
	}))
	defer server.Close()

	app := NewApp()
	events := make(chan ChatEvent, 8)
	app.eventSink = func(event ChatEvent) {
		events <- event
	}
	if err := app.StartChat(ChatRequest{
		RequestID: "cancel-test",
		Profile:   ConnectionProfile{BaseURL: server.URL},
		Model:     "test-model",
		Messages:  []ChatMessage{{Role: "user", Content: "취소 테스트"}},
	}); err != nil {
		t.Fatalf("StartChat() error = %v", err)
	}

	cancelled := false
	timeout := time.NewTimer(3 * time.Second)
	defer timeout.Stop()
	for !cancelled {
		select {
		case event := <-events:
			switch event.Type {
			case "delta":
				if !app.CancelChat("cancel-test") {
					t.Fatal("CancelChat() = false, want true")
				}
			case "completed":
				t.Fatal("cancelled stream emitted completed")
			case "cancelled":
				if event.Metrics == nil {
					t.Fatal("cancelled event has no metrics")
				}
				cancelled = true
			}
		case <-timeout.C:
			t.Fatal("timed out waiting for cancelled event")
		}
	}
}

func TestStreamWatchdogFailsWhenOutputNeverStarts(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	watchdog := newStreamWatchdog(time.Now(), cancel, streamTimeoutPolicy{
		firstOutputTimeout: 30 * time.Millisecond,
		outputIdleTimeout:  40 * time.Millisecond,
		checkInterval:      5 * time.Millisecond,
	})
	defer watchdog.stop()
	go watchdog.watch(ctx)

	select {
	case <-ctx.Done():
	case <-time.After(300 * time.Millisecond):
		t.Fatal("stream watchdog did not time out before the first output")
	}
	if err := watchdog.timeoutError(); err == nil || !strings.Contains(err.Error(), "시작되지") {
		t.Fatalf("watchdog timeout error = %v, want first-output timeout", err)
	}
}

func TestStreamWatchdogExtendsWhileOutputContinues(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	watchdog := newStreamWatchdog(time.Now(), cancel, streamTimeoutPolicy{
		firstOutputTimeout: 80 * time.Millisecond,
		outputIdleTimeout:  80 * time.Millisecond,
		checkInterval:      5 * time.Millisecond,
	})
	defer watchdog.stop()
	go watchdog.watch(ctx)

	for range 4 {
		watchdog.recordOutput()
		time.Sleep(35 * time.Millisecond)
	}
	select {
	case <-ctx.Done():
		t.Fatalf("stream watchdog cancelled an active stream: %v", watchdog.timeoutError())
	default:
	}

	select {
	case <-ctx.Done():
	case <-time.After(400 * time.Millisecond):
		t.Fatal("stream watchdog did not time out after output stopped")
	}
	if err := watchdog.timeoutError(); err == nil || !strings.Contains(err.Error(), "출력이") {
		t.Fatalf("watchdog timeout error = %v, want output-idle timeout", err)
	}
}

func TestChatStreamTimeoutPolicyIsLooserThanBenchmark(t *testing.T) {
	if defaultChatStreamTimeoutPolicy.firstOutputTimeout <= defaultBenchmarkStreamTimeoutPolicy.firstOutputTimeout {
		t.Fatalf("chat first-output timeout = %s, want longer than benchmark timeout %s", defaultChatStreamTimeoutPolicy.firstOutputTimeout, defaultBenchmarkStreamTimeoutPolicy.firstOutputTimeout)
	}
	if defaultChatStreamTimeoutPolicy.outputIdleTimeout <= defaultBenchmarkStreamTimeoutPolicy.outputIdleTimeout {
		t.Fatalf("chat output-idle timeout = %s, want longer than benchmark timeout %s", defaultChatStreamTimeoutPolicy.outputIdleTimeout, defaultBenchmarkStreamTimeoutPolicy.outputIdleTimeout)
	}
}

func TestStreamingHTTPClientHasNoAbsoluteTimeout(t *testing.T) {
	if timeout := streamingHTTPClient().Timeout; timeout != 0 {
		t.Fatalf("streaming HTTP timeout = %s, want no absolute timeout", timeout)
	}
}

func TestModelBenchmarkStoreCreatesSavesAndOpensBenchmark(t *testing.T) {
	store := newModelBenchmarkStore(t.TempDir())
	benchmark, err := store.Create(ModelBenchmark{
		ProfileID:      "profile-1",
		ProfileName:    "로컬 vLLM",
		ProfileBaseURL: "http://localhost:8000",
		Model:          "model-a",
		SuiteName:      "기본 실용 벤치마크",
		Status:         "running",
		Cases: []ModelBenchmarkCase{
			{ID: "case-1", Category: "지시 이행", Title: "구조화된 출력", Prompt: "JSON 배열만 출력", Status: "pending"},
			{ID: "case-2", Category: "추론", Title: "제약 조건", Prompt: "가능한 순서를 제시", Status: "pending"},
		},
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if benchmark.ID == "" || benchmark.CreatedAt == "" {
		t.Fatalf("Create() = %#v", benchmark)
	}
	if benchmark.Imported {
		t.Fatalf("Create() marked a local benchmark as imported: %#v", benchmark)
	}

	benchmark.Status = "completed"
	benchmark.Cases[0] = ModelBenchmarkCase{
		ID: "case-1", Category: "지시 이행", Title: "구조화된 출력", Prompt: "JSON 배열만 출력", Content: "첫 번째 응답", Status: "complete",
		Usage:   &TokenUsage{PromptTokens: 10, CompletionTokens: 4, TotalTokens: 14},
		Metrics: &ResponseMetrics{TotalDurationMs: 1_200, FirstTokenDurationMs: 180},
	}
	benchmark.Cases[1] = ModelBenchmarkCase{
		ID: "case-2", Category: "추론", Title: "제약 조건", Prompt: "가능한 순서를 제시", Content: "두 번째 응답", Status: "complete",
		Usage:   &TokenUsage{PromptTokens: 10, CompletionTokens: 5, TotalTokens: 15},
		Metrics: &ResponseMetrics{TotalDurationMs: 1_500, FirstTokenDurationMs: 220},
	}
	saved, err := store.Save(benchmark)
	if err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	opened, err := store.Open(saved.ID)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	if opened.Model != "model-a" || len(opened.Cases) != 2 || opened.Cases[0].Content != "첫 번째 응답" {
		t.Fatalf("Open() = %#v", opened)
	}

	summaries, err := store.List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(summaries) != 1 || summaries[0].Model != "model-a" || summaries[0].CaseCount != 2 || summaries[0].CompletedCaseCount != 2 {
		t.Fatalf("List() = %#v", summaries)
	}
	if summaries[0].ProfileName != "로컬 vLLM" || summaries[0].ProfileBaseURL != "http://localhost:8000" {
		t.Fatalf("List() profile summary = %#v", summaries[0])
	}

	if err := store.Delete(saved.ID); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if _, err := store.Open(saved.ID); err == nil {
		t.Fatal("Open() succeeded after benchmark Delete()")
	}
}

func TestModelBenchmarkStoreImportsSharedReportAndPreservesMetrics(t *testing.T) {
	store := newModelBenchmarkStore(t.TempDir())
	source := completedBenchmarkForReport("shared-result")
	payload, err := json.Marshal(benchmarkReportPayload{
		Version: benchmarkReportFormatVersion,
		Records: []ModelBenchmark{source},
	})
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	path := filepath.Join(t.TempDir(), "shared-benchmark.html")
	contents := "<html><body><!-- agent-chat-benchmark-report-v1 " + base64.StdEncoding.EncodeToString(payload) + " --></body></html>"
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	importResult, err := store.ImportReport(path)
	if err != nil {
		t.Fatalf("ImportReport() error = %v", err)
	}
	imported := importResult.Imported
	if len(imported) != 1 || imported[0].ID != source.ID || !imported[0].Imported {
		t.Fatalf("ImportReport() = %#v, want source ID %q", imported, source.ID)
	}
	if importResult.DuplicateCount != 0 {
		t.Fatalf("ImportReport().DuplicateCount = %d, want 0", importResult.DuplicateCount)
	}
	opened, err := store.Open(source.ID)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	if got := opened.Cases[0]; got.Content != source.Cases[0].Content || got.Metrics == nil || *got.Metrics != *source.Cases[0].Metrics || got.Usage == nil || *got.Usage != *source.Cases[0].Usage {
		t.Fatalf("opened imported case = %#v, want original metrics and response", got)
	}

	// Re-importing the same report must keep both results instead of replacing
	// the first one, because an imported report may use an existing local ID.
	importedAgain, err := store.ImportReport(path)
	if err != nil {
		t.Fatalf("second ImportReport() error = %v", err)
	}
	if len(importedAgain.Imported) != 0 || importedAgain.DuplicateCount != 1 {
		t.Fatalf("second ImportReport() = %#v, want one skipped duplicate", importedAgain)
	}
	summaries, err := store.List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(summaries) != 1 || !summaries[0].Imported {
		t.Fatalf("List() = %#v, want one imported record", summaries)
	}
}

func TestModelBenchmarkStoreImportsOnlyNewResultsFromMixedReport(t *testing.T) {
	store := newModelBenchmarkStore(t.TempDir())
	source := completedBenchmarkForReport("shared-result")
	if _, err := store.ImportReport(writeBenchmarkReport(t, source)); err != nil {
		t.Fatalf("first ImportReport() error = %v", err)
	}

	newResult := completedBenchmarkForReport(source.ID)
	newResult.Model = "new-model"
	newResult.CreatedAt = "2026-09-10T01:02:03Z"
	newResult.UpdatedAt = "2026-09-10T01:02:04Z"
	newResult.Cases[0].ID = "new-case"

	result, err := store.ImportReport(writeBenchmarkReport(t, source, newResult))
	if err != nil {
		t.Fatalf("mixed ImportReport() error = %v", err)
	}
	if len(result.Imported) != 1 || result.Imported[0].ID == source.ID || result.DuplicateCount != 1 {
		t.Fatalf("mixed ImportReport() = %#v, want one new result with a new ID and one skipped duplicate", result)
	}
	summaries, err := store.List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(summaries) != 2 {
		t.Fatalf("List() count = %d, want 2", len(summaries))
	}
}

func TestModelBenchmarkStoreImportsExistingLocalMarkdownRecord(t *testing.T) {
	store := newModelBenchmarkStore(t.TempDir())
	source := completedBenchmarkForReport("local-record")
	contents, err := marshalModelBenchmark(source)
	if err != nil {
		t.Fatalf("marshalModelBenchmark() error = %v", err)
	}
	path := filepath.Join(t.TempDir(), "local-record.md")
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	importResult, err := store.ImportReport(path)
	if err != nil {
		t.Fatalf("ImportReport() error = %v", err)
	}
	imported := importResult.Imported
	if len(imported) != 1 || imported[0].ID != source.ID || !imported[0].Imported {
		t.Fatalf("ImportReport() = %#v, want %#v", imported, source)
	}
}

func writeBenchmarkReport(t *testing.T, records ...ModelBenchmark) string {
	t.Helper()
	payload, err := json.Marshal(benchmarkReportPayload{
		Version: benchmarkReportFormatVersion,
		Records: records,
	})
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	path := filepath.Join(t.TempDir(), "shared-benchmark.html")
	contents := "<html><body><!-- agent-chat-benchmark-report-v1 " + base64.StdEncoding.EncodeToString(payload) + " --></body></html>"
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	return path
}

func TestReadBenchmarkReportRejectsReportsWithoutImportData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old-report.md")
	if err := os.WriteFile(path, []byte("# Agent Chat 벤치마크 보고서\n"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	if _, err := readBenchmarkReport(path); err == nil {
		t.Fatal("readBenchmarkReport() accepted a report without import data")
	}
}

func completedBenchmarkForReport(id string) ModelBenchmark {
	return ModelBenchmark{
		ID:             id,
		ProfileID:      "profile-1",
		ProfileName:    "공유 서버",
		ProfileBaseURL: "https://models.example.com/v1",
		Model:          "shared-model",
		SuiteName:      "공유 벤치마크",
		Status:         "completed",
		CreatedAt:      "2026-09-09T01:02:03Z",
		UpdatedAt:      "2026-09-09T01:02:04Z",
		Cases: []ModelBenchmarkCase{{
			ID:       "shared-case",
			Category: "지시 이행",
			Title:    "구조화된 출력",
			Prompt:   "JSON 배열로 답변",
			Content:  "[\"결과\"]",
			Status:   "complete",
			Usage:    &TokenUsage{PromptTokens: 11, CompletionTokens: 7, TotalTokens: 18},
			Metrics:  &ResponseMetrics{TotalDurationMs: 1_234, FirstTokenDurationMs: 321},
		}},
	}
}
