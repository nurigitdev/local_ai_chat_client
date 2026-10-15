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

func TestDecisionHTMLRankingNoteOutsideModelGrid(t *testing.T) {
	s := NewApp().GetDefaultDecisionSuite()
	b := DecisionBenchmark{Suite: s, Types: []string{"ranking"}, CreatedAt: "2026-10-15T01:50:51Z", Targets: []DecisionTarget{{ID: "a", Model: "A"}, {ID: "b", Model: "B"}, {ID: "c", Model: "C"}}}
	report := decisionHTMLReport([]DecisionBenchmark{b}, "report", "")
	if !strings.Contains(report, "</article></div><p class='muted' style='margin:12px 20px'>상위 후보에서") {
		t.Fatal("note remains in model grid")
	}
	if strings.Contains(report, "%!s") || !strings.Contains(report, "2026-10-15 10:50:51 KST") {
		t.Fatal("report formatting")
	}
	if strings.Contains(report, "<th>정밀도</th>") {
		t.Fatal("ranking has an empty single-label matrix")
	}
}

func TestDecisionHTMLRankingIdentification(t *testing.T) {
	task := DecisionTask{ID: "rank", Type: "ranking", Options: []DecisionOption{{Key: "A"}, {Key: "B"}, {Key: "C"}, {Key: "D"}}}
	results := []DecisionCaseResult{}
	for _, predicted := range []string{"A|B", "A|C", "C|D"} {
		results = append(results, DecisionCaseResult{TaskID: "rank", TargetID: "a", Status: "completed", Expected: "A|B", Predicted: predicted, LabelValid: true, ProbabilityValid: true, Probabilities: map[string]float64{"A": .8, "B": .1, "C": .06, "D": .04}})
	}
	for i, want := range []string{"full", "partial", "miss"} {
		category, _, low := decisionIdentification(task, results[i])
		if category != want || len(low) != 1 || low[0] != "B" {
			t.Fatalf("identification %d: %s %v", i, category, low)
		}
	}
	results[0].Truncated = new(bool)
	*results[0].Truncated = true
	category, _, low := decisionIdentification(task, results[0])
	if category != "unavailable" || len(low) > 0 {
		t.Fatal("truncation counted")
	}
	results[0].Truncated = nil
	b := DecisionBenchmark{Suite: DecisionSuite{Tasks: []DecisionTask{task}}, Targets: []DecisionTarget{{ID: "a", Model: "A"}}, Types: []string{"ranking"}, Results: results}
	report := decisionHTMLReport([]DecisionBenchmark{b}, "report", "")
	for _, want := range []string{"전체 식별 · 일부 정답 업무 25% 미만</span> <b>1</b>", "일부 누락 · 누락 업무 25% 미만</span> <b>1</b>", "모든 업무 누락</span> <b>1</b>", "stroke-dashoffset='-33.3333'", "누락 업무 25.0% 이상", "data-filter='model'", "data-filter='task'", "data-filter='result'", "data-filter='search'", "data-panel='2' hidden", "id='decision-report-interaction'"} {
		if !strings.Contains(report, want) {
			t.Fatal("missing", want)
		}
	}
}
func TestDecisionHTMLCaseBrowserEscapesData(t *testing.T) {
	b := DecisionBenchmark{Suite: DecisionSuite{Tasks: []DecisionTask{{ID: "rank", Type: "ranking"}}, Cases: []DecisionCase{{ID: "case", Text: "</script><script>alert(1)</script>", Rationale: "<img src=x>"}}}, Targets: []DecisionTarget{{ID: "' onmouseover='bad", Model: "<script>bad</script>"}}, Results: []DecisionCaseResult{{CaseID: "case", TargetID: "' onmouseover='bad", TaskID: "rank", Raw: []byte(`{"text":"</script><script>bad</script>"}`)}}}
	report := decisionHTMLReport([]DecisionBenchmark{b}, "report", "")
	if strings.Contains(report, "<script>alert(1)") || strings.Contains(report, "<img src=x>") || strings.Contains(report, "data-model='' onmouseover") {
		t.Fatal("unescaped report data")
	}
	if strings.Count(report, "<script ") != 1 || !strings.Contains(report, "&lt;/script&gt;") {
		t.Fatal("static script or data escaping changed")
	}
}

func TestDecisionHTMLExplanationProvenance(t *testing.T) {
	task := DecisionTask{ID: "business-domain-ranking", Type: "ranking", Instructions: map[string]string{"ko": "필요한 업무를 평가하세요"}, Options: []DecisionOption{{Key: "D04", Descriptions: map[string]string{"ko": "회계 기록결산"}}, {Key: "D05", Descriptions: map[string]string{"ko": "자금 계획조달"}}}}
	b := DecisionBenchmark{Suite: DecisionSuite{Tasks: []DecisionTask{task}, Cases: []DecisionCase{{ID: "r", Text: "결산과 자금 조달", Rationale: "D04, D05 소관이다."}}}, Targets: []DecisionTarget{{ID: "t", Model: "M"}}, Results: []DecisionCaseResult{{TargetID: "t", CaseID: "r", TaskID: task.ID, Expected: "D04|D05", Predicted: "D04|D05", Status: "completed", LabelValid: true}}}
	report := decisionHTMLCases(b)
	for _, want := range []string{"회계, 자금 관리 소관이다.", "평가 세트의 정답과 설명", "앱이 계산한 평가 결과", "모델이 반환한 전체 업무별 확률", "모델에 전달한 후보 설명", "모델의 설명이 아닙니다"} {
		if !strings.Contains(report, want) {
			t.Fatal("missing", want)
		}
	}
	if strings.Contains(report, "D04, D05 소관") || strings.Contains(report, "<summary>판단 기준</summary>") {
		t.Fatal("ambiguous explanation")
	}
}

func TestDecisionCandidateAssessmentSeparatesInclusionAndAllocation(t *testing.T) {
	task := DecisionTask{Type: "ranking", Options: []DecisionOption{{Key: "A"}, {Key: "B"}, {Key: "C"}, {Key: "D"}}}
	r := DecisionCaseResult{Status: "completed", LabelValid: true, ProbabilityValid: true, Expected: "A|B", Predicted: "A|B", Probabilities: map[string]float64{"A": .3, "B": .1, "C": .4, "D": .2}}
	for _, tc := range []struct{ key, selection, allocation string }{{"A", "상위 후보 포함", "기준 충족"}, {"B", "상위 후보 포함", "기준 미달"}, {"C", "상위 후보 미포함", "기준 충족"}, {"D", "상위 후보 미포함", "기준 미달"}} {
		selection, allocation := decisionCandidateAssessment(task, r, tc.key)
		if selection != tc.selection || allocation != tc.allocation {
			t.Fatal(tc.key, selection, allocation)
		}
	}
	r.Probabilities["B"] = .25
	_, allocation := decisionCandidateAssessment(task, r, "B")
	if allocation != "기준 충족" {
		t.Fatal("threshold boundary")
	}
	r.ProbabilityValid = false
	_, allocation = decisionCandidateAssessment(task, r, "B")
	if allocation != "확인 불가" {
		t.Fatal("invalid probability counted")
	}
	r.Truncated = new(bool)
	*r.Truncated = true
	selection, _ := decisionCandidateAssessment(task, r, "B")
	if selection != "채점 불가" {
		t.Fatal("truncation counted")
	}
	report := decisionHTMLRankingTable(task, r)
	for _, text := range []string{"<th>정답</th>", "<th>상위 후보</th>", "<th>확률</th>"} {
		if !strings.Contains(report, text) {
			t.Fatal("missing", text)
		}
	}
}

func TestDecisionRankingDonutSegments(t *testing.T) {
	task := DecisionTask{ID: "rank", Type: "ranking", Options: []DecisionOption{{Key: "A"}, {Key: "B"}, {Key: "C"}, {Key: "D"}}}
	results := []DecisionCaseResult{}
	for _, predicted := range []string{"A|B", "A|C", "C|D"} {
		for _, probabilities := range []map[string]float64{{"A": .25, "B": .25, "C": .25, "D": .25}, {"A": .6, "B": .1, "C": .2, "D": .1}} {
			results = append(results, DecisionCaseResult{TaskID: "rank", TargetID: "t", Status: "completed", Expected: "A|B", Predicted: predicted, LabelValid: true, ProbabilityValid: true, Probabilities: probabilities})
		}
	}
	segments := decisionRankingSegments(task, results, "t")
	total := 0
	for i, segment := range segments {
		total += segment.count
		if segment.count != []int{1, 1, 1, 1, 2}[i] {
			t.Fatal(segment)
		}
	}
	if total != 6 {
		t.Fatal("duplicate or missing cases", total)
	}
	results[0].ProbabilityValid = false
	results[1].Truncated = new(bool)
	*results[1].Truncated = true
	segments = decisionRankingSegments(task, results, "t")
	total = 0
	for _, segment := range segments {
		total += segment.count
	}
	if total != 5 || segments[len(segments)-1].label != "확률 확인 불가" || segments[len(segments)-1].count != 1 {
		t.Fatal("invalid/excluded cases", segments)
	}
	for _, segment := range segments {
		if strings.Contains(segment.label, "기준 충족") {
			t.Fatal("ambiguous category", segment)
		}
	}
}

func TestDecisionPartialSegmentsUseOnlyMissingProbabilities(t *testing.T) {
	task := DecisionTask{ID: "rank", Type: "ranking", Options: []DecisionOption{{Key: "A"}, {Key: "B"}, {Key: "C"}, {Key: "D"}}}
	r := DecisionCaseResult{TaskID: "rank", TargetID: "t", Status: "completed", Expected: "A|B", Predicted: "A|C", LabelValid: true, ProbabilityValid: true, Probabilities: map[string]float64{"A": .1, "B": .3, "C": .4, "D": .2}}
	segments := decisionRankingSegments(task, []DecisionCaseResult{r}, "t")
	if segments[2].count != 1 || segments[3].count != 0 {
		t.Fatal("found low probability changed missing assessment", segments)
	}
	r.Expected = "A|B|D"
	segments = decisionRankingSegments(task, []DecisionCaseResult{r}, "t")
	if segments[3].count != 1 {
		t.Fatal("mixed missing probabilities not low", segments)
	}
	r.Probabilities["D"] = .25
	segments = decisionRankingSegments(task, []DecisionCaseResult{r}, "t")
	if segments[2].count != 1 {
		t.Fatal("threshold boundary", segments)
	}
}
