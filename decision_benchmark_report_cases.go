package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

//go:embed decision_report_interaction.js
var decisionReportInteraction string

var decisionDomainCodePattern = regexp.MustCompile(`\bD(?:0[1-9]|1[0-9]|20)\b`)

func decisionHTMLRationale(task DecisionTask, text string) string {
	if task.ID != "business-domain-choice" && task.ID != "business-domain-ranking" {
		return text
	}
	return decisionDomainCodePattern.ReplaceAllStringFunc(text, func(key string) string { return decisionHTMLAnswer(task, key) })
}
func decisionIdentification(task DecisionTask, r DecisionCaseResult) (string, int, []string) {
	if !decisionHTMLScorable(r) {
		return "unavailable", 0, nil
	}
	if task.Type != "ranking" {
		if r.Correct {
			return "full", 1, nil
		}
		return "miss", 0, nil
	}
	selected := map[string]bool{}
	for _, key := range strings.Split(r.Predicted, "|") {
		selected[key] = true
	}
	hits := 0
	low := []string{}
	expected := strings.Split(r.Expected, "|")
	for _, key := range expected {
		if selected[key] {
			hits++
		}
		if p, ok := r.Probabilities[key]; ok && r.ProbabilityValid && len(task.Options) > 0 && p < 1/float64(len(task.Options)) {
			low = append(low, key)
		}
	}
	category := "miss"
	if hits == len(expected) {
		category = "full"
	} else if hits > 0 {
		category = "partial"
	}
	return category, hits, low
}
func decisionCaseStatus(task DecisionTask, r DecisionCaseResult) string {
	if r.Truncated != nil && *r.Truncated {
		return "입력 잘림 · 집계 제외"
	}
	if r.Status != "completed" {
		return decisionHTMLStatus(r.Status)
	}
	if !decisionHTMLScorable(r) {
		return "채점 불가"
	}
	category, _, _ := decisionIdentification(task, r)
	if task.Type == "ranking" {
		return map[string]string{"full": "전체 식별", "partial": "일부 식별", "miss": "식별 실패"}[category]
	}
	if r.Correct {
		return "정답"
	}
	return "오답"
}
func decisionHTMLCases(b DecisionBenchmark) string {
	var out strings.Builder
	out.WriteString("<section class='case-browser'><h3>문항별 정답과 모델 판단</h3><p class='muted'>모델과 유형으로 좁힌 뒤 문항을 선택하세요. 오른쪽에서 정답과 판단을 비교할 수 있습니다.</p><div class='case-filters'><label>모델<select data-filter='model'><option value='all'>모든 모델</option>")
	for _, target := range b.Targets {
		fmt.Fprintf(&out, "<option value='%s'>%s</option>", decisionHTMLText(target.ID), decisionHTMLText(target.Model))
	}
	out.WriteString("</select></label><label>판단 유형<select data-filter='task'><option value='all'>모든 유형</option>")
	for _, task := range b.Suite.Tasks {
		for _, typ := range b.Types {
			if task.Type == typ {
				fmt.Fprintf(&out, "<option value='%s'>%s</option>", decisionHTMLText(task.ID), decisionHTMLText(decisionHTMLType(task.Type)))
			}
		}
	}
	out.WriteString("</select></label><label>결과<select data-filter='result'><option value='all'>전체</option><option value='full'>정답·전체 식별</option><option value='partial'>일부 식별</option><option value='miss'>오답·식별 실패</option><option value='attention'>확률 배분 주의</option><option value='unavailable'>오류·집계 제외</option></select></label><label>질문 검색<input type='search' data-filter='search' placeholder='질문 내용 또는 문항 ID'></label></div><div class='case-workspace'><div class='case-list' aria-label='문항 목록'>")
	cases := map[string]DecisionCase{}
	for _, c := range b.Suite.Cases {
		cases[c.ID] = c
	}
	for i, r := range b.Results {
		c := cases[r.CaseID]
		task, _ := decisionTask(b.Suite, r.TaskID)
		category, _, low := decisionIdentification(task, r)
		model := ""
		for _, t := range b.Targets {
			if t.ID == r.TargetID {
				model = t.Model
			}
		}
		question := c.Text
		for _, line := range strings.Split(c.Text, "\n") {
			if strings.HasPrefix(line, "요청:") {
				question = strings.TrimSpace(strings.TrimPrefix(line, "요청:"))
				break
			}
		}
		fmt.Fprintf(&out, "<button type='button' class='case-choice' data-case='%d' data-model='%s' data-task='%s' data-result='%s' data-attention='%t' aria-pressed='false'><small>%s · %s</small><span>%s</span><b>%s</b>%s</button>", i, decisionHTMLText(r.TargetID), decisionHTMLText(r.TaskID), category, len(low) > 0, decisionHTMLText(c.ID), decisionHTMLText(model), decisionHTMLText(question), decisionHTMLText(decisionCaseStatus(task, r)), map[bool]string{true: "<small class='attention-label'>확률 배분 주의</small>", false: ""}[len(low) > 0])
	}
	out.WriteString("<p class='case-empty' hidden>해당하는 문항이 없습니다.</p></div><div class='case-panels' aria-live='polite'><p class='case-placeholder'>문항을 선택하세요.</p>")
	for i, r := range b.Results {
		c := cases[r.CaseID]
		task, _ := decisionTask(b.Suite, r.TaskID)
		model := ""
		for _, t := range b.Targets {
			if t.ID == r.TargetID {
				model = t.Model
			}
		}
		fmt.Fprintf(&out, "<article class='case-panel' data-panel='%d' hidden><h3>%s</h3><p class='muted'>%s · %s</p><span class='badge'>%s</span><pre>%s</pre><div class='answer-pair'><div><small>정답 업무</small><strong>%s</strong></div><div><small>%s</small><strong>%s</strong></div></div><h4>평가 세트의 정답과 설명</h4><p class='muted'>평가 세트에 작성된 설명이며 모델의 설명이 아닙니다. 정답과 정답 설명은 모델 요청에 포함되지 않습니다.</p><p>%s</p>", i, decisionHTMLText(c.ID), decisionHTMLText(model), decisionHTMLText(decisionHTMLType(task.Type)), decisionHTMLText(decisionCaseStatus(task, r)), decisionHTMLText(c.Text), decisionHTMLText(decisionHTMLAnswer(task, r.Expected)), map[bool]string{true: "앱이 평가에 사용한 상위 후보", false: "모델이 선택한 업무"}[task.Type == "ranking"], decisionHTMLText(decisionHTMLAnswer(task, r.Predicted)), decisionHTMLText(decisionHTMLRationale(task, c.Rationale)))
		out.WriteString("<ul>")
		for _, key := range strings.Split(r.Expected, "|") {
			for _, option := range task.Options {
				if option.Key == key {
					fmt.Fprintf(&out, "<li><strong>%s</strong>: %s</li>", decisionHTMLText(decisionHTMLAnswer(task, key)), decisionHTMLText(option.Descriptions["ko"]))
				}
			}
		}
		out.WriteString("</ul>")
		if r.Error != "" {
			out.WriteString("<p class='alert'>" + decisionHTMLText(r.Error) + "</p>")
		}
		if task.Type == "ranking" {
			out.WriteString(decisionHTMLRankingTable(task, r))
		}
		instructions := c.Instructions["ko"]
		if instructions == "" {
			instructions = task.Instructions["ko"]
		}
		fmt.Fprintf(&out, "<details><summary>모델에 전달한 질문과 후보 설명</summary><p class='muted'>모델 요청에 담긴 내용입니다. 위의 정답 설명과는 별개입니다.</p><h4>판단 질문</h4><pre>%s</pre><pre>%s</pre><table><thead><tr><th>업무영역</th><th>모델에 전달한 후보 설명</th></tr></thead><tbody>", decisionHTMLText(instructions), decisionHTMLText(task.Context["ko"]))
		for _, option := range task.Options {
			fmt.Fprintf(&out, "<tr><td>%s</td><td>%s</td></tr>", decisionHTMLText(decisionHTMLAnswer(task, option.Key)), decisionHTMLText(option.Descriptions["ko"]))
		}
		out.WriteString("</tbody></table></details>")
		raw, _ := json.MarshalIndent(r.Raw, "", "  ")
		out.WriteString("<details><summary>원본 응답</summary><pre>" + decisionHTMLText(string(raw)) + "</pre></details></article>")
	}
	out.WriteString("</div></div><noscript><p>문항 선택 기능을 사용하려면 브라우저의 JavaScript를 허용하세요. 아래에서 모든 문항의 상세 내용을 확인할 수도 있습니다.</p><style>.case-panel[hidden]{display:block!important}.case-list,.case-filters,.case-placeholder{display:none!important}.case-panels{max-height:none!important}</style></noscript></section>")
	return out.String()
}

func decisionCandidateAssessment(task DecisionTask, r DecisionCaseResult, key string) (string, string) {
	selection := "채점 불가"
	if decisionHTMLScorable(r) {
		selection = "상위 후보 미포함"
		for _, selected := range strings.Split(r.Predicted, "|") {
			if selected == key {
				selection = "상위 후보 포함"
				break
			}
		}
	}
	allocation := "확인 불가"
	if p, ok := r.Probabilities[key]; ok && r.ProbabilityValid && len(task.Options) > 0 {
		allocation = "기준 충족"
		if p < 1/float64(len(task.Options)) {
			allocation = "기준 미달"
		}
	}
	return selection, allocation
}

type decisionDonutSegment struct {
	label, color string
	count        int
}

func decisionRankingSegments(task DecisionTask, results []DecisionCaseResult, targetID string) []decisionDonutSegment {
	threshold := "배분 기준"
	if len(task.Options) > 0 {
		threshold = strings.TrimSuffix(fmt.Sprintf("%.1f", 100/float64(len(task.Options))), ".0") + "%"
	}
	segments := []decisionDonutSegment{{"전체 식별 · 모든 정답 업무 " + threshold + " 이상", "#24704E", 0}, {"전체 식별 · 일부 정답 업무 " + threshold + " 미만", "#7FB99B", 0}, {"일부 누락 · 누락 업무 " + threshold + " 이상", "#C76D18", 0}, {"일부 누락 · 누락 업무 " + threshold + " 미만", "#F0B45B", 0}, {"모든 업무 누락", "#C9504C", 0}, {"확률 확인 불가", "#7B8794", 0}}
	for _, r := range results {
		if r.TaskID != task.ID || r.TargetID != targetID || !decisionHTMLScorable(r) {
			continue
		}
		category, _, _ := decisionIdentification(task, r)
		index := 4
		if category == "full" || category == "partial" {
			index = 0
			if category == "partial" {
				index = 2
			}
			selected := map[string]bool{}
			for _, key := range strings.Split(r.Predicted, "|") {
				selected[key] = true
			}
			unknown, low := false, false
			for _, key := range strings.Split(r.Expected, "|") {
				if category == "partial" && selected[key] {
					continue
				}
				_, allocation := decisionCandidateAssessment(task, r, key)
				if allocation == "확인 불가" {
					unknown = true
				}
				if allocation == "기준 미달" {
					low = true
				}
			}
			if unknown {
				index = 5
			} else if low {
				index++
			}
		}
		segments[index].count++
	}
	if segments[5].count == 0 {
		segments = segments[:5]
	}
	return segments
}
