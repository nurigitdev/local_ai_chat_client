package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
)

type DecisionClassMetric struct {
	Key       string   `json:"key"`
	Support   int      `json:"support"`
	Precision *float64 `json:"precision"`
	Recall    *float64 `json:"recall"`
	F1        *float64 `json:"f1"`
}
type DecisionBenchmarkSummary struct {
	TargetID          string                `json:"targetID"`
	TaskID            string                `json:"taskID"`
	Type              string                `json:"type"`
	Planned           int                   `json:"planned"`
	Skipped           int                   `json:"skipped"`
	Pending           int                   `json:"pending"`
	WarmupFailed      bool                  `json:"warmupFailed"`
	WarmupError       string                `json:"warmupError"`
	Attempted         int                   `json:"attempted"`
	Completed         int                   `json:"completed"`
	Scorable          int                   `json:"scorable"`
	ProbabilityCount  int                   `json:"probabilityCount"`
	Correct           int                   `json:"correct"`
	Errors            int                   `json:"errors"`
	Truncated         int                   `json:"truncated"`
	Accuracy          *float64              `json:"accuracy"`
	AttemptAccuracy   *float64              `json:"attemptAccuracy"`
	SuccessRate       *float64              `json:"successRate"`
	MacroF1           *float64              `json:"macroF1"`
	TopMAE            *float64              `json:"topMAE"`
	ExpectedMAE       *float64              `json:"expectedMAE"`
	Brier             *float64              `json:"brier"`
	ECE               *float64              `json:"ece"`
	FalsePositiveRate *float64              `json:"falsePositiveRate"`
	FalseNegativeRate *float64              `json:"falseNegativeRate"`
	Confusion         [][]int               `json:"confusion"`
	Classes           []DecisionClassMetric `json:"classes"`
	LatencyCount      int                   `json:"latencyCount"`
	MeanMs            *float64              `json:"meanMs"`
	P50Ms             *float64              `json:"p50Ms"`
	P95Ms             *float64              `json:"p95Ms"`
	MinMs             *float64              `json:"minMs"`
	MaxMs             *float64              `json:"maxMs"`
}

func decisionRatio(a, b float64) *float64 {
	if b == 0 {
		return nil
	}
	v := a / b
	return &v
}
func validDecisionNumber(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0) && v >= 0 && v <= 1
}
func normalizeDecisionProbabilities(p map[string]float64, task DecisionTask) (map[string]float64, error) {
	if len(p) != len(task.Options) {
		return nil, errors.New("확률 키가 선택지와 일치하지 않습니다")
	}
	sum := 0.0
	for _, o := range task.Options {
		v, ok := p[o.Key]
		if !ok || !validDecisionNumber(v) {
			return nil, errors.New("누락 또는 범위 밖 확률입니다")
		}
		sum += v
	}
	if sum == 0 || math.Abs(sum-1) > 0.0100000001 {
		return nil, errors.New("확률 합이 허용 범위를 벗어났습니다")
	}
	out := map[string]float64{}
	for k, v := range p {
		out[k] = v / sum
	}
	return out, nil
}
func scoreDecisionResponse(raw []byte, task DecisionTask, c DecisionCase) (DecisionCaseResult, error) {
	r := DecisionCaseResult{CaseID: c.ID, TaskID: task.ID, Expected: c.Expected, Raw: append(json.RawMessage(nil), raw...)}
	var payload struct {
		Model   string `json:"model"`
		Routing struct {
			Model string `json:"model"`
		} `json:"routing"`
		Truncated *bool `json:"truncated"`
		Usage     struct {
			Truncated          *bool    `json:"truncated"`
			StateTokensDropped int      `json:"state_tokens_dropped"`
			TruncatedQuestions []string `json:"truncated_questions"`
		} `json:"usage"`
		Answers map[string]json.RawMessage `json:"answers"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return r, errors.New("서버 응답이 올바른 JSON이 아닙니다")
	}
	r.ReturnedModel = payload.Model
	r.RoutingModel = payload.Routing.Model
	r.Truncated = payload.Truncated
	if payload.Usage.Truncated != nil && (r.Truncated == nil || *payload.Usage.Truncated) {
		r.Truncated = payload.Usage.Truncated
	}
	if payload.Usage.StateTokensDropped > 0 {
		value := true
		r.Truncated = &value
	}
	for _, question := range payload.Usage.TruncatedQuestions {
		if question == "decision" {
			value := true
			r.Truncated = &value
		}
	}
	value, ok := payload.Answers["decision"]
	if !ok {
		return r, errors.New("answers.decision이 없습니다")
	}
	var answer struct {
		Type          string             `json:"type"`
		Choice        string             `json:"choice"`
		Noul          *float64           `json:"noul"`
		Probabilities map[string]float64 `json:"probabilities"`
		Truncated     *bool              `json:"truncated"`
	}
	if err := json.Unmarshal(value, &answer); err != nil {
		return r, errors.New("판단 응답 형식이 올바르지 않습니다")
	}
	if answer.Type != "" && answer.Type != task.Type {
		return r, errors.New("응답 유형이 요청과 다릅니다")
	}
	if answer.Truncated != nil && (r.Truncated == nil || *answer.Truncated) {
		r.Truncated = answer.Truncated
	}
	switch task.Type {
	case "choice":
		found := false
		for _, o := range task.Options {
			if o.Key == answer.Choice {
				found = true
			}
		}
		if !found {
			return r, errors.New("서버가 미등록 선택지를 반환했습니다")
		}
		r.Predicted = answer.Choice
		r.LabelValid = true
	case "noul":
		if answer.Noul == nil || !validDecisionNumber(*answer.Noul) {
			return r, errors.New("유효한 P(true)가 없습니다")
		}
		p := *answer.Noul
		r.Probabilities = map[string]float64{"false": 1 - p, "true": p}
		r.ProbabilityValid = true
		r.LabelValid = true
		r.Predicted = "false"
		if p >= 0.5 {
			r.Predicted = "true"
		}
	case "score":
	default:
		return r, fmt.Errorf("지원하지 않는 유형: %s", task.Type)
	}
	if task.Type != "noul" {
		p, err := normalizeDecisionProbabilities(answer.Probabilities, task)
		if err != nil {
			r.ProbabilityError = err.Error()
		} else {
			r.ProbabilityValid = true
			r.Probabilities = p
			if task.Type == "score" {
				max := -1.0
				for _, o := range task.Options {
					v := p[o.Key]
					k, _ := strconv.Atoi(o.Key)
					r.ExpectedScore += float64(k) * v
					if v > max {
						max = v
						r.Predicted = o.Key
					}
				}
				r.LabelValid = true
			}
		}
	}
	r.Correct = r.LabelValid && r.Expected == r.Predicted
	return r, nil
}
func summarizeDecision(b DecisionBenchmark) []DecisionBenchmarkSummary {
	out := []DecisionBenchmarkSummary{}
	for _, target := range b.Targets {
		for _, task := range b.Suite.Tasks {
			selected := false
			for _, typ := range b.Types {
				if typ == task.Type {
					selected = true
				}
			}
			if !selected {
				continue
			}
			s := DecisionBenchmarkSummary{TargetID: target.ID, TaskID: task.ID, Type: task.Type, Classes: []DecisionClassMetric{}, Confusion: make([][]int, len(task.Options))}
			for _, r := range b.Warmups {
				if r.TargetID == target.ID && r.TaskID == task.ID && (r.Status != "completed" || !r.LabelValid) {
					s.WarmupFailed = true
					s.WarmupError = r.Error
					if s.WarmupError == "" {
						s.WarmupError = "준비 응답을 채점할 수 없습니다"
					}
				}
			}
			keys := map[string]int{}
			for i, o := range task.Options {
				keys[o.Key] = i
				s.Confusion[i] = make([]int, len(task.Options))
			}
			durations := []float64{}
			var brier, topMAE, expectedMAE float64
			binN := [10]int{}
			binConf := [10]float64{}
			binCorrect := [10]float64{}
			for _, r := range b.Results {
				if r.TargetID != target.ID || r.TaskID != task.ID {
					continue
				}
				s.Planned++
				if r.Status == "skipped" {
					s.Skipped++
					continue
				}
				if r.Status == "pending" {
					s.Pending++
					continue
				}
				s.Attempted++
				if r.Status == "completed" {
					s.Completed++
					durations = append(durations, float64(r.DurationMs))
				} else {
					s.Errors++
				}
				if r.Truncated != nil && *r.Truncated {
					s.Truncated++
					continue
				}
				if r.Status != "completed" {
					continue
				}
				if r.LabelValid {
					s.Scorable++
					if r.Correct {
						s.Correct++
					}
					s.Confusion[keys[r.Expected]][keys[r.Predicted]]++
					if task.Type == "score" {
						a, _ := strconv.Atoi(r.Expected)
						p, _ := strconv.Atoi(r.Predicted)
						topMAE += math.Abs(float64(a - p))
					}
				}
				if r.ProbabilityValid {
					s.ProbabilityCount++
					max := -1.0
					pred := ""
					for _, o := range task.Options {
						p := r.Probabilities[o.Key]
						y := 0.0
						if o.Key == r.Expected {
							y = 1
						}
						brier += (p - y) * (p - y)
						if p > max || (task.Type == "noul" && p == max && o.Key == "true") {
							max = p
							pred = o.Key
						}
					}
					bin := int(max * 10)
					if bin > 9 {
						bin = 9
					}
					binN[bin]++
					binConf[bin] += max
					if pred == r.Expected {
						binCorrect[bin]++
					}
					if task.Type == "score" {
						a, _ := strconv.Atoi(r.Expected)
						expectedMAE += math.Abs(r.ExpectedScore - float64(a))
					}
				}
			}
			s.Accuracy = decisionRatio(float64(s.Correct), float64(s.Scorable))
			s.AttemptAccuracy = decisionRatio(float64(s.Correct), float64(s.Attempted))
			s.SuccessRate = decisionRatio(float64(s.Completed), float64(s.Attempted))
			s.Brier = decisionRatio(brier, float64(s.ProbabilityCount))
			ece := 0.0
			for i, n := range binN {
				if n > 0 {
					ece += math.Abs(binConf[i] - binCorrect[i])
				}
			}
			s.ECE = decisionRatio(ece, float64(s.ProbabilityCount))
			macro := 0.0
			for i, o := range task.Options {
				tp := s.Confusion[i][i]
				support, predicted := 0, 0
				for j := range task.Options {
					support += s.Confusion[i][j]
					predicted += s.Confusion[j][i]
				}
				f := decisionRatio(float64(2*tp), float64(support+predicted))
				if f != nil {
					macro += *f
				}
				s.Classes = append(s.Classes, DecisionClassMetric{o.Key, support, decisionRatio(float64(tp), float64(predicted)), decisionRatio(float64(tp), float64(support)), f})
			}
			s.MacroF1 = decisionRatio(macro, float64(len(task.Options)))
			if s.Scorable == 0 {
				s.MacroF1 = nil
			}
			if task.Type == "noul" {
				f, t := keys["false"], keys["true"]
				s.FalsePositiveRate = decisionRatio(float64(s.Confusion[f][t]), float64(s.Confusion[f][f]+s.Confusion[f][t]))
				s.FalseNegativeRate = decisionRatio(float64(s.Confusion[t][f]), float64(s.Confusion[t][f]+s.Confusion[t][t]))
			}
			if task.Type == "score" {
				s.TopMAE = decisionRatio(topMAE, float64(s.Scorable))
				s.ExpectedMAE = decisionRatio(expectedMAE, float64(s.ProbabilityCount))
			}
			s.LatencyCount = len(durations)
			if len(durations) > 0 {
				sort.Float64s(durations)
				total := 0.0
				for _, d := range durations {
					total += d
				}
				s.MeanMs = decisionRatio(total, float64(len(durations)))
				s.MinMs = &durations[0]
				s.MaxMs = &durations[len(durations)-1]
				s.P50Ms = &durations[int(math.Ceil(float64(len(durations))*0.5))-1]
				s.P95Ms = &durations[int(math.Ceil(float64(len(durations))*0.95))-1]
			}
			out = append(out, s)
		}
	}
	return out
}
