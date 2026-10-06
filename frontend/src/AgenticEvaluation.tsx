import {type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Dialogs, Events} from '@wailsio/runtime';
import {App as ChatService} from '../bindings/github.com/taengson/agent-chat-desktop';
import type {
    AgenticEvaluation,
    AgenticEvaluationAction,
    AgenticEvaluationRun,
    AgenticEvaluationScenarioSummary,
    AgenticEvaluationSummary,
    ConnectionProfile,
    Model,
    SavedConnectionProfile,
} from '../bindings/github.com/taengson/agent-chat-desktop/models';
import OpenRouterModelPicker, {isOpenRouterURL} from './OpenRouterModelPicker';
import {
    reasoningEffortLabel,
    reasoningEffortOptions,
    reasoningEffortWarning,
    type ReasoningEffort,
} from './reasoningEffort';

const agenticEvaluationEventName = 'agentic-evaluation:event';
const maxAgenticEvaluationRuns = 240;
const agenticEvaluationReportFormatVersion = 1;

type AgenticEvaluationReportFormat = 'html' | 'markdown';

interface AgenticEvaluationWorkspaceProps {
    profiles: SavedConnectionProfile[];
    connectionAPIKey: string;
    openRouterModelIDs: string[];
    onOpenRouterModelIDsChange: (modelIDs: string[]) => void;
    onBusyChange: (busy: boolean) => void;
    onSidebarChange: (state: AgenticEvaluationSidebarState) => void;
    sidebarAction: AgenticEvaluationSidebarAction | null;
    onSidebarActionHandled: (sequence: number) => void;
}

export interface AgenticEvaluationSidebarAction {
    kind: 'open' | 'delete';
    id: string;
    sequence: number;
}

export interface AgenticEvaluationSidebarSection {
    id: string;
    label: string;
}

export interface AgenticEvaluationSidebarState {
    sections: AgenticEvaluationSidebarSection[];
    activeSectionID: string;
    history: AgenticEvaluationSummary[];
    loadingHistory: boolean;
    selectedEvaluationID: string;
}

type ModelAggregate = {
    model: string;
    total: number;
    passed: number;
    attempts: number;
    passedDurationMs: number;
    inputTokens: number;
    outputTokens: number;
};

type PassTargetStatus = 'pending' | 'running' | 'passed' | 'not-passed' | 'cancelled';

type PassTarget = {
    key: string;
    model: string;
    scenarioID: string;
    suite: string;
    title: string;
    environment: string;
    language: string;
    category: string;
    attempts: number;
    activeDurationMs: number;
    inputTokens: number;
    outputTokens: number;
    status: PassTargetStatus;
    runOrder: number;
};

function formatTime(value?: string): string {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('ko-KR', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(date);
}

function formatDuration(milliseconds?: number): string {
    if (milliseconds === undefined || milliseconds <= 0) return '—';
    const seconds = milliseconds / 1_000;
    return `${new Intl.NumberFormat('ko-KR', {maximumFractionDigits: seconds < 10 ? 1 : 0}).format(seconds)}초`;
}

function runDurationMs(run: AgenticEvaluationRun): number {
    if (run.metrics?.totalDurationMs && run.metrics.totalDurationMs > 0) return run.metrics.totalDurationMs;
    if (!run.startedAt || !run.finishedAt) return 0;
    const startedAt = new Date(run.startedAt).getTime();
    const finishedAt = new Date(run.finishedAt).getTime();
    return Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt
        ? finishedAt - startedAt
        : 0;
}

function runStatusText(status: string): string {
    const labels: Record<string, string> = {
        pending: '대기', running: '실행 중', success: '성공', failed: '목표 미달',
        cancelled: '취소됨', interrupted: '중단됨', action_limit: '행동 한도',
        context_limit: '문맥 한도', time_limit: '시간 한도', connection_error: '연결 오류',
    };
    return labels[status] || status || '알 수 없음';
}

function passTargetStatusText(status: PassTargetStatus): string {
    const labels: Record<PassTargetStatus, string> = {
        pending: '대기', running: '실행 중', passed: '통과', 'not-passed': '미통과', cancelled: '취소됨',
    };
    return labels[status];
}

function feedbackRetryLabel(enabled: boolean): string {
    return enabled ? '채점 사유 피드백 재시도' : '독립 재시도';
}

function evaluationStatusText(status: string): string {
    if (status === 'running') return '실행 중';
    if (status === 'completed') return '완료';
    if (status === 'cancelled') return '취소됨';
    return status || '알 수 없음';
}

function actionLabel(action: AgenticEvaluationAction): string {
    if (action.type === 'tool') return action.toolName || '도구 호출';
    if (action.type === 'complete') return '완료 선언';
    return '형식 오류';
}

function formatReportTime(value: string | Date): string {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('ko-KR', {
        year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(date);
}

function escapeHTML(value: string): string {
    return value.replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character] || character);
}

function markdownCodeBlock(value: string): string {
    const longestBacktickRun = Math.max(0, ...(value.match(/`+/g) || []).map((run) => run.length));
    const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
    return `${fence}text\n${value || '(없음)'}\n${fence}`;
}

function base64EncodeUTF8(value: string): string {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

function agenticEvaluationReportMarker(evaluation: AgenticEvaluation): string {
    const payload = base64EncodeUTF8(JSON.stringify({version: agenticEvaluationReportFormatVersion, evaluation}));
    return `<!-- agent-chat-agentic-evaluation-report-v1 ${payload} -->`;
}

function reportFormatInfo(format: AgenticEvaluationReportFormat): {label: string; extension: string; filterName: string} {
    return format === 'html'
        ? {label: 'HTML 보고서', extension: 'html', filterName: 'HTML 파일'}
        : {label: 'Markdown', extension: 'md', filterName: 'Markdown 파일'};
}

function reportFilenamePart(value: string, fallback: string): string {
    const normalized = value
        .normalize('NFC')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
        .replace(/_{2,}/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/[. ]+$/g, '')
        .trim();
    return normalized || fallback;
}

function agenticEvaluationReportFilename(evaluation: AgenticEvaluation, format: AgenticEvaluationReportFormat): string {
    const model = reportFilenamePart((evaluation.modelIDs || []).join('_vs_'), 'model');
    const date = new Date(evaluation.updatedAt);
    const dateTag = Number.isNaN(date.getTime()) ? 'report' : date.toISOString().slice(0, 10);
    return `agentic_evaluation_${model}__${dateTag}.${reportFormatInfo(format).extension}`;
}

function runMetricLines(run: AgenticEvaluationRun): string[] {
    const lines = [`상태: ${runStatusText(run.status)}`, `행동: ${(run.actions || []).length}회`];
    if (run.retryFeedback) lines.push(`피드백: 이전 ${run.retryFeedback.attempt}회 미통과 사유 전달`);
    if (run.startedAt) lines.push(`시작: ${formatReportTime(run.startedAt)}`);
    if (run.finishedAt) lines.push(`완료: ${formatReportTime(run.finishedAt)}`);
    if (run.metrics) {
        lines.push(`전체 응답 시간: ${formatDuration(run.metrics.totalDurationMs)}`);
        if (run.metrics.firstTokenDurationMs > 0) lines.push(`첫 토큰 시간: ${formatDuration(run.metrics.firstTokenDurationMs)}`);
    }
    if (run.usage) lines.push(`토큰: 입력 ${run.usage.promptTokens} · 출력 ${run.usage.completionTokens} · 합계 ${run.usage.totalTokens}`);
    return lines;
}

function agenticRunMarkdown(run: AgenticEvaluationRun, index: number): string[] {
    const lines = [
        `## ${index + 1}. ${run.title}`,
        '',
        `- 묶음: ${run.suite || '기존 시나리오'}`,
        `- 환경: ${run.environment}`,
        ...(run.language ? [`- 언어: ${run.language}`] : []),
        `- 분류: ${run.category}`,
        `- 모델: ${run.model}`,
        `- 시나리오: ${run.scenarioID}@${run.scenarioVersion} · 시도 ${run.attempt} · 환경 변형 ${run.variant}`,
        `- 채점: ${run.graderVersion}`,
        ...runMetricLines(run).map((line) => `- ${line}`),
        '',
        '### 목표',
        '',
        markdownCodeBlock(run.goal),
    ];
    if (run.initialStateHash) lines.push('', `- 초기 상태 해시: ${run.initialStateHash}`);
    if (run.result) {
        lines.push('', '### 상태 평가', '', `- 결과: ${run.result.passed ? '통과' : '미달'} (${run.result.outcome})`, '', markdownCodeBlock(run.result.summary));
        if ((run.result.requirements || []).length) lines.push('', '#### 확인 조건', '', ...(run.result.requirements || []).map((item) => `- ${item}`));
        if ((run.result.violations || []).length) lines.push('', '#### 위반 사항', '', ...(run.result.violations || []).map((item) => `- ${item}`));
    }
    if (run.error) lines.push('', '### 오류', '', markdownCodeBlock(run.error));
    lines.push('', '### 행동 기록');
    if ((run.actions || []).length === 0) {
        lines.push('', '기록된 행동이 없습니다.');
    } else {
        (run.actions || []).forEach((action) => {
            lines.push('', `#### ${action.step}. ${actionLabel(action)} · ${action.status}`, '', `- 발생 시각: ${formatReportTime(action.occurredAt)}`);
            if (action.arguments) lines.push('', '입력값', '', markdownCodeBlock(action.arguments));
            if (action.output) lines.push('', '출력', '', markdownCodeBlock(action.output));
            if (action.rawContent) lines.push('', '원본 응답', '', markdownCodeBlock(action.rawContent));
        });
    }
    lines.push('', '### 상태 변경');
    if ((run.stateChanges || []).length === 0) {
        lines.push('', '기록된 상태 변경이 없습니다.');
    } else {
        (run.stateChanges || []).forEach((change) => {
            lines.push('', `#### ${change.resource}`, '', '이전 상태', '', markdownCodeBlock(change.before || ''), '', '변경 후 상태', '', markdownCodeBlock(change.after || ''));
        });
    }
    return lines;
}

function agenticPassTargetMarkdown(evaluation: AgenticEvaluation): string[] {
    const lines = ['# 통과까지 결과'];
    passTargets(evaluation).forEach((target) => {
        lines.push(
            '',
            `## ${target.model} · ${target.title}`,
            '',
            `- 묶음: ${target.suite || '기존 시나리오'}${target.language ? ` · ${target.language}` : ''}`,
            `- 결과: ${passTargetStatusText(target.status)}`,
            `- 시도: ${passTargetAttemptText(target, evaluation.maxAttempts)}`,
            `- 누적 실행 시간: ${formatDuration(target.activeDurationMs)}`,
        );
    });
    return lines;
}

function agenticEvaluationMarkdownReport(evaluation: AgenticEvaluation): string {
    const runs = evaluation.runs || [];
    const lines = [
        '# Agent Chat 에이전트 실험 보고서',
        '',
        `- 생성 시각: ${formatReportTime(new Date())}`,
        `- 실행 상태: ${evaluationStatusText(evaluation.status)}`,
        `- 연결 프로필: ${evaluation.profileName}`,
        `- 연결 주소: ${evaluation.profileBaseURL}`,
        `- 모델: ${(evaluation.modelIDs || []).join(', ')}`,
        `- 실험 묶음: ${[...new Set((evaluation.runs || []).map((run) => run.suite || '기존 시나리오'))].join(', ')}`,
        `- 시나리오: ${(evaluation.scenarioIDs || []).join(', ')}`,
        `- 최대 시도: ${evaluation.maxAttempts}회`,
        `- 재시도 방식: ${feedbackRetryLabel(evaluation.feedbackRetry)}`,
        `- 추론 강도: ${reasoningEffortLabel(evaluation.reasoningEffort || '')}`,
        `- 시작: ${formatReportTime(evaluation.createdAt)}`,
        `- 최종 갱신: ${formatReportTime(evaluation.updatedAt)}`,
        '',
        '> 이 보고서에는 API 키와 인증 헤더가 포함되지 않습니다.',
        '',
        agenticEvaluationReportMarker(evaluation),
        '',
        '## 실행 규칙',
        '',
        `- 행동 형식: ${evaluation.executionRules.actionFormatVersion}`,
        `- 시스템 프롬프트: ${evaluation.executionRules.systemPromptVersion}`,
        `- 도구 정의: ${evaluation.executionRules.toolDefinitionVersion}`,
        `- 채점기: ${evaluation.executionRules.graderVersion}`,
        `- 최대 행동: ${evaluation.executionRules.maxActions}`,
        `- 실행 제한: ${evaluation.executionRules.runTimeoutSeconds}초`,
        '',
        ...agenticPassTargetMarkdown(evaluation),
        '',
        '# 실행별 결과',
    ];
    runs.forEach((run, index) => lines.push('', ...agenticRunMarkdown(run, index)));
    return `${lines.join('\n')}\n`;
}

function agenticRunHTML(run: AgenticEvaluationRun, index: number): string {
    const result = run.result
        ? `<section><h3>상태 평가</h3><p><strong>${run.result.passed ? '통과' : '미달'}</strong> · ${escapeHTML(run.result.outcome)}</p><pre>${escapeHTML(run.result.summary)}</pre>${(run.result.requirements || []).length ? `<h4>확인 조건</h4><ul>${(run.result.requirements || []).map((item) => `<li>${escapeHTML(item)}</li>`).join('')}</ul>` : ''}${(run.result.violations || []).length ? `<h4>위반 사항</h4><ul class="violations">${(run.result.violations || []).map((item) => `<li>${escapeHTML(item)}</li>`).join('')}</ul>` : ''}</section>`
        : '';
    const actions = (run.actions || []).length
        ? (run.actions || []).map((action) => `<article class="trace"><h4>${action.step}. ${escapeHTML(actionLabel(action))} · ${escapeHTML(action.status)}</h4><p>발생 시각: ${escapeHTML(formatReportTime(action.occurredAt))}</p>${action.arguments ? `<h5>입력값</h5><pre>${escapeHTML(action.arguments)}</pre>` : ''}${action.output ? `<h5>출력</h5><pre>${escapeHTML(action.output)}</pre>` : ''}${action.rawContent ? `<h5>원본 응답</h5><pre>${escapeHTML(action.rawContent)}</pre>` : ''}</article>`).join('')
        : '<p class="empty">기록된 행동이 없습니다.</p>';
    const changes = (run.stateChanges || []).length
        ? (run.stateChanges || []).map((change) => `<article class="trace"><h4>${escapeHTML(change.resource)}</h4><h5>이전 상태</h5><pre>${escapeHTML(change.before || '(없음)')}</pre><h5>변경 후 상태</h5><pre>${escapeHTML(change.after || '(없음)')}</pre></article>`).join('')
        : '<p class="empty">기록된 상태 변경이 없습니다.</p>';
    return `<article class="run"><header><p class="label">실행 ${index + 1}</p><h2>${escapeHTML(run.title)}</h2></header><dl><div><dt>묶음</dt><dd>${escapeHTML(run.suite || '기존 시나리오')}</dd></div><div><dt>환경</dt><dd>${escapeHTML(run.environment)}</dd></div>${run.language ? `<div><dt>언어</dt><dd>${escapeHTML(run.language)}</dd></div>` : ''}<div><dt>분류</dt><dd>${escapeHTML(run.category)}</dd></div><div><dt>모델</dt><dd>${escapeHTML(run.model)}</dd></div><div><dt>시나리오</dt><dd>${escapeHTML(`${run.scenarioID}@${run.scenarioVersion} · 시도 ${run.attempt} · 환경 변형 ${run.variant}`)}</dd></div><div><dt>채점기</dt><dd>${escapeHTML(run.graderVersion)}</dd></div>${runMetricLines(run).map((line) => `<div><dt>실행 정보</dt><dd>${escapeHTML(line)}</dd></div>`).join('')}</dl><section><h3>목표</h3><pre>${escapeHTML(run.goal)}</pre></section>${run.initialStateHash ? `<p>초기 상태 해시: <code>${escapeHTML(run.initialStateHash)}</code></p>` : ''}${result}${run.error ? `<section><h3>오류</h3><pre>${escapeHTML(run.error)}</pre></section>` : ''}<section><h3>행동 기록</h3>${actions}</section><section><h3>상태 변경</h3>${changes}</section></article>`;
}

function agenticPassTargetHTML(evaluation: AgenticEvaluation): string {
    const rows = passTargets(evaluation).map((target) => `<tr><td>${escapeHTML(target.suite || '기존 시나리오')}${target.language ? ` · ${escapeHTML(target.language)}` : ''}</td><td>${escapeHTML(target.model)}</td><td>${escapeHTML(target.title)}</td><td>${escapeHTML(passTargetStatusText(target.status))}</td><td>${escapeHTML(passTargetAttemptText(target, evaluation.maxAttempts))}</td><td>${escapeHTML(formatDuration(target.activeDurationMs))}</td></tr>`).join('');
    return `<section class="rules"><h2>통과까지 결과</h2><table><thead><tr><th>묶음</th><th>모델</th><th>시나리오</th><th>최종 결과</th><th>시도</th><th>누적 실행 시간</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function agenticEvaluationHTMLReport(evaluation: AgenticEvaluation): string {
    const title = 'Agent Chat 에이전트 실험 보고서';
    const metadata = [
        ['실행 상태', evaluationStatusText(evaluation.status)], ['연결 프로필', evaluation.profileName], ['연결 주소', evaluation.profileBaseURL],
        ['모델', (evaluation.modelIDs || []).join(', ')], ['실험 묶음', [...new Set((evaluation.runs || []).map((run) => run.suite || '기존 시나리오'))].join(', ')], ['시나리오', (evaluation.scenarioIDs || []).join(', ')], ['최대 시도', `${evaluation.maxAttempts}회`], ['재시도 방식', feedbackRetryLabel(evaluation.feedbackRetry)],
        ['추론 강도', reasoningEffortLabel(evaluation.reasoningEffort || '')], ['시작', formatReportTime(evaluation.createdAt)], ['최종 갱신', formatReportTime(evaluation.updatedAt)],
    ].map(([label, value]) => `<div><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(value)}</dd></div>`).join('');
    const rules = [
        ['행동 형식', evaluation.executionRules.actionFormatVersion], ['시스템 프롬프트', evaluation.executionRules.systemPromptVersion],
        ['도구 정의', evaluation.executionRules.toolDefinitionVersion], ['채점기', evaluation.executionRules.graderVersion],
        ['최대 행동', String(evaluation.executionRules.maxActions)], ['실행 제한', `${evaluation.executionRules.runTimeoutSeconds}초`],
    ].map(([label, value]) => `<li><strong>${escapeHTML(label)}:</strong> ${escapeHTML(value)}</li>`).join('');
    return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHTML(title)}</title>
  <style>
    :root { color: #292925; background: #f6f6f3; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; } body { max-width: 960px; margin: 0 auto; padding: 42px 24px 64px; line-height: 1.6; } h1, h2, h3, h4, h5, p { margin-top: 0; } h1 { font-size: 28px; } h2 { margin-bottom: 0; font-size: 21px; } h3 { margin: 22px 0 9px; color: #426b80; font-size: 15px; } h4 { margin-bottom: 6px; font-size: 13px; } h5 { margin: 12px 0 5px; color: #6d6d65; font-size: 11px; } .generated, .notice, .label, .empty { color: #6f6f67; font-size: 13px; } .notice { padding: 12px 14px; border-left: 3px solid #7d9fb2; background: #edf5f9; } .rules, .run { margin-top: 22px; padding: 24px; border: 1px solid #deded7; border-radius: 14px; background: #fff; box-shadow: 0 5px 20px rgba(31, 31, 27, .04); } .label { margin-bottom: 4px; color: #56778a; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; } dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 20px 0 24px; } dl div { padding: 10px 12px; border-radius: 8px; background: #f7f7f4; } dt { color: #73736c; font-size: 11px; } dd { margin: 2px 0 0; overflow-wrap: anywhere; font-size: 13px; } section + section { margin-top: 18px; } pre { margin: 0; padding: 14px; overflow-x: auto; border: 1px solid #e1e1db; border-radius: 8px; background: #fbfbf9; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.65 ui-monospace, SFMono-Regular, Menlo, monospace; } .trace { margin-top: 10px; padding: 14px; border: 1px solid #e6e6e0; border-radius: 9px; background: #fcfcfa; } .trace > p { color: #777770; font-size: 12px; } ul { padding-left: 20px; } .violations { color: #a2574d; } code { padding: .12em .34em; border-radius: 4px; background: #f0f0ec; font: .9em ui-monospace, SFMono-Regular, Menlo, monospace; } @media print { body { max-width: none; padding: 20px; background: #fff; } .run, .rules { break-inside: avoid; box-shadow: none; } }
  </style>
</head>
<body>
  <main>
    <header><h1>${escapeHTML(title)}</h1><p class="generated">생성 시각: ${escapeHTML(formatReportTime(new Date()))}</p><p class="notice">이 보고서에는 API 키와 인증 헤더가 포함되지 않습니다.</p></header>
    <section class="rules"><h2>실행 요약</h2><dl>${metadata}</dl><h3>실행 규칙</h3><ul>${rules}</ul></section>
    ${agenticPassTargetHTML(evaluation)}
    ${(evaluation.runs || []).map(agenticRunHTML).join('')}
  </main>
  ${agenticEvaluationReportMarker(evaluation)}
</body>
</html>`;
}

function passTargetKey(model: string, scenarioID: string): string {
    return `${model}\u0000${scenarioID}`;
}

function passTargets(evaluation: AgenticEvaluation): PassTarget[] {
    const targets = new Map<string, PassTarget & {runs: AgenticEvaluationRun[]}>();
    for (const model of evaluation.modelIDs || []) {
        for (const scenarioID of evaluation.scenarioIDs || []) {
            const key = passTargetKey(model, scenarioID);
            targets.set(key, {
                key, model, scenarioID, suite: '', title: scenarioID, environment: '', language: '', category: '', attempts: 0,
                activeDurationMs: 0, inputTokens: 0, outputTokens: 0, status: 'pending', runOrder: Number.MAX_SAFE_INTEGER, runs: [],
            });
        }
    }
    for (const [runIndex, run] of (evaluation.runs || []).entries()) {
        const key = passTargetKey(run.model, run.scenarioID);
        const current = targets.get(key) || {
            key, model: run.model, scenarioID: run.scenarioID, suite: run.suite || '', title: run.title, environment: run.environment, language: run.language || '', category: run.category,
            attempts: 0, activeDurationMs: 0, inputTokens: 0, outputTokens: 0, status: 'pending' as PassTargetStatus, runOrder: runIndex, runs: [],
        };
        current.suite = run.suite || current.suite;
        current.title = run.title || current.title;
        current.environment = run.environment || current.environment;
        current.language = run.language || current.language;
        current.category = run.category || current.category;
        current.runOrder = Math.min(current.runOrder, runIndex);
        current.runs.push(run);
        targets.set(key, current);
    }
    return Array.from(targets.values()).map((target) => {
        const runs = target.runs.sort((left, right) => left.attempt - right.attempt);
        const attempted = runs.filter((run) => Boolean(run.startedAt));
        const passed = attempted.find((run) => run.result?.passed);
        target.attempts = attempted.length;
        target.activeDurationMs = attempted.reduce((total, run) => total + runDurationMs(run), 0);
        target.inputTokens = attempted.reduce((total, run) => total + (run.usage?.promptTokens || 0), 0);
        target.outputTokens = attempted.reduce((total, run) => total + (run.usage?.completionTokens || 0), 0);
        if (passed) target.status = 'passed';
        else if (evaluation.status === 'cancelled') target.status = 'cancelled';
        else if (attempted.length >= evaluation.maxAttempts || evaluation.status === 'completed') target.status = 'not-passed';
        else if (runs.some((run) => run.status === 'running')) target.status = 'running';
        return target;
    }).sort((left, right) => left.runOrder - right.runOrder);
}

function aggregateByModel(targets: PassTarget[]): ModelAggregate[] {
    const aggregate = new Map<string, ModelAggregate>();
    for (const target of targets) {
        const current = aggregate.get(target.model) || {
            model: target.model, total: 0, passed: 0, attempts: 0, passedDurationMs: 0, inputTokens: 0, outputTokens: 0,
        };
        current.total += 1;
        current.attempts += target.attempts;
        current.inputTokens += target.inputTokens;
        current.outputTokens += target.outputTokens;
        if (target.status === 'passed') {
            current.passed += 1;
            current.passedDurationMs += target.activeDurationMs;
        }
        aggregate.set(target.model, current);
    }
    return Array.from(aggregate.values()).sort((left, right) => left.model.localeCompare(right.model));
}

function aggregateByEnvironment(targets: PassTarget[]): Array<{environment: string; total: number; finished: number; passed: number}> {
    const aggregate = new Map<string, {environment: string; total: number; finished: number; passed: number}>();
    for (const target of targets) {
        const current = aggregate.get(target.environment) || {environment: target.environment, total: 0, finished: 0, passed: 0};
        current.total += 1;
        if (target.status === 'passed' || target.status === 'not-passed' || target.status === 'cancelled') current.finished += 1;
        if (target.status === 'passed') current.passed += 1;
        aggregate.set(target.environment, current);
    }
    return Array.from(aggregate.values()).sort((left, right) => left.environment.localeCompare(right.environment));
}

function groupTargetsBySuite(targets: PassTarget[]): Array<{suite: string; targets: PassTarget[]}> {
    const groups = new Map<string, PassTarget[]>();
    for (const target of targets) {
        const suite = target.suite || '기존 시나리오';
        groups.set(suite, [...(groups.get(suite) || []), target]);
    }
    return Array.from(groups, ([suite, suiteTargets]) => ({suite, targets: suiteTargets}));
}

function passTargetAttemptText(target: PassTarget, maxAttempts: number): string {
    if (target.status === 'passed') return `${target.attempts}회 만에 통과`;
    if (target.status === 'not-passed') return `${target.attempts}회 시도했으나 미통과`;
    if (target.status === 'cancelled') return `${target.attempts}/${maxAttempts}회 시도 후 취소`;
    return `${target.attempts}/${maxAttempts}회 시도`;
}

function groupScenarios(scenarios: AgenticEvaluationScenarioSummary[]) {
    return scenarios.reduce<Record<string, AgenticEvaluationScenarioSummary[]>>((groups, scenario) => {
        const suite = scenario.suite || '기존 시나리오';
        groups[suite] = [...(groups[suite] || []), scenario];
        return groups;
    }, {});
}

export default function AgenticEvaluationWorkspace({
    profiles,
    connectionAPIKey,
    openRouterModelIDs,
    onOpenRouterModelIDsChange,
    onBusyChange,
    onSidebarChange,
    sidebarAction,
    onSidebarActionHandled,
}: AgenticEvaluationWorkspaceProps) {
    const [profileID, setProfileID] = useState('');
    const [apiKey, setAPIKey] = useState('');
    const [models, setModels] = useState<Model[]>([]);
    const [selectedModels, setSelectedModels] = useState<string[]>([]);
    const [loadingModels, setLoadingModels] = useState(false);
    const [openRouterPickerOpen, setOpenRouterPickerOpen] = useState(false);
    const [scenarios, setScenarios] = useState<AgenticEvaluationScenarioSummary[]>([]);
    const [selectedScenarioIDs, setSelectedScenarioIDs] = useState<string[]>([]);
    const [maxAttempts, setMaxAttempts] = useState(3);
    const [feedbackRetry, setFeedbackRetry] = useState(false);
    const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('');
    const [history, setHistory] = useState<AgenticEvaluationSummary[]>([]);
    const [loadingHistory, setLoadingHistory] = useState(true);
    const [evaluation, setEvaluation] = useState<AgenticEvaluation | null>(null);
    const [view, setView] = useState<'home' | 'result'>('home');
    const [error, setError] = useState('');
    const [starting, setStarting] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [exportingFormat, setExportingFormat] = useState<AgenticEvaluationReportFormat | null>(null);
    const [exportMessage, setExportMessage] = useState('');
    const [importing, setImporting] = useState(false);
    const [importMessage, setImportMessage] = useState('');
    const [activeResultSectionID, setActiveResultSectionID] = useState('');
    const handledSidebarActionSequence = useRef<number | null>(null);

    const selectedProfile = useMemo(
        () => profiles.find((profile) => profile.id === profileID),
        [profileID, profiles],
    );
    const usingOpenRouter = isOpenRouterURL(selectedProfile?.baseURL || '');
    const availableModels = useMemo(() => (
        usingOpenRouter
            ? models.filter((model) => openRouterModelIDs.includes(model.id))
            : models
    ), [models, openRouterModelIDs, usingOpenRouter]);
    const scenarioGroups = useMemo(() => groupScenarios(scenarios), [scenarios]);
    const running = evaluation?.status === 'running';
    const reasoningWarning = reasoningEffortWarning(reasoningEffort);
    const plannedRunCount = selectedModels.length * selectedScenarioIDs.length * maxAttempts;
    const runCountOverLimit = plannedRunCount > maxAgenticEvaluationRuns;
    const resultSidebarSections = useMemo<AgenticEvaluationSidebarSection[]>(() => {
        if (view !== 'result' || !evaluation) return [];
        const targetGroups = groupTargetsBySuite(passTargets(evaluation));
        return [
            ...targetGroups.map((group, index) => ({
                id: `agentic-model-pass-${index}`,
                label: `${group.suite} 모델별 통과 시간`,
            })),
            ...targetGroups.map((group, index) => ({
                id: `agentic-scenario-results-${index}`,
                label: `${group.suite} 시나리오별 최종 결과`,
            })),
            {id: 'agentic-run-results', label: '실행별 결과'},
        ];
    }, [evaluation, view]);

    const refreshHistory = useCallback(async () => {
        try {
            const loaded = await ChatService.ListAgenticEvaluations();
            setHistory(loaded || []);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setLoadingHistory(false);
        }
    }, []);

    const refreshEvaluation = useCallback(async (id: string) => {
        try {
            const opened = await ChatService.OpenAgenticEvaluation(id);
            setEvaluation(opened);
            return opened;
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
            return null;
        }
    }, []);

    useEffect(() => {
        if (connectionAPIKey) setAPIKey(connectionAPIKey);
    }, [connectionAPIKey]);

    useEffect(() => {
        if (!profileID && profiles.length > 0) setProfileID(profiles[0].id);
        if (profileID && !profiles.some((profile) => profile.id === profileID)) setProfileID(profiles[0]?.id || '');
    }, [profileID, profiles]);

    useEffect(() => {
        let active = true;
        void ChatService.ListAgenticEvaluationScenarios().then((loaded) => {
            if (!active) return;
            const next = loaded || [];
            setScenarios(next);
            setSelectedScenarioIDs((current) => current.length > 0
                ? current.filter((id) => next.some((scenario) => scenario.id === id))
                : next.map((scenario) => scenario.id));
        }).catch((reason) => {
            if (active) setError(reason instanceof Error ? reason.message : String(reason));
        });
        return () => { active = false; };
    }, []);

    useEffect(() => {
        setLoadingHistory(true);
        void refreshHistory();
    }, [refreshHistory]);

    useEffect(() => {
        onBusyChange(running);
        return () => onBusyChange(false);
    }, [onBusyChange, running]);

    useEffect(() => {
        const availableSectionIDs = new Set(resultSidebarSections.map((section) => section.id));
        setActiveResultSectionID((current) => (
            availableSectionIDs.has(current) ? current : resultSidebarSections[0]?.id || ''
        ));
    }, [resultSidebarSections]);

    useEffect(() => {
        onSidebarChange({
            sections: resultSidebarSections,
            activeSectionID: activeResultSectionID,
            history,
            loadingHistory,
            selectedEvaluationID: view === 'result' ? evaluation?.id || '' : '',
        });
    }, [activeResultSectionID, evaluation?.id, history, loadingHistory, onSidebarChange, resultSidebarSections, view]);

    useEffect(() => () => onSidebarChange({
        sections: [], activeSectionID: '', history: [], loadingHistory: false, selectedEvaluationID: '',
    }), [onSidebarChange]);

    useEffect(() => {
        if (!sidebarAction || handledSidebarActionSequence.current === sidebarAction.sequence) return;
        handledSidebarActionSequence.current = sidebarAction.sequence;
        const {id, kind, sequence} = sidebarAction;
        void (async () => {
            try {
                setError('');
                if (kind === 'open') {
                    const opened = await ChatService.OpenAgenticEvaluation(id);
                    setEvaluation(opened);
                    setView('result');
                    document.querySelector<HTMLElement>('.benchmark-panel')?.scrollTo(0, 0);
                } else {
                    await ChatService.DeleteAgenticEvaluation(id);
                    if (evaluation?.id === id) {
                        setEvaluation(null);
                        setView('home');
                        document.querySelector<HTMLElement>('.benchmark-panel')?.scrollTo(0, 0);
                    }
                    await refreshHistory();
                }
            } catch (reason) {
                setError(reason instanceof Error ? reason.message : String(reason));
            } finally {
                onSidebarActionHandled(sequence);
            }
        })();
    }, [evaluation?.id, onSidebarActionHandled, refreshHistory, sidebarAction]);

    useEffect(() => {
        if (resultSidebarSections.length === 0 || typeof IntersectionObserver === 'undefined') return undefined;
        const scrollPanel = document.querySelector<HTMLElement>('.benchmark-panel');
        const sections = resultSidebarSections
            .map((section) => document.getElementById(section.id))
            .filter((section): section is HTMLElement => section !== null);
        if (sections.length === 0) return undefined;

        const observer = new IntersectionObserver((entries) => {
            const visible = entries
                .filter((entry) => entry.isIntersecting)
                .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
            if (visible[0]) setActiveResultSectionID(visible[0].target.id);
        }, {
            root: scrollPanel,
            rootMargin: '-48px 0px -62% 0px',
            threshold: 0.01,
        });
        sections.forEach((section) => observer.observe(section));
        return () => observer.disconnect();
    }, [resultSidebarSections]);

    useEffect(() => {
        const listener = Events.On(agenticEvaluationEventName, (event) => {
            const payload = event.data as {evaluationID?: string};
            if (!payload.evaluationID) return;
            void refreshHistory();
            if (evaluation?.id === payload.evaluationID) void refreshEvaluation(payload.evaluationID);
        });
        return listener;
    }, [evaluation?.id, refreshEvaluation, refreshHistory]);

    useEffect(() => {
        setSelectedModels((current) => current.filter((id) => availableModels.some((model) => model.id === id)));
    }, [availableModels]);

    async function loadModels() {
        if (!selectedProfile) {
            setError('연결 프로필을 선택해 주세요.');
            return;
        }
        try {
            setLoadingModels(true);
            setError('');
            const loaded = await ChatService.ListModels({baseURL: selectedProfile.baseURL, apiKey});
            const next = loaded || [];
            setModels(next);
            if (isOpenRouterURL(selectedProfile.baseURL)) {
                setSelectedModels((current) => current.filter((id) => openRouterModelIDs.includes(id)));
            } else {
                setSelectedModels((current) => current.length > 0
                    ? current.filter((id) => next.some((model) => model.id === id))
                    : next.slice(0, 1).map((model) => model.id));
            }
        } catch (reason) {
            setModels([]);
            setSelectedModels([]);
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setLoadingModels(false);
        }
    }

    function handleAPIKeyKeyDown(event: KeyboardEvent<HTMLInputElement>) {
        if (event.key !== 'Enter' || loadingModels || !selectedProfile) return;
        event.preventDefault();
        void loadModels();
    }

    function toggleModel(modelID: string) {
        setSelectedModels((current) => current.includes(modelID)
            ? current.filter((id) => id !== modelID)
            : [...current, modelID]);
    }

    function toggleScenario(scenarioID: string) {
        setSelectedScenarioIDs((current) => current.includes(scenarioID)
            ? current.filter((id) => id !== scenarioID)
            : [...current, scenarioID]);
    }

    function setSuiteSelection(suite: string, selected: boolean) {
        const ids = (scenarioGroups[suite] || []).map((scenario) => scenario.id);
        setSelectedScenarioIDs((current) => selected
            ? Array.from(new Set([...current, ...ids]))
            : current.filter((id) => !ids.includes(id)));
    }

    async function startEvaluation() {
        if (!selectedProfile || selectedModels.length === 0 || selectedScenarioIDs.length === 0) {
            setError('연결 프로필, 모델, 시나리오를 모두 선택해 주세요.');
            return;
        }
        if (usingOpenRouter && !apiKey.trim()) {
            setError('OpenRouter 프로필은 API 키를 입력해 주세요.');
            return;
        }
        try {
            setStarting(true);
            setError('');
            const profile: ConnectionProfile = {baseURL: selectedProfile.baseURL, apiKey: apiKey.trim()};
            const started = await ChatService.StartAgenticEvaluation({
                profile,
                profileID: selectedProfile.id,
                profileName: selectedProfile.name,
                modelIDs: selectedModels,
                scenarioIDs: selectedScenarioIDs,
                maxAttempts,
                feedbackRetry,
                reasoningEffort,
            });
            setEvaluation(started);
            setView('result');
            void refreshHistory();
            void refreshEvaluation(started.id);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setStarting(false);
        }
    }

    async function cancelEvaluation() {
        if (!evaluation || !running) return;
        try {
            setCancelling(true);
            setError('');
            await ChatService.CancelAgenticEvaluation(evaluation.id);
            await refreshEvaluation(evaluation.id);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setCancelling(false);
        }
    }

    async function exportEvaluationReport(format: AgenticEvaluationReportFormat) {
        if (!evaluation || running || exportingFormat) return;
        const formatInfo = reportFormatInfo(format);
        try {
            setExportingFormat(format);
            setExportMessage('');
            setError('');
            const path = await Dialogs.SaveFile({
                Title: `에이전트 실험 ${formatInfo.label} 저장`,
                ButtonText: '보고서 저장',
                Filename: agenticEvaluationReportFilename(evaluation, format),
                Filters: [{DisplayName: formatInfo.filterName, Pattern: `*.${formatInfo.extension}`}],
            });
            if (!path) return;
            const contents = format === 'html'
                ? agenticEvaluationHTMLReport(evaluation)
                : agenticEvaluationMarkdownReport(evaluation);
            await ChatService.SaveAgenticEvaluationExport(path, contents);
            setExportMessage(`${formatInfo.label}를 저장했습니다.`);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setExportingFormat(null);
        }
    }

    async function importEvaluationReport() {
        if (running || importing) return;
        try {
            setImporting(true);
            setImportMessage('');
            setError('');
            const path = await Dialogs.OpenFile({
                Title: '에이전트 실험 보고서 가져오기',
                ButtonText: '보고서 가져오기',
                Filters: [{DisplayName: '에이전트 실험 보고서', Pattern: '*.md;*.html'}],
            });
            if (!path) return;
            const result = await ChatService.ImportAgenticEvaluationReport(path);
            await refreshHistory();
            setEvaluation(result.evaluation);
            setView('result');
            setImportMessage(result.duplicate ? '이미 저장된 동일한 보고서입니다.' : '에이전트 실험 보고서를 가져왔습니다.');
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setImporting(false);
        }
    }

    function applyOpenRouterModels(nextIDs: string[]) {
        onOpenRouterModelIDsChange(nextIDs);
        setSelectedModels((current) => current.filter((id) => nextIDs.includes(id)));
    }

    function renderRun(run: AgenticEvaluationRun) {
        const result = run.result;
        return <article className="agentic-run-card" key={run.id}>
            <header className="agentic-run-heading">
                <div>
                    <span>{run.suite || '기존 시나리오'} · {run.environment}{run.language ? ` · ${run.language}` : ''}</span>
                    <strong>{run.title}</strong>
                    <small>{run.model} · {run.category} · 시도 {run.attempt} · 환경 변형 {run.variant} · {run.scenarioID}@{run.scenarioVersion}</small>
                    {run.initialStateHash && <small>초기 상태 {run.initialStateHash.slice(0, 12)} · 채점 {run.graderVersion}</small>}
                </div>
                <span className={`agentic-status ${run.status}`}>{runStatusText(run.status)}</span>
            </header>
            <p className="agentic-run-goal">{run.goal}</p>
            {run.retryFeedback && <p className="agentic-retry-feedback">이전 {run.retryFeedback.attempt}회차의 미통과 사유를 전달한 재시도입니다. 이전 실행의 변경 사항은 이어받지 않습니다.</p>}
            {result && <section className={`agentic-result ${result.passed ? 'passed' : 'failed'}`}>
                <strong>{result.passed ? '상태 평가 통과' : '상태 평가 미달'}</strong>
                <p>{result.summary}</p>
                {(result.requirements || []).length > 0 && <ul><li>확인 조건: {(result.requirements || []).join(' · ')}</li></ul>}
                {(result.violations || []).length > 0 && <ul className="agentic-violations">{(result.violations || []).map((violation) => <li key={violation}>{violation}</li>)}</ul>}
            </section>}
            {run.error && <p className="agentic-run-error">{run.error}</p>}
            <div className="agentic-run-metrics">
                <span>행동 {(run.actions || []).length}회</span>
                {run.metrics && <span>응답 {formatDuration(run.metrics.totalDurationMs)}</span>}
                {run.usage && <span>입력 {run.usage.promptTokens} · 출력 {run.usage.completionTokens} 토큰</span>}
                {run.finishedAt && <span>{formatTime(run.finishedAt)}</span>}
            </div>
            {(run.actions || []).length > 0 && <details className="agentic-details">
                <summary>행동 기록 {(run.actions || []).length}개</summary>
                <ol className="agentic-action-list">
                    {(run.actions || []).map((action) => <li key={`${action.step}-${action.occurredAt}`} className={action.status}>
                        <div><strong>{action.step}. {actionLabel(action)}</strong><span>{action.status === 'success' ? '성공' : '오류'}</span></div>
                        {action.arguments && <code>{action.arguments}</code>}
                        {action.output && <pre>{action.output}</pre>}
                        {action.rawContent && action.type === 'invalid' && <pre>{action.rawContent}</pre>}
                    </li>)}
                </ol>
            </details>}
            {(run.stateChanges || []).length > 0 && <details className="agentic-details">
                <summary>상태 변경 {(run.stateChanges || []).length}개</summary>
                <div className="agentic-change-list">
                    {(run.stateChanges || []).map((change) => <article key={`${change.resource}-${change.after}`}>
                        <strong>{change.resource}</strong>
                        {change.before && <pre>{change.before}</pre>}
                        <span>→</span>
                        {change.after && <pre>{change.after}</pre>}
                    </article>)}
                </div>
            </details>}
        </article>;
    }

    if (view === 'result' && evaluation) {
        const runs = evaluation.runs || [];
        const targets = passTargets(evaluation);
        const targetGroups = groupTargetsBySuite(targets);
        const completedTargets = targets.filter((target) => target.status === 'passed' || target.status === 'not-passed' || target.status === 'cancelled').length;
        const passedTargets = targets.filter((target) => target.status === 'passed').length;
        return <section className="agentic-page" aria-label="에이전트 실험 결과">
            <header className="agentic-header">
                <div>
                    <span className="eyebrow">AGENTIC EVALUATION</span>
                    <h1>{running ? '에이전트 실험 실행 중' : '에이전트 실험 결과'}</h1>
                    <p>{evaluation.profileName} · 추론 {reasoningEffortLabel(evaluation.reasoningEffort || '')} · {formatTime(evaluation.createdAt)}</p>
                </div>
                <div className="agentic-header-actions">
                    {!running && <><button className="agentic-report-button" type="button" onClick={() => void exportEvaluationReport('html')} disabled={exportingFormat !== null}>{exportingFormat === 'html' ? '저장 창 여는 중…' : 'HTML 보고서'}</button>
                    <button className="agentic-report-button" type="button" onClick={() => void exportEvaluationReport('markdown')} disabled={exportingFormat !== null}>{exportingFormat === 'markdown' ? '저장 창 여는 중…' : 'Markdown'}</button></>}
                    <button className="text-button" type="button" disabled={running} onClick={() => setView('home')}>실험 홈</button>
                    {running && <button className="danger-button" type="button" onClick={() => void cancelEvaluation()} disabled={cancelling}>{cancelling ? '취소 중…' : '실행 취소'}</button>}
                </div>
            </header>
            {error && <p className="error-banner">{error}</p>}
            {exportMessage && <p className="agentic-transfer-status" role="status">{exportMessage}</p>}
            {importMessage && <p className="agentic-transfer-status" role="status">{importMessage}</p>}
            <section className="agentic-summary-grid">
                <div><span>진행</span><strong>{completedTargets}/{targets.length}</strong></div>
                <div><span>최종 통과</span><strong>{passedTargets}/{targets.length}</strong></div>
                <div><span>선택 모델</span><strong>{evaluation.modelIDs?.length || 0}</strong></div>
                <div><span>최대 시도</span><strong>{evaluation.maxAttempts}회</strong></div>
            </section>
            <section className="agentic-info-card">
                <strong>실행 격리</strong>
                <p>각 실행은 시나리오 원본에서 새 상태를 만들고, 허용된 가상 도구만 호출합니다. 실행이 끝나면 원본과 작업 사본은 폐기되고 행동 기록과 상태 차이만 보관됩니다.</p>
                <div className="agentic-rule-list">
                    <span>행동 {evaluation.executionRules.actionFormatVersion}</span>
                    <span>지시 {evaluation.executionRules.systemPromptVersion}</span>
                    <span>도구 {evaluation.executionRules.toolDefinitionVersion}</span>
                    <span>채점 {evaluation.executionRules.graderVersion}</span>
                    <span>최대 {evaluation.executionRules.maxActions} 행동 · {Math.floor(evaluation.executionRules.runTimeoutSeconds / 60)}분</span>
                    <span>{feedbackRetryLabel(evaluation.feedbackRetry)}</span>
                </div>
            </section>
            {targetGroups.map((group, index) => {
                const aggregate = aggregateByModel(group.targets);
                const environmentAggregate = aggregateByEnvironment(group.targets);
                return <section className="agentic-comparison-card agentic-suite-results" id={`agentic-model-pass-${index}`} key={group.suite}>
                    <div className="agentic-card-heading"><div><span className="eyebrow">MODEL COMPARISON · {group.suite}</span><h2>{group.suite} 모델별 통과 시간</h2></div><small>대기열 시간은 제외하고 실제 실행 시간만 합산합니다.</small></div>
                    <div className="agentic-comparison-table" role="table" aria-label={`${group.suite} 모델별 에이전트 실험 결과`}>
                        <div className="agentic-comparison-row header" role="row"><span>모델</span><span>통과</span><span>총 시도</span><span>평균 통과 시간</span><span>토큰</span></div>
                        {aggregate.map((item) => <div className="agentic-comparison-row" role="row" key={item.model}>
                            <strong title={item.model}>{item.model}</strong><span>{item.passed}/{item.total}</span><span>{item.attempts}회</span><span>{item.passed ? formatDuration(item.passedDurationMs / item.passed) : '—'}</span><span>{item.inputTokens + item.outputTokens}</span>
                        </div>)}
                    </div>
                    <div className="agentic-environment-summary" aria-label={`${group.suite} 환경별 성공 현황`}>
                        {environmentAggregate.map((item) => <article key={item.environment}><span>{item.environment}</span><strong>{item.passed}/{item.total}</strong><small>{item.finished}/{item.total} 완료</small></article>)}
                    </div>
                </section>;
            })}
            {targetGroups.map((group, index) => <section className="agentic-comparison-card agentic-suite-results" id={`agentic-scenario-results-${index}`} key={`${group.suite}-targets`}>
                <div className="agentic-card-heading"><div><span className="eyebrow">TIME TO PASS · {group.suite}</span><h2>{group.suite} 시나리오별 최종 결과</h2></div><small>통과한 조합은 즉시 종료하고, 미통과 조합은 실제 시도 횟수를 남깁니다.</small></div>
                <div className="agentic-pass-target-table" role="table" aria-label={`${group.suite} 시나리오별 통과 결과`}>
                    <div className="agentic-pass-target-row header" role="row"><span>모델</span><span>시나리오</span><span>최종 결과</span><span>시도 기록</span><span>누적 실행 시간</span></div>
                    {group.targets.map((target) => <div className="agentic-pass-target-row" role="row" key={target.key}>
                        <strong title={target.model}>{target.model}</strong><span title={target.scenarioID}>{target.title}{target.language ? ` · ${target.language}` : ''}</span><span className={`agentic-target-status ${target.status}`}>{passTargetStatusText(target.status)}</span><span>{passTargetAttemptText(target, evaluation.maxAttempts)}</span><span>{formatDuration(target.activeDurationMs)}</span>
                    </div>)}
                </div>
            </section>)}
            <section className="agentic-runs-section" id="agentic-run-results">
                <div className="agentic-card-heading"><div><span className="eyebrow">RUN TRACE</span><h2>실행별 결과</h2></div><small>도구 호출, 복구 시도, 최종 상태 평가를 확인할 수 있습니다.</small></div>
                <div className="agentic-run-list">{runs.map(renderRun)}</div>
            </section>
        </section>;
    }

    return <section className="agentic-page" aria-label="에이전트 실험">
        <header className="agentic-header">
            <div>
                <span className="eyebrow">AGENTIC EVALUATION</span>
                <h1>에이전트 실험</h1>
                <p>모델이 제한된 가상 환경에서 도구를 고르고, 오류를 복구하며, 목표 상태를 만드는 과정을 평가합니다.</p>
            </div>
            <div className="agentic-header-actions">
                <button className="agentic-report-button" type="button" onClick={() => void importEvaluationReport()} disabled={importing}>{importing ? '보고서 읽는 중…' : '보고서 가져오기'}</button>
            </div>
        </header>
        {error && <p className="error-banner">{error}</p>}
        {importMessage && <p className="agentic-transfer-status" role="status">{importMessage}</p>}
        <section className="agentic-info-card">
            <strong>안전한 가상 실행</strong>
            <p>실제 파일, 셸, 네트워크에는 접근하지 않습니다. 문서 작업 공간과 업무 기록 도구의 사본을 메모리에서 제공하고 실행 후 버립니다.</p>
        </section>
        <section className="agentic-setup-grid">
            <article className="agentic-setup-card">
                <div className="agentic-card-heading"><div><span className="eyebrow">1. CONNECTION</span><h2>연결과 모델</h2></div></div>
                <label className="agentic-field"><span>연결 프로필</span><select value={profileID} onChange={(event) => { setProfileID(event.target.value); setModels([]); setSelectedModels([]); }}>
                    <option value="">선택하세요</option>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}
                </select></label>
                <label className="agentic-field"><span>API 키 <small>{usingOpenRouter ? 'OpenRouter · 실행 중에만 사용' : '필요한 경우 · 실행 중에만 사용'}</small></span><input value={apiKey} onChange={(event) => setAPIKey(event.target.value)} onKeyDown={handleAPIKeyKeyDown} type="password" placeholder={usingOpenRouter ? 'OpenRouter API 키 입력' : '필요한 경우 입력'} autoComplete="off" /></label>
                <div className="agentic-model-load"><button className="primary-button agentic-model-load-button" type="button" onClick={() => void loadModels()} disabled={loadingModels || !selectedProfile}>{loadingModels ? '모델 불러오는 중…' : '모델 불러오기'}</button>
                    {usingOpenRouter && <button className="text-button" type="button" onClick={() => setOpenRouterPickerOpen(true)} disabled={models.length === 0}>표시 모델 고르기</button>}</div>
                <div className="agentic-model-selection" aria-label="실험할 모델">
                    {availableModels.length === 0 ? <p>모델을 불러온 뒤 하나 이상 선택하세요.</p> : availableModels.map((model) => <label key={model.id}><input type="checkbox" checked={selectedModels.includes(model.id)} onChange={() => toggleModel(model.id)} /><span>{model.id}</span></label>)}
                </div>
            </article>
            <article className="agentic-setup-card">
                <div className="agentic-card-heading"><div><span className="eyebrow">2. SCENARIOS</span><h2>가상 환경과 시나리오</h2></div><small>{selectedScenarioIDs.length}/{scenarios.length}개 선택</small></div>
                <div className="agentic-scenario-groups">{Object.entries(scenarioGroups).map(([suite, items]) => {
                    const suiteSelected = items.every((scenario) => selectedScenarioIDs.includes(scenario.id));
                    return <section className="agentic-scenario-suite" key={suite}>
                        <label className="agentic-suite"><input type="checkbox" checked={suiteSelected} onChange={(event) => setSuiteSelection(suite, event.target.checked)} /><span><strong>{suite}</strong><small>{items.length}개 시나리오</small></span></label>
                        {items.map((scenario) => <label className="agentic-scenario" key={scenario.id}><input type="checkbox" checked={selectedScenarioIDs.includes(scenario.id)} onChange={() => toggleScenario(scenario.id)} /><span><strong>{scenario.title}</strong><small>{scenario.language ? `${scenario.language} · ${scenario.category}` : scenario.category} · {scenario.description}</small></span></label>)}
                    </section>;
                })}</div>
            </article>
            <article className="agentic-setup-card agentic-run-settings">
                <div className="agentic-card-heading"><div><span className="eyebrow">3. RUN</span><h2>통과 조건</h2></div></div>
                <label className="agentic-field"><span>최대 시도</span><select value={maxAttempts} onChange={(event) => setMaxAttempts(Number(event.target.value))}>{[1, 2, 3, 4, 5].map((count) => <option value={count} key={count}>{count}회</option>)}</select></label>
                <label className="agentic-field"><span>추론 강도</span><select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)}>{reasoningEffortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                <label className="agentic-field agentic-feedback-retry"><span>피드백 재시도</span><span><input type="checkbox" checked={feedbackRetry} onChange={(event) => setFeedbackRetry(event.target.checked)} disabled={starting} />미통과 사유 전달</span></label>
                {reasoningWarning && <p className="agentic-warning">{reasoningWarning}</p>}
                <p className="agentic-run-count">최대 <strong>{plannedRunCount}</strong>회까지 실행합니다. {feedbackRetry ? '피드백 재시도는 같은 초기 환경에서 채점 사유를 전달합니다.' : '모델·시나리오 조합이 통과하면 해당 조합은 즉시 종료합니다.'}</p>
                <button className="primary-button" type="button" onClick={() => void startEvaluation()} disabled={starting || runCountOverLimit || !selectedProfile || selectedModels.length === 0 || selectedScenarioIDs.length === 0}>{starting ? '실험 준비 중…' : '에이전트 실험 시작'}</button>
                {runCountOverLimit && <p className="agentic-warning">한 대기열은 최대 {maxAgenticEvaluationRuns}회까지 실행할 수 있습니다. 모델, 시나리오 또는 최대 시도 횟수를 줄여 주세요.</p>}
            </article>
        </section>
        <OpenRouterModelPicker
            open={openRouterPickerOpen}
            models={models}
            selectedModel=""
            selectedModelIDs={openRouterModelIDs}
            onClose={() => setOpenRouterPickerOpen(false)}
            onApply={applyOpenRouterModels}
        />
    </section>;
}
