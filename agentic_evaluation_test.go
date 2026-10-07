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
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/taengson/agent-chat-desktop/internal/provider/openai"
)

func agenticReportFixture(t *testing.T, id string, model string) AgenticEvaluation {
	t.Helper()
	scenario, ok := findAgenticScenario("records-no-change")
	if !ok {
		t.Fatal("records-no-change scenario is missing")
	}
	return AgenticEvaluation{
		ID: id, ProfileID: "profile-1", ProfileName: "테스트", ProfileBaseURL: "http://localhost:8000",
		ModelIDs: []string{model}, ScenarioIDs: []string{scenario.ID}, MaxAttempts: 1,
		ExecutionRules: defaultAgenticExecutionRules(), Status: "completed",
		CreatedAt: "2026-10-01T00:00:00Z", UpdatedAt: "2026-10-01T00:05:00Z",
		Runs: []AgenticEvaluationRun{{
			ID: "run-" + id, Model: model, ScenarioID: scenario.ID, ScenarioVersion: scenario.Version,
			InitialStateHash: scenario.Build(1).InitialStateHash(), GraderVersion: agenticGraderVersion,
			Environment: scenario.Environment, Category: scenario.Category, Title: scenario.Title, Goal: scenario.Goal,
			Variant: 1, Status: "success", StartedAt: "2026-10-01T00:00:01Z", FinishedAt: "2026-10-01T00:04:59Z",
			Actions:      []AgenticEvaluationAction{{Step: 1, Type: "tool", ToolName: "list_records", Arguments: "{}", Output: "[N-701]", Status: "success", OccurredAt: "2026-10-01T00:00:02Z"}},
			StateChanges: []AgenticEvaluationChange{{Resource: "N-701", Before: "open", After: "closed"}},
			Result:       &AgenticEvaluationResult{Passed: true, Outcome: "passed", Summary: "목표 상태를 확인했습니다.", Requirements: []string{"변경 없음"}},
			Usage:        &TokenUsage{PromptTokens: 10, CompletionTokens: 4, TotalTokens: 14}, Metrics: &ResponseMetrics{TotalDurationMs: 2500, FirstTokenDurationMs: 180},
		}},
	}
}

func writeAgenticReport(t *testing.T, path string, version int, evaluation AgenticEvaluation) {
	t.Helper()
	payload, err := json.Marshal(agenticEvaluationReportPayload{Version: version, Evaluation: evaluation})
	if err != nil {
		t.Fatalf("marshal report payload: %v", err)
	}
	contents := []byte("<!doctype html>\n<!-- agent-chat-agentic-evaluation-report-v1 " + base64.StdEncoding.EncodeToString(payload) + " -->\n")
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatalf("write report: %v", err)
	}
}

func TestDocumentEnvironmentRetriesWithoutLeakingState(t *testing.T) {
	environment := buildDocumentEvidenceRecovery(1)
	policy := environment.Execute("read_file", json.RawMessage(`{"path":"case-policy.md"}`))
	if policy.Status != "success" {
		t.Fatalf("policy read = %#v", policy)
	}
	first := environment.Execute("read_file", json.RawMessage(`{"path":"cases.json"}`))
	if first.Status != "error" {
		t.Fatalf("first read status = %q, want error", first.Status)
	}
	second := environment.Execute("read_file", json.RawMessage(`{"path":"cases.json"}`))
	if second.Status != "success" || !strings.Contains(second.Output, "E-201") {
		t.Fatalf("second read = %#v", second)
	}
	written := environment.Execute("write_file", json.RawMessage(`{"path":"evidence-review.json","content":"{\"E-201\":\"accepted\",\"E-202\":\"needs_review\",\"E-203\":\"rejected\"}"}`))
	if written.Status != "success" || len(written.Changes) != 1 {
		t.Fatalf("write = %#v", written)
	}
	document := environment.(*documentEnvironment)
	if document.baseFiles["evidence-review.json"] != "{}" || document.overlay["evidence-review.json"] == "{}" {
		t.Fatalf("document overlay did not preserve base state: %#v", document)
	}
	if result := environment.Grade("done"); !result.Passed {
		t.Fatalf("Grade() = %#v", result)
	}

	newEnvironment := buildDocumentEvidenceRecovery(1)
	if result := newEnvironment.Grade("done"); result.Passed {
		t.Fatalf("fresh environment unexpectedly retained changes: %#v", result)
	}
}

func TestStateGradeRequiresEvidenceDiscovery(t *testing.T) {
	environment := buildDocumentRefundReview(1)
	written := environment.Execute("write_file", json.RawMessage(`{"path":"refund-review.json","content":"{\"D-101\":\"approved\",\"D-102\":\"rejected\",\"D-103\":\"needs_review\",\"D-104\":\"rejected\",\"D-105\":\"rejected\"}"}`))
	if written.Status != "success" {
		t.Fatalf("write = %#v", written)
	}
	result := environment.Grade("done")
	if result.Passed || len(result.Violations) == 0 {
		t.Fatalf("Grade() = %#v, want discovery violation", result)
	}
}

func TestDocumentEnvironmentRejectsForbiddenToolAndPath(t *testing.T) {
	environment := buildDocumentRefundReview(1)
	if execution := environment.Execute("shell", json.RawMessage(`{"command":"rm -rf /"}`)); execution.Status != "error" {
		t.Fatalf("forbidden tool status = %q, want error", execution.Status)
	}
	if execution := environment.Execute("write_file", json.RawMessage(`{"path":"../refund-review.json","content":"{}"}`)); execution.Status != "error" {
		t.Fatalf("forbidden path status = %q, want error", execution.Status)
	}
	if execution := environment.Execute("write_file", json.RawMessage(`{"path":"refund-policy.md","content":"changed"}`)); execution.Status != "error" {
		t.Fatalf("read-only path status = %q, want error", execution.Status)
	}
}

func TestRecordEnvironmentRejectsUnnecessaryChange(t *testing.T) {
	environment := buildRecordsNoChange(1)
	change := environment.Execute("update_record", json.RawMessage(`{"id":"N-701","status":"closed"}`))
	if change.Status != "success" {
		t.Fatalf("update_record() = %#v", change)
	}
	result := environment.Grade("done")
	if result.Passed || len(result.Violations) == 0 {
		t.Fatalf("Grade() = %#v, want failed with violation", result)
	}
}

func TestConflictRecoveryAcceptsUsefulNoteButRequiresTheRecoveredState(t *testing.T) {
	environment := buildRecordsConflictRecovery(1)
	if result := environment.Execute("get_record", json.RawMessage(`{"id":"C-601"}`)); result.Status != "success" {
		t.Fatalf("initial read = %#v", result)
	}
	if result := environment.Execute("update_record", json.RawMessage(`{"id":"C-601","status":"approved","note":"승인 요청 처리"}`)); result.Status != "error" {
		t.Fatalf("conflicting update = %#v", result)
	}
	if result := environment.Execute("get_record", json.RawMessage(`{"id":"C-601"}`)); result.Status != "success" {
		t.Fatalf("recovery read = %#v", result)
	}
	if result := environment.Execute("update_record", json.RawMessage(`{"id":"C-601","status":"approved","note":"충돌 후 재시도"}`)); result.Status != "success" {
		t.Fatalf("recovery update = %#v", result)
	}
	if result := environment.Grade("done"); !result.Passed {
		t.Fatalf("grade with useful note = %#v", result)
	}

	if !sameRecordState(
		recordData{ID: "C-601", Status: "approved", Payment: "confirmed", Note: "annotation"},
		recordData{ID: "C-601", Status: "approved", Payment: "confirmed"},
	) {
		t.Fatal("a note must not change the graded business state")
	}
	if sameRecordState(
		recordData{ID: "C-601", Status: "rejected", Payment: "confirmed"},
		recordData{ID: "C-601", Status: "approved", Payment: "confirmed"},
	) {
		t.Fatal("a different status must not match the graded business state")
	}
}

func TestJavaPageLimitAcceptsEquivalentUpperBoundImplementations(t *testing.T) {
	for name, source := range map[string]string{
		"math-min": `return Math.min(requested, maximum);`,
		"explicit-branch": `if (requested > maximum) {
  return maximum;
}
return requested;`,
	} {
		if !javaPageLimitUpperBoundCheck(source) {
			t.Fatalf("%s implementation was rejected", name)
		}
	}
	if javaPageLimitUpperBoundCheck(`return requested;`) {
		t.Fatal("implementation without an upper bound was accepted")
	}
	if javaPageLimitUpperBoundCheck(`if (requested > maximum) return maximum; return maximum;`) {
		t.Fatal("implementation that changes in-range values was accepted")
	}
}

func TestPythonRetryDelayAcceptsEquivalentCappingImplementations(t *testing.T) {
	for name, source := range map[string]string{
		"min": `return min(base_ms * (2 ** (attempt - 1)), max_ms)`,
		"explicit-branch": `delay = base_ms * (2 ** (attempt - 1))
if delay > max_ms:
  return max_ms
return delay`,
		"capped-doubling": `steps = attempt - 1
cap_steps = 0
value = base_ms
while value < max_ms:
  value *= 2
  cap_steps += 1
if steps >= cap_steps:
  return max_ms
return base_ms * (2 ** steps)`,
	} {
		if !pythonRetryDelayCheck(source) {
			t.Fatalf("%s implementation was rejected", name)
		}
	}
	if pythonRetryDelayCheck(`return base_ms * (2 ** (attempt - 1))`) {
		t.Fatal("implementation without a maximum cap was accepted")
	}
	if pythonRetryDelayCheck(`delay = base_ms * (2 ** (attempt - 1))
if delay > max_ms:
  return max_ms
return max_ms`) {
		t.Fatal("implementation that changes uncapped values was accepted")
	}
}

func TestParseAgenticModelActionRequiresOneStrictJSONObject(t *testing.T) {
	action, err := parseAgenticModelAction(`{"type":"tool","name":"read_file","arguments":{"path":"policy.md"}}`)
	if err != nil || action.Type != "tool" || action.Name != "read_file" {
		t.Fatalf("parseAgenticModelAction() = %#v, %v", action, err)
	}
	if _, err := parseAgenticModelAction("```json\n{}\n```"); err == nil {
		t.Fatal("parseAgenticModelAction() accepted markdown")
	}
	if _, err := parseAgenticModelAction(`{"type":"tool","name":"read_file","arguments":[]} `); err == nil {
		t.Fatal("parseAgenticModelAction() accepted a non-object arguments value")
	}
	if _, err := parseAgenticModelAction(`{"type":"tool","name":"read_file","arguments":null}`); err == nil {
		t.Fatal("parseAgenticModelAction() accepted null arguments")
	}
	if _, err := parseAgenticModelAction(`{"type":"complete","summary":"done"} {"type":"complete","summary":"again"}`); err == nil {
		t.Fatal("parseAgenticModelAction() accepted trailing JSON")
	}
}

func TestAgenticEvaluationRunsShareVariantInitialStateAcrossModels(t *testing.T) {
	runs := makeAgenticEvaluationRuns([]string{"model-a", "model-b"}, []string{"document-refund-review"})
	if len(runs) != 2 {
		t.Fatalf("run count = %d, want 2", len(runs))
	}
	if runs[0].Attempt != 1 || runs[1].Attempt != 1 || runs[0].Variant != 1 || runs[1].Variant != 1 {
		t.Fatalf("initial attempts and variants = %#v", runs)
	}
	if runs[0].InitialStateHash == "" || runs[0].InitialStateHash != runs[1].InitialStateHash {
		t.Fatalf("same-variant initial state = %q, %q", runs[0].InitialStateHash, runs[1].InitialStateHash)
	}
	if runs[0].GraderVersion != agenticGraderVersion {
		t.Fatalf("grader version = %q, want %q", runs[0].GraderVersion, agenticGraderVersion)
	}
}

func TestAgenticEvaluationRetriesOnlyUntilFirstPass(t *testing.T) {
	run := makeAgenticEvaluationRuns([]string{"model-a"}, []string{"records-no-change"})[0]
	evaluation := AgenticEvaluation{MaxAttempts: 3}
	run.StartedAt = nowAgenticTime()
	run.Result = &AgenticEvaluationResult{Passed: false, Outcome: "failed"}
	if !shouldRetryAgenticRun(evaluation, run) {
		t.Fatal("failed first attempt should be retried")
	}
	retry, ok := nextAgenticEvaluationRun(evaluation, run)
	if !ok || retry.Attempt != 2 || retry.Variant != 2 || retry.InitialStateHash == run.InitialStateHash || retry.RetryFeedback != nil {
		t.Fatalf("retry = %#v, want a distinct second variant", retry)
	}
	feedbackEvaluation := AgenticEvaluation{MaxAttempts: 3, FeedbackRetry: true}
	run.Result = &AgenticEvaluationResult{Passed: false, Outcome: "failed", Summary: "필수 조건을 확인하지 않았습니다", Violations: []string{"근거를 읽지 않았습니다"}}
	feedbackRetry, ok := nextAgenticEvaluationRun(feedbackEvaluation, run)
	if !ok || feedbackRetry.Attempt != 2 || feedbackRetry.Variant != run.Variant || feedbackRetry.InitialStateHash != run.InitialStateHash || feedbackRetry.RetryFeedback == nil || feedbackRetry.RetryFeedback.Attempt != 1 {
		t.Fatalf("feedback retry = %#v, want the same initial environment and grader feedback", feedbackRetry)
	}
	if message := agenticRetryFeedbackMessage(*feedbackRetry.RetryFeedback); !strings.Contains(message, "근거를 읽지 않았습니다") {
		t.Fatalf("feedback message = %q", message)
	}
	run.Result = &AgenticEvaluationResult{Passed: true, Outcome: "passed"}
	if shouldRetryAgenticRun(evaluation, run) {
		t.Fatal("passed attempt must not schedule another run")
	}
	retry.StartedAt = nowAgenticTime()
	retry.Attempt = evaluation.MaxAttempts
	retry.Result = &AgenticEvaluationResult{Passed: false, Outcome: "failed"}
	if shouldRetryAgenticRun(evaluation, retry) {
		t.Fatal("final allowed attempt must not be retried")
	}
}

func TestAgenticEvaluationRunsEachTargetToCompletionBeforeStartingNextTarget(t *testing.T) {
	runs := makeAgenticEvaluationRuns(
		[]string{"model-a", "model-b"},
		[]string{"document-refund-review", "records-no-change"},
	)
	evaluation := AgenticEvaluation{MaxAttempts: 3, Runs: runs}
	evaluation.Runs[0].StartedAt = nowAgenticTime()
	evaluation.Runs[0].Result = &AgenticEvaluationResult{Passed: false, Outcome: "failed"}

	retry, ok := nextAgenticEvaluationRun(evaluation, evaluation.Runs[0])
	if !ok {
		t.Fatal("failed first attempt should create a retry")
	}
	retryIndex := insertAgenticEvaluationRunAfter(&evaluation, 0, retry)
	if retryIndex != 1 {
		t.Fatalf("retry index = %d, want 1", retryIndex)
	}
	if got := evaluation.Runs[1]; got.Model != "model-a" || got.ScenarioID != "document-refund-review" || got.Attempt != 2 {
		t.Fatalf("adjacent retry = %#v, want model-a's second document attempt", got)
	}
	if got := evaluation.Runs[2]; got.Model != "model-b" || got.ScenarioID != "document-refund-review" || got.Attempt != 1 {
		t.Fatalf("next target = %#v, want model-b's first document attempt", got)
	}
}

func TestEveryScenarioHasDeterministicDistinctVariants(t *testing.T) {
	for _, scenario := range agenticScenarios() {
		first := scenario.Build(1).InitialStateHash()
		second := scenario.Build(2).InitialStateHash()
		if first == "" || second == "" {
			t.Fatalf("%s has an empty initial-state hash", scenario.ID)
		}
		if first == second {
			t.Fatalf("%s does not change initial state between variants", scenario.ID)
		}
		if first != scenario.Build(1).InitialStateHash() {
			t.Fatalf("%s variant 1 is not deterministic", scenario.ID)
		}
	}
}

func TestAgenticScenarioCatalogSeparatesDocumentBusinessAndDevelopment(t *testing.T) {
	scenarios := agenticScenarios()
	if len(scenarios) != 8 {
		t.Fatalf("scenario count = %d, want 8", len(scenarios))
	}
	counts := map[string]int{}
	languages := map[string]int{}
	for _, scenario := range scenarios {
		counts[scenario.Suite]++
		if scenario.Suite == agenticSuiteDevelopment {
			languages[scenario.Language]++
		}
	}
	if counts[agenticSuiteDocumentBusiness] != 4 || counts[agenticSuiteDevelopment] != 4 {
		t.Fatalf("suite counts = %#v, want four scenarios in each suite", counts)
	}
	if languages["Python"] != 2 || languages["Java"] != 2 {
		t.Fatalf("development language counts = %#v, want two Python and two Java scenarios", languages)
	}
	if _, found := findAgenticScenario("document-release-readiness"); found {
		t.Fatal("retired document scenario must not be selectable")
	}
}

func TestCodeEnvironmentRequiresRelevantReadsTestsAndTargetOnlyChanges(t *testing.T) {
	scenario, found := findAgenticScenario("python-query-serializer")
	if !found {
		t.Fatal("python query scenario is missing")
	}
	environment := scenario.Build(1)
	for _, path := range []string{"ISSUE.md", "docs/query-contract.md", "tests/test_query_public.md", "src/query.py"} {
		if result := environment.Execute("read_file", json.RawMessage(`{"path":"`+path+`"}`)); result.Status != "success" {
			t.Fatalf("read %s = %#v", path, result)
		}
	}
	content := `def serialize_query(params):
    parts = []
    for key, value in params.items():
        if value is None:
            continue
        rendered = "true" if value is True else "false" if value is False else str(value)
        parts.append(f"{key}={rendered}")
    return "&".join(parts)
`
	if result := environment.Execute("write_file", json.RawMessage(`{"path":"src/query.py","content":`+strconv.Quote(content)+`}`)); result.Status != "success" {
		t.Fatalf("write target = %#v", result)
	}
	if result := environment.Execute("run_tests", json.RawMessage(`{}`)); result.Status != "success" || !strings.Contains(result.Output, `"passed":true`) {
		t.Fatalf("run tests = %#v", result)
	}
	if result := environment.Grade("done"); !result.Passed {
		t.Fatalf("grade = %#v", result)
	}

	forbidden := scenario.Build(1)
	if result := forbidden.Execute("write_file", json.RawMessage(`{"path":"src/query_legacy.py","content":"changed"}`)); result.Status != "error" {
		t.Fatalf("dummy write = %#v", result)
	}
	if result := forbidden.Grade("done"); result.Passed || len(result.Violations) == 0 {
		t.Fatalf("forbidden grade = %#v", result)
	}
}

func TestAgenticQueueAllowsOnlyOneEvaluation(t *testing.T) {
	app := NewApp()
	firstCancel := func() {}
	if err := app.reserveAgenticEvaluation("agentic-one", firstCancel); err != nil {
		t.Fatalf("reserve first evaluation: %v", err)
	}
	if err := app.reserveAgenticEvaluation("agentic-two", func() {}); err == nil {
		t.Fatal("second evaluation was accepted while the first was active")
	}
	app.releaseAgenticEvaluation("agentic-one")
	if err := app.reserveAgenticEvaluation("agentic-two", func() {}); err != nil {
		t.Fatalf("reserve after release: %v", err)
	}
	app.releaseAgenticEvaluation("agentic-two")
}

func TestAgenticRunStatusClassifiesCancellationAndTimeout(t *testing.T) {
	cancelledContext, cancel := context.WithCancel(context.Background())
	cancel()
	if status := agenticRunStatusForContext(cancelledContext); status != "cancelled" {
		t.Fatalf("cancelled status = %q", status)
	}
	// A deadline already in the past deterministically represents a time limit.
	// A one-nanosecond timeout can be cancelled by its cleanup before its timer
	// is observed on very fast Windows test runs.
	timedOutContext, timedOutCancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer timedOutCancel()
	time.Sleep(time.Millisecond)
	if status := agenticRunStatusForContext(timedOutContext); status != "time_limit" {
		t.Fatalf("timeout status = %q", status)
	}
}

func TestAgenticEvaluationStorePersistsAndMarksInterruptedRuns(t *testing.T) {
	store := newAgenticEvaluationStore(t.TempDir())
	scenario, ok := findAgenticScenario("records-no-change")
	if !ok {
		t.Fatal("records-no-change scenario is missing")
	}
	evaluation := AgenticEvaluation{
		ID: "evaluation-1", ProfileID: "profile-1", ProfileName: "테스트", ProfileBaseURL: "http://localhost:8000",
		ModelIDs: []string{"model-a"}, ScenarioIDs: []string{scenario.ID}, MaxAttempts: 1, FeedbackRetry: true, Status: "running",
		Runs: []AgenticEvaluationRun{{
			ID: "run-1", Model: "model-a", ScenarioID: scenario.ID, ScenarioVersion: scenario.Version,
			Environment: scenario.Environment, Category: scenario.Category, Title: scenario.Title, Goal: scenario.Goal,
			Variant: 1, Status: "running", Actions: []AgenticEvaluationAction{},
		}},
	}
	created, err := store.Create(evaluation)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := store.MarkInterrupted(); err != nil {
		t.Fatalf("MarkInterrupted() error = %v", err)
	}
	opened, err := store.Open(created.ID)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	if opened.Status != "cancelled" || !opened.FeedbackRetry || opened.Runs[0].Status != "cancelled" || opened.Runs[0].Result == nil || opened.Runs[0].Result.Outcome != "interrupted" {
		t.Fatalf("interrupted record = %#v", opened)
	}
	summaries, err := store.List()
	if err != nil || len(summaries) != 1 || !summaries[0].FeedbackRetry {
		t.Fatalf("summary = %#v, err = %v", summaries, err)
	}
}

func TestAgenticEvaluationStoreBoundsCompletedHistory(t *testing.T) {
	store := newAgenticEvaluationStore(t.TempDir())
	scenario, ok := findAgenticScenario("records-no-change")
	if !ok {
		t.Fatal("records-no-change scenario is missing")
	}
	for index := 0; index <= maxStoredAgenticEvaluations; index++ {
		initialHash := scenario.Build(1).InitialStateHash()
		evaluation := AgenticEvaluation{
			ID: newConversationID(), ProfileID: "profile-1", ProfileName: "테스트", ProfileBaseURL: "http://localhost:8000",
			ModelIDs: []string{"model-a"}, ScenarioIDs: []string{scenario.ID}, MaxAttempts: 1,
			ExecutionRules: defaultAgenticExecutionRules(), Status: "completed",
			Runs: []AgenticEvaluationRun{{
				ID: newConversationID(), Model: "model-a", ScenarioID: scenario.ID, ScenarioVersion: scenario.Version,
				InitialStateHash: initialHash, GraderVersion: agenticGraderVersion,
				Environment: scenario.Environment, Category: scenario.Category, Title: scenario.Title, Goal: scenario.Goal,
				Variant: 1, Status: "success", Actions: []AgenticEvaluationAction{},
			}},
		}
		if _, err := store.Create(evaluation); err != nil {
			t.Fatalf("Create(%d) error = %v", index, err)
		}
	}
	summaries, err := store.List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(summaries) != maxStoredAgenticEvaluations {
		t.Fatalf("stored summary count = %d, want %d", len(summaries), maxStoredAgenticEvaluations)
	}
}

func TestAgenticEvaluationStoreExcludesLegacyRepeatRecords(t *testing.T) {
	store := newAgenticEvaluationStore(t.TempDir())
	directory, err := store.directory()
	if err != nil {
		t.Fatalf("directory() error = %v", err)
	}
	id := newConversationID()
	contents := []byte("<!-- agent-chat-agentic-evaluation {\"id\":\"" + id + "\",\"repetitions\":1} -->\n")
	if err := os.WriteFile(filepath.Join(directory, id+".md"), contents, 0o600); err != nil {
		t.Fatalf("write legacy record: %v", err)
	}
	summaries, err := store.List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(summaries) != 0 {
		t.Fatalf("legacy records must be excluded from history: %#v", summaries)
	}
	if _, err := store.Open(id); !errors.Is(err, errLegacyAgenticEvaluation) {
		t.Fatalf("Open() error = %v, want legacy-record error", err)
	}
}

func TestAgenticEvaluationReportImportsFullRecordAndSkipsDuplicates(t *testing.T) {
	store := newAgenticEvaluationStore(t.TempDir())
	evaluation := agenticReportFixture(t, "report-evaluation", "model-a")
	evaluation.Runs[0].Actions[0].RawContent = `{"type":"tool","name":"list_records"}`
	path := filepath.Join(t.TempDir(), "agentic-report.html")
	writeAgenticReport(t, path, agenticEvaluationReportFormatVersion, evaluation)

	imported, err := store.ImportReport(path)
	if err != nil {
		t.Fatalf("ImportReport() error = %v", err)
	}
	if imported.Duplicate || imported.Evaluation.ID != evaluation.ID {
		t.Fatalf("first import = %#v", imported)
	}
	opened, err := store.Open(evaluation.ID)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	if opened.CreatedAt != evaluation.CreatedAt || opened.UpdatedAt != evaluation.UpdatedAt {
		t.Fatalf("timestamps changed after import: %#v", opened)
	}
	if got := opened.Runs[0].Actions[0].RawContent; got != evaluation.Runs[0].Actions[0].RawContent {
		t.Fatalf("raw action record = %q, want %q", got, evaluation.Runs[0].Actions[0].RawContent)
	}
	if got := opened.Runs[0].StateChanges[0].After; got != "closed" {
		t.Fatalf("state change after = %q", got)
	}

	duplicate, err := store.ImportReport(path)
	if err != nil {
		t.Fatalf("second ImportReport() error = %v", err)
	}
	if !duplicate.Duplicate || duplicate.Evaluation.ID != evaluation.ID {
		t.Fatalf("duplicate import = %#v", duplicate)
	}
	summaries, err := store.List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(summaries) != 1 {
		t.Fatalf("history count = %d, want 1", len(summaries))
	}
}

func TestAgenticEvaluationReportProtectsConflictingRecord(t *testing.T) {
	store := newAgenticEvaluationStore(t.TempDir())
	existing := agenticReportFixture(t, "shared-evaluation", "model-a")
	if _, err := store.Create(existing); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	incoming := agenticReportFixture(t, existing.ID, "model-b")
	path := filepath.Join(t.TempDir(), "agentic-report.md")
	writeAgenticReport(t, path, agenticEvaluationReportFormatVersion, incoming)

	imported, err := store.ImportReport(path)
	if err != nil {
		t.Fatalf("ImportReport() error = %v", err)
	}
	if imported.Duplicate || imported.Evaluation.ID == existing.ID {
		t.Fatalf("conflicting import = %#v", imported)
	}
	original, err := store.Open(existing.ID)
	if err != nil {
		t.Fatalf("Open original error = %v", err)
	}
	if original.ModelIDs[0] != "model-a" {
		t.Fatalf("original record was overwritten: %#v", original)
	}
	if imported.Evaluation.ModelIDs[0] != "model-b" {
		t.Fatalf("imported record = %#v", imported.Evaluation)
	}
}

func TestAgenticEvaluationReportRejectsUnsupportedVersionAndRunningResult(t *testing.T) {
	store := newAgenticEvaluationStore(t.TempDir())
	evaluation := agenticReportFixture(t, "invalid-report", "model-a")
	path := filepath.Join(t.TempDir(), "agentic-report.html")
	writeAgenticReport(t, path, agenticEvaluationReportFormatVersion+1, evaluation)
	if _, err := store.ImportReport(path); err == nil || !strings.Contains(err.Error(), "지원하지 않는") {
		t.Fatalf("unsupported version error = %v", err)
	}

	evaluation.Status = "running"
	writeAgenticReport(t, path, agenticEvaluationReportFormatVersion, evaluation)
	if _, err := store.ImportReport(path); err == nil || !strings.Contains(err.Error(), "실행 중") {
		t.Fatalf("running report error = %v", err)
	}
}

func TestAgenticEvaluationRunsToolsUntilStateBasedSuccess(t *testing.T) {
	responses := []string{
		`{"type":"tool","name":"list_records","arguments":{}}`,
		`{"type":"tool","name":"get_record","arguments":{"id":"C-601"}}`,
		`{"type":"tool","name":"update_record","arguments":{"id":"C-601","status":"approved"}}`,
		`{"type":"tool","name":"get_record","arguments":{"id":"C-601"}}`,
		`{"type":"tool","name":"update_record","arguments":{"id":"C-601","status":"approved"}}`,
		`{"type":"tool","name":"get_record","arguments":{"id":"C-601"}}`,
		`{"type":"complete","summary":"승인 상태를 확인했습니다."}`,
	}
	var mu sync.Mutex
	responseIndex := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/chat/completions" {
			t.Fatalf("path = %q, want /v1/chat/completions", request.URL.Path)
		}
		mu.Lock()
		if responseIndex >= len(responses) {
			mu.Unlock()
			t.Fatalf("received more requests than expected")
		}
		response := responses[responseIndex]
		responseIndex++
		mu.Unlock()
		encoded, _ := json.Marshal(response)
		writer.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(writer, "data: {\"choices\":[{\"delta\":{\"content\":%s}}]}\n\n", encoded)
		fmt.Fprint(writer, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":4,\"total_tokens\":14}}\n\n")
		fmt.Fprint(writer, "data: [DONE]\n\n")
	}))
	defer server.Close()

	app := NewApp()
	app.agenticEvaluations = newAgenticEvaluationStore(t.TempDir())
	finished := make(chan AgenticEvaluationEvent, 1)
	app.agenticEventSink = func(event AgenticEvaluationEvent) {
		if event.Type == "finished" {
			finished <- event
		}
	}
	created, err := app.StartAgenticEvaluation(AgenticEvaluationStartRequest{
		Profile:     ConnectionProfile{BaseURL: server.URL, APIKey: "test-key"},
		ProfileID:   "profile-1",
		ProfileName: "테스트 서버",
		ModelIDs:    []string{"local-agent"},
		ScenarioIDs: []string{"records-conflict-recovery"},
		MaxAttempts: 1,
	})
	if err != nil {
		t.Fatalf("StartAgenticEvaluation() error = %v", err)
	}
	select {
	case event := <-finished:
		if event.Status != "completed" {
			t.Fatalf("finished event = %#v", event)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("agentic evaluation did not finish")
	}
	opened, err := app.OpenAgenticEvaluation(created.ID)
	if err != nil {
		t.Fatalf("OpenAgenticEvaluation() error = %v", err)
	}
	if opened.Status != "completed" || len(opened.Runs) != 1 {
		t.Fatalf("evaluation = %#v", opened)
	}
	run := opened.Runs[0]
	if run.Status != "success" || run.Result == nil || !run.Result.Passed {
		t.Fatalf("run = %#v", run)
	}
	if len(run.Actions) != len(responses) || run.Actions[2].Status != "error" || len(run.StateChanges) != 1 {
		t.Fatalf("actions = %#v", run.Actions)
	}
	if run.Usage == nil || run.Usage.TotalTokens != len(responses)*14 {
		t.Fatalf("usage = %#v", run.Usage)
	}
}

func TestAgenticEvaluationSeparatesConnectionFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		http.Error(writer, "temporary upstream failure", http.StatusBadGateway)
	}))
	defer server.Close()

	app := NewApp()
	app.agenticEvaluations = newAgenticEvaluationStore(t.TempDir())
	finished := make(chan AgenticEvaluationEvent, 1)
	app.agenticEventSink = func(event AgenticEvaluationEvent) {
		if event.Type == "finished" {
			finished <- event
		}
	}
	created, err := app.StartAgenticEvaluation(AgenticEvaluationStartRequest{
		Profile: ConnectionProfile{BaseURL: server.URL, APIKey: "test-key"}, ProfileID: "profile-1", ProfileName: "테스트 서버",
		ModelIDs: []string{"local-agent"}, ScenarioIDs: []string{"records-no-change"}, MaxAttempts: 1,
	})
	if err != nil {
		t.Fatalf("StartAgenticEvaluation() error = %v", err)
	}
	select {
	case event := <-finished:
		if event.Status != "completed" {
			t.Fatalf("finished event = %#v", event)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("agentic evaluation did not finish")
	}
	opened, err := app.OpenAgenticEvaluation(created.ID)
	if err != nil {
		t.Fatalf("OpenAgenticEvaluation() error = %v", err)
	}
	if opened.Runs[0].Status != "connection_error" || opened.Runs[0].Result == nil || opened.Runs[0].Result.Outcome != "goal_not_met" {
		t.Fatalf("connection failure run = %#v", opened.Runs[0])
	}
}

func TestAgenticTimeoutPresetsAndLegacyRules(t *testing.T) {
	standard := defaultAgenticExecutionRules()
	if standard.TimeoutPreset != agenticTimeoutStandard || standard.FirstOutputTimeoutSeconds != 600 || standard.OutputIdleTimeoutSeconds != 60 || standard.RunTimeoutSeconds != 3600 || standard.ActionTimeoutSeconds != 0 || standard.MaxActions != 24 {
		t.Fatalf("standard rules = %#v", standard)
	}
	local, err := agenticExecutionRulesForPreset(agenticTimeoutSlowLocal)
	if err != nil || local.FirstOutputTimeoutSeconds != 900 || local.OutputIdleTimeoutSeconds != 300 || local.RunTimeoutSeconds != 7200 {
		t.Fatalf("local rules = %#v, %v", local, err)
	}
	if _, err := agenticExecutionRulesForPreset("unknown"); err == nil {
		t.Fatal("unknown timeout preset was accepted")
	}
	legacy := legacyAgenticExecutionRules()
	if legacy.TimeoutMode != "" || legacy.ActionTimeoutSeconds != 120 || legacy.RunTimeoutSeconds != 600 || legacy.MaxActions != 12 || validateAgenticExecutionRules(legacy) != nil {
		t.Fatalf("legacy rules = %#v", legacy)
	}
}

func TestAgenticLegacyInterruptedRunIsRegradedOnlyAfterVerifiedReplay(t *testing.T) {
	evaluation := agenticReportFixture(t, "legacy-regrade", "local-agent")
	evaluation.ExecutionRules = legacyAgenticExecutionRules()
	run := &evaluation.Runs[0]
	run.Status = "connection_error"
	run.Result = &AgenticEvaluationResult{Outcome: "connection_error", Summary: "모델 요청에 실패했습니다"}
	run.Error = "스트리밍 연결이 중단되었습니다"
	run.Actions = nil
	run.StateChanges = nil
	scenario, _ := findAgenticScenario(run.ScenarioID)
	environment := scenario.Build(run.Variant)
	for index, id := range []string{"N-701", "N-702"} {
		arguments := fmt.Sprintf(`{"id":%q}`, id)
		execution := environment.Execute("get_record", json.RawMessage(arguments))
		run.Actions = append(run.Actions, AgenticEvaluationAction{
			Step: index + 1, Type: "tool", ToolName: "get_record", Arguments: arguments,
			Output: trimAgenticRecord(execution.Output), Status: execution.Status, OccurredAt: "2026-10-01T00:00:02Z",
		})
	}
	contents, err := marshalAgenticEvaluation(evaluation)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := parseAgenticEvaluation(contents)
	if err != nil || parsed.Runs[0].Result == nil || !parsed.Runs[0].Result.Passed || parsed.Runs[0].Status != "connection_error" {
		t.Fatalf("regraded record = %#v, %v", parsed.Runs[0], err)
	}
	if parsed.ExecutionRules.ActionTimeoutSeconds != 120 {
		t.Fatalf("historical timeout changed: %#v", parsed.ExecutionRules)
	}
	evaluation.Runs[0].Actions[0].Output = "tampered output"
	contents, err = marshalAgenticEvaluation(evaluation)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err = parseAgenticEvaluation(contents)
	if err != nil || parsed.Runs[0].Result != nil {
		t.Fatalf("unverifiable record must remain ungraded: %#v, %v", parsed.Runs[0], err)
	}
}

func TestAgenticLegacyActionLimitIsRegradedAtItsRecordedLimit(t *testing.T) {
	evaluation := agenticReportFixture(t, "legacy-action-limit", "local-agent")
	evaluation.ExecutionRules = legacyAgenticExecutionRules()
	run := &evaluation.Runs[0]
	run.Status = "action_limit"
	run.Result = &AgenticEvaluationResult{Outcome: "action_limit", Summary: "최대 행동 횟수에 도달했습니다"}
	run.Error = "최대 행동 횟수에 도달했습니다"
	run.Actions = nil
	run.StateChanges = nil
	scenario, _ := findAgenticScenario(run.ScenarioID)
	environment := scenario.Build(run.Variant)
	for index := range evaluation.ExecutionRules.MaxActions {
		id := "N-701"
		if index%2 == 1 {
			id = "N-702"
		}
		arguments := fmt.Sprintf(`{"id":%q}`, id)
		execution := environment.Execute("get_record", json.RawMessage(arguments))
		run.Actions = append(run.Actions, AgenticEvaluationAction{
			Step: index + 1, Type: "tool", ToolName: "get_record", Arguments: arguments,
			Output: trimAgenticRecord(execution.Output), Status: execution.Status, OccurredAt: "2026-10-01T00:00:02Z",
		})
	}
	contents, err := marshalAgenticEvaluation(evaluation)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := parseAgenticEvaluation(contents)
	if err != nil || parsed.Runs[0].Result == nil || !parsed.Runs[0].Result.Passed || parsed.Runs[0].Status != "action_limit" || parsed.ExecutionRules.MaxActions != 12 {
		t.Fatalf("historical action limit = %#v, %v", parsed.Runs[0], err)
	}
}

func TestAgenticActionUsesOutputActivityInsteadOfAbsoluteDeadline(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "text/event-stream")
		flusher := writer.(http.Flusher)
		for range 9 {
			fmt.Fprint(writer, "data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n")
			flusher.Flush()
			time.Sleep(300 * time.Millisecond)
		}
		fmt.Fprint(writer, "data: [DONE]\n\n")
		flusher.Flush()
	}))
	defer server.Close()
	client, err := openai.NewClient(server.URL, "", streamingHTTPClient())
	if err != nil {
		t.Fatal(err)
	}
	rules := defaultAgenticExecutionRules()
	rules.FirstOutputTimeoutSeconds = 1
	rules.OutputIdleTimeoutSeconds = 1
	started := time.Now()
	response, err := requestAgenticAction(context.Background(), client, "local-agent", "", []openai.Message{{Role: "user", Content: "test"}}, rules)
	if err != nil || len(response.Content) != 9 || time.Since(started) < 2*time.Second {
		t.Fatalf("active stream ended early: %#v, %v", response, err)
	}
}

func TestAgenticActionDistinguishesFirstOutputAndIdleTimeout(t *testing.T) {
	for _, test := range []struct {
		name          string
		firstOutput   bool
		errorContains string
	}{
		{name: "first output", firstOutput: true, errorContains: "시작되지"},
		{name: "idle output", errorContains: "멈췄"},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writer.Header().Set("Content-Type", "text/event-stream")
				flusher := writer.(http.Flusher)
				if !test.firstOutput {
					fmt.Fprint(writer, "data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n")
				}
				flusher.Flush()
				time.Sleep(2300 * time.Millisecond)
				fmt.Fprint(writer, "data: [DONE]\n\n")
			}))
			defer server.Close()
			client, err := openai.NewClient(server.URL, "", streamingHTTPClient())
			if err != nil {
				t.Fatal(err)
			}
			rules := defaultAgenticExecutionRules()
			rules.FirstOutputTimeoutSeconds = 1
			rules.OutputIdleTimeoutSeconds = 1
			_, err = requestAgenticAction(context.Background(), client, "local-agent", "", []openai.Message{{Role: "user", Content: "test"}}, rules)
			if !errors.Is(err, errAgenticStreamTimeout) || !strings.Contains(err.Error(), test.errorContains) {
				t.Fatalf("timeout error = %v", err)
			}
		})
	}
}

func TestAgenticEvaluationCountsCompletedStateAfterConnectionFailure(t *testing.T) {
	responses := []string{
		`{"type":"tool","name":"get_record","arguments":{"id":"N-701"}}`,
		`{"type":"tool","name":"get_record","arguments":{"id":"N-702"}}`,
	}
	var mu sync.Mutex
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		index := requestCount
		requestCount++
		mu.Unlock()
		if index >= len(responses) {
			http.Error(writer, "upstream disconnected", http.StatusBadGateway)
			return
		}
		encoded, _ := json.Marshal(responses[index])
		writer.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(writer, "data: {\"choices\":[{\"delta\":{\"content\":%s}}]}\n\n", encoded)
		fmt.Fprint(writer, "data: [DONE]\n\n")
	}))
	defer server.Close()

	app := NewApp()
	app.agenticEvaluations = newAgenticEvaluationStore(t.TempDir())
	finished := make(chan AgenticEvaluationEvent, 1)
	app.agenticEventSink = func(event AgenticEvaluationEvent) {
		if event.Type == "finished" {
			finished <- event
		}
	}
	created, err := app.StartAgenticEvaluation(AgenticEvaluationStartRequest{
		Profile: ConnectionProfile{BaseURL: server.URL}, ProfileID: "profile-1", ProfileName: "테스트 서버",
		ModelIDs: []string{"local-agent"}, ScenarioIDs: []string{"records-no-change"}, MaxAttempts: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("agentic evaluation did not finish")
	}
	opened, err := app.OpenAgenticEvaluation(created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(opened.Runs) != 1 || opened.Runs[0].Status != "connection_error" || opened.Runs[0].Result == nil || !opened.Runs[0].Result.Passed || opened.Runs[0].Error == "" {
		t.Fatalf("graded connection failure = %#v", opened.Runs)
	}
	if summary := agenticEvaluationSummary(opened); summary.PassedTargetCount != 1 {
		t.Fatalf("summary = %#v", summary)
	}
}

func TestAgenticRunLimitWaitsForCurrentAction(t *testing.T) {
	var requestCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		requestCount.Add(1)
		writer.Header().Set("Content-Type", "text/event-stream")
		flusher := writer.(http.Flusher)
		response := `{"type":"tool","name":"get_record","arguments":{"id":"N-701"}}`
		encoded, _ := json.Marshal(response)
		fmt.Fprintf(writer, "data: {\"choices\":[{\"delta\":{\"content\":%s}}]}\n\n", encoded)
		flusher.Flush()
		time.Sleep(1200 * time.Millisecond)
		fmt.Fprint(writer, "data: {\"choices\":[{\"delta\":{\"content\":\" \"}}]}\n\n")
		flusher.Flush()
		time.Sleep(1200 * time.Millisecond)
		fmt.Fprint(writer, "data: [DONE]\n\n")
	}))
	defer server.Close()
	client, err := openai.NewClient(server.URL, "", streamingHTTPClient())
	if err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	app.agenticEvaluations = newAgenticEvaluationStore(t.TempDir())
	evaluation := agenticReportFixture(t, "soft-run-limit", "local-agent")
	evaluation.Status = "running"
	evaluation.ExecutionRules.RunTimeoutSeconds = 1
	evaluation.Runs[0].Status = "running"
	evaluation.Runs[0].StartedAt = nowAgenticTime()
	evaluation.Runs[0].FinishedAt = ""
	evaluation.Runs[0].Result = nil
	evaluation.Runs[0].Actions = nil
	evaluation.Runs[0].StateChanges = nil
	app.executeAgenticRun(context.Background(), client, &evaluation, 0)
	run := evaluation.Runs[0]
	if run.Status != "time_limit" || len(run.Actions) != 1 || requestCount.Load() != 1 || run.Result == nil || run.Result.Outcome != "goal_not_met" {
		t.Fatalf("soft run limit cut the active action: %#v, requests=%d", run, requestCount.Load())
	}
}

func TestAgenticActionLimitGradesFinalState(t *testing.T) {
	responses := []string{
		`{"type":"tool","name":"get_record","arguments":{"id":"N-701"}}`,
		`{"type":"tool","name":"get_record","arguments":{"id":"N-702"}}`,
	}
	var requestCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		index := int(requestCount.Add(1)) - 1
		if index >= len(responses) {
			http.Error(writer, "unexpected request", http.StatusInternalServerError)
			return
		}
		encoded, _ := json.Marshal(responses[index])
		writer.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(writer, "data: {\"choices\":[{\"delta\":{\"content\":%s}}]}\n\n", encoded)
		fmt.Fprint(writer, "data: [DONE]\n\n")
	}))
	defer server.Close()
	client, err := openai.NewClient(server.URL, "", streamingHTTPClient())
	if err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	app.agenticEvaluations = newAgenticEvaluationStore(t.TempDir())
	evaluation := agenticReportFixture(t, "graded-action-limit", "local-agent")
	evaluation.Status = "running"
	evaluation.MaxAttempts = 2
	evaluation.ExecutionRules.MaxActions = 2
	evaluation.Runs[0].Status = "running"
	evaluation.Runs[0].StartedAt = nowAgenticTime()
	evaluation.Runs[0].FinishedAt = ""
	evaluation.Runs[0].Result = nil
	evaluation.Runs[0].Actions = nil
	evaluation.Runs[0].StateChanges = nil
	app.executeAgenticRun(context.Background(), client, &evaluation, 0)
	run := evaluation.Runs[0]
	if run.Status != "action_limit" || len(run.Actions) != 2 || requestCount.Load() != 2 || run.Result == nil || !run.Result.Passed || shouldRetryAgenticRun(evaluation, run) {
		t.Fatalf("action-limit grading = %#v, requests=%d", run, requestCount.Load())
	}
}

func TestAgenticEvaluationSeparatesRepeatedFormatFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "text/event-stream")
		encoded, _ := json.Marshal("설명 문장만 응답합니다")
		fmt.Fprintf(writer, "data: {\"choices\":[{\"delta\":{\"content\":%s}}]}\n\n", encoded)
		fmt.Fprint(writer, "data: [DONE]\n\n")
	}))
	defer server.Close()

	app := NewApp()
	app.agenticEvaluations = newAgenticEvaluationStore(t.TempDir())
	finished := make(chan AgenticEvaluationEvent, 1)
	app.agenticEventSink = func(event AgenticEvaluationEvent) {
		if event.Type == "finished" {
			finished <- event
		}
	}
	created, err := app.StartAgenticEvaluation(AgenticEvaluationStartRequest{
		Profile: ConnectionProfile{BaseURL: server.URL, APIKey: "test-key"}, ProfileID: "profile-1", ProfileName: "테스트 서버",
		ModelIDs: []string{"local-agent"}, ScenarioIDs: []string{"records-no-change"}, MaxAttempts: 1,
	})
	if err != nil {
		t.Fatalf("StartAgenticEvaluation() error = %v", err)
	}
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("agentic evaluation did not finish")
	}
	opened, err := app.OpenAgenticEvaluation(created.ID)
	if err != nil {
		t.Fatalf("OpenAgenticEvaluation() error = %v", err)
	}
	run := opened.Runs[0]
	if run.Status != "failed" || run.Result == nil || run.Result.Outcome != "format_error" || len(run.Actions) != maxAgenticInvalidActions {
		t.Fatalf("format failure run = %#v", run)
	}
}
