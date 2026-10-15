package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecisionRankingMetricsAndRoundtrip(t *testing.T) {
	task := DecisionTask{ID: "rank", Type: "ranking", Name: "ranking", Instructions: map[string]string{"ko": "Rank work"}, Options: []DecisionOption{{Key: "A", Descriptions: map[string]string{"ko": "Alpha"}}, {Key: "B", Descriptions: map[string]string{"ko": "Beta"}}, {Key: "C", Descriptions: map[string]string{"ko": "Gamma"}}}}
	c := DecisionCase{ID: "r", PairID: "r", TaskID: "rank", Language: "ko", Text: "Do two tasks", Expected: "A|B"}
	raw := []byte(`{"answers":{"decision":{"type":"choice","choice":"A","probabilities":{"A":0.8,"B":0.05,"C":0.15}}}}`)
	r, e := scoreDecisionResponse(raw, task, c)
	if e != nil || r.Correct || !r.LabelValid || r.Predicted != "A|C" {
		t.Fatal(r, e)
	}
	assertNear(t, r.RankingRecall, .5)
	assertNear(t, r.RelevantProbability, .85)
	r.Status = "completed"
	r.TargetID = "t"
	suite := DecisionSuite{Format: "decision-benchmark-suite", Version: 1, Name: "suite", Tasks: []DecisionTask{task}, Cases: []DecisionCase{c}}
	b := DecisionBenchmark{ID: newConversationID(), SchemaVersion: 1, ScoringVersion: decisionScoringVersion, Suite: suite, Targets: []DecisionTarget{{ID: "t", Model: "m", BaseURL: "http://localhost:12300"}}, Types: []string{"ranking"}, TimeoutSeconds: 60, Status: "completed", Results: []DecisionCaseResult{r}}
	b.Fingerprint = decisionFingerprint(suite, b.Types)
	sum := summarizeDecision(b)[0]
	assertNear(t, sum.RankingRecall, .5)
	assertNear(t, sum.RelevantProbability, .85)
	if sum.Brier != nil || sum.MacroF1 != nil {
		t.Fatal("single-label metrics applied")
	}
	request, e := buildDecisionRequest(b.Targets[0], task, c)
	if e != nil || strings.Contains(string(request), "A|B") || !strings.Contains(string(request), `"type":"choice"`) {
		t.Fatal(string(request), e)
	}
	for _, format := range []string{"md", "html"} {
		report, e := decisionReport(b, format)
		if e != nil {
			t.Fatal(e)
		}
		got, e := decodeDecisionRecord([]byte(report))
		if e != nil {
			t.Fatal(e)
		}
		assertNear(t, got.Summaries[0].RankingRecall, .5)
	}
	var data map[string]any
	json.Unmarshal(raw, &data)
	data["answers"].(map[string]any)["decision"].(map[string]any)["probabilities"] = map[string]float64{"A": .6, "B": .2, "C": .2}
	tie, _ := json.Marshal(data)
	r, e = scoreDecisionResponse(tie, task, c)
	if e != nil || r.LabelValid || r.RankingRecall != nil {
		t.Fatal("cutoff tie was scored", r, e)
	}
}

func TestDecisionRankingRun(t *testing.T) {
	s := NewApp().GetDefaultDecisionSuite()
	s.Tasks = s.Tasks[1:]
	s.Cases = s.Cases[20:21]
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		json.NewDecoder(r.Body).Decode(&req)
		question := req["questions"].(map[string]any)["decision"].(map[string]any)
		if question["type"] != "choice" {
			t.Error("ranking sent to server")
		}
		probabilities := map[string]float64{}
		for _, o := range s.Tasks[0].Options {
			probabilities[o.Key] = 0
		}
		labels := strings.Split(s.Cases[0].Expected, "|")
		probabilities[labels[0]] = .6
		probabilities[labels[1]] = .4
		json.NewEncoder(w).Encode(map[string]any{"answers": map[string]any{"decision": map[string]any{"type": "choice", "choice": labels[0], "probabilities": probabilities}}})
	}))
	defer server.Close()
	a := NewApp()
	a.decisions.root = t.TempDir()
	b, e := a.StartDecisionBenchmark(DecisionStartRequest{Suite: s, Types: []string{"ranking"}, Targets: []DecisionTarget{{ID: "t", Model: "m", BaseURL: server.URL, Enabled: true}}, TimeoutSeconds: 60})
	if e != nil {
		t.Fatal(e)
	}
	done := decisionAwait(t, a, b.ID)
	if done.Status != "completed" || len(done.Results) != 1 || !done.Results[0].Correct {
		t.Fatal(done.Status, done.Results)
	}
	assertNear(t, done.Summaries[0].RankingRecall, 1)
}
