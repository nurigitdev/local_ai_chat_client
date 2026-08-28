package openai

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func testClient(handler roundTripFunc) *http.Client {
	return &http.Client{Transport: handler}
}

func testResponse(status int, contentType, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"Content-Type": []string{contentType}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func TestListModels(t *testing.T) {
	httpClient := testClient(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/v1/models" {
			t.Fatalf("path = %q, want /v1/models", request.URL.Path)
		}
		if got := request.Header.Get("Authorization"); got != "Bearer secret" {
			t.Fatalf("Authorization = %q", got)
		}
		return testResponse(http.StatusOK, "application/json", `{"data":[{"id":"local-model","owned_by":"vllm"}]}`), nil
	})

	client, err := NewClient("http://localhost:8000", "secret", httpClient)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	models, err := client.ListModels(context.Background())
	if err != nil {
		t.Fatalf("ListModels() error = %v", err)
	}
	want := []Model{{ID: "local-model", OwnedBy: "vllm"}}
	if !reflect.DeepEqual(models, want) {
		t.Fatalf("ListModels() = %#v, want %#v", models, want)
	}
}

func TestStreamChat(t *testing.T) {
	httpClient := testClient(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/v1/chat/completions" {
			t.Fatalf("path = %q, want /v1/chat/completions", request.URL.Path)
		}
		var payload struct {
			StreamOptions struct {
				IncludeUsage bool `json:"include_usage"`
			} `json:"stream_options"`
		}
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		if !payload.StreamOptions.IncludeUsage {
			t.Fatal("stream_options.include_usage = false, want true")
		}
		body := "data: {\"choices\":[{\"delta\":{\"content\":\"안녕\"}}]}\n\n" +
			"data: {\"choices\":[{\"delta\":{\"content\":\"하세요\"}}]}\n\n" +
			"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":3,\"total_tokens\":15}}\n\n" +
			"data: [DONE]\n\n"
		return testResponse(http.StatusOK, "text/event-stream", body), nil
	})

	client, err := NewClient("http://localhost:8000/v1", "", httpClient)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	var chunks []StreamChunk
	err = client.StreamChat(context.Background(), ChatRequest{
		Model:    "local-model",
		Messages: []Message{{Role: "user", Content: "테스트"}},
	}, func(chunk StreamChunk) {
		chunks = append(chunks, chunk)
	})
	if err != nil {
		t.Fatalf("StreamChat() error = %v", err)
	}
	var deltas []string
	var usage *TokenUsage
	for _, chunk := range chunks {
		deltas = append(deltas, chunk.Delta)
		if chunk.Usage != nil {
			usage = chunk.Usage
		}
	}
	if got := strings.Join(deltas, ""); got != "안녕하세요" {
		t.Fatalf("deltas = %q, want 안녕하세요", got)
	}
	if usage == nil || *usage != (TokenUsage{PromptTokens: 12, CompletionTokens: 3, TotalTokens: 15}) {
		t.Fatalf("usage = %#v", usage)
	}
}

func TestAPIError(t *testing.T) {
	httpClient := testClient(func(_ *http.Request) (*http.Response, error) {
		return testResponse(http.StatusUnauthorized, "application/json", `{"error":{"message":"invalid token"}}`), nil
	})

	client, err := NewClient("http://localhost:8000", "bad-key", httpClient)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	_, err = client.ListModels(context.Background())
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("ListModels() error = %T, want *APIError", err)
	}
	if apiErr.StatusCode != http.StatusUnauthorized || apiErr.Message != "invalid token" {
		t.Fatalf("APIError = %#v", apiErr)
	}
}
