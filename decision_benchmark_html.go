package main

import (
	"encoding/json"
	"fmt"
	"html"
	"strings"
)

func decisionHTMLText(s string) string { return html.EscapeString(neutralDecisionText(s)) }
func decisionHTMLStatus(s string) string {
	if label, ok := map[string]string{"completed": "완료", "running": "실행 중", "partial": "일부 실패", "error": "오류", "failed": "실패", "cancelled": "취소", "interrupted": "중단", "skipped": "미실행", "pending": "대기"}[s]; ok {
		return label
	}
	return s
}
func decisionHTMLType(s string) string {
	return map[string]string{"choice": "업무영역 분류", "noul": "업무영역 해당 여부", "score": "업무 적합도 평가"}[s]
}
func decisionHTMLAnswer(task DecisionTask, key string) string {
	if key == "" {
		return "판단 없음"
	}
	if task.Type == "noul" {
		if key == "true" {
			return "해당함"
		}
		if key == "false" {
			return "해당하지 않음"
		}
	}
	if task.ID == "business-domain-fit" {
		if v, ok := map[string]string{"0": "부적합", "1": "불명확", "2": "적합"}[key]; ok {
			return v
		}
	}
	if task.ID == "business-domain-choice" {
		names := []string{"HW 개발", "펌웨어 개발", "응용 소프트웨어 개발", "회계", "자금 관리", "제조", "인사", "급여", "개발 품질", "양산 품질", "제품 출하", "프로젝트 수행", "총무", "영업", "부품 구매", "부품 창고·수불", "홍보·IR", "감사", "프로젝트 기획", "지식 관리"}
		for i, name := range names {
			if key == fmt.Sprintf("D%02d", i+1) {
				return name
			}
		}
	}
	for _, option := range task.Options {
		if option.Key == key {
			return option.Descriptions["ko"]
		}
	}
	return key
}
func decisionHTMLMetric(v *float64, percent bool) string {
	if v == nil {
		return "—"
	}
	if percent {
		return fmt.Sprintf("%.1f%%", *v*100)
	}
	return fmt.Sprintf("%.3f", *v)
}

// Standalone reports require no network, scripts, or application runtime.
func decisionHTMLReport(records []DecisionBenchmark, title, note string) string {
	var out strings.Builder
	out.WriteString(`<!doctype html><html lang='ko'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><title>Decision Benchmark 보고서</title><style>
 :root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f5f6f2;color:#303c32;font:14px/1.7 "Malgun Gothic",system-ui,sans-serif}main{max-width:1200px;margin:40px auto;padding:0 24px}h1{font-size:28px;line-height:1.4;margin:8px 0}h2{font-size:21px;margin:0 0 8px}h3{font-size:16px;margin:0 0 6px}h4{margin:16px 0 8px}.eyebrow{font-size:12px;letter-spacing:2px;color:#4f7660}.muted{color:#74816f;font-size:12px}.report-header{margin-bottom:28px}.record{background:white;border:1px solid #dce2d6;border-radius:14px;padding:28px;margin:24px 0}.record-head{border-bottom:1px solid #e1e6db;padding-bottom:16px;margin-bottom:20px}.task{border:1px solid #dce2d6;border-radius:10px;overflow:hidden;margin:18px 0}.task header{padding:15px 20px;background:#f4f7f0}.task header p{margin:0;color:#74816f;font-size:12px}.models{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}.model{padding:20px;text-align:center;border-right:1px solid #e5e9df}.model:last-child{border:0}.model-name{overflow-wrap:anywhere;font-weight:600;font-size:13px}.donut{width:170px;height:170px;margin:18px auto 10px;position:relative}.donut svg{width:100%;height:100%}.donut .center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}.donut strong{font-size:28px;color:#355840;line-height:1.4}.donut small{color:#74816f}.legend{display:flex;justify-content:center;gap:18px;font-size:12px;margin-top:10px}.legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px}.conclusion{background:#fafcf7;border-top:1px solid #e2e7dc;padding:12px 20px;margin:0;color:#46623b}.pattern{background:#fffaed;color:#8b6831;padding:10px;border-radius:6px;font-size:12px;text-align:left}.alert{padding:12px 16px;border:1px solid #e6bdb2;background:#fff3ef;color:#91452e;border-radius:8px;margin:14px 0}.scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:12px;margin:12px 0}th,td{padding:10px 12px;border-bottom:1px solid #e2e7dc;text-align:left;vertical-align:top}th{background:#f4f7f0;color:#5d7351}td.question{min-width:230px;max-width:450px}td.answer{min-width:110px}details{border-top:1px solid #e2e7dc;padding:12px 0}summary{cursor:pointer;color:#4c6841;font-weight:600}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5ef;padding:14px;border-radius:6px;max-height:400px;overflow:auto;font-size:12px}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}.metric{padding:14px;background:#f4f7f0;border-radius:7px}.metric b{display:block;font-size:22px;color:#355840}.metric p{font-size:12px;color:#74816f;margin:4px 0}.badge{display:inline-block;padding:3px 8px;background:#edf3e5;color:#577143;border-radius:5px;font-size:12px}.footer{font-size:12px;color:#74816f;margin:24px 0}.case-body p{margin:8px 0}@media(max-width:650px){main{margin:20px auto;padding:0 12px}.record{padding:16px}h1{font-size:23px}.model{border-right:0;border-bottom:1px solid #e5e9df}}@media print{body{background:white}main{margin:0;max-width:none;padding:0}.record{break-inside:auto}.task,.model{break-inside:avoid}details{break-inside:auto}}
 </style></head><body><main><header class='report-header'><span class='eyebrow'>MODEL LAB / DECISION</span><h1>`)
	out.WriteString(decisionHTMLText(title))
	out.WriteString("</h1><p>" + decisionHTMLText(note) + "</p></header>")
	for _, b := range records {
		sums := summarizeDecision(b)
		name := b.ExperimentName
		if name == "" {
			name = b.Suite.Name
		}
		fmt.Fprintf(&out, "<section class='record'><header class='record-head'><h2>%s</h2><span class='badge'>%s</span><p class='muted'>%s · 한국어 · %s</p></header>", decisionHTMLText(name), decisionHTMLText(decisionHTMLStatus(b.Status)), decisionHTMLText(b.CreatedAt), decisionHTMLText(b.Suite.Revision))
		if b.Error != "" {
			out.WriteString("<p class='alert'>" + decisionHTMLText(b.Error) + "</p>")
		}
		for _, task := range b.Suite.Tasks {
			var selected bool
			for _, typ := range b.Types {
				if typ == task.Type {
					selected = true
				}
			}
			if !selected {
				continue
			}
			purpose := map[string]string{"choice": "요청을 담당할 업무영역을 골랐는지", "noul": "후보 업무영역에 해당하는 요청인지 구분했는지", "score": "부적합·불명확·적합을 기준에 맞게 판단했는지"}[task.Type]
			fmt.Fprintf(&out, "<section class='task'><header><h3>%s</h3><p>%s</p></header><div class='models'>", decisionHTMLText(decisionHTMLType(task.Type)), decisionHTMLText(purpose))
			for _, target := range b.Targets {
				var sum DecisionBenchmarkSummary
				for _, s := range sums {
					if s.TargetID == target.ID && s.TaskID == task.ID {
						sum = s
					}
				}
				rate := 0.0
				display := "평가 불가"
				if sum.Scorable > 0 {
					rate = 100 * float64(sum.Correct) / float64(sum.Scorable)
					display = fmt.Sprintf("%.1f%%", rate)
				}
				remainder := "#dec3ad"
				if sum.Scorable == 0 {
					remainder = "#e6e9e1"
				}
				fmt.Fprintf(&out, `<article class='model'><div class='model-name'>%s</div><div class='donut'><svg viewBox='0 0 160 160' aria-hidden='true'><circle cx='80' cy='80' r='65' fill='none' stroke='%s' stroke-width='14'/><circle cx='80' cy='80' r='65' fill='none' stroke='#4f8063' stroke-width='14' pathLength='100' stroke-dasharray='%.4f %.4f' transform='rotate(-90 80 80)'/></svg><div class='center'><strong>%s</strong><small>정답률</small></div></div><b>%d문항 중 %d문항 정답</b>`, decisionHTMLText(target.Model), remainder, rate, 100-rate, display, sum.Scorable, sum.Correct)
				if sum.Scorable > 0 {
					fmt.Fprintf(&out, `<div class='legend'><span><i style='background:#4f8063'></i>정답 %d</span><span><i style='background:#dec3ad'></i>오답 %d</span></div>`, sum.Correct, sum.Scorable-sum.Correct)
				}
				predictions := map[string]int{}
				for _, r := range b.Results {
					if r.TargetID == target.ID && r.TaskID == task.ID && decisionHTMLScorable(r) {
						predictions[r.Predicted]++
					}
				}
				for key, count := range predictions {
					if count == sum.Scorable && count >= 2 {
						fmt.Fprintf(&out, "<p class='pattern'>%d문항 모두 ‘%s’로 판단했습니다. 한 답에 치우친 결과인지 문항별로 확인하세요.</p>", count, decisionHTMLText(decisionHTMLAnswer(task, key)))
					}
				}
				if sum.WarmupFailed {
					out.WriteString("<p class='alert'>준비 요청 실패: " + decisionHTMLText(sum.WarmupError) + "</p>")
				}
				out.WriteString("</article>")
			}
			out.WriteString("</div><p class='conclusion'>" + decisionHTMLText(decisionHTMLConclusion(b, task.ID)) + "</p></section>")
		}
		out.WriteString("<p class='muted'>정답률은 채점 가능한 문항 기준입니다. 오류·미실행·입력 잘림은 오답으로 계산하지 않습니다. 이 세트의 결과만으로 전반적인 업무 능력을 확정하지 않습니다.</p>")
		out.WriteString("<details><summary>실험 정보와 실행 상태</summary>")
		fmt.Fprintf(&out, "<p>테스트셋: %s<br>출처: %s<br>정답 검토: %s<br>요청 제한: %d초 · 준비 요청은 집계 제외</p>", decisionHTMLText(b.Suite.Name), decisionHTMLText(b.Suite.SourceDocument), decisionHTMLText(decisionHTMLReviewStatus(b.Suite.ReviewStatus)), b.TimeoutSeconds)
		for _, task := range b.Suite.Tasks {
			if context := task.Context["ko"]; context != "" {
				fmt.Fprintf(&out, "<details><summary>공통 업무 설명 · %s</summary><pre>%s</pre></details>", decisionHTMLText(task.Name), decisionHTMLText(context))
			}
		}
		out.WriteString("<div class='scroll'><table><thead><tr><th>모델</th><th>유형</th><th>완료 / 전체</th><th>오류</th><th>미실행</th><th>평균 응답</th></tr></thead><tbody>")
		for _, s := range sums {
			model := ""
			for _, t := range b.Targets {
				if t.ID == s.TargetID {
					model = t.Model
				}
			}
			ms := "—"
			if s.MeanMs != nil {
				ms = fmt.Sprintf("%.0f ms", *s.MeanMs)
			}
			fmt.Fprintf(&out, "<tr><td>%s</td><td>%s</td><td>%d / %d</td><td>%d</td><td>%d</td><td>%s</td></tr>", decisionHTMLText(model), decisionHTMLText(decisionHTMLType(s.Type)), s.Completed, s.Planned, s.Errors, s.Skipped, ms)
		}
		out.WriteString("</tbody></table></div><p class='muted'>응답 시간은 네트워크를 포함합니다. 실행 환경이 다르면 속도만으로 모델을 비교할 수 없습니다.</p>")
		for _, t := range b.Targets {
			out.WriteString("<p>" + decisionHTMLText(t.Model) + " · " + decisionHTMLText(t.BaseURL) + "</p>")
		}
		for _, r := range b.Warmups {
			if r.Error != "" {
				out.WriteString("<p class='alert'>준비 요청: " + decisionHTMLText(r.Error) + "</p>")
			}
		}
		out.WriteString("</details><details><summary>상세 분석과 지표 설명</summary>")
		for _, s := range sums {
			var task DecisionTask
			task, _ = decisionTask(b.Suite, s.TaskID)
			model := ""
			for _, t := range b.Targets {
				if t.ID == s.TargetID {
					model = t.Model
				}
			}
			fmt.Fprintf(&out, "<h3>%s · %s</h3><div class='metrics'>", decisionHTMLText(model), decisionHTMLText(decisionHTMLType(s.Type)))
			metrics := []struct {
				name    string
				v       *float64
				explain string
			}{{"영역별 균형 성능 (Macro F1)", s.MacroF1, "각 정답 종류를 같은 비중으로 평균합니다. 1에 가까울수록 좋습니다."}, {"확률 오차 (Brier)", s.Brier, "정답 확률의 오차입니다. 0에 가까울수록 좋습니다."}, {"확신과 실제 정답률의 차이 (ECE)", s.ECE, "확신이 실제 정답률과 맞는지 확인합니다. 0에 가까울수록 좋습니다."}}
			if s.Type == "score" {
				metrics = append(metrics, struct {
					name    string
					v       *float64
					explain string
				}{"등급 차이 (MAE)", s.TopMAE, "정답과 선택 등급의 평균 간격입니다. 0은 일치, 1은 한 단계 차이입니다."})
			}
			for _, m := range metrics {
				fmt.Fprintf(&out, "<div class='metric'>%s<b>%s</b><p>%s</p></div>", decisionHTMLText(m.name), decisionHTMLMetric(m.v, false), decisionHTMLText(m.explain))
			}
			fmt.Fprintf(&out, "</div><p class='muted'>정답 평가 %d문항 · 확률 평가 %d문항 · 잘림 제외 %d문항</p>", s.Scorable, s.ProbabilityCount, s.Truncated)
			out.WriteString("<details><summary>어떤 정답을 잘 찾았는지</summary><p>정밀도: 이 답을 선택했을 때 맞은 비율 · 재현율: 실제 이 답인 문항을 찾은 비율</p><div class='scroll'><table><tr><th>정답 종류</th><th>문항 수</th><th>정밀도</th><th>재현율</th><th>균형 점수 (F1)</th></tr>")
			for _, c := range s.Classes {
				fmt.Fprintf(&out, "<tr><td>%s</td><td>%d</td><td>%s</td><td>%s</td><td>%s</td></tr>", decisionHTMLText(decisionHTMLAnswer(task, c.Key)), c.Support, decisionHTMLMetric(c.Precision, true), decisionHTMLMetric(c.Recall, true), decisionHTMLMetric(c.F1, false))
			}
			out.WriteString("</table></div><h4>다른 답으로 판단한 경우</h4>")
			for i, row := range s.Confusion {
				for j, n := range row {
					if i != j && n > 0 {
						fmt.Fprintf(&out, "<p>%s → %s · %d문항</p>", decisionHTMLText(decisionHTMLAnswer(task, s.Classes[i].Key)), decisionHTMLText(decisionHTMLAnswer(task, s.Classes[j].Key)), n)
					}
				}
			}
			out.WriteString("</details>")
		}
		out.WriteString("</details><details><summary>문항별 정답과 모델 판단</summary><p>질문을 펼치면 입력 전문, 정답 근거와 원본 응답을 확인할 수 있습니다.</p><div class='scroll'><table><thead><tr><th>질문 / 모델</th><th>결과</th><th>정답</th><th>모델 판단</th></tr></thead><tbody>")
		cases := map[string]DecisionCase{}
		for _, c := range b.Suite.Cases {
			cases[c.ID] = c
		}
		for _, r := range b.Results {
			c := cases[r.CaseID]
			task, _ := decisionTask(b.Suite, r.TaskID)
			model := ""
			for _, t := range b.Targets {
				if t.ID == r.TargetID {
					model = t.Model
				}
			}
			status := decisionHTMLStatus(r.Status)
			if r.Status == "completed" {
				status = "채점 불가"
				if r.LabelValid {
					status = "오답"
					if r.Correct {
						status = "정답"
					}
				}
				if r.Truncated != nil && *r.Truncated {
					status = "입력 잘림 · 집계 제외"
				}
			}
			question := c.Text
			for _, line := range strings.Split(c.Text, "\n") {
				if strings.HasPrefix(line, "요청:") {
					question = strings.TrimSpace(strings.TrimPrefix(line, "요청:"))
					break
				}
			}
			fmt.Fprintf(&out, "<tr><td class='question'><details><summary>%s</summary><div class='case-body'><pre>%s</pre><p>정답 근거: %s</p><p>%s</p><details><summary>원본 응답</summary><pre>", decisionHTMLText(question), decisionHTMLText(c.Text), decisionHTMLText(c.Rationale), decisionHTMLText(r.Error))
			questionInstructions := c.Instructions["ko"]
			if questionInstructions == "" {
				questionInstructions = task.Instructions["ko"]
			}
			out.WriteString(decisionHTMLText("판단 질문: "+questionInstructions) + "\n\n")
			raw, _ := json.MarshalIndent(r.Raw, "", "  ")
			out.WriteString(decisionHTMLText(string(raw)))
			fmt.Fprintf(&out, "</pre></details></div></details><small class='muted'>%s · %s</small></td><td>%s</td><td class='answer'>%s</td><td class='answer'>%s</td></tr>", decisionHTMLText(model), decisionHTMLText(decisionHTMLType(task.Type)), decisionHTMLText(status), decisionHTMLText(decisionHTMLAnswer(task, r.Expected)), decisionHTMLText(decisionHTMLAnswer(task, r.Predicted)))
		}
		out.WriteString("</tbody></table></div></details></section>")
	}
	out.WriteString("<p class='footer'>보고서는 인터넷 연결 없이 열 수 있습니다. 복원용 원본 데이터는 HTML 주석에 보관되어 앱으로 다시 가져올 수 있습니다.</p></main></body></html>\n")
	return out.String()
}
func decisionHTMLScorable(r DecisionCaseResult) bool {
	return r.Status == "completed" && r.LabelValid && (r.Truncated == nil || !*r.Truncated)
}
func decisionHTMLConclusion(b DecisionBenchmark, taskID string) string {
	if len(b.Targets) == 0 {
		return "채점 가능한 결과가 없습니다."
	}
	common := map[string]bool{}
	for _, r := range b.Results {
		if r.TargetID == b.Targets[0].ID && r.TaskID == taskID && decisionHTMLScorable(r) {
			common[r.CaseID] = true
		}
	}
	for _, t := range b.Targets[1:] {
		eligible := map[string]bool{}
		for _, r := range b.Results {
			if r.TargetID == t.ID && r.TaskID == taskID && decisionHTMLScorable(r) {
				eligible[r.CaseID] = true
			}
		}
		for id := range common {
			if !eligible[id] {
				delete(common, id)
			}
		}
	}
	if len(common) == 0 {
		return "모든 모델이 함께 채점된 문항이 없어 직접 비교할 수 없습니다."
	}
	best, worst := -1, len(common)+1
	names := []string{}
	for _, t := range b.Targets {
		correct := 0
		for _, r := range b.Results {
			if r.TargetID == t.ID && r.TaskID == taskID && common[r.CaseID] && r.Correct {
				correct++
			}
		}
		if correct > best {
			best = correct
			names = []string{t.Model}
		} else if correct == best {
			names = append(names, t.Model)
		}
		if correct < worst {
			worst = correct
		}
	}
	if len(b.Targets) == 1 {
		return fmt.Sprintf("%d문항 중 %d문항을 맞혔습니다.", len(common), best)
	}
	if best == worst {
		return fmt.Sprintf("공통 %d문항에서 모든 모델이 %d문항을 맞혔습니다.", len(common), best)
	}
	return fmt.Sprintf("%s의 정답이 더 많습니다. 공통 %d문항에서 %d문항 정답, 최소 정답 모델보다 %d문항 차이입니다.", strings.Join(names, ", "), len(common), best, best-worst)
}

func decisionHTMLReviewStatus(status string) string {
	if status == "unreviewed" {
		return "정답 검토 전 초안"
	}
	if status == "" {
		return "검토 정보 없음"
	}
	return status
}
