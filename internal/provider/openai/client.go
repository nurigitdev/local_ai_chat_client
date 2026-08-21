package openai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxErrorBodySize = 64 * 1024

type Client struct {
	baseURL    *url.URL
	apiKey     string
	httpClient *http.Client
}

type Model struct {
	ID      string `json:"id"`
	OwnedBy string `json:"owned_by"`
}

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ChatRequest struct {
	Model    string
	Messages []Message
}

type APIError struct {
	StatusCode int
	Message    string
}

func (e *APIError) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("AI server returned HTTP %d", e.StatusCode)
	}
	return fmt.Sprintf("AI server returned HTTP %d: %s", e.StatusCode, e.Message)
}

func NewClient(baseURL, apiKey string, httpClient *http.Client) (*Client, error) {
	baseURL = strings.TrimSpace(baseURL)
	if baseURL == "" {
		return nil, errors.New("AI 서버 URL을 입력해 주세요")
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, errors.New("AI 서버 URL이 올바르지 않습니다")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("AI 서버 URL은 http 또는 https여야 합니다")
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	parsed.Path = strings.TrimRight(parsed.Path, "/")

	if httpClient == nil {
		httpClient = &http.Client{Timeout: 5 * time.Minute}
	}
	return &Client{baseURL: parsed, apiKey: strings.TrimSpace(apiKey), httpClient: httpClient}, nil
}

func (c *Client) ListModels(ctx context.Context) ([]Model, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.endpoint("models"), nil)
	if err != nil {
		return nil, err
	}
	c.setHeaders(request)

	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, connectionError(err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, decodeAPIError(response)
	}

	var payload struct {
		Data []Model `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, errors.New("모델 목록 응답을 읽을 수 없습니다")
	}
	return payload.Data, nil
}

func (c *Client) StreamChat(ctx context.Context, input ChatRequest, onDelta func(string)) error {
	payload, err := json.Marshal(struct {
		Model    string    `json:"model"`
		Messages []Message `json:"messages"`
		Stream   bool      `json:"stream"`
	}{Model: input.Model, Messages: input.Messages, Stream: true})
	if err != nil {
		return err
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint("chat/completions"), bytes.NewReader(payload))
	if err != nil {
		return err
	}
	c.setHeaders(request)

	response, err := c.httpClient.Do(request)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return context.Canceled
		}
		return connectionError(err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return decodeAPIError(response)
	}

	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, ":") {
			continue
		}
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			return nil
		}

		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error,omitempty"`
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return errors.New("스트리밍 응답 형식이 올바르지 않습니다")
		}
		if chunk.Error != nil {
			return &APIError{StatusCode: response.StatusCode, Message: chunk.Error.Message}
		}
		for _, choice := range chunk.Choices {
			if choice.Delta.Content != "" {
				onDelta(choice.Delta.Content)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return context.Canceled
		}
		return errors.New("스트리밍 연결이 중단되었습니다")
	}
	return nil
}

func (c *Client) endpoint(resource string) string {
	copyURL := *c.baseURL
	basePath := strings.TrimRight(copyURL.Path, "/")
	if !strings.HasSuffix(basePath, "/v1") {
		basePath += "/v1"
	}
	copyURL.Path = basePath + "/" + strings.TrimLeft(resource, "/")
	return copyURL.String()
}

func (c *Client) setHeaders(request *http.Request) {
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		request.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
}

func decodeAPIError(response *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(response.Body, maxErrorBodySize))
	var payload struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	message := ""
	if json.Unmarshal(body, &payload) == nil {
		message = strings.TrimSpace(payload.Error.Message)
	}
	if message == "" {
		message = strings.TrimSpace(string(body))
	}
	return &APIError{StatusCode: response.StatusCode, Message: message}
}

func connectionError(err error) error {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return errors.New("AI 서버에 연결할 수 없습니다")
	}
	return err
}
