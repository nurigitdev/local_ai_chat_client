package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestAgenticViolationDetailsIdentifyTheGradedResource(t *testing.T) {
	environments := []agenticEnvironment{buildDocumentEvidenceRecovery(1), buildRecordsRefundQueue(1), pythonRetryDelayScenario().Build(1)}
	for _, environment := range environments {
		result := environment.Grade("")
		if result.Passed || len(result.ViolationDetails) != len(result.Violations) {
			t.Fatalf("missing grading targets: %#v", result)
		}
		for index, detail := range result.ViolationDetails {
			if detail.ViolationIndex != index || detail.ToolName == "" || detail.Kind == "" {
				t.Fatalf("invalid target: %#v", detail)
			}
			if detail.Kind != "test" && detail.Resource == "" {
				t.Fatalf("missing resource: %#v", detail)
			}
		}
		encoded, err := json.Marshal(result)
		if err != nil {
			t.Fatal(err)
		}
		var decoded AgenticEvaluationResult
		if err := json.Unmarshal(encoded, &decoded); err != nil || len(decoded.ViolationDetails) != len(result.ViolationDetails) {
			t.Fatalf("targets not preserved: %v", err)
		}
	}
	result := buildDocumentEvidenceRecovery(1).Grade("")
	for _, detail := range result.ViolationDetails {
		if detail.Kind == "state" && (detail.Resource != "evidence-review.json" || detail.ToolName != "write_file") {
			t.Fatalf("wrong document target: %#v", detail)
		}
	}
}

func TestAgenticResultExplanationMatchesJSONVerdict(t *testing.T) {
	for _, actual := range []string{
		`{"E-201":"accepted","E-202":"needs_review"}`,
		` {"E-202":"needs_review", "E-201":"accepted"} `,
		`{}`, `{"E-201":"rejected"}`, `{"E-201":"accepted","E-202":"needs_review","extra":true}`,
		`[]`, `null`, `{"E-201":`,
	} {
		expected := `{"E-201":"accepted","E-202":"needs_review"}`
		messages := agenticJSONDifferences("evidence-review.json", actual, expected)
		if (len(messages) == 0) != sameJSON(actual, expected) {
			t.Fatalf("explanation disagrees with grade for %s: %v", actual, messages)
		}
	}
	messages := strings.Join(agenticJSONDifferences("evidence-review.json", `{"E-201":"rejected"}`, `{"E-201":"accepted","E-202":"needs_review"}`), "\n")
	for _, detail := range []string{"E-201", "접수 승인", "거절", "E-202", "누락", "추가 검토 필요"} {
		if !strings.Contains(messages, detail) {
			t.Fatalf("missing %s in %s", detail, messages)
		}
	}
}

func TestAgenticRecordExplanationUsesKoreanAndIgnoresAnnotation(t *testing.T) {
	expected := recordData{ID: "R-401", Status: "approved", Payment: "confirmed", Proof: true}
	actual := expected
	actual.Note = "optional annotation"
	if messages := agenticRecordDifferences(expected.ID, actual, expected); len(messages) != 0 {
		t.Fatal(messages)
	}
	actual.Status = "waiting"
	messages := strings.Join(agenticRecordDifferences(expected.ID, actual, expected), "\n")
	for _, detail := range []string{"처리 상태가", "승인 완료", "대기 중"} {
		if !strings.Contains(messages, detail) {
			t.Fatalf("missing %s in %s", detail, messages)
		}
	}
	if strings.Contains(messages, "approved") || strings.Contains(messages, "status") {
		t.Fatal(messages)
	}
}
