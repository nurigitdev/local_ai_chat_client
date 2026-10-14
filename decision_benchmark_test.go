package main

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func decisionTestSuite() DecisionSuite {
	s := NewApp().GetDefaultDecisionSuite()
	cases := []DecisionCase{}
	for _, task := range s.Tasks {
		for _, c := range s.Cases {
			if c.TaskID == task.ID {
				cases = append(cases, c)
				break
			}
		}
	}
	s.Cases = cases
	return s
}
func decisionFixture(task DecisionTask, expected string) []byte {
	p := map[string]float64{}
	for _, o := range task.Options {
		p[o.Key] = 0
	}
	p[expected] = 1
	a := map[string]any{"type": task.Type, "probabilities": p}
	switch task.Type {
	case "choice":
		a["choice"] = expected
	case "noul":
		v := 0.0
		if expected == "true" {
			v = 1
		}
		a = map[string]any{"type": "noul", "noul": v}
	case "score":
		a["score"] = 0
		a["legend"] = map[string]string{"0": "部", "1": "?", "2": "ok"}
	}
	b, _ := json.Marshal(map[string]any{"model": "laya-rl-agent", "routing": map[string]string{"model": "multilingual"}, "truncated": false, "answers": map[string]any{"decision": a}, "usage": map[string]int{"input_tokens": 7}})
	return b
}
func assertNear(t *testing.T, v *float64, want float64) {
	t.Helper()
	if v == nil || math.Abs(*v-want) > 1e-8 {
		t.Fatalf("got %v want %v", v, want)
	}
}
func TestDecisionBuiltinAndRequests(t *testing.T) {
	s := NewApp().GetDefaultDecisionSuite()
	if e := validateDecisionSuite(s); e != nil {
		t.Fatal(e)
	}
	if len(s.Cases) != 120 {
		t.Fatal(len(s.Cases))
	}
	counts := map[string]int{}
	for _, c := range s.Cases {
		task, _ := decisionTask(s, c.TaskID)
		counts[task.Type]++
		req, e := buildDecisionRequest(DecisionTarget{Model: "multilingual"}, task, c)
		if e != nil {
			t.Fatal(e)
		}
		for _, bad := range []string{"\"expected\"", "\"rationale\"", "\"pairID\"", c.ID} {
			if strings.Contains(string(req), bad) {
				t.Fatalf("request leaked %s", bad)
			}
		}
	}
	if counts["choice"] != 20 || counts["noul"] != 40 || counts["score"] != 60 {
		t.Fatal(counts)
	}
}
func TestDecisionTypedScoring(t *testing.T) {
	s := decisionTestSuite()
	for _, c := range s.Cases {
		task, _ := decisionTask(s, c.TaskID)
		r, e := scoreDecisionResponse(decisionFixture(task, c.Expected), task, c)
		if e != nil || !r.Correct || !r.ProbabilityValid || r.ReturnedModel != "laya-rl-agent" || r.RoutingModel != "multilingual" {
			t.Fatalf("%s: %+v %v", task.Type, r, e)
		}
	}
	task := s.Tasks[2]
	c := s.Cases[2]
	c.Expected = "0"
	r, e := scoreDecisionResponse([]byte(`{"answers":{"decision":{"type":"score","score":2,"probabilities":{"0":0.4,"1":0.4,"2":0.2}}}}`), task, c)
	if e != nil || r.Predicted != "0" || math.Abs(r.ExpectedScore-.8) > 1e-8 {
		t.Fatalf("tie/weighted: %+v %v", r, e)
	}
	c = s.Cases[1]
	c.Expected = "true"
	r, e = scoreDecisionResponse([]byte(`{"answers":{"decision":{"noul":0.5}}}`), s.Tasks[1], c)
	if e != nil || !r.Correct {
		t.Fatalf("noul tie: %+v %v", r, e)
	}
}
func TestDecisionInvalidResponses(t *testing.T) {
	s := decisionTestSuite()
	choice := s.Tasks[0]
	c := s.Cases[0]
	for _, raw := range []string{`not-json`, `{}`, `{"answers":{"decision":{"choice":"missing"}}}`} {
		if _, e := scoreDecisionResponse([]byte(raw), choice, c); e == nil {
			t.Fatal("accepted", raw)
		}
	}
	r, e := scoreDecisionResponse([]byte(`{"answers":{"decision":{"choice":"D01","probabilities":{"D01":1.1}}}}`), choice, c)
	if e != nil || !r.LabelValid || r.ProbabilityValid {
		t.Fatalf("label must survive invalid probability: %+v %v", r, e)
	}
	task := DecisionTask{Type: "score", Options: []DecisionOption{{Key: "0"}, {Key: "1"}}}
	for _, p := range []map[string]float64{{"0": math.NaN(), "1": 0}, {"0": -0.1, "1": 1.1}, {"0": 0.1, "1": 0.1}} {
		if _, e := normalizeDecisionProbabilities(p, task); e == nil {
			t.Fatal("accepted invalid p")
		}
	}
	p, e := normalizeDecisionProbabilities(map[string]float64{"0": 0.49, "1": 0.5}, task)
	if e != nil || math.Abs(p["0"]+p["1"]-1) > 1e-8 {
		t.Fatal(p, e)
	}
}
func TestDecisionMetricsDenominators(t *testing.T) {
	s := decisionTestSuite()
	s.Tasks = s.Tasks[1:2]
	s.Cases = s.Cases[1:2]
	task := s.Tasks[0]
	c := s.Cases[0]
	c.Expected = "true"
	r, _ := scoreDecisionResponse([]byte(`{"answers":{"decision":{"noul":0.8}}}`), task, c)
	r.TargetID = "t"
	r.Status = "completed"
	r.DurationMs = 10
	wrong := r
	wrong.Expected = "false"
	wrong.Correct = false
	wrong.DurationMs = 30
	bad := r
	bad.Status = "error"
	bad.LabelValid = false
	bad.ProbabilityValid = false
	cut := r
	tr := true
	cut.Truncated = &tr
	cut.DurationMs = 50
	b := DecisionBenchmark{Suite: s, Targets: []DecisionTarget{{ID: "t"}}, Types: []string{"noul"}, Results: []DecisionCaseResult{r, wrong, bad, cut}}
	v := summarizeDecision(b)[0]
	if v.Attempted != 4 || v.Scorable != 2 || v.ProbabilityCount != 2 || v.Truncated != 1 || v.Errors != 1 {
		t.Fatal(v)
	}
	assertNear(t, v.Accuracy, .5)
	assertNear(t, v.AttemptAccuracy, .25)
	assertNear(t, v.Brier, .68)
	assertNear(t, v.ECE, .3)
	assertNear(t, v.FalsePositiveRate, 1)
	assertNear(t, v.FalseNegativeRate, 0)
	assertNear(t, v.P50Ms, 30)
	assertNear(t, v.P95Ms, 50)
	b.Results = nil
	v = summarizeDecision(b)[0]
	if v.Accuracy != nil || v.Brier != nil || v.MeanMs != nil {
		t.Fatal("empty metrics should be unavailable")
	}
}
func decisionAwait(t *testing.T, a *App, id string) DecisionBenchmark {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if a.GetActiveDecisionBenchmark() == "" {
			b, e := a.OpenDecisionBenchmark(id)
			if e != nil {
				t.Fatal(e)
			}
			return b
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("run did not finish")
	return DecisionBenchmark{}
}
func TestDecisionSequentialTwoTargetsAndReports(t *testing.T) {
	s := decisionTestSuite()
	var calls atomic.Int32
	var concurrent atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if concurrent.Add(1) != 1 {
			t.Error("parallel request")
		}
		defer concurrent.Add(-1)
		calls.Add(1)
		var req struct {
			State struct {
				Body string `json:"body"`
			} `json:"state"`
			Questions map[string]struct {
				Type string `json:"type"`
			} `json:"questions"`
		}
		if e := json.NewDecoder(r.Body).Decode(&req); e != nil {
			t.Error(e)
		}
		for _, c := range s.Cases {
			if strings.HasSuffix(req.State.Body, c.Text) {
				task, _ := decisionTask(s, c.TaskID)
				if task.Type != req.Questions["decision"].Type {
					continue
				}
				if task.Context["ko"] != "" && !strings.HasPrefix(req.State.Body, task.Context["ko"]+"\n\n") {
					t.Error("공통 설명이 실행 요청에서 누락되었습니다")
				}
				w.Write(decisionFixture(task, c.Expected))
				return
			}
		}
		http.Error(w, "unknown", 400)
	}))
	defer server.Close()
	a := NewApp()
	a.decisions.root = t.TempDir()
	targets := []DecisionTarget{{ID: "a", Model: "multilingual", BaseURL: server.URL, Enabled: true}, {ID: "b", Model: "multilingual", BaseURL: server.URL, Enabled: true}}
	b, e := a.StartDecisionBenchmark(DecisionStartRequest{ExperimentName: "MyBee 비교 실험", Suite: s, Types: []string{"choice", "noul", "score"}, Targets: targets, TimeoutSeconds: 60})
	if e != nil {
		t.Fatal(e)
	}
	done := decisionAwait(t, a, b.ID)
	if done.ExperimentName != "MyBee 비교 실험" {
		t.Fatal("실험 이름이 기록되지 않았습니다")
	}
	if done.Status != "completed" || calls.Load() != 12 || len(done.Warmups) != 6 {
		t.Fatalf("%s calls %d warm %d", done.Status, calls.Load(), len(done.Warmups))
	}
	for _, sum := range done.Summaries {
		assertNear(t, sum.Accuracy, 1)
	}
	for _, format := range []string{"md", "html"} {
		report, e := a.ExportDecisionBenchmark(done.ID, format)
		if e != nil {
			t.Fatal(e)
		}
		restored, e := decodeDecisionRecord([]byte(report))
		if e != nil || restored.Fingerprint != done.Fingerprint || restored.ExperimentName != done.ExperimentName {
			t.Fatal(e)
		}
		other := NewApp()
		other.decisions.root = t.TempDir()
		if _, e = other.ImportDecisionReport(report); e != nil {
			t.Fatal(e)
		}
		if _, e = other.ImportDecisionReport(report); e != nil {
			t.Fatal(e)
		}
		records, _ := other.ListDecisionBenchmarks()
		if len(records) != 1 {
			t.Fatal("duplicate report")
		}
	}
}
func TestDecisionCancellationPreservesCompleted(t *testing.T) {
	s := decisionTestSuite()
	s.Tasks = s.Tasks[:1]
	s.Cases = s.Cases[:1]
	second := s.Cases[0]
	second.ID += "-second"
	second.PairID += "-second"
	s.Cases = append(s.Cases, second)
	var calls atomic.Int32
	entered := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ioBody := map[string]any{}
		_ = json.NewDecoder(r.Body).Decode(&ioBody)
		n := calls.Add(1)
		if n <= 2 {
			w.Write(decisionFixture(s.Tasks[0], s.Cases[0].Expected))
			return
		}
		close(entered)
		select {
		case <-r.Context().Done():
		case <-time.After(time.Second):
		}
	}))
	defer server.Close()
	a := NewApp()
	a.decisions.root = t.TempDir()
	b, e := a.StartDecisionBenchmark(DecisionStartRequest{Suite: s, Types: []string{"choice"}, Targets: []DecisionTarget{{ID: "t", Model: "multilingual", BaseURL: server.URL, Enabled: true}}, TimeoutSeconds: 60})
	if e != nil {
		t.Fatal(e)
	}
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("measurement did not start")
	}
	if e = a.DeleteDecisionBenchmark(b.ID); e == nil {
		t.Fatal("deleted active")
	}
	a.CancelDecisionBenchmark(b.ID)
	done := decisionAwait(t, a, b.ID)
	if done.Status != "cancelled" || done.Results[0].Status != "completed" || done.Results[1].Status != "cancelled" {
		t.Fatalf("%+v", done.Results)
	}
}
func TestDecisionTimeoutErrorsAndSecretRedaction(t *testing.T) {
	s := decisionTestSuite()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := string(decisionFixture(s.Tasks[0], s.Cases[0].Expected))
		raw = strings.Replace(raw, "laya-rl-agent", "test-secret", 1)
		w.Write([]byte(raw))
	}))
	defer server.Close()
	r, e := callDecision(context.Background(), DecisionTarget{ID: "t", BaseURL: server.URL, Model: "multilingual"}, "test-secret", s.Tasks[0], s.Cases[0], 60)
	if e != nil || strings.Contains(string(r.Raw), "test-secret") || strings.Contains(r.ReturnedModel, "test-secret") {
		t.Fatalf("token redaction: %+v error %v", r, e)
	}
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { time.Sleep(30 * time.Millisecond); w.Write([]byte("{}")) }))
	defer slow.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer cancel()
	r, e = callDecision(ctx, DecisionTarget{BaseURL: slow.URL}, "", s.Tasks[0], s.Cases[0], 60)
	if e == nil || r.Status != "cancelled" {
		t.Fatal(r, e)
	}
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "secret backend details", 503) }))
	defer bad.Close()
	r, e = callDecision(context.Background(), DecisionTarget{BaseURL: bad.URL}, "", s.Tasks[0], s.Cases[0], 60)
	if e == nil || strings.Contains(r.Error, "secret") {
		t.Fatal(r, e)
	}
}
func TestDecisionRestartAndSaveFailure(t *testing.T) {
	a := NewApp()
	a.decisions.root = t.TempDir()
	s := decisionTestSuite()
	b := DecisionBenchmark{ID: newConversationID(), SchemaVersion: 1, ScoringVersion: decisionScoringVersion, Suite: s, Targets: []DecisionTarget{{ID: "t", BaseURL: "http://localhost:12300", Model: "multilingual"}}, TimeoutSeconds: 60, Types: []string{"choice"}, Status: "running", Results: []DecisionCaseResult{{TargetID: "t", CaseID: s.Cases[0].ID, TaskID: s.Cases[0].TaskID, Expected: s.Cases[0].Expected, Status: "pending"}}}
	b.Fingerprint = decisionFingerprint(s, b.Types)
	if e := a.decisions.save(b); e != nil {
		t.Fatal(e)
	}
	if e := a.decisions.markInterrupted(); e != nil {
		t.Fatal(e)
	}
	got, e := a.decisions.open(b.ID)
	if e != nil || got.Status != "interrupted" || got.Results[0].Status != "skipped" {
		t.Fatal(got, e)
	}
	badroot := filepath.Join(t.TempDir(), "file")
	if e = os.WriteFile(badroot, []byte("x"), 0600); e != nil {
		t.Fatal(e)
	}
	a.decisions.root = badroot
	if e = a.decisions.save(b); e == nil {
		t.Fatal("accepted save failure")
	}
	if _, e = a.decisions.open("../outside"); e == nil {
		t.Fatal("accepted unsafe ID")
	}
}

func TestDecisionCommonComparison(t *testing.T) {
	s := decisionTestSuite()
	task := s.Tasks[0]
	c := s.Cases[0]
	r, _ := scoreDecisionResponse(decisionFixture(task, c.Expected), task, c)
	r.TargetID = "t"
	r.Status = "completed"
	b := DecisionBenchmark{ID: "one", Status: "completed", ScoringVersion: decisionScoringVersion, Suite: s, Targets: []DecisionTarget{{ID: "t"}}, Types: []string{"choice"}, Results: []DecisionCaseResult{r}}
	b.Fingerprint = decisionFingerprint(s, b.Types)
	other := b
	other.ID = "two"
	cmp, e := commonDecisionComparison([]DecisionBenchmark{b, other})
	if e != nil || cmp.CommonCaseCount != 1 {
		t.Fatal(cmp, e)
	}
	assertNear(t, cmp.Records[0].Summaries[0].Accuracy, 1)
	other.Results = []DecisionCaseResult{}
	cmp, e = commonDecisionComparison([]DecisionBenchmark{b, other})
	if e != nil || cmp.CommonCaseCount != 0 || cmp.Records[0].Summaries[0].Accuracy != nil {
		t.Fatal(cmp, e)
	}
	other.Fingerprint = "different"
	if _, e = commonDecisionComparison([]DecisionBenchmark{b, other}); e == nil {
		t.Fatal("compared different snapshots")
	}
}
func TestDecisionScoreMAEAndHTML(t *testing.T) {
	s := decisionTestSuite()
	s.Tasks = s.Tasks[2:]
	s.Cases = s.Cases[2:]
	c := s.Cases[0]
	c.Expected = "2"
	r, _ := scoreDecisionResponse([]byte(`{"answers":{"decision":{"probabilities":{"0":0.5,"1":0.3,"2":0.2}}}}`), s.Tasks[0], c)
	r.Status = "completed"
	r.TargetID = "t"
	b := DecisionBenchmark{Suite: s, Targets: []DecisionTarget{{ID: "t"}}, Types: []string{"score"}, Results: []DecisionCaseResult{r}}
	v := summarizeDecision(b)[0]
	assertNear(t, v.TopMAE, 2)
	assertNear(t, v.ExpectedMAE, 1.3)
	b.Suite.Name = "<script>alert(1)</script>"
	report, e := decisionReport(b, "html")
	if e != nil || strings.Contains(report, "<script>") || !strings.Contains(report, "&lt;script&gt;") {
		t.Fatal("HTML was not escaped", e)
	}
}

func TestDecisionReportValidationAndComparisonRoundtrip(t *testing.T) {
	a := NewApp()
	a.decisions.root = t.TempDir()
	s := decisionTestSuite()
	r, _ := scoreDecisionResponse(decisionFixture(s.Tasks[0], s.Cases[0].Expected), s.Tasks[0], s.Cases[0])
	r.TargetID = "t"
	r.Status = "completed"
	b := DecisionBenchmark{ID: newConversationID(), SchemaVersion: 1, ScoringVersion: decisionScoringVersion, Suite: s, Targets: []DecisionTarget{{ID: "t", Model: "multilingual", BaseURL: "http://localhost:12300"}}, Types: []string{"choice"}, TimeoutSeconds: 60, Status: "completed", Results: []DecisionCaseResult{r}}
	b.Fingerprint = decisionFingerprint(s, b.Types)
	b.Summaries = summarizeDecision(b)
	if e := a.decisions.save(b); e != nil {
		t.Fatal(e)
	}
	other := b
	other.ID = newConversationID()
	other.CreatedAt = "later"
	if e := a.decisions.save(other); e != nil {
		t.Fatal(e)
	}
	for _, format := range []string{"md", "html"} {
		report, e := a.ExportDecisionComparison([]string{b.ID, other.ID}, format)
		if e != nil {
			t.Fatal(e)
		}
		importer := NewApp()
		importer.decisions.root = t.TempDir()
		items, e := importer.ImportDecisionReports(report)
		if e != nil || len(items) != 2 {
			t.Fatal(items, e)
		}
		if _, e = importer.ImportDecisionReports(report); e != nil {
			t.Fatal(e)
		}
		records, e := importer.ListDecisionBenchmarks()
		if e != nil || len(records) != 2 {
			t.Fatal(records, e)
		}
	}
	for _, edit := range []func(*DecisionBenchmark){func(b *DecisionBenchmark) { b.SchemaVersion = 9 }, func(b *DecisionBenchmark) { b.Results[0].Correct = false }, func(b *DecisionBenchmark) { b.Results[0].CaseID = "missing" }, func(b *DecisionBenchmark) { b.Results = append(b.Results, b.Results[0]) }, func(b *DecisionBenchmark) { b.Fingerprint = "bad" }} {
		payload, _ := json.Marshal(b)
		var modified DecisionBenchmark
		json.Unmarshal(payload, &modified)
		edit(&modified)
		report, e := decisionReport(modified, "md")
		if e != nil {
			t.Fatal(e)
		}
		if _, e = decodeDecisionRecord([]byte(report)); e == nil {
			t.Fatal("accepted invalid report")
		}
	}
}
func TestDecisionSanitizesEscapedSecretsAndHeaders(t *testing.T) {
	token := "test-\"secret"
	raw, _ := json.Marshal(map[string]any{"echo": token, "headers": map[string]string{"Authorization": "Bearer " + token}, "authorization": "Bearer " + token, "answers": map[string]any{"decision": map[string]float64{"noul": .5}}})
	clean := redactDecisionToken(raw, token)
	var decoded map[string]any
	if e := json.Unmarshal(clean, &decoded); e != nil {
		t.Fatal(e)
	}
	if _, ok := decoded["headers"]; ok {
		t.Fatal("saved authentication headers")
	}
	if _, ok := decoded["authorization"]; ok {
		t.Fatal("saved authentication header")
	}
	if decoded["echo"] != "[REDACTED]" {
		t.Fatal(decoded)
	}
}

func TestDecisionStopsOnMidRunSaveFailure(t *testing.T) {
	a := NewApp()
	originalRoot := t.TempDir()
	a.decisions.root = originalRoot
	badRoot := filepath.Join(t.TempDir(), "blocked")
	os.WriteFile(badRoot, []byte("x"), 0600)
	var calls atomic.Int32
	failed := make(chan struct{})
	s := decisionTestSuite()
	s.Tasks = s.Tasks[:1]
	s.Cases = s.Cases[:1]
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Write(decisionFixture(s.Tasks[0], s.Cases[0].Expected))
	}))
	defer server.Close()
	a.decisionEventSink = func(e DecisionBenchmarkEvent) {
		if e.Type == "started" {
			a.decisions.root = badRoot
		}
		if e.Type == "failed" {
			close(failed)
		}
	}
	b, e := a.StartDecisionBenchmark(DecisionStartRequest{Suite: s, Types: []string{"choice"}, Targets: []DecisionTarget{{ID: "t", BaseURL: server.URL, Model: "multilingual", Enabled: true}}, TimeoutSeconds: 60})
	if e != nil {
		t.Fatal(e)
	}
	select {
	case <-failed:
	case <-time.After(3 * time.Second):
		t.Fatal("save failure did not stop run")
	}
	deadline := time.Now().Add(3 * time.Second)
	for a.GetActiveDecisionBenchmark() != "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if a.GetActiveDecisionBenchmark() != "" || calls.Load() != 1 {
		t.Fatal("continued after save failure")
	}
	a.decisions.root = originalRoot
	if _, e = a.OpenDecisionBenchmark(b.ID); e != nil {
		t.Fatal("initial snapshot was not preserved", e)
	}
}

func TestDecisionLegacyReportRemainsReadableWithNeutralDisplay(t *testing.T) {
	s := decisionTestSuite()
	s.Name = "MyBee 업무영역"
	s.SourceDocument = "MyBee_코드체계_설계서"
	c := s.Cases[0]
	task := s.Tasks[0]
	r, _ := scoreDecisionResponse(decisionFixture(task, c.Expected), task, c)
	r.TargetID = "t"
	r.Status = "completed"
	b := DecisionBenchmark{ID: newConversationID(), SchemaVersion: 1, ScoringVersion: legacyDecisionScoringVersion, Suite: s, Targets: []DecisionTarget{{ID: "t", BaseURL: "http://localhost:12300", Model: "multilingual"}}, Types: []string{"choice"}, TimeoutSeconds: 60, Status: "completed", Results: []DecisionCaseResult{r}}
	b.Fingerprint = decisionFingerprintForVersion(s, b.Types, legacyDecisionScoringVersion)
	report, e := decisionReport(b, "md")
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(report, "MyBee") {
		t.Fatal("brand leaked into visible report")
	}
	restored, e := decodeDecisionRecord([]byte(report))
	if e != nil || restored.Fingerprint != b.Fingerprint || restored.Suite.Name != s.Name {
		t.Fatal("legacy snapshot was not preserved", e)
	}
}

func TestDecisionWarmupFailureOnlySkipsItsTask(t *testing.T) {
	s := decisionTestSuite()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Questions map[string]struct {
				Type string `json:"type"`
			} `json:"questions"`
			State struct {
				Body string `json:"body"`
			} `json:"state"`
		}
		if e := json.NewDecoder(r.Body).Decode(&req); e != nil {
			t.Error(e)
		}
		for _, c := range s.Cases {
			if !strings.HasSuffix(req.State.Body, c.Text) {
				continue
			}
			task, _ := decisionTask(s, c.TaskID)
			if task.Type != req.Questions["decision"].Type {
				continue
			}
			if task.Type == "choice" {
				http.Error(w, "decision options exceed the 240-token budget", 400)
				return
			}
			w.Write(decisionFixture(task, c.Expected))
			return
		}
		http.Error(w, "unknown", 400)
	}))
	defer server.Close()
	a := NewApp()
	a.decisions.root = t.TempDir()
	b, e := a.StartDecisionBenchmark(DecisionStartRequest{Suite: s, Types: []string{"choice", "noul", "score"}, Targets: []DecisionTarget{{ID: "t", Model: "multilingual", BaseURL: server.URL, Enabled: true}}, TimeoutSeconds: 60})
	if e != nil {
		t.Fatal(e)
	}
	done := decisionAwait(t, a, b.ID)
	if done.Status != "partial" || len(done.Warmups) != 3 {
		t.Fatal(done.Status, len(done.Warmups))
	}
	for _, sum := range done.Summaries {
		if sum.Type == "choice" {
			if !sum.WarmupFailed || sum.Skipped != 1 || sum.Attempted != 0 || sum.Planned != 1 || sum.Accuracy != nil {
				t.Fatalf("%+v", sum)
			}
		} else if sum.Completed != 1 || sum.Skipped != 0 || sum.WarmupFailed {
			t.Fatalf("%+v", sum)
		}
	}
}

func TestDecisionRequestKeepsContextOutsideOptions(t *testing.T) {
	task := DecisionTask{ID: "probe", Type: "choice", Instructions: map[string]string{"ko": "Choose one"}, Context: map[string]string{"ko": "A: hardware design\nB: software design"}, Options: []DecisionOption{{Key: "A", Descriptions: map[string]string{"ko": "Hardware"}}, {Key: "B", Descriptions: map[string]string{"ko": "Software"}}}}
	c := DecisionCase{Text: "Design a sensor board", Expected: "A", Rationale: "private grading reason"}
	raw, e := buildDecisionRequest(DecisionTarget{Model: "m"}, task, c)
	if e != nil {
		t.Fatal(e)
	}
	var req struct {
		State struct {
			Body string `json:"body"`
		}
		Questions map[string]struct {
			Instructions string
			Criteria     map[string]string
		}
	}
	if e = json.Unmarshal(raw, &req); e != nil {
		t.Fatal(e)
	}
	if req.State.Body != task.Context["ko"]+"\n\n"+c.Text || req.Questions["decision"].Instructions != "Choose one" || req.Questions["decision"].Criteria["A"] != "Hardware" {
		t.Fatal("context was lost or expanded options")
	}
	if strings.Contains(string(raw), c.Rationale) || strings.Contains(string(raw), "expected") {
		t.Fatal("answer leaked")
	}
	changed := task
	changed.Context = map[string]string{"ko": "different definition"}
	a := decisionTestSuite()
	b := a
	a.Tasks = []DecisionTask{task}
	b.Tasks = []DecisionTask{changed}
	if decisionFingerprint(a, []string{"choice"}) == decisionFingerprint(b, []string{"choice"}) {
		t.Fatal("context must change comparison conditions")
	}
}

func TestDecisionUsageTruncationMetadata(t *testing.T) {
	s := decisionTestSuite()
	task := s.Tasks[0]
	c := s.Cases[0]
	for _, tc := range []struct {
		usage string
		want  bool
	}{{`{"truncated":false,"state_tokens_dropped":0}`, false}, {`{"truncated":true}`, true}, {`{"state_tokens_dropped":5}`, true}, {`{"truncated_questions":["decision"]}`, true}} {
		var data map[string]any
		json.Unmarshal(decisionFixture(task, c.Expected), &data)
		delete(data, "truncated")
		var usage any
		json.Unmarshal([]byte(tc.usage), &usage)
		data["usage"] = usage
		raw, _ := json.Marshal(data)
		r, e := scoreDecisionResponse(raw, task, c)
		if e != nil || r.Truncated == nil || *r.Truncated != tc.want {
			t.Fatal("usage truncation", tc, r, e)
		}
		r.TargetID = "t"
		r.Status = "completed"
		r.Truncated = nil // simulate a record saved before usage support
		b := DecisionBenchmark{ID: newConversationID(), SchemaVersion: 1, ScoringVersion: decisionScoringVersion, Suite: s, Targets: []DecisionTarget{{ID: "t", Model: "model", BaseURL: "http://localhost:12300"}}, Types: []string{"choice", "noul", "score"}, TimeoutSeconds: 60, Status: "completed", Results: []DecisionCaseResult{r}}
		for _, item := range s.Cases[1:] {
			b.Results = append(b.Results, DecisionCaseResult{TargetID: "t", TaskID: item.TaskID, CaseID: item.ID, Expected: item.Expected, Status: "skipped"})
		}
		b.Fingerprint = decisionFingerprint(s, b.Types)
		report, e := decisionReport(b, "md")
		if e != nil {
			t.Fatal(e)
		}
		restored, e := decodeDecisionRecord([]byte(report))
		if e != nil {
			t.Fatal("old record rejected", e)
		}
		if restored.Results[0].Truncated == nil || *restored.Results[0].Truncated != tc.want {
			t.Fatal("old metadata not normalized")
		}
		if tc.want && restored.Summaries[0].Scorable != 0 {
			t.Fatal("truncated scored")
		}
	}
}

func TestDecisionSeparatedQuestionContract(t *testing.T) {
	s := NewApp().GetDefaultDecisionSuite()
	if s.Revision != "0.5.0-draft-compact" || len(s.Tasks[0].Context) != 0 {
		t.Fatal("wrong default")
	}
	for _, c := range s.Cases {
		task, _ := decisionTask(s, c.TaskID)
		raw, e := buildDecisionRequest(DecisionTarget{Model: "m"}, task, c)
		if e != nil {
			t.Fatal(e)
		}
		var req struct {
			State     struct{ Body string }
			Questions map[string]struct{ Instructions string }
		}
		if e = json.Unmarshal(raw, &req); e != nil {
			t.Fatal(e)
		}
		if req.State.Body != c.Text || strings.Contains(req.State.Body, "후보 기준:") || strings.Contains(req.State.Body, "후보 업무영역:") {
			t.Fatal("state polluted", c.ID)
		}
		if c.Candidate != "" && req.Questions["decision"].Instructions != c.Instructions["ko"] {
			t.Fatal("candidate question missing", c.ID)
		}
		if strings.Contains(string(raw), c.Rationale) || strings.Contains(string(raw), "expected") {
			t.Fatal("grading metadata sent", c.ID)
		}
	}
	old := s
	old.Cases = append([]DecisionCase(nil), s.Cases...)
	old.Cases[20].Instructions = map[string]string{"ko": "different question"}
	if decisionFingerprint(s, []string{"noul"}) == decisionFingerprint(old, []string{"noul"}) {
		t.Fatal("question change ignored")
	}
}
