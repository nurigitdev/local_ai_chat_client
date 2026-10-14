package main

import (
	"errors"
	"strings"
)

type DecisionComparison struct {
	Records         []DecisionBenchmark `json:"records"`
	CommonCaseCount int                 `json:"commonCaseCount"`
	Warning         string              `json:"warning"`
}

func commonDecisionComparison(records []DecisionBenchmark) (DecisionComparison, error) {
	out := DecisionComparison{Records: []DecisionBenchmark{}}
	if len(records) < 2 || len(records) > 3 {
		return out, errors.New("비교는 2~3개 기록을 선택해 주세요")
	}
	common := map[string]bool{}
	for _, c := range records[0].Suite.Cases {
		common[c.ID] = true
	}
	for _, b := range records {
		if b.Fingerprint != records[0].Fingerprint || b.ScoringVersion != records[0].ScoringVersion {
			return out, errors.New("세트·과제·채점 버전이 달라 비교할 수 없습니다")
		}
		if b.Status == "running" {
			return out, errors.New("완료된 기록을 비교해 주세요")
		}
		for id := range common {
			for _, target := range b.Targets {
				valid := false
				for _, r := range b.Results {
					if r.CaseID == id && r.TargetID == target.ID && r.Status == "completed" && r.LabelValid && (r.Truncated == nil || !*r.Truncated) {
						valid = true
						break
					}
				}
				if !valid {
					delete(common, id)
					break
				}
			}
		}
	}
	out.CommonCaseCount = len(common)
	for _, b := range records {
		results := []DecisionCaseResult{}
		for _, r := range b.Results {
			if common[r.CaseID] {
				results = append(results, r)
			}
		}
		b.Results = results
		b.Summaries = summarizeDecision(b)
		out.Records = append(out.Records, b)
	}
	warnings := []string{"확률 지표의 표본 수는 유효한 확률 응답에 따라 다를 수 있습니다", "다른 환경 또는 미확인 환경의 왕복 시간은 참고값입니다"}
	if len(common) == 0 {
		warnings = append(warnings, "공통 채점 가능 문항이 없어 성능 비교는 평가 불가입니다")
	}
	out.Warning = strings.Join(warnings, ". ")
	return out, nil
}
func (a *App) CompareDecisionBenchmarks(ids []string) (DecisionComparison, error) {
	records := []DecisionBenchmark{}
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			return DecisionComparison{}, errors.New("같은 기록을 중복 선택할 수 없습니다")
		}
		seen[id] = true
		b, e := a.decisions.open(id)
		if e != nil {
			return DecisionComparison{}, e
		}
		records = append(records, b)
	}
	return commonDecisionComparison(records)
}
