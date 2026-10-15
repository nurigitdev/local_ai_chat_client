package main

import (
	"fmt"
	"html"
	"sort"
	"strings"
	"time"
)

func decisionHTMLText(s string) string { return html.EscapeString(neutralDecisionText(s)) }
func decisionHTMLStatus(s string) string {
	if label, ok := map[string]string{"completed": "완료", "running": "실행 중", "partial": "일부 실패", "error": "오류", "failed": "실패", "cancelled": "취소", "interrupted": "중단", "skipped": "미실행", "pending": "대기"}[s]; ok {
		return label
	}
	return s
}
func decisionHTMLType(s string) string {
	return map[string]string{"ranking": "복합 업무 후보 순위", "choice": "단일 업무영역 분류", "noul": "업무영역 해당 여부", "score": "업무 적합도 평가"}[s]
}
func decisionHTMLAnswer(task DecisionTask, key string) string {
	if strings.Contains(key, "|") {
		labels := strings.Split(key, "|")
		for i, label := range labels {
			labels[i] = decisionHTMLAnswer(task, label)
		}
		return strings.Join(labels, " · ")
	}
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
	if task.ID == "business-domain-choice" || task.ID == "business-domain-ranking" {
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

// Standalone reports require no network or application runtime.
func decisionHTMLReport(records []DecisionBenchmark, title, note string) string {
	var out strings.Builder
	out.WriteString(`<!doctype html><html lang='ko'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><title>Decision Benchmark 보고서</title><style>
 :root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f5f6f2;color:#303c32;font:14px/1.7 "Malgun Gothic",system-ui,sans-serif}main{max-width:1200px;margin:40px auto;padding:0 24px}h1{font-size:28px;line-height:1.4;margin:8px 0}h2{font-size:21px;margin:0 0 8px}h3{font-size:16px;margin:0 0 6px}h4{margin:16px 0 8px}.eyebrow{font-size:12px;letter-spacing:2px;color:#4f7660}.muted{color:#74816f;font-size:12px}.report-header{margin-bottom:28px}.record{background:white;border:1px solid #dce2d6;border-radius:14px;padding:28px;margin:24px 0}.record-head{border-bottom:1px solid #e1e6db;padding-bottom:16px;margin-bottom:20px}.task{border:1px solid #dce2d6;border-radius:10px;overflow:hidden;margin:18px 0}.task header{padding:15px 20px;background:#f4f7f0}.task header p{margin:0;color:#74816f;font-size:12px}.models{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}.model{padding:20px;text-align:center;border-right:1px solid #e5e9df}.model:last-child{border:0}.model-name{overflow-wrap:anywhere;font-weight:600;font-size:13px}.donut{width:170px;height:170px;margin:18px auto 10px;position:relative}.donut svg{width:100%;height:100%}.donut .center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}.donut strong{font-size:28px;color:#355840;line-height:1.4}.donut small{color:#74816f}.legend{display:flex;justify-content:center;gap:12px;flex-wrap:wrap;font-size:12px;margin-top:10px}.legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px}.conclusion{background:#fafcf7;border-top:1px solid #e2e7dc;padding:12px 20px;margin:0;color:#46623b}.pattern{background:#fffaed;color:#8b6831;padding:10px;border-radius:6px;font-size:12px;text-align:left}.alert{padding:12px 16px;border:1px solid #e6bdb2;background:#fff3ef;color:#91452e;border-radius:8px;margin:14px 0}.scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:12px;margin:12px 0}th,td{padding:10px 12px;border-bottom:1px solid #e2e7dc;text-align:left;vertical-align:top}th{background:#f4f7f0;color:#5d7351}td.question{min-width:230px;max-width:450px}td.answer{min-width:110px}details{border-top:1px solid #e2e7dc;padding:12px 0}summary{cursor:pointer;color:#4c6841;font-weight:600}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5ef;padding:14px;border-radius:6px;max-height:400px;overflow:auto;font-size:12px}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}.metric{padding:14px;background:#f4f7f0;border-radius:7px}.metric b{display:block;font-size:22px;color:#355840}.metric p{font-size:12px;color:#74816f;margin:4px 0}.badge.allocation-low{background:#fff3d8;color:#805c1e}.badge{display:inline-block;padding:3px 8px;background:#edf3e5;color:#577143;border-radius:5px;font-size:12px}.footer{font-size:12px;color:#74816f;margin:24px 0}.case-body p{margin:8px 0}@media(max-width:650px){main{margin:20px auto;padding:0 12px}.record{padding:16px}h1{font-size:23px}.model{border-right:0;border-bottom:1px solid #e5e9df}}@media print{body{background:white}main{margin:0;max-width:none;padding:0}.record{break-inside:auto}.task,.model{break-inside:avoid}details{break-inside:auto}}
 .legend.subdivided{display:grid;gap:7px;text-align:left;max-width:260px;margin:14px auto 0}.legend.subdivided>span{display:flex;align-items:center;gap:6px}.legend.subdivided b{margin-left:auto}.legend.subdivided i{flex-shrink:0}.case-browser{margin-top:24px;border-top:1px solid #dce2d6;padding-top:20px}.case-filters{display:grid;grid-template-columns:1fr 1fr 1fr 1.4fr;gap:12px;margin:16px 0}.case-filters label{font-size:12px;color:#617158}.case-filters select,.case-filters input{display:block;width:100%;min-width:0;margin-top:5px;padding:10px;border:1px solid #d5ddcd;border-radius:6px;background:white;color:#303c32;font:inherit}.case-workspace{display:grid;grid-template-columns:minmax(0,.85fr) minmax(0,1.4fr);gap:18px}.case-list,.case-panels{max-height:75vh;overflow:auto;min-width:0;overscroll-behavior:contain}.case-choice{display:block;width:100%;text-align:left;border:1px solid #dce2d6;border-radius:7px;padding:12px;margin-bottom:8px;background:#fafcf7;color:inherit;font:inherit;cursor:pointer}.case-choice span{display:block;margin:5px 0}.case-choice small{color:#74816f}.case-choice b{font-size:12px}.case-choice[aria-pressed=true]{background:#edf5e6;border-color:#8da780}.case-choice:hover{border-color:#8da780}.case-choice:focus-visible{outline:2px solid #4f8063;outline-offset:2px}.case-panel{padding:18px;background:#fafcf7;border:1px solid #c7d6bd;border-radius:8px}.case-panel h3{overflow-wrap:anywhere}.answer-pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}.answer-pair>div{background:white;border:1px solid #dce2d6;border-radius:7px;padding:12px}.answer-pair small,.answer-pair strong{display:block}.answer-pair small{color:#74816f}.case-empty,.case-placeholder{padding:20px;color:#74816f}[hidden]{display:none!important}@media(max-width:850px){.case-filters{grid-template-columns:1fr 1fr}.case-workspace{grid-template-columns:minmax(0,1fr)}.case-list{max-height:32vh}.case-panels{max-height:none}}@media print{.case-filters,.case-list,.case-placeholder{display:none}.case-workspace{display:block}.case-panels{max-height:none;overflow:visible}.case-panel[hidden]{display:block!important}.case-panel{margin:12px 0}}
 .legend.subdivided i{width:12px;height:12px;border:1px solid #fff;box-shadow:0 0 0 1px #78906f}.legend.subdivided span{font-weight:600}.legend.subdivided span span{font-weight:400}
 </style></head><body><main><header class='report-header'><span class='eyebrow'>MODEL LAB / DECISION</span><h1>`)
	out.WriteString(decisionHTMLText(title))
	out.WriteString("</h1><p>" + decisionHTMLText(note) + "</p></header>")
	for _, b := range records {
		sums := summarizeDecision(b)
		name := b.ExperimentName
		if name == "" {
			name = b.Suite.Name
		}
		fmt.Fprintf(&out, "<section class='record'><header class='record-head'><h2>%s</h2><span class='badge'>%s</span><p class='muted'>%s · 한국어 · %s</p></header>", decisionHTMLText(name), decisionHTMLText(decisionHTMLStatus(b.Status)), decisionHTMLText(decisionHTMLDate(b.CreatedAt)), decisionHTMLText(b.Suite.Revision))
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
			purpose := map[string]string{"ranking": "복합 요청의 필요한 영역을 상위에 함께 올렸는지", "choice": "요청을 담당할 업무영역을 골랐는지", "noul": "후보 업무영역에 해당하는 요청인지 구분했는지", "score": "부적합·불명확·적합을 기준에 맞게 판단했는지"}[task.Type]
			fmt.Fprintf(&out, "<section class='task'><header><h3>%s</h3><p>%s</p></header><div class='models'>", decisionHTMLText(decisionHTMLType(task.Type)), decisionHTMLText(purpose))
			for _, target := range b.Targets {
				var sum DecisionBenchmarkSummary
				for _, s := range sums {
					if s.TargetID == target.ID && s.TaskID == task.ID {
						sum = s
					}
				}
				full, partial, miss := sum.Correct, 0, sum.Scorable-sum.Correct
				if task.Type == "ranking" {
					full, miss = 0, 0
					for _, r := range b.Results {
						if r.TargetID == target.ID && r.TaskID == task.ID && decisionHTMLScorable(r) {
							category, _, _ := decisionIdentification(task, r)
							switch category {
							case "full":
								full++
							case "partial":
								partial++
							case "miss":
								miss++
							}
						}
					}
				}
				var segments []decisionDonutSegment
				if task.Type == "ranking" {
					segments = decisionRankingSegments(task, b.Results, target.ID)
				}
				out.WriteString(decisionHTMLDonut(target.Model, task.Type, sum.Scorable, full, partial, miss, segments...))

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
			out.WriteString("</div>")
			if task.Type == "ranking" {
				baseline := 0.0
				if len(task.Options) > 0 {
					baseline = 1 / float64(len(task.Options))
				}
				fmt.Fprintf(&out, "<p class='muted' style='margin:12px 20px'>상위 후보에서 모두 찾은 문항은 모든 정답 업무의 확률로, 일부를 놓친 문항은 빠진 정답 업무의 확률로 나눕니다. 누락 업무 %s 이상은 빠진 업무가 모두 기준 이상이지만 순위에서 밀린 경우이고, 미만은 하나라도 기준보다 낮은 경우입니다. 중앙의 전체 식별률은 확률 배분과 관계없이 모두 찾은 비율입니다.</p>", decisionHTMLMetric(&baseline, true))
			}
			out.WriteString("<p class='conclusion'>" + decisionHTMLText(decisionHTMLTaskConclusion(b, task)) + "</p></section>")
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
			if s.Type == "ranking" {
				metrics = nil
				metrics = append(metrics, struct {
					name    string
					v       *float64
					explain string
				}{"정답 영역 회수율", s.RankingRecall, "상위 K개에서 필요한 영역을 찾은 비율입니다. K는 정답 개수이며 높을수록 좋습니다."}, struct {
					name    string
					v       *float64
					explain string
				}{"상위 순위 품질 (NDCG@K)", s.NDCG, "필요한 영역이 높은 순위에 있는 정도입니다. 1에 가까울수록 좋습니다."}, struct {
					name    string
					v       *float64
					explain string
				}{"정답 영역 확률 합", s.RelevantProbability, "정답 영역 확률의 합입니다. 보조 지표이며 한 영역 누락을 숨길 수 있습니다."})
			}
			if s.Type == "score" {
				metrics = append(metrics, struct {
					name    string
					v       *float64
					explain string
				}{"등급 차이 (MAE)", s.TopMAE, "정답과 선택 등급의 평균 간격입니다. 0은 일치, 1은 한 단계 차이입니다."})
			}
			for _, m := range metrics {
				fmt.Fprintf(&out, "<div class='metric'>%s<b>%s</b><p>%s</p></div>", decisionHTMLText(m.name), decisionHTMLMetric(m.v, s.Type == "ranking" && m.name != "상위 순위 품질 (NDCG@K)"), decisionHTMLText(m.explain))
			}
			fmt.Fprintf(&out, "</div><p class='muted'>정답 평가 %d문항 · 확률 평가 %d문항 · 잘림 제외 %d문항</p>", s.Scorable, s.ProbabilityCount, s.Truncated)
			if s.Type == "ranking" {
				out.WriteString("<p class='muted'>복합 평가는 문항별 상위 목록과 누락 영역을 확인합니다.</p>")
				continue
			}
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
		out.WriteString("</details>")
		out.WriteString(decisionHTMLCases(b))
		out.WriteString("</section>")
	}
	out.WriteString("<p class='footer'>보고서는 인터넷 연결 없이 열 수 있습니다. 복원용 원본 데이터는 HTML 주석에 보관되어 앱으로 다시 가져올 수 있습니다.</p></main><script id='decision-report-interaction'>" + decisionReportInteraction + "</script></body></html>\n")
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

func decisionHTMLChartLabel(typ string) string {
	if typ == "ranking" {
		return "전체 식별률"
	}
	return "정답률"
}
func decisionHTMLDate(value string) string {
	parsed, e := time.Parse(time.RFC3339Nano, value)
	if e != nil {
		return value
	}
	return parsed.In(time.FixedZone("KST", 9*60*60)).Format("2006-01-02 15:04:05 KST")
}
func decisionHTMLRankingTable(task DecisionTask, r DecisionCaseResult) string {
	var out strings.Builder
	out.WriteString("<h4>앱이 계산한 평가 결과</h4><p class='muted'>모델이 반환한 확률을 앱이 정렬하고, 정답 업무 개수만큼 상위 후보를 골라 평가했습니다.</p>")
	options := append([]DecisionOption(nil), task.Options...)
	sort.SliceStable(options, func(i, j int) bool { return r.Probabilities[options[i].Key] > r.Probabilities[options[j].Key] })
	labels := strings.Split(r.Expected, "|")
	expected := map[string]bool{}
	top := map[string]bool{}
	for _, key := range labels {
		expected[key] = true
	}
	for _, key := range strings.Split(r.Predicted, "|") {
		top[key] = true
	}
	missing := []string{}
	for _, key := range labels {
		if !top[key] {
			missing = append(missing, decisionHTMLAnswer(task, key))
		}
	}
	if len(missing) > 0 {
		out.WriteString("<p>상위 목록에서 빠진 정답: " + decisionHTMLText(strings.Join(missing, " · ")) + "</p>")
	}
	category, hits, low := decisionIdentification(task, r)
	if category != "unavailable" {
		fmt.Fprintf(&out, "<p>필요한 업무 %d개 중 %d개 식별 · %s</p>", len(labels), hits, decisionHTMLText(decisionCaseStatus(task, r)))
	}

	if len(low) > 0 {
		names := []string{}
		for _, key := range low {
			names = append(names, decisionHTMLAnswer(task, key))
		}
		baseline := 1 / float64(len(task.Options))
		fmt.Fprintf(&out, "<p class='pattern'>확률 배분 주의: %s — 균등 배분 기준 %s 미만</p>", decisionHTMLText(strings.Join(names, " · ")), decisionHTMLMetric(&baseline, true))
	}
	fmt.Fprintf(&out, "<p>정답 영역 회수율 %s · 정답 영역 확률 합 %s</p>", decisionHTMLMetric(r.RankingRecall, true), decisionHTMLMetric(r.RelevantProbability, true))
	out.WriteString("<details><summary>모델이 반환한 전체 업무별 확률</summary><p class='muted'>모델이 반환한 확률을 앱이 높은 순서로 정렬한 표입니다. 평가 후보 목록은 앱이 구성했습니다.</p><div class='scroll'><table><thead><tr><th>순위</th><th>업무영역</th><th>확률</th><th>정답</th><th>상위 후보</th></tr></thead><tbody>")
	for i, o := range options {
		value, exists := r.Probabilities[o.Key]
		probability := "—"
		if exists {
			probability = decisionHTMLMetric(&value, true)
		}
		correct := "—"
		selection := "—"
		if top[o.Key] {
			selection = "포함"
		}
		if expected[o.Key] {
			correct = "정답 업무"
		}
		fmt.Fprintf(&out, "<tr><td>%d</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>", i+1, decisionHTMLText(decisionHTMLAnswer(task, o.Key)), probability, correct, selection)
	}
	out.WriteString("</tbody></table></div></details>")
	return out.String()
}

func decisionHTMLTaskConclusion(b DecisionBenchmark, task DecisionTask) string {
	text := decisionHTMLConclusion(b, task.ID)
	if task.Type == "ranking" {
		text = strings.ReplaceAll(text, "문항을 맞혔습니다.", "문항의 업무를 모두 식별했습니다.")
		text = strings.ReplaceAll(text, "의 정답이 더 많습니다.", "의 전체 식별 문항이 더 많습니다.")
		text = strings.ReplaceAll(text, "문항 정답, 최소 정답 모델보다", "문항 전체 식별, 가장 적게 식별한 모델보다")
	}
	return text
}
func decisionHTMLDonut(model, typ string, count, full, partial, miss int, rankingSegments ...decisionDonutSegment) string {
	var out strings.Builder
	display := "평가 불가"
	if count > 0 {
		display = fmt.Sprintf("%.1f%%", 100*float64(full)/float64(count))
	}
	fmt.Fprintf(&out, "<article class='model'><div class='model-name'>%s</div><div class='donut'><svg viewBox='0 0 160 160' aria-hidden='true'><circle cx='80' cy='80' r='65' fill='none' stroke='#e6e9e1' stroke-width='14'/>", decisionHTMLText(model))
	segments := []decisionDonutSegment{{"정답", "#24704E", full}, {"오답", "#C9504C", miss}}
	if typ == "ranking" {
		segments = rankingSegments
	}

	offset := 0.0
	if count > 0 {
		for _, segment := range segments {
			rate := 100 * float64(segment.count) / float64(count)
			fmt.Fprintf(&out, "<circle cx='80' cy='80' r='65' fill='none' stroke='%s' stroke-width='14' pathLength='100' stroke-dasharray='%.4f %.4f' stroke-dashoffset='%.4f' transform='rotate(-90 80 80)'/>", segment.color, rate, 100-rate, -offset)
			offset += rate
		}
	}
	fmt.Fprintf(&out, "</svg><div class='center'><strong>%s</strong><small>%s</small></div></div><b>%d문항 중 %d문항 %s</b>", display, decisionHTMLChartLabel(typ), count, full, map[bool]string{true: "전체 식별", false: "정답"}[typ == "ranking"])
	if count > 0 {
		class := "legend"
		if typ == "ranking" {
			class += " subdivided"
		}
		out.WriteString("<div class='" + class + "'>")
		for _, segment := range segments {
			fmt.Fprintf(&out, "<span><i style='background:%s'></i><span>%s</span> <b>%d</b></span>", segment.color, segment.label, segment.count)
		}
		out.WriteString("</div>")
	}
	return out.String()
}
