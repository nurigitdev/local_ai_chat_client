package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestDocumentEnvironmentRetriesWithoutLeakingState(t *testing.T) {
	environment := buildDocumentEvidenceRecovery(1)
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
	if result := environment.Grade("done"); !result.Passed {
		t.Fatalf("Grade() = %#v", result)
	}

	newEnvironment := buildDocumentEvidenceRecovery(1)
	if result := newEnvironment.Grade("done"); result.Passed {
		t.Fatalf("fresh environment unexpectedly retained changes: %#v", result)
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

func TestAgenticEvaluationStorePersistsAndMarksInterruptedRuns(t *testing.T) {
	store := newAgenticEvaluationStore(t.TempDir())
	scenario, ok := findAgenticScenario("records-no-change")
	if !ok {
		t.Fatal("records-no-change scenario is missing")
	}
	evaluation := AgenticEvaluation{
		ID: "evaluation-1", ProfileID: "profile-1", ProfileName: "테스트", ProfileBaseURL: "http://localhost:8000",
		ModelIDs: []string{"model-a"}, ScenarioIDs: []string{scenario.ID}, Repetitions: 1, Status: "running",
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
	if opened.Status != "cancelled" || opened.Runs[0].Status != "cancelled" || opened.Runs[0].Result == nil || opened.Runs[0].Result.Outcome != "interrupted" {
		t.Fatalf("interrupted record = %#v", opened)
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
		Repetitions: 1,
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
