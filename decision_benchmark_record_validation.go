package main

import (
	"encoding/json"
	"errors"
	"fmt"
)

func validateDecisionRecord(b DecisionBenchmark) error {
	if b.TimeoutSeconds != 60 && b.TimeoutSeconds != 180 {
		return errors.New("기록의 요청 제한이 올바르지 않습니다")
	}
	statuses := map[string]bool{"running": true, "completed": true, "partial": true, "failed": true, "cancelled": true, "interrupted": true}
	if !statuses[b.Status] {
		return errors.New("알 수 없는 기록 상태")
	}
	if len(b.Targets) == 0 || len(b.Targets) > 12 {
		return errors.New("기록의 대상 수가 올바르지 않습니다")
	}
	targets := map[string]bool{}
	for _, t := range b.Targets {
		if e := validateDecisionTarget(t); e != nil {
			return e
		}
		if targets[t.ID] {
			return errors.New("기록의 대상 ID가 중복됩니다")
		}
		targets[t.ID] = true
	}
	selected := map[string]bool{}
	for _, typ := range b.Types {
		if (typ != "choice" && typ != "noul" && typ != "score") || selected[typ] {
			return errors.New("기록의 평가 유형이 올바르지 않습니다")
		}
		selected[typ] = true
	}
	if len(selected) == 0 {
		return errors.New("평가 유형이 없습니다")
	}
	cases := map[string]DecisionCase{}
	expected := map[string]bool{}
	for _, c := range b.Suite.Cases {
		cases[c.ID] = c
		task, _ := decisionTask(b.Suite, c.TaskID)
		if selected[task.Type] {
			for _, t := range b.Targets {
				expected[t.ID+"\x00"+c.ID] = true
			}
		}
	}
	if len(expected) == 0 || len(expected) > 12000 || len(b.Results) != len(expected) {
		return errors.New("기록의 결과 문항 수가 스냅샷과 다릅니다")
	}
	seen := map[string]bool{}
	resultStatuses := map[string]bool{"pending": true, "skipped": true, "completed": true, "error": true, "cancelled": true}
	for _, r := range b.Results {
		key := r.TargetID + "\x00" + r.CaseID
		c := cases[r.CaseID]
		if !expected[key] || seen[key] || r.TaskID != c.TaskID || r.Expected != c.Expected || !resultStatuses[r.Status] || r.DurationMs < 0 {
			return errors.New("결과의 대상·문항·정답·상태가 스냅샷과 다릅니다")
		}
		seen[key] = true
		if b.Status != "running" && r.Status == "pending" {
			return errors.New("종료 기록에 대기 문항이 남아 있습니다")
		}
		if r.Status == "completed" {
			task, _ := decisionTask(b.Suite, c.TaskID)
			graded, e := scoreDecisionResponse(r.Raw, task, c)
			if e != nil {
				return fmt.Errorf("완료 응답 검증 실패: %w", e)
			}
			truncated := r.Truncated
			if truncated == nil {
				truncated = graded.Truncated
			}
			a, _ := json.Marshal(struct {
				P         string
				L         bool
				V         bool
				C         bool
				Probs     map[string]float64
				Mean      float64
				Truncated *bool
			}{r.Predicted, r.LabelValid, r.ProbabilityValid, r.Correct, r.Probabilities, r.ExpectedScore, truncated})
			z, _ := json.Marshal(struct {
				P         string
				L         bool
				V         bool
				C         bool
				Probs     map[string]float64
				Mean      float64
				Truncated *bool
			}{graded.Predicted, graded.LabelValid, graded.ProbabilityValid, graded.Correct, graded.Probabilities, graded.ExpectedScore, graded.Truncated})
			if string(a) != string(z) {
				return errors.New("채점 결과가 원본 응답과 다릅니다")
			}
		}
	}
	if len(b.Warmups) > len(b.Targets)*len(b.Suite.Tasks) {
		return errors.New("준비 요청 수가 올바르지 않습니다")
	}
	for _, r := range b.Warmups {
		c, ok := cases[r.CaseID]
		if !ok || !targets[r.TargetID] || c.TaskID != r.TaskID {
			return errors.New("준비 요청이 스냅샷과 다릅니다")
		}
	}
	return nil
}
