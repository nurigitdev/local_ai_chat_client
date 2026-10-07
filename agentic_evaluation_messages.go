package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

type agenticViolationSet struct {
	Violations []string
	Details    []AgenticViolationDetail
}

func (s *agenticViolationSet) add(resource, tool, kind string, messages ...string) {
	for _, message := range messages {
		s.Details = append(s.Details, AgenticViolationDetail{ViolationIndex: len(s.Violations), Resource: resource, ToolName: tool, Kind: kind})
		s.Violations = append(s.Violations, message)
	}
}

// Explain the same JSON comparison used by grading without changing its rules.
func agenticJSONDifferences(file, actual, expected string) []string {
	var saved, wanted any
	if json.Unmarshal([]byte(actual), &saved) != nil {
		return []string{file + "의 내용을 JSON 형식으로 읽을 수 없습니다. 괄호, 따옴표, 쉼표를 확인하세요."}
	}
	if json.Unmarshal([]byte(expected), &wanted) != nil {
		return []string{file + "의 채점 기준을 읽을 수 없습니다."}
	}
	return agenticValueDifferences(file, saved, wanted)
}

func agenticValueDifferences(label string, actual, expected any) []string {
	if wanted, ok := expected.(map[string]any); ok {
		saved, ok := actual.(map[string]any)
		if !ok {
			return []string{label + "은 항목별 결과를 담은 JSON 객체여야 합니다."}
		}
		keys := make([]string, 0, len(wanted)+len(saved))
		for key := range wanted {
			keys = append(keys, key)
		}
		for key := range saved {
			if _, exists := wanted[key]; !exists {
				keys = append(keys, key)
			}
		}
		sort.Strings(keys)
		var messages []string
		for _, key := range keys {
			itemLabel := label + "의 " + agenticFieldLabel(key)
			want, required := wanted[key]
			value, exists := saved[key]
			if !required {
				messages = append(messages, itemLabel+": 요구하지 않은 항목입니다.")
			} else if !exists {
				messages = append(messages, agenticSubject(itemLabel)+" 누락되었습니다. 필요한 결과는 ‘"+agenticValueLabel(want)+"’입니다.")
			} else {
				messages = append(messages, agenticValueDifferences(itemLabel, value, want)...)
			}
		}
		return messages
	}
	left, _ := json.Marshal(actual)
	right, _ := json.Marshal(expected)
	if string(left) == string(right) {
		return nil
	}
	return []string{fmt.Sprintf("%s 올바르지 않습니다. ‘%s’이어야 하지만 ‘%s’로 저장되어 있습니다.", agenticSubject(label), agenticValueLabel(expected), agenticValueLabel(actual))}
}

func agenticSubject(label string) string {
	chars := []rune(label)
	if len(chars) > 0 {
		last := chars[len(chars)-1]
		if last >= '가' && last <= '힣' && (last-'가')%28 == 0 {
			return label + "가"
		}
	}
	return label + "이"
}

func agenticCodeCheckMessage(name, expected string) string {
	descriptions := map[string]string{
		"입력 검증":  "잘못된 입력에 오류 발생시키기",
		"값 문자열화": "숫자와 문자열 값을 문자열로 바꾸기",
		"상한 제한":  "요청 값이 최댓값을 넘지 않도록 제한하기",
		"안전한 비교": "빈 입력이나 같은 상태로의 변경을 거부하고 상태 이름 비교하기",
	}
	description, ok := descriptions[name]
	if !ok {
		description = expected
	}
	return "작성한 코드가 ‘" + description + "’ 검사에서 통과하지 못했습니다. 코드를 실행하지 않고 정해진 표현이 있는지 비교하는 검사이므로, 같은 기능을 다른 방식으로 작성하면 미통과할 수 있습니다."
}

func agenticFieldLabel(field string) string {
	labels := map[string]string{
		"id": "기록 번호", "status": "처리 상태", "tier": "고객 등급", "payment": "결제 상태", "delivery": "배송 상태",
		"risk": "위험 표시", "proof": "증빙 유무", "consent": "동의 여부", "address": "주소 확인 여부",
		"decision": "배포 결정", "reasons": "배포 보류 사유",
	}
	if label, ok := labels[field]; ok {
		return label
	}
	return field + " 항목"
}

func agenticValueLabel(value any) string {
	switch v := value.(type) {
	case string:
		labels := map[string]string{
			"approved": "승인 완료", "accepted": "접수 승인", "needs_review": "추가 검토 필요", "review": "검토 필요",
			"rejected": "거절", "waiting": "대기 중", "priority": "우선 처리", "vip": "우수 고객", "standard": "일반 고객",
			"confirmed": "확인 완료", "pending": "확인 대기", "delivered": "배송 완료", "returned": "반송",
			"proceed": "배포 진행", "hold": "배포 보류", "security-review": "보안 검토 미완료",
			"crash-free": "오류 없이 동작한 비율이 기준 미달", "rollback-check": "이전 버전 복구 점검 미완료",
		}
		if label, ok := labels[v]; ok {
			return label
		}
		if v == "" {
			return "값 없음"
		}
		return v
	case bool:
		if v {
			return "예"
		}
		return "아니요"
	case nil:
		return "값 없음"
	case []any:
		if len(v) == 0 {
			return "없음"
		}
		items := make([]string, 0, len(v))
		for _, item := range v {
			items = append(items, agenticValueLabel(item))
		}
		return strings.Join(items, ", ")
	default:
		encoded, _ := json.Marshal(value)
		return string(encoded)
	}
}

func agenticRecordDifferences(id string, actual, expected recordData) []string {
	// Note is an optional annotation and is excluded by the existing grader.
	actual.Note, expected.Note = "", ""
	left, _ := json.Marshal(actual)
	right, _ := json.Marshal(expected)
	return agenticJSONDifferences(id+" 기록", string(left), string(right))
}
