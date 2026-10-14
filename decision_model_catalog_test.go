package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecisionOllamaCatalogUsesExactInstalledTags(t *testing.T) {
	var inference int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/tags" {
			w.Write([]byte(`{"models":[{"name":"tev1:4b","capabilities":["decision"]},{"name":"nimble:9b","capabilities":["decision"]},{"name":"qwen:9b","capabilities":["completion"]},{"name":"tev1:4b","capabilities":["decision"]}]}`))
			return
		}
		inference++
		http.Error(w, "should not infer", 500)
	}))
	defer server.Close()
	target := DecisionTarget{ID: "t", Runtime: "ollama", BaseURL: server.URL}
	catalog, e := getDecisionModelCatalog(context.Background(), target, "")
	if e != nil || !catalog.Available || len(catalog.Models) != 2 || catalog.Models[0] != "nimble:9b" || catalog.Models[1] != "tev1:4b" {
		t.Fatal(catalog, e)
	}
	target.Model = "tev1"
	if e = ensureDecisionModelInstalled(context.Background(), target, ""); e == nil || !strings.Contains(e.Error(), "tev1:4b") {
		t.Fatal("missing tag was not diagnosed", e)
	}
	target.Model = "tev1:4b"
	if e = ensureDecisionModelInstalled(context.Background(), target, ""); e != nil {
		t.Fatal(e)
	}
	if inference != 0 {
		t.Fatal("model discovery performed inference")
	}
}
func TestDecisionLayaAndGenericCatalog(t *testing.T) {
	for _, mode := range []string{"models", "health", "none"} {
		t.Run(mode, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case mode == "models" && r.URL.Path == "/v1/models":
					w.Write([]byte(`{"data":[{"id":"multilingual"}]}`))
				case mode == "health" && r.URL.Path == "/health":
					w.Write([]byte(`{"status":"ok","loaded":["multilingual"]}`))
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			c, e := getDecisionModelCatalog(context.Background(), DecisionTarget{ID: "t", Runtime: "systemone", BaseURL: server.URL}, "")
			if e != nil {
				t.Fatal(e)
			}
			if mode == "none" {
				if c.Available || len(c.Models) != 0 || !strings.Contains(c.Message, "직접 입력") {
					t.Fatal(c)
				}
			} else if !c.Available || len(c.Models) != 1 || c.Models[0] != "multilingual" {
				t.Fatal(c)
			}
		})
	}
}
func TestDecisionCatalogAuthenticationAndErrors(t *testing.T) {
	for _, status := range []int{401, 500} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer secret" {
				t.Error("missing token")
			}
			http.Error(w, "private backend details and secret", status)
		}))
		_, e := getDecisionModelCatalog(context.Background(), DecisionTarget{ID: "t", Runtime: "ollama", BaseURL: server.URL}, "secret")
		server.Close()
		if e == nil || strings.Contains(e.Error(), "secret") || strings.Contains(e.Error(), "private") {
			t.Fatal(e)
		}
	}
}
func TestDecision404DistinguishesModelFromRoute(t *testing.T) {
	missing := decisionHTTPError(404, []byte(`{"error":"model \"tev1\" not found, try pulling it first"}`), DecisionTarget{Model: "tev1"})
	if !strings.Contains(missing.Error(), "모델") || strings.Contains(missing.Error(), "경로") {
		t.Fatal(missing)
	}
	route := decisionHTTPError(404, []byte("404 page not found"), DecisionTarget{Model: "tev1"})
	if !strings.Contains(route.Error(), "/v1/systemone") {
		t.Fatal(route)
	}
	if strings.Contains(decisionHTTPError(503, []byte("secret"), DecisionTarget{}).Error(), "secret") {
		t.Fatal("leaked error body")
	}
}
func TestDecisionConnectionRejectsMissingTagBeforeInference(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/tags" {
			w.Write([]byte(`{"models":[{"name":"tev1:4b","capabilities":["decision"]}]}`))
			return
		}
		calls++
		http.Error(w, "bad", 500)
	}))
	defer server.Close()
	a := NewApp()
	target := DecisionTarget{ID: "t", Runtime: "ollama", BaseURL: server.URL, Model: "tev1", Enabled: true}
	if _, e := a.CheckDecisionConnection(target, "", 60); e == nil || !strings.Contains(e.Error(), "tev1:4b") {
		t.Fatal(e)
	}
	if _, e := a.StartDecisionBenchmark(DecisionStartRequest{Suite: decisionTestSuite(), Targets: []DecisionTarget{target}, Types: []string{"choice"}, TimeoutSeconds: 60}); e == nil {
		t.Fatal("started with invalid tag")
	}
	if calls != 0 || a.GetActiveDecisionBenchmark() != "" {
		t.Fatal("invalid model started inference")
	}
}

func TestDecisionHTTPErrorExplainsBudgetAndMemoryLimits(t *testing.T) {
	budget := decisionHTTPError(400, []byte("{\"error\":\"question 0: decision options exceed the 240-token budget\"}"), DecisionTarget{})
	if !strings.Contains(budget.Error(), "240토큰") || !strings.Contains(budget.Error(), "선택지") {
		t.Fatal(budget)
	}
	memory := decisionHTTPError(500, []byte("{\"error\":\"model requires 11.5 GiB but only 11.3 GiB are available (after 512.0 MiB overhead)\"}"), DecisionTarget{})
	if !strings.Contains(memory.Error(), "11.5GiB") || !strings.Contains(memory.Error(), "11.3GiB") {
		t.Fatal(memory)
	}
	private := decisionHTTPError(500, []byte("{\"error\":\"private secret path and token\"}"), DecisionTarget{})
	if strings.Contains(private.Error(), "secret") {
		t.Fatal("unrecognized private error leaked")
	}
}

func TestDecisionConnectionUsesTinyProbeWithoutDataset(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/systemone" {
			t.Error("unexpected route", r.URL.Path)
		}
		var body struct {
			State struct {
				Body string `json:"body"`
			} `json:"state"`
			Questions map[string]struct {
				Type         string            `json:"type"`
				Instructions string            `json:"instructions"`
				Criteria     map[string]string `json:"criteria"`
			} `json:"questions"`
		}
		if e := json.NewDecoder(r.Body).Decode(&body); e != nil {
			t.Fatal(e)
		}
		q := body.Questions["decision"]
		if body.State.Body != "Hello" || len(body.Questions) != 1 || q.Type != "noul" || len(q.Criteria) != 2 || len(q.Instructions) > 80 {
			t.Error("connection test used a benchmark payload", body)
		}
		for key := range q.Criteria {
			if key != "true" && key != "false" {
				t.Error("unexpected option", key)
			}
		}
		w.Write([]byte("{\"answers\":{\"decision\":{\"type\":\"noul\",\"noul\":0.1}}}"))
	}))
	defer server.Close()
	a := NewApp()
	a.decisions.root = t.TempDir()
	result, e := a.CheckDecisionConnection(DecisionTarget{ID: "t", Model: "test", BaseURL: server.URL, Runtime: "systemone"}, "", 60)
	if e != nil || !result.LabelValid || result.Status != "completed" {
		t.Fatal(result, e)
	}
	if result.Correct {
		t.Fatal("fixture should deliberately disagree with the probe answer")
	}
	records, e := a.ListDecisionBenchmarks()
	if e != nil || len(records) != 0 || calls != 1 {
		t.Fatal("connection test created evaluation data", records, e, calls)
	}
}
