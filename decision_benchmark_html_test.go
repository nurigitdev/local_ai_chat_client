package main

import (
	"strings"
	"testing"
)

func TestDecisionHTMLReadableAndRestorable(t *testing.T) {
	s := decisionTestSuite()
	s.Name = "<script>alert(1)</script>"
	s.SourceDocument = "<img src=x onerror=alert(1)>"
	r, _ := scoreDecisionResponse(decisionFixture(s.Tasks[0], s.Cases[0].Expected), s.Tasks[0], s.Cases[0])
	r.TargetID = "t"
	r.Status = "completed"
	b := DecisionBenchmark{ID: newConversationID(), SchemaVersion: 1, ScoringVersion: decisionScoringVersion, Suite: s, Targets: []DecisionTarget{{ID: "t", Model: "<script>model</script>", BaseURL: "http://localhost:12300"}}, Types: []string{"choice"}, TimeoutSeconds: 60, Status: "completed", Results: []DecisionCaseResult{r}}
	b.Fingerprint = decisionFingerprint(s, b.Types)
	report, e := decisionReport(b, "html")
	if e != nil {
		t.Fatal(e)
	}
	for _, required := range []string{"<style>", "<svg", "100.0%", "1문항 중 1문항 정답", "문항별 정답과 모델 판단", "&lt;script&gt;", "&lt;img"} {
		if !strings.Contains(report, required) {
			t.Fatal("missing", required)
		}
	}
	for _, forbidden := range []string{"<pre># Decision", "~~~json", "<script>", "<img src=x"} {
		if strings.Contains(report, forbidden) {
			t.Fatal("visible unsafe or raw export", forbidden)
		}
	}
	restored, e := decodeDecisionRecord([]byte(report))
	if e != nil || restored.Fingerprint != b.Fingerprint || restored.Results[0].Correct != b.Results[0].Correct {
		t.Fatal("restoration changed", e)
	}
}
func TestDecisionHTMLComparisonUsesStyledSummary(t *testing.T) {
	s := decisionTestSuite()
	r, _ := scoreDecisionResponse(decisionFixture(s.Tasks[0], s.Cases[0].Expected), s.Tasks[0], s.Cases[0])
	r.TargetID = "t"
	r.Status = "completed"
	b := DecisionBenchmark{Suite: s, Targets: []DecisionTarget{{ID: "t", Model: "model"}}, Types: []string{"choice"}, Results: []DecisionCaseResult{r}}
	report := decisionHTMLReport([]DecisionBenchmark{b, b}, "비교 보고서", "공통 문항 1개")
	if strings.Count(report, "class='record'") != 2 || !strings.Contains(report, "공통 문항 1개") || strings.Contains(report, "~~~json") {
		t.Fatal("comparison rendering")
	}
	b.Results[0].Truncated = new(bool)
	*b.Results[0].Truncated = true
	if strings.Contains(decisionHTMLReport([]DecisionBenchmark{b}, "보고서", ""), "100.0%") {
		t.Fatal("truncated counted")
	}
}
