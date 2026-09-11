import {FormEvent, useEffect, useMemo, useRef, useState} from 'react';
import {Dialogs, Events} from '@wailsio/runtime';
import ReactMarkdown from 'react-markdown';
import {renderToStaticMarkup} from 'react-dom/server';
import remarkGfm from 'remark-gfm';
import {App as ChatService} from '../bindings/github.com/taengson/agent-chat-desktop';
import OpenRouterModelPicker, {isOpenRouterURL} from './OpenRouterModelPicker';
import type {
    ChatEvent,
    ConnectionProfile,
    Model,
    ModelBenchmark,
    ModelBenchmarkCase,
    ModelBenchmarkSummary,
    ResponseMetrics,
    SavedConnectionProfile,
    TokenUsage,
} from '../bindings/github.com/taengson/agent-chat-desktop/models';
import {
    reasoningEffortFilenameTag,
    reasoningEffortLabel,
    reasoningEffortOptions,
    reasoningEffortWarning,
    type ReasoningEffort,
} from './reasoningEffort';

const chatEventName = 'chat:event';
const openRouterProfileID = 'builtin-openrouter';
const openRouterBenchmarkProfile: SavedConnectionProfile = {
    id: openRouterProfileID,
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
};

type BenchmarkCaseDraft = Pick<ModelBenchmarkCase, 'category' | 'title' | 'prompt'>;
type BenchmarkSuite = {
    id: string;
    name: string;
    description: string;
    templates: BenchmarkCaseDraft[];
};
type BenchmarkHomeTab = 'run' | 'analysis' | 'comparison' | 'practical';
type BenchmarkMetric = 'totalDuration' | 'firstToken' | 'generationSpeed' | 'outputTokens';
type BenchmarkChartScale = 'relative' | 'absolute';
type BenchmarkExportKind = 'analysis' | 'comparison' | 'practical';
type BenchmarkExportFormat = 'html' | 'markdown';
type PracticalBenchmarkSuite = 'document' | 'development';
type PracticalComparisonLabel = 'A' | 'B' | 'C';

type PracticalBenchmarkPair = {
    document: ModelBenchmark;
    development: ModelBenchmark;
};

type PracticalBenchmarkPairs = Record<PracticalComparisonLabel, PracticalBenchmarkPair | null>;

type PracticalBenchmarkPairCandidate = {
    id: string;
    document: ModelBenchmarkSummary;
    development: ModelBenchmarkSummary;
};

const benchmarkReportFormatVersion = 1;
const benchmarkReportMarkerName = 'agent-chat-benchmark-report-v1';
const practicalBenchmarkSuiteLabels: Record<PracticalBenchmarkSuite, string> = {
    document: '문서·한국어 실무',
    development: '개발·지시 이행',
};
const emptyPracticalBenchmarkPairs: PracticalBenchmarkPairs = {A: null, B: null, C: null};

const developmentBenchmarkTemplates: BenchmarkCaseDraft[] = [
    {
        category: '알고리즘',
        title: '3Sum · 중복과 경계값',
        prompt: `정수 배열이 주어졌을 때, 합이 0이 되는 세 개의 엘리먼트를 모두 찾는 3Sum 알고리즘을 작성해줘.\n\n조건:\n- 중복된 결과는 없어야 합니다.\n- 시간 복잡도는 O(n^2)으로 최적화해줘.\n- 입력 배열이 비어있거나 요소가 3개 미만인 경우의 처리도 포함해줘.`,
    },
    {
        category: '엄격한 제약 조건 이행',
        title: '엄격한 제약 조건 이행 테스트',
        prompt: `비밀번호 유효성을 검사하는 함수를 작성해줘.

제약 조건:
1. 최소 10자 이상
2. 대문자/소문자/숫자/특수문자 포함
3. 동일한 문자 3번 연속 사용 금지

단, if문을 사용하지 않고 오직 정규표현식(Regex)만 사용하여 작성하고, 각 정규표현식 그룹이 무엇을 의미하는지 표(Table)로 정리해줘.`,
    },
    {
        category: 'Python 코드 작성',
        title: '팰린드롬 판별 함수',
        prompt: `Python을 사용하여 사용자가 입력한 문자열이 팰린드롬(거꾸로 읽어도 같은 단어)인지 확인하는 함수를 작성해줘.

예외 처리(공백, 대소문자 무시)를 포함하고 주석을 상세히 달아줘.`,
    },
    {
        category: '분산 시스템 설계',
        title: '선착순 쿠폰 발급 동시성 제어',
        prompt: `대규모 트래픽이 발생하는 선착순 쿠폰 발급 시스템을 설계하려고 합니다.

Redis를 활용하여 동시성 이슈(Race Condition)를 해결하는 두 가지 접근 방식을 제시하고, Python 또는 의사 코드로 구현하세요.

[조건]

1. 두 방식의 구현 코드를 각각 작성할 것.
2. 두 방식의 장단점, 성능(처리량), 정합성 관점의 비교 표를 작성할 것.
3. 어떤 상황에서 어느 방식을 채택해야 하는지 결론 및 시나리오별 가이드를 제시할 것.`,
    },
];

const benchmarkSuites: BenchmarkSuite[] = [
    {
        id: 'development',
        name: '개발·지시 이행 · 4문항',
        description: '알고리즘 정확성, 엄격한 제약 준수, 코드 작성, 분산 시스템 설계를 확인합니다.',
        templates: developmentBenchmarkTemplates,
    },
    {
        id: 'document',
        name: '문서·한국어 실무 · 4문항',
        description: '회의록 요약, 일정 제약 검토, 비개발자 설명, 간결한 문체 제어를 확인합니다.',
        templates: [
            {
                category: '회의록 요약',
                title: '결정과 후속 작업 정리',
                prompt: `다음 회의 메모를 바탕으로 "결정된 내용", "후속 작업", "주의할 점"을 각각 최대 2개의 글머리표로 정리하세요. 회의 메모에 없는 내용은 추측하지 마세요.\n\n- 모바일 앱 출시일은 6월 18일로 유지한다.\n- 결제 오류 재현 결과는 금요일 오전까지 공유한다.\n- 디자인팀은 새 아이콘 시안을 수요일에 전달한다.\n- 번역 검수가 늦어지면 일본어 출시는 다음 배포로 미룰 수 있다.`,
            },
            {
                category: '업무 추론',
                title: '배포 순서 제약 검토',
                prompt: `다음 다섯 작업을 한 줄의 실행 순서로 배치하세요. 이어서 각 조건이 충족됐는지 글머리표 4개로 짧게 확인하세요.\n\n작업: A. API 명세 확정, B. 화면 연동, C. 데이터 이관, D. 통합 테스트, E. 운영 배포\n\n조건:\n- A는 B와 C보다 앞에 있어야 합니다.\n- B와 C는 모두 D보다 앞에 있어야 합니다.\n- D는 E보다 앞에 있어야 합니다.\n- C는 B보다 앞에 있어야 합니다.\n\n다른 설명이나 표는 작성하지 마세요.`,
            },
            {
                category: '한국어 설명',
                title: '로컬 AI를 쉽게 설명',
                prompt: `비개발자에게 "로컬 AI 모델은 내 컴퓨터에서 실행되어 데이터가 외부 서버로 전송되지 않을 수 있지만, 컴퓨터 성능과 모델 선택에 따라 응답 속도와 품질이 달라진다"는 내용을 설명하세요.\n\n조건:\n- 한국어 글머리표 3개만 사용\n- 각 글머리표는 한 문장\n- 과장된 표현과 확정적인 보안 보장은 피할 것`,
            },
            {
                category: '문체 제어',
                title: '간결한 캐시 위험 안내',
                prompt: `제품 담당자에게 캐시 기능의 장점과 주의점을 안내하세요. 제목 한 줄과 글머리표 3개만 사용하세요. 전문 용어는 처음 나올 때 쉬운 말로 풀어 쓰고, 장점은 2개·주의점은 1개여야 합니다.`,
            },
        ],
    },
];

const defaultBenchmarkSuiteID = 'development';

const benchmarkMetricOptions: Array<{key: BenchmarkMetric; label: string; direction: string}> = [
    {key: 'totalDuration', label: '총 응답 시간', direction: '낮을수록 빠름'},
    {key: 'firstToken', label: '첫 토큰 시간', direction: '낮을수록 빠름'},
    {key: 'generationSpeed', label: '생성 속도', direction: '높을수록 빠름'},
    {key: 'outputTokens', label: '출력 토큰', direction: '응답 길이 참고'},
];

export interface ModelBenchmarkSidebarState {
    model: string;
    profileName: string;
    profileBaseURL: string;
    status: 'idle' | 'running';
    completedCaseCount: number;
    caseCount: number;
    recent: ModelBenchmarkSummary[];
    imported: ModelBenchmarkSummary[];
    isHistoryLoading: boolean;
}

interface ModelBenchmarkProps {
    profiles: SavedConnectionProfile[];
    connectionAPIKey: string;
    openRouterModelIDs: string[];
    onOpenRouterModelIDsChange: (modelIDs: string[]) => void;
    onBusyChange: (busy: boolean) => void;
    onSidebarChange: (state: ModelBenchmarkSidebarState) => void;
    openBenchmarkID: string | null;
    onOpenBenchmarkHandled: () => void;
    historyRefreshKey: number;
    onRequestBenchmarkDelete: (summary: ModelBenchmarkSummary) => void;
}

function makeID(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatDuration(milliseconds?: number): string {
    if (milliseconds === undefined || milliseconds < 0) {
        return '시간 정보 없음';
    }
    const seconds = milliseconds / 1_000;
    return `${new Intl.NumberFormat('ko-KR', {
        minimumFractionDigits: seconds < 10 ? 1 : 0,
        maximumFractionDigits: seconds < 10 ? 1 : 0,
    }).format(seconds)}초`;
}

function formatGenerationSpeed(usage?: TokenUsage | null, metrics?: ResponseMetrics | null): string | null {
    const tokensPerSecond = generationSpeedValue(usage, metrics);
    return tokensPerSecond === undefined
        ? null
        : `${new Intl.NumberFormat('ko-KR', {maximumFractionDigits: 1}).format(tokensPerSecond)} tok/s`;
}

function generationSpeedValue(usage?: TokenUsage | null, metrics?: ResponseMetrics | null): number | undefined {
    if (!usage || !metrics || usage.completionTokens <= 0) {
        return undefined;
    }
    const generationDuration = metrics.totalDurationMs - metrics.firstTokenDurationMs;
    if (generationDuration <= 0) {
        return undefined;
    }
    return usage.completionTokens / (generationDuration / 1_000);
}

function benchmarkMetricValue(benchmarkCase: ModelBenchmarkCase | undefined, metric: BenchmarkMetric): number | undefined {
    if (!benchmarkCase) return undefined;
    if (metric === 'totalDuration') return benchmarkCase.metrics?.totalDurationMs;
    if (metric === 'firstToken') {
        const value = benchmarkCase.metrics?.firstTokenDurationMs;
        return value && value > 0 ? value : undefined;
    }
    if (metric === 'generationSpeed') return generationSpeedValue(benchmarkCase.usage, benchmarkCase.metrics);
    return benchmarkCase.usage?.completionTokens;
}

function formatBenchmarkMetric(metric: BenchmarkMetric, value?: number): string {
    if (value === undefined) return '—';
    if (metric === 'totalDuration' || metric === 'firstToken') return formatDuration(value);
    if (metric === 'generationSpeed') {
        return `${new Intl.NumberFormat('ko-KR', {maximumFractionDigits: 1}).format(value)} tok/s`;
    }
    return `${new Intl.NumberFormat('ko-KR').format(value)} 토큰`;
}

function formatBenchmarkDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('ko-KR', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(date);
}

function benchmarkRecordLabel(summary: ModelBenchmarkSummary): string {
    return `${summary.model} · 추론 ${reasoningEffortLabel(summary.reasoningEffort)} · ${summary.profileName} · ${summary.suiteName} · ${formatBenchmarkDate(summary.updatedAt)}`;
}

function benchmarkComparisonRecordLabel(summary: ModelBenchmarkSummary): string {
    return `${summary.model} · 추론 ${reasoningEffortLabel(summary.reasoningEffort)} · ${summary.profileName} · ${formatBenchmarkDate(summary.updatedAt)}`;
}

function benchmarkStatusText(status: string): string {
    if (status === 'completed') return '완료';
    if (status === 'running') return '실행 중';
    return status || '알 수 없음';
}

function formatReportDate(value: string | Date): string {
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
    return `${fence}text\n${value || '내용 없음'}\n${fence}`;
}

function benchmarkCaseAnswer(benchmarkCase: ModelBenchmarkCase): string {
    return benchmarkCase.content.trim() || benchmarkCase.error || '응답 내용이 없습니다.';
}

function renderBenchmarkMarkdownForHTML(benchmarkCase: ModelBenchmarkCase): string {
    return renderToStaticMarkup(
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{benchmarkCaseAnswer(benchmarkCase)}</ReactMarkdown>,
    );
}

function benchmarkCaseMetricLines(benchmarkCase: ModelBenchmarkCase): string[] {
    const lines = [`상태: ${caseStatusText(benchmarkCase.status)}`];
    if (benchmarkCase.metrics) {
        lines.push(`총 응답 시간: ${formatDuration(benchmarkCase.metrics.totalDurationMs)}`);
        if (benchmarkCase.metrics.firstTokenDurationMs > 0) {
            lines.push(`첫 토큰 시간: ${formatDuration(benchmarkCase.metrics.firstTokenDurationMs)}`);
        }
    }
    const speed = formatGenerationSpeed(benchmarkCase.usage, benchmarkCase.metrics);
    if (speed) lines.push(`생성 속도: ${speed}`);
    if (benchmarkCase.usage) {
        lines.push(`토큰: 입력 ${benchmarkCase.usage.promptTokens} · 출력 ${benchmarkCase.usage.completionTokens} · 합계 ${benchmarkCase.usage.totalTokens}`);
    }
    return lines;
}

function benchmarkExportKindLabel(kind: BenchmarkExportKind): string {
    if (kind === 'analysis') return '기록 분석';
    if (kind === 'practical') return '실무·개발 비교';
    return '기록 비교';
}

function benchmarkExportFormatInfo(format: BenchmarkExportFormat): {label: string; extension: string; filterName: string} {
    return format === 'html'
        ? {label: 'HTML 보고서', extension: 'html', filterName: 'HTML 보고서'}
        : {label: 'Markdown', extension: 'md', filterName: 'Markdown 문서'};
}

function benchmarkExportFilenamePart(value: string, fallback: string): string {
    const normalized = value
        .normalize('NFC')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
        .replace(/_{2,}/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/[. ]+$/g, '')
        .trim();
    return normalized || fallback;
}

function benchmarkExportFilename(kind: BenchmarkExportKind, format: BenchmarkExportFormat, records: ModelBenchmark[]): string {
    const joinedPart = (value: (record: ModelBenchmark) => string, fallback: string) => benchmarkExportFilenamePart(
        [...new Set(records.map(value).filter(Boolean))].join(' vs '),
        fallback,
    );
    const model = joinedPart((record) => record.model, 'model');
    const suite = joinedPart((record) => record.suiteName, 'questionnaire');
    const reasoningEfforts = [...new Set(records.map((record) => reasoningEffortFilenameTag(record.reasoningEffort)))];
    const reasoning = reasoningEfforts.length === 1 ? reasoningEfforts[0] : 'r-mixed';
    if (kind === 'practical' && records.length >= 4) {
        const primaryModel = benchmarkExportFilenamePart(records[0].model, 'model');
        const otherModelCount = Math.max(1, Math.ceil(records.length / 2) - 1);
        const otherModels = `${otherModelCount}other${otherModelCount === 1 ? '' : 's'}`;
        return `benchmark_${primaryModel}_vs_${otherModels}__${reasoning}__문서-개발.${benchmarkExportFormatInfo(format).extension}`;
    }
    if (kind === 'comparison' && records.length > 1) {
        const primaryModel = benchmarkExportFilenamePart(records[0].model, 'model');
        const otherModelCount = records.length - 1;
        const otherModels = `${otherModelCount}other${otherModelCount === 1 ? '' : 's'}`;
        return `benchmark_${primaryModel}_vs_${otherModels}__${reasoning}__${suite}.${benchmarkExportFormatInfo(format).extension}`;
    }
    return `benchmark_${model}__${reasoning}__${suite}.${benchmarkExportFormatInfo(format).extension}`;
}

function benchmarkReportRecordLabel(kind: BenchmarkExportKind, recordIndex: number): string {
    if (kind === 'analysis') return '선택한 기록';
    if (kind === 'practical') {
        const condition = String.fromCharCode(65 + Math.floor(recordIndex / 2));
        const suite = recordIndex % 2 === 0 ? '문서·한국어 실무' : '개발·지시 이행';
        return `${condition} 비교 조건 · ${suite}`;
    }
    return `기록 ${String.fromCharCode(65 + recordIndex)}`;
}

function base64EncodeUTF8(value: string): string {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

function benchmarkReportImportMarker(records: ModelBenchmark[]): string {
    const payload = base64EncodeUTF8(JSON.stringify({version: benchmarkReportFormatVersion, records}));
    return `<!-- ${benchmarkReportMarkerName} ${payload} -->`;
}

function benchmarkMetadataMarkdown(benchmark: ModelBenchmark): string[] {
    const summary = benchmarkSummary(benchmark);
    return [
        `- 모델: ${benchmark.model}`,
        `- 추론 강도: ${reasoningEffortLabel(benchmark.reasoningEffort)}`,
        `- 연결 프로필: ${benchmark.profileName}`,
        `- 서버 주소: ${benchmark.profileBaseURL}`,
        `- 질문지: ${benchmark.suiteName}`,
        `- 상태: ${benchmarkStatusText(benchmark.status)}`,
        `- 완료 항목: ${summary.completedCaseCount}/${summary.caseCount}`,
        `- 기록 시각: ${formatReportDate(benchmark.updatedAt)}`,
    ];
}

function benchmarkMarkdownReport(kind: BenchmarkExportKind, records: ModelBenchmark[]): string {
    const lines = [
        `# Agent Chat 벤치마크 ${benchmarkExportKindLabel(kind)} 보고서`,
        '',
        `- 생성 시각: ${formatReportDate(new Date())}`,
        `- 포함 기록: ${records.length}개`,
        '',
        '> 이 보고서에는 API 키와 인증 헤더가 포함되지 않습니다.',
        '',
        benchmarkReportImportMarker(records),
    ];

    records.forEach((benchmark, recordIndex) => {
        const recordLabel = benchmarkReportRecordLabel(kind, recordIndex);
        lines.push('', `## ${recordLabel} · ${benchmark.model}`, '', ...benchmarkMetadataMarkdown(benchmark));
        (benchmark.cases || []).forEach((benchmarkCase, caseIndex) => {
            lines.push(
                '',
                `### ${caseIndex + 1}. ${benchmarkCase.category} · ${benchmarkCase.title}`,
                '',
                '#### 질문',
                markdownCodeBlock(benchmarkCase.prompt),
                '',
                `#### 모델 응답 · ${caseStatusText(benchmarkCase.status)}`,
                markdownCodeBlock(benchmarkCaseAnswer(benchmarkCase)),
                '',
                '#### 측정값',
                ...benchmarkCaseMetricLines(benchmarkCase).map((line) => `- ${line}`),
            );
        });
    });
    return `${lines.join('\n')}\n`;
}

function benchmarkHTMLReport(kind: BenchmarkExportKind, records: ModelBenchmark[]): string {
    const title = `Agent Chat 벤치마크 ${benchmarkExportKindLabel(kind)} 보고서`;
    const generatedAt = formatReportDate(new Date());
    const recordHTML = records.map((benchmark, recordIndex) => {
        const summary = benchmarkSummary(benchmark);
        const recordLabel = benchmarkReportRecordLabel(kind, recordIndex);
        const metadata = [
            ['모델', benchmark.model],
            ['추론 강도', reasoningEffortLabel(benchmark.reasoningEffort)],
            ['연결 프로필', benchmark.profileName],
            ['서버 주소', benchmark.profileBaseURL],
            ['질문지', benchmark.suiteName],
            ['상태', benchmarkStatusText(benchmark.status)],
            ['완료 항목', `${summary.completedCaseCount}/${summary.caseCount}`],
            ['기록 시각', formatReportDate(benchmark.updatedAt)],
        ].map(([label, value]) => `<div><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(value)}</dd></div>`).join('');
        const cases = (benchmark.cases || []).map((benchmarkCase, caseIndex) => `
            <article class="case">
              <h3>${caseIndex + 1}. ${escapeHTML(benchmarkCase.category)} · ${escapeHTML(benchmarkCase.title)}</h3>
              <section><h4>질문</h4><pre>${escapeHTML(benchmarkCase.prompt)}</pre></section>
              <section><h4>모델 응답 · ${escapeHTML(caseStatusText(benchmarkCase.status))}</h4><div class="markdown-body">${renderBenchmarkMarkdownForHTML(benchmarkCase)}</div></section>
              <ul>${benchmarkCaseMetricLines(benchmarkCase).map((line) => `<li>${escapeHTML(line)}</li>`).join('')}</ul>
            </article>`).join('');
        return `
          <section class="record">
            <header><p class="label">${escapeHTML(recordLabel)}</p><h2>${escapeHTML(benchmark.model)}</h2></header>
            <dl>${metadata}</dl>
            ${cases || '<p class="empty">저장된 테스트 항목이 없습니다.</p>'}
          </section>`;
    }).join('');

    return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHTML(title)}</title>
  <style>
    :root { color: #292925; background: #f6f6f3; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { max-width: 960px; margin: 0 auto; padding: 42px 24px 64px; line-height: 1.6; }
    main > header { margin-bottom: 24px; } h1, h2, h3, h4, p { margin-top: 0; } h1 { font-size: 28px; } h2 { margin-bottom: 0; font-size: 21px; } h3 { font-size: 16px; } h4 { margin-bottom: 8px; color: #56778a; font-size: 12px; }
    .generated, .notice, .label, .empty { color: #6f6f67; font-size: 13px; } .notice { padding: 12px 14px; border-left: 3px solid #7d9fb2; background: #edf5f9; }
    .record { margin-top: 22px; padding: 24px; border: 1px solid #deded7; border-radius: 14px; background: #fff; box-shadow: 0 5px 20px rgba(31, 31, 27, .04); }
    .label { margin-bottom: 4px; color: #56778a; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 20px 0 24px; } dl div { padding: 10px 12px; border-radius: 8px; background: #f7f7f4; } dt { color: #73736c; font-size: 11px; } dd { margin: 2px 0 0; overflow-wrap: anywhere; font-size: 13px; }
    .case { padding: 18px 0; border-top: 1px solid #e6e6e0; } .case section + section { margin-top: 16px; } .case section > pre { margin: 0; padding: 14px; overflow-x: auto; border: 1px solid #e1e1db; border-radius: 8px; background: #fbfbf9; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.65 ui-monospace, SFMono-Regular, Menlo, monospace; } ul { margin: 14px 0 0; padding-left: 20px; color: #5d5d56; font-size: 13px; }
    .markdown-body > :first-child { margin-top: 0; } .markdown-body > :last-child { margin-bottom: 0; } .markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 { margin: 1.5em 0 .55em; line-height: 1.35; color: #292925; } .markdown-body h1 { font-size: 22px; } .markdown-body h2 { font-size: 19px; } .markdown-body h3 { font-size: 16px; } .markdown-body p { margin: .75em 0; } .markdown-body ul, .markdown-body ol { margin: .75em 0; padding-left: 25px; color: inherit; font-size: inherit; } .markdown-body li + li { margin-top: .25em; } .markdown-body a { color: #26627d; } .markdown-body blockquote { margin: 1em 0; padding: .15em 1em; border-left: 3px solid #9ab9c8; color: #55554f; background: #f7fafb; } .markdown-body code { padding: .12em .34em; border-radius: 4px; background: #f0f0ec; font: .9em ui-monospace, SFMono-Regular, Menlo, monospace; } .markdown-body pre { margin: 1em 0; padding: 14px; overflow-x: auto; border: 1px solid #e1e1db; border-radius: 8px; background: #fbfbf9; font: 12px/1.65 ui-monospace, SFMono-Regular, Menlo, monospace; } .markdown-body pre code { padding: 0; background: transparent; font: inherit; } .markdown-body table { display: block; max-width: 100%; margin: 1em 0; overflow-x: auto; border-collapse: collapse; } .markdown-body th, .markdown-body td { padding: 8px 10px; border: 1px solid #deded7; text-align: left; } .markdown-body th { background: #f5f5f1; } .markdown-body hr { margin: 1.5em 0; border: 0; border-top: 1px solid #deded7; } .markdown-body img { max-width: 100%; height: auto; }
    @media print { body { max-width: none; padding: 20px; background: #fff; } .record { break-inside: avoid; box-shadow: none; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHTML(title)}</h1>
      <p class="generated">생성 시각: ${escapeHTML(generatedAt)} · 포함 기록: ${records.length}개</p>
      <p class="notice">이 보고서에는 API 키와 인증 헤더가 포함되지 않습니다.</p>
    </header>
    ${recordHTML}
  </main>
  ${benchmarkReportImportMarker(records)}
</body>
</html>`;
}

function hasSameTestConfiguration(left: ModelBenchmark, right: ModelBenchmark): boolean {
    const leftCases = left.cases || [];
    const rightCases = right.cases || [];
    return leftCases.length === rightCases.length && leftCases.every((benchmarkCase, index) => {
        const other = rightCases[index];
        return other
            && benchmarkCase.category === other.category
            && benchmarkCase.title === other.title
            && benchmarkCase.prompt === other.prompt;
    });
}

function practicalBenchmarkSuite(suiteName: string): PracticalBenchmarkSuite | null {
    const normalized = suiteName.replace(/[\s·/]+/g, '');
    if (normalized.includes('문서한국어실무')) return 'document';
    if (normalized.includes('개발지시이행')) return 'development';
    return null;
}

function isPracticalBenchmarkPairComplete(pair: PracticalBenchmarkPair): boolean {
    return practicalBenchmarkSuite(pair.document.suiteName) === 'document'
        && practicalBenchmarkSuite(pair.development.suiteName) === 'development'
        && (pair.document.cases || []).length === 4
        && (pair.development.cases || []).length === 4;
}

function hasSameBenchmarkCondition(
    left: Pick<ModelBenchmarkSummary, 'model' | 'profileBaseURL' | 'reasoningEffort'>,
    right: Pick<ModelBenchmarkSummary, 'model' | 'profileBaseURL' | 'reasoningEffort'>,
): boolean {
    return left.model === right.model
        && left.profileBaseURL === right.profileBaseURL
        && left.reasoningEffort === right.reasoningEffort;
}

function hasSamePracticalTestConfiguration(left: PracticalBenchmarkPair, right: PracticalBenchmarkPair): boolean {
    return hasSameTestConfiguration(left.document, right.document)
        && hasSameTestConfiguration(left.development, right.development);
}

function practicalBenchmarkPairCandidateLabel(candidate: PracticalBenchmarkPairCandidate): string {
    return `${candidate.document.model} · 추론 ${reasoningEffortLabel(candidate.document.reasoningEffort)} · ${candidate.document.profileName} · 문서 ${formatBenchmarkDate(candidate.document.updatedAt)} · 개발 ${formatBenchmarkDate(candidate.development.updatedAt)}`;
}

function suiteCaseDrafts(suite: BenchmarkSuite): BenchmarkCaseDraft[] {
    return suite.templates.map((template) => ({...template}));
}

function defaultCaseDrafts(): BenchmarkCaseDraft[] {
    const defaultSuite = benchmarkSuites.find((suite) => suite.id === defaultBenchmarkSuiteID) || benchmarkSuites[0];
    return suiteCaseDrafts(defaultSuite);
}

function createBenchmarkCases(drafts: BenchmarkCaseDraft[]): ModelBenchmarkCase[] {
    return drafts.map((draft) => ({
        id: makeID(),
        ...draft,
        content: '',
        status: 'pending',
    }));
}

function completedCaseCount(cases: ModelBenchmarkCase[]): number {
    return cases.filter((benchmarkCase) => ['complete', 'cancelled', 'failed'].includes(benchmarkCase.status)).length;
}

function benchmarkSummary(benchmark: ModelBenchmark): ModelBenchmarkSummary {
    const cases = benchmark.cases || [];
    const casesWithMetrics = cases.filter((benchmarkCase) => benchmarkCase.metrics);
    const totalDuration = casesWithMetrics.reduce((total, benchmarkCase) => total + (benchmarkCase.metrics?.totalDurationMs || 0), 0);
    const firstTokenDuration = casesWithMetrics.reduce((total, benchmarkCase) => total + (benchmarkCase.metrics?.firstTokenDurationMs || 0), 0);
    const totalCompletionTokens = cases.reduce((total, benchmarkCase) => total + (benchmarkCase.usage?.completionTokens || 0), 0);
    const totalGenerationDuration = casesWithMetrics.reduce((total, benchmarkCase) => {
        const metrics = benchmarkCase.metrics;
        return total + (metrics ? Math.max(0, metrics.totalDurationMs - metrics.firstTokenDurationMs) : 0);
    }, 0);
    return {
        id: benchmark.id,
        imported: benchmark.imported,
        suiteName: benchmark.suiteName,
        model: benchmark.model,
        reasoningEffort: benchmark.reasoningEffort,
        profileName: benchmark.profileName,
        profileBaseURL: benchmark.profileBaseURL,
        status: benchmark.status,
        updatedAt: benchmark.updatedAt,
        caseCount: cases.length,
        completedCaseCount: completedCaseCount(cases),
        averageTotalDurationMs: casesWithMetrics.length ? Math.round(totalDuration / casesWithMetrics.length) : 0,
        averageFirstTokenDurationMs: casesWithMetrics.length ? Math.round(firstTokenDuration / casesWithMetrics.length) : 0,
        averageGenerationSpeed: totalGenerationDuration > 0 ? totalCompletionTokens / (totalGenerationDuration / 1_000) : 0,
    };
}

function caseStatusText(status: string): string {
    if (status === 'streaming') return '실행 중…';
    if (status === 'complete') return '완료';
    if (status === 'cancelled') return '중단됨';
    if (status === 'failed') return '실패';
    return '대기 중';
}

function comparisonSummary(metric: BenchmarkMetric, values: Array<{label: string; value?: number}>): string {
    const measured = values.filter((item): item is {label: string; value: number} => item.value !== undefined);
    if (measured.length === 0) return '측정값 없음';

    const higherIsBetter = metric === 'generationSpeed' || metric === 'outputTokens';
    const bestValue = higherIsBetter
        ? Math.max(...measured.map((item) => item.value))
        : Math.min(...measured.map((item) => item.value));
    const bestLabels = measured.filter((item) => item.value === bestValue).map((item) => item.label).join('·');
    const isTie = bestLabels.includes('·');

    if (metric === 'outputTokens') {
        return `${bestLabels}${isTie ? '가 공동으로 가장 많음' : '가 가장 많음'} · ${formatBenchmarkMetric(metric, bestValue)}`;
    }
    return `${bestLabels}${isTie ? '가 공동으로 가장 빠름' : '가 가장 빠름'} · ${formatBenchmarkMetric(metric, bestValue)}`;
}

function relativeBenchmarkValue(metric: BenchmarkMetric, value: number | undefined, values: Array<number | undefined>): number | undefined {
    if (value === undefined) return undefined;
    const availableValues = values.filter((candidate): candidate is number => candidate !== undefined && candidate > 0);
    if (availableValues.length === 0) return undefined;
    if (metric === 'totalDuration' || metric === 'firstToken') {
        return value / Math.max(...availableValues) * 100;
    }
    return value / Math.max(...availableValues) * 100;
}

function formatRelativePercent(value: number): string {
    const digits = value >= 10 ? 0 : 1;
    return `${new Intl.NumberFormat('ko-KR', {maximumFractionDigits: digits}).format(value)}%`;
}

function relativeComparisonSummary(metric: BenchmarkMetric, values: Array<{label: string; value?: number}>): string {
    const measured = values.filter((item): item is {label: string; value: number} => item.value !== undefined && item.value > 0);
    if (measured.length === 0) return '측정값 없음';
    if (measured.length === 1) return `${measured[0].label}만 측정됨`;

    const higherIsBetter = metric === 'generationSpeed' || metric === 'outputTokens';
    const bestValue = higherIsBetter
        ? Math.max(...measured.map((item) => item.value))
        : Math.min(...measured.map((item) => item.value));
    const winners = measured.filter((item) => item.value === bestValue);
    const label = winners.map((item) => item.label).join('·');
    const result = metric === 'outputTokens' ? '많음' : '빠름';

    if (winners.length > 1) return `${label}가 공동으로 가장 ${result}`;

    const advantage = measured
        .filter((item) => item.value !== bestValue)
        .map((item) => {
            const percentage = higherIsBetter
                ? (bestValue - item.value) / item.value * 100
                : (item.value - bestValue) / item.value * 100;
            return `${item.label}보다 ${formatRelativePercent(percentage)}`;
        });
    return `${label}가 ${advantage.join(', ')} ${result}`;
}

function relativeScaleDescription(metric: BenchmarkMetric): string {
    if (metric === 'totalDuration' || metric === 'firstToken') return '각 질문의 가장 오래 걸린 응답 = 100% · 낮을수록 빠름';
    if (metric === 'generationSpeed') return '각 질문의 가장 빠른 생성 속도 = 100%';
    return '각 질문의 가장 많은 출력 = 100%';
}

function BenchmarkBarPlot({
    primary,
    secondary,
    tertiary,
    metric,
    scale,
}: {
    primary: ModelBenchmark;
    secondary?: ModelBenchmark | null;
    tertiary?: ModelBenchmark | null;
    metric: BenchmarkMetric;
    scale: BenchmarkChartScale;
}) {
    const primaryCases = primary.cases || [];
    const secondaryCases = secondary?.cases || [];
    const tertiaryCases = tertiary?.cases || [];
    const caseCount = Math.max(primaryCases.length, secondaryCases.length, tertiaryCases.length);
    const groups = Array.from({length: caseCount}, (_, index) => ({
        primaryCase: primaryCases[index],
        secondaryCase: secondaryCases[index],
        tertiaryCase: tertiaryCases[index],
    }));
    const values = groups.flatMap(({primaryCase, secondaryCase, tertiaryCase}) => [
        benchmarkMetricValue(primaryCase, metric),
        benchmarkMetricValue(secondaryCase, metric),
        benchmarkMetricValue(tertiaryCase, metric),
    ]).filter((value): value is number => value !== undefined);
    const maximumValue = Math.max(...values, 1);
    return (
        <div className={`benchmark-vertical-chart${tertiary ? ' three-series' : ''}`}>
            <div className="benchmark-chart-scale" aria-hidden="true">
                <span>{scale === 'relative' ? '100%' : formatBenchmarkMetric(metric, maximumValue)}</span>
                <span>0</span>
            </div>
            <div className="benchmark-chart-groups">
                {groups.map(({primaryCase, secondaryCase, tertiaryCase}, index) => {
                    const primaryValue = benchmarkMetricValue(primaryCase, metric);
                    const secondaryValue = benchmarkMetricValue(secondaryCase, metric);
                    const tertiaryValue = benchmarkMetricValue(tertiaryCase, metric);
                    const groupValues = [primaryValue, secondaryValue, tertiaryValue];
                    const primaryChartValue = scale === 'relative' ? relativeBenchmarkValue(metric, primaryValue, groupValues) : primaryValue;
                    const secondaryChartValue = scale === 'relative' ? relativeBenchmarkValue(metric, secondaryValue, groupValues) : secondaryValue;
                    const tertiaryChartValue = scale === 'relative' ? relativeBenchmarkValue(metric, tertiaryValue, groupValues) : tertiaryValue;
                    const chartMaximum = scale === 'relative' ? 100 : maximumValue;
                    return (
                        <div className="benchmark-chart-group" key={index}>
                            <div className="benchmark-chart-bars">
                                <div className="benchmark-chart-column">
                                    <span>{formatBenchmarkMetric(metric, primaryValue)}</span>
                                    <div className="benchmark-chart-track">
                                        {primaryChartValue !== undefined && (
                                            <div
                                                className="benchmark-chart-bar primary"
                                                style={{height: `${Math.max(3, primaryChartValue / chartMaximum * 100)}%`}}
                                                title={`A · ${formatBenchmarkMetric(metric, primaryValue)}${scale === 'relative' ? ` · 상대 ${primaryChartValue.toFixed(1)}%` : ''}`}
                                            />
                                        )}
                                    </div>
                                    <small>A</small>
                                </div>
                                {secondary && (
                                    <div className="benchmark-chart-column">
                                        <span>{formatBenchmarkMetric(metric, secondaryValue)}</span>
                                        <div className="benchmark-chart-track">
                                            {secondaryChartValue !== undefined && (
                                                <div
                                                    className="benchmark-chart-bar secondary"
                                                    style={{height: `${Math.max(3, secondaryChartValue / chartMaximum * 100)}%`}}
                                                    title={`B · ${formatBenchmarkMetric(metric, secondaryValue)}${scale === 'relative' ? ` · 상대 ${secondaryChartValue.toFixed(1)}%` : ''}`}
                                                />
                                            )}
                                        </div>
                                        <small>B</small>
                                    </div>
                                )}
                                {tertiary && (
                                    <div className="benchmark-chart-column">
                                        <span>{formatBenchmarkMetric(metric, tertiaryValue)}</span>
                                        <div className="benchmark-chart-track">
                                            {tertiaryChartValue !== undefined && (
                                                <div
                                                    className="benchmark-chart-bar tertiary"
                                                    style={{height: `${Math.max(3, tertiaryChartValue / chartMaximum * 100)}%`}}
                                                    title={`C · ${formatBenchmarkMetric(metric, tertiaryValue)}${scale === 'relative' ? ` · 상대 ${tertiaryChartValue.toFixed(1)}%` : ''}`}
                                                />
                                            )}
                                        </div>
                                        <small>C</small>
                                    </div>
                                )}
                            </div>
                            <strong>{index + 1}</strong>
                            <span title={primaryCase?.title || secondaryCase?.title || tertiaryCase?.title}>{primaryCase?.title || secondaryCase?.title || tertiaryCase?.title || '테스트'}</span>
                            {secondary && (
                                <small>{scale === 'relative' ? relativeComparisonSummary(metric, [
                                    {label: 'A', value: primaryValue},
                                    {label: 'B', value: secondaryValue},
                                    ...(tertiary ? [{label: 'C', value: tertiaryValue}] : []),
                                ]) : comparisonSummary(metric, [
                                    {label: 'A', value: primaryValue},
                                    {label: 'B', value: secondaryValue},
                                    ...(tertiary ? [{label: 'C', value: tertiaryValue}] : []),
                                ])}</small>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function BenchmarkVerticalChart({
    primary,
    secondary,
    tertiary,
    metric,
    onMetricChange,
    scale,
    onScaleChange,
}: {
    primary: ModelBenchmark;
    secondary?: ModelBenchmark | null;
    tertiary?: ModelBenchmark | null;
    metric: BenchmarkMetric;
    onMetricChange: (metric: BenchmarkMetric) => void;
    scale: BenchmarkChartScale;
    onScaleChange: (scale: BenchmarkChartScale) => void;
}) {
    const metricOption = benchmarkMetricOptions.find((option) => option.key === metric) || benchmarkMetricOptions[0];

    return (
        <section className="benchmark-visual-card" aria-label={`${metricOption.label} 세로 막대 그래프`}>
            <div className="benchmark-visual-card-heading">
                <div>
                    <strong>{metricOption.label}</strong>
                    <small>{secondary && scale === 'relative' ? relativeScaleDescription(metric) : metricOption.direction}</small>
                </div>
                <div className="benchmark-chart-controls">
                    {secondary && (
                        <div className="benchmark-scale-switch" role="group" aria-label="그래프 눈금">
                            <button className={scale === 'relative' ? 'active' : ''} type="button" onClick={() => onScaleChange('relative')}>상대 비교</button>
                            <button className={scale === 'absolute' ? 'active' : ''} type="button" onClick={() => onScaleChange('absolute')}>실측값</button>
                        </div>
                    )}
                    <div className="benchmark-metric-switch" role="group" aria-label="그래프 지표">
                        {benchmarkMetricOptions.map((option) => (
                            <button
                                className={metric === option.key ? 'active' : ''}
                                key={option.key}
                                type="button"
                                onClick={() => onMetricChange(option.key)}
                            >
                                {option.label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>
            <div className="benchmark-chart-legend">
                <span className="primary">A · {primary.model}</span>
                {secondary && <span className="secondary">B · {secondary.model}</span>}
                {tertiary && <span className="tertiary">C · {tertiary.model}</span>}
            </div>
            <BenchmarkBarPlot primary={primary} secondary={secondary} tertiary={tertiary} metric={metric} scale={secondary ? scale : 'absolute'} />
        </section>
    );
}

function PracticalBenchmarkCaseChart({
    suite,
    primary,
    secondary,
    tertiary,
    metric,
    scale,
}: {
    suite: PracticalBenchmarkSuite;
    primary: ModelBenchmarkCase;
    secondary: ModelBenchmarkCase;
    tertiary?: ModelBenchmarkCase;
    metric: BenchmarkMetric;
    scale: BenchmarkChartScale;
}) {
    const metricOption = benchmarkMetricOptions.find((option) => option.key === metric) || benchmarkMetricOptions[0];
    const primaryValue = benchmarkMetricValue(primary, metric);
    const secondaryValue = benchmarkMetricValue(secondary, metric);
    const tertiaryValue = benchmarkMetricValue(tertiary, metric);
    const values = [primaryValue, secondaryValue, tertiaryValue];
    const maximumValue = Math.max(...values.filter((value): value is number => value !== undefined), 1);
    const primaryChartValue = scale === 'relative' ? relativeBenchmarkValue(metric, primaryValue, values) : primaryValue;
    const secondaryChartValue = scale === 'relative' ? relativeBenchmarkValue(metric, secondaryValue, values) : secondaryValue;
    const tertiaryChartValue = scale === 'relative' ? relativeBenchmarkValue(metric, tertiaryValue, values) : tertiaryValue;
    const chartMaximum = scale === 'relative' ? 100 : maximumValue;
    const renderBar = (label: PracticalComparisonLabel, value: number | undefined, chartValue: number | undefined, tone: 'primary' | 'secondary' | 'tertiary') => (
        <div className="benchmark-practical-case-column">
            <span>{formatBenchmarkMetric(metric, value)}</span>
            <div className="benchmark-practical-case-track">
                {chartValue !== undefined && (
                    <div
                        className={`benchmark-practical-case-bar ${tone}`}
                        style={{height: `${Math.max(3, chartValue / chartMaximum * 100)}%`}}
                        title={`${label} · ${formatBenchmarkMetric(metric, value)}${scale === 'relative' ? ` · 상대 ${chartValue.toFixed(1)}%` : ''}`}
                    />
                )}
            </div>
            <small>{label}</small>
        </div>
    );

    return (
        <section className="benchmark-practical-case-chart" aria-label={`${practicalBenchmarkSuiteLabels[suite]} ${primary.title} ${metricOption.label} 비교 그래프`}>
            <div className="benchmark-practical-case-heading">
                <span>{practicalBenchmarkSuiteLabels[suite]}</span>
                <strong>{primary.category}</strong>
                <small title={primary.title}>{primary.title}</small>
            </div>
            <div className={`benchmark-practical-case-bars${tertiary ? ' three-series' : ''}`}>
                {renderBar('A', primaryValue, primaryChartValue, 'primary')}
                {renderBar('B', secondaryValue, secondaryChartValue, 'secondary')}
                {tertiary && renderBar('C', tertiaryValue, tertiaryChartValue, 'tertiary')}
            </div>
            <p>{scale === 'relative' ? relativeComparisonSummary(metric, [
                {label: 'A', value: primaryValue},
                {label: 'B', value: secondaryValue},
                ...(tertiary ? [{label: 'C', value: tertiaryValue}] : []),
            ]) : comparisonSummary(metric, [
                {label: 'A', value: primaryValue},
                {label: 'B', value: secondaryValue},
                ...(tertiary ? [{label: 'C', value: tertiaryValue}] : []),
            ])}</p>
        </section>
    );
}

function BenchmarkExportActions({
    kind,
    exportingFormat,
    exportMessage,
    disabled: isDisabled,
    onExport,
}: {
    kind: BenchmarkExportKind;
    exportingFormat: BenchmarkExportFormat | null;
    exportMessage: string;
    disabled: boolean;
    onExport: (format: BenchmarkExportFormat) => void;
}) {
    const disabled = isDisabled || exportingFormat !== null;
    return (
        <section className="benchmark-export-actions" aria-label={`${benchmarkExportKindLabel(kind)} 보고서 내보내기`}>
            <div>
                <span>보고서 내보내기</span>
                <small>질문·답변 전문과 측정값을 저장하며, 다른 Agent Chat에서 다시 가져올 수 있습니다. API 키는 포함되지 않습니다.</small>
            </div>
            <div className="benchmark-export-buttons">
                <button className="benchmark-export-button" type="button" onClick={() => onExport('html')} disabled={disabled}>
                    {exportingFormat === 'html' ? '저장 창 여는 중…' : 'HTML 보고서'}
                </button>
                <button className="benchmark-export-button" type="button" onClick={() => onExport('markdown')} disabled={disabled}>
                    {exportingFormat === 'markdown' ? '저장 창 여는 중…' : 'Markdown'}
                </button>
            </div>
            {exportMessage && <p className="benchmark-export-status" role="status">{exportMessage}</p>}
        </section>
    );
}

function ModelBenchmarkWorkspace({
    profiles,
    connectionAPIKey,
    openRouterModelIDs,
    onOpenRouterModelIDsChange,
    onBusyChange,
    onSidebarChange,
    openBenchmarkID,
    onOpenBenchmarkHandled,
    historyRefreshKey,
    onRequestBenchmarkDelete,
}: ModelBenchmarkProps) {
    const [profileID, setProfileID] = useState('');
    const [apiKey, setAPIKey] = useState('');
    const [models, setModels] = useState<Model[]>([]);
    const [selectedModel, setSelectedModel] = useState('');
    const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('');
    const [openRouterModelPickerOpen, setOpenRouterModelPickerOpen] = useState(false);
    const [loadingModels, setLoadingModels] = useState(false);
    const [benchmark, setBenchmark] = useState<ModelBenchmark | null>(null);
    const [view, setView] = useState<'home' | 'run'>('home');
    const [homeTab, setHomeTab] = useState<BenchmarkHomeTab>('run');
    const [suiteID, setSuiteID] = useState(defaultBenchmarkSuiteID);
    const [caseDrafts, setCaseDrafts] = useState<BenchmarkCaseDraft[]>(defaultCaseDrafts);
    const [history, setHistory] = useState<ModelBenchmarkSummary[]>([]);
    const [loadingHistory, setLoadingHistory] = useState(true);
    const [analysisID, setAnalysisID] = useState('');
    const [analysisRecord, setAnalysisRecord] = useState<ModelBenchmark | null>(null);
    const [analysisMetric, setAnalysisMetric] = useState<BenchmarkMetric>('totalDuration');
    const [analysisScale, setAnalysisScale] = useState<BenchmarkChartScale>('absolute');
    const [comparisonSuite, setComparisonSuite] = useState<PracticalBenchmarkSuite>('document');
    const [comparisonAID, setComparisonAID] = useState('');
    const [comparisonBID, setComparisonBID] = useState('');
    const [comparisonCID, setComparisonCID] = useState('');
    const [comparisonA, setComparisonA] = useState<ModelBenchmark | null>(null);
    const [comparisonB, setComparisonB] = useState<ModelBenchmark | null>(null);
    const [comparisonC, setComparisonC] = useState<ModelBenchmark | null>(null);
    const [comparisonMetric, setComparisonMetric] = useState<BenchmarkMetric>('totalDuration');
    const [comparisonScale, setComparisonScale] = useState<BenchmarkChartScale>('relative');
    const [practicalAID, setPracticalAID] = useState('');
    const [practicalBID, setPracticalBID] = useState('');
    const [practicalCID, setPracticalCID] = useState('');
    const [practicalPairs, setPracticalPairs] = useState<PracticalBenchmarkPairs>(emptyPracticalBenchmarkPairs);
    const [practicalMetric, setPracticalMetric] = useState<BenchmarkMetric>('totalDuration');
    const [practicalScale, setPracticalScale] = useState<BenchmarkChartScale>('relative');
    const [loadingAnalysis, setLoadingAnalysis] = useState(false);
    const [loadingComparison, setLoadingComparison] = useState(false);
    const [loadingPractical, setLoadingPractical] = useState(false);
    const [isRunning, setIsRunning] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [error, setError] = useState('');
    const [exportingFormat, setExportingFormat] = useState<BenchmarkExportFormat | null>(null);
    const [exportMessage, setExportMessage] = useState('');
    const [runExportMenuOpen, setRunExportMenuOpen] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const [importMessage, setImportMessage] = useState('');

    const benchmarkRef = useRef<ModelBenchmark | null>(null);
    const requestRef = useRef<{requestID: string; caseID: string} | null>(null);
    const runProfileRef = useRef<ConnectionProfile | null>(null);
    const modelLoadPromiseRef = useRef<ReturnType<typeof ChatService.ListModels> | null>(null);
    const modelLoadSequenceRef = useRef(0);

    const benchmarkProfiles = useMemo(
        () => profiles.some((profile) => profile.id === openRouterProfileID)
            ? profiles
            : [openRouterBenchmarkProfile, ...profiles],
        [profiles],
    );
    const selectedProfile = useMemo(
        () => benchmarkProfiles.find((profile) => profile.id === profileID),
        [benchmarkProfiles, profileID],
    );
    const usingOpenRouter = isOpenRouterURL(selectedProfile?.baseURL || '');
    const benchmarkReasoningWarning = reasoningEffortWarning(reasoningEffort);

    useEffect(() => {
        if (!usingOpenRouter || models.length === 0 || openRouterModelIDs.length === 0) return;
        setSelectedModel((current) => openRouterModelIDs.includes(current) ? current : '');
    }, [models.length, openRouterModelIDs, usingOpenRouter]);
    const selectedSuite = useMemo(
        () => benchmarkSuites.find((suite) => suite.id === suiteID) || benchmarkSuites[0],
        [suiteID],
    );
    const completedHistory = useMemo(
        () => history.filter((item) => item.status === 'completed' && item.caseCount > 0),
        [history],
    );
    const practicalDocumentHistory = useMemo(
        () => completedHistory.filter((item) => practicalBenchmarkSuite(item.suiteName) === 'document'),
        [completedHistory],
    );
    const practicalDevelopmentHistory = useMemo(
        () => completedHistory.filter((item) => practicalBenchmarkSuite(item.suiteName) === 'development'),
        [completedHistory],
    );
    const comparisonHistory = useMemo(
        () => completedHistory.filter((item) => practicalBenchmarkSuite(item.suiteName) === comparisonSuite),
        [comparisonSuite, completedHistory],
    );
    const practicalPairCandidates = useMemo(() => practicalDocumentHistory.flatMap((document) => (
        practicalDevelopmentHistory
            .filter((development) => hasSameBenchmarkCondition(document, development))
            .map((development) => ({
                id: `${document.id}:${development.id}`,
                document,
                development,
            }))
    )).sort((left, right) => (
        Math.max(Date.parse(right.document.updatedAt), Date.parse(right.development.updatedAt))
        - Math.max(Date.parse(left.document.updatedAt), Date.parse(left.development.updatedAt))
    )), [practicalDocumentHistory, practicalDevelopmentHistory]);

    function replaceBenchmark(nextBenchmark: ModelBenchmark | null) {
        benchmarkRef.current = nextBenchmark;
        setBenchmark(nextBenchmark);
    }

    function upsertHistory(nextBenchmark: ModelBenchmark) {
        const summary = benchmarkSummary(nextBenchmark);
        setHistory((current) => [summary, ...current.filter((item) => item.id !== summary.id)]
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
    }

    async function persistBenchmark(nextBenchmark: ModelBenchmark): Promise<ModelBenchmark> {
        const saved = await ChatService.SaveModelBenchmark(nextBenchmark);
        replaceBenchmark(saved);
        upsertHistory(saved);
        return saved;
    }

    async function loadHistory() {
        try {
            const loaded = await ChatService.ListModelBenchmarks();
            setHistory(loaded || []);
        } catch (reason) {
            setError(String(reason));
        } finally {
            setLoadingHistory(false);
        }
    }

    useEffect(() => {
        setLoadingHistory(true);
        void loadHistory();
    }, [historyRefreshKey]);

    useEffect(() => {
        if (connectionAPIKey) {
            setAPIKey(connectionAPIKey);
        }
    }, [connectionAPIKey]);

    useEffect(() => {
        const availableIDs = completedHistory.map((item) => item.id);
        if (!availableIDs.includes(analysisID)) {
            setAnalysisID(availableIDs[0] || '');
        }
    }, [analysisID, completedHistory]);

    useEffect(() => {
        const availableIDs = comparisonHistory.map((item) => item.id);
        const nextAID = availableIDs.includes(comparisonAID) ? comparisonAID : availableIDs[0] || '';
        const nextBID = availableIDs.includes(comparisonBID) && comparisonBID !== nextAID
            ? comparisonBID
            : availableIDs.find((id) => id !== nextAID) || '';
        const nextCID = availableIDs.includes(comparisonCID) && comparisonCID !== nextAID && comparisonCID !== nextBID
            ? comparisonCID
            : '';
        if (nextAID !== comparisonAID) setComparisonAID(nextAID);
        if (nextBID !== comparisonBID) setComparisonBID(nextBID);
        if (nextCID !== comparisonCID) setComparisonCID(nextCID);
    }, [comparisonAID, comparisonBID, comparisonCID, comparisonHistory]);

    useEffect(() => {
        const candidateIDs = practicalPairCandidates.map((candidate) => candidate.id);
        const firstAvailable = (excluded: string[]) => candidateIDs.find((id) => !excluded.includes(id)) || '';
        const nextAID = candidateIDs.includes(practicalAID) ? practicalAID : firstAvailable([]);
        const nextBID = candidateIDs.includes(practicalBID) && practicalBID !== nextAID
            ? practicalBID
            : firstAvailable([nextAID]);
        const nextCID = candidateIDs.includes(practicalCID) && practicalCID !== nextAID && practicalCID !== nextBID
            ? practicalCID
            : '';
        if (nextAID !== practicalAID) setPracticalAID(nextAID);
        if (nextBID !== practicalBID) setPracticalBID(nextBID);
        if (nextCID !== practicalCID) setPracticalCID(nextCID);
    }, [practicalAID, practicalBID, practicalCID, practicalPairCandidates]);

    useEffect(() => {
        if (loadingHistory || isRunning || !benchmark || history.some((item) => item.id === benchmark.id)) return;
        replaceBenchmark(null);
        setView('home');
    }, [benchmark, history, isRunning, loadingHistory]);

    useEffect(() => {
        if (!analysisID) {
            setAnalysisRecord(null);
            return;
        }
        let active = true;
        setLoadingAnalysis(true);
        void ChatService.OpenModelBenchmark(analysisID)
            .then((opened) => {
                if (active) setAnalysisRecord(opened);
            })
            .catch((reason) => {
                if (active) setError(String(reason));
            })
            .finally(() => {
                if (active) setLoadingAnalysis(false);
            });
        return () => {
            active = false;
        };
    }, [analysisID]);

    useEffect(() => {
        if (!comparisonAID || !comparisonBID) {
            setComparisonA(null);
            setComparisonB(null);
            setComparisonC(null);
            return;
        }
        let active = true;
        setLoadingComparison(true);
        const requests = [
            ChatService.OpenModelBenchmark(comparisonAID),
            ChatService.OpenModelBenchmark(comparisonBID),
        ];
        if (comparisonCID) requests.push(ChatService.OpenModelBenchmark(comparisonCID));
        void Promise.all(requests).then(([left, right, third]) => {
            if (!active) return;
            setComparisonA(left);
            setComparisonB(right);
            setComparisonC(third || null);
        }).catch((reason) => {
            if (active) setError(String(reason));
        }).finally(() => {
            if (active) setLoadingComparison(false);
        });
        return () => {
            active = false;
        };
    }, [comparisonAID, comparisonBID, comparisonCID]);

    useEffect(() => {
        if (!practicalAID || !practicalBID) {
            setPracticalPairs(emptyPracticalBenchmarkPairs);
            setLoadingPractical(false);
            return;
        }
        const candidatesByID = new Map(practicalPairCandidates.map((candidate) => [candidate.id, candidate]));
        const selectedCandidates = [practicalAID, practicalBID, practicalCID]
            .map((id) => candidatesByID.get(id))
            .filter((candidate): candidate is PracticalBenchmarkPairCandidate => candidate !== undefined);
        if (selectedCandidates.length < 2) {
            setPracticalPairs(emptyPracticalBenchmarkPairs);
            setLoadingPractical(false);
            return;
        }
        const ids = [...new Set(selectedCandidates.flatMap((candidate) => [candidate.document.id, candidate.development.id]))];
        let active = true;
        setLoadingPractical(true);
        void Promise.all(ids.map((id) => ChatService.OpenModelBenchmark(id))).then((records) => {
            if (!active) return;
            const recordsByID = new Map(records.map((record) => [record.id, record]));
            const pairFor = (id: string): PracticalBenchmarkPair | null => {
                const candidate = candidatesByID.get(id);
                if (!candidate) return null;
                const document = recordsByID.get(candidate.document.id);
                const development = recordsByID.get(candidate.development.id);
                return document && development ? {document, development} : null;
            };
            setPracticalPairs({A: pairFor(practicalAID), B: pairFor(practicalBID), C: pairFor(practicalCID)});
        }).catch((reason) => {
            if (active) setError(String(reason));
        }).finally(() => {
            if (active) setLoadingPractical(false);
        });
        return () => {
            active = false;
        };
    }, [practicalAID, practicalBID, practicalCID, practicalPairCandidates]);

    useEffect(() => {
        onBusyChange(isRunning);
        return () => onBusyChange(false);
    }, [isRunning, onBusyChange]);

    useEffect(() => {
        const summary = benchmark ? benchmarkSummary(benchmark) : undefined;
        onSidebarChange({
            model: isRunning ? benchmark?.model || '' : '',
            profileName: isRunning ? benchmark?.profileName || '' : '',
            profileBaseURL: isRunning ? benchmark?.profileBaseURL || '' : '',
            status: isRunning ? 'running' : 'idle',
            completedCaseCount: isRunning ? summary?.completedCaseCount || 0 : 0,
            caseCount: isRunning ? summary?.caseCount || 0 : 0,
            recent: history.filter((item) => !item.imported).slice(0, 8),
            imported: history.filter((item) => item.imported).slice(0, 8),
            isHistoryLoading: loadingHistory,
        });
    }, [benchmark, history, isRunning, loadingHistory, onSidebarChange]);

    useEffect(() => () => onSidebarChange({
        model: '',
        profileName: '',
        profileBaseURL: '',
        status: 'idle',
        completedCaseCount: 0,
        caseCount: 0,
        recent: [],
        imported: [],
        isHistoryLoading: false,
    }), [onSidebarChange]);

    function updateCase(
        source: ModelBenchmark,
        caseID: string,
        update: (benchmarkCase: ModelBenchmarkCase) => ModelBenchmarkCase,
    ): ModelBenchmark {
        return {
            ...source,
            cases: (source.cases || []).map((benchmarkCase) => benchmarkCase.id === caseID ? update(benchmarkCase) : benchmarkCase),
        };
    }

    async function completeBenchmark(source: ModelBenchmark) {
        const completed: ModelBenchmark = {...source, status: 'completed'};
        try {
            await persistBenchmark(completed);
        } catch (reason) {
            setError(String(reason));
        } finally {
            requestRef.current = null;
            runProfileRef.current = null;
            setCancelling(false);
            setIsRunning(false);
        }
    }

    async function startNextCase(source: ModelBenchmark) {
        const nextCase = (source.cases || []).find((benchmarkCase) => benchmarkCase.status === 'pending');
        if (!nextCase) {
            await completeBenchmark(source);
            return;
        }
        const profile = runProfileRef.current;
        if (!profile) {
            setError('벤치마크 실행 정보를 찾을 수 없습니다. 새 벤치마크를 시작해 주세요.');
            setIsRunning(false);
            return;
        }

        const streaming = updateCase(source, nextCase.id, (benchmarkCase) => ({...benchmarkCase, status: 'streaming'}));
        replaceBenchmark(streaming);
        try {
            const saved = await persistBenchmark(streaming);
            const requestID = makeID();
            requestRef.current = {requestID, caseID: nextCase.id};
            await ChatService.StartChat({
                requestID,
                profile,
                model: saved.model,
                messages: [{role: 'user', content: nextCase.prompt}],
                reasoningEffort: saved.reasoningEffort,
                benchmark: true,
            });
        } catch (reason) {
            requestRef.current = null;
            const failed = updateCase(benchmarkRef.current || streaming, nextCase.id, (benchmarkCase) => ({
                ...benchmarkCase, status: 'failed', error: String(reason),
            }));
            try {
                const saved = await persistBenchmark(failed);
                await startNextCase(saved);
            } catch (saveReason) {
                setError(String(saveReason));
                setIsRunning(false);
            }
        }
    }

    async function finishCase(
        caseID: string,
        status: ModelBenchmarkCase['status'],
        metrics?: ResponseMetrics | null,
        errorMessage?: string,
    ) {
        const source = benchmarkRef.current;
        if (!source) return;
        const finished = updateCase(source, caseID, (benchmarkCase) => ({
            ...benchmarkCase,
            status,
            metrics: metrics ?? benchmarkCase.metrics,
            error: errorMessage || benchmarkCase.error,
        }));
        requestRef.current = null;
        replaceBenchmark(finished);
        try {
            const saved = await persistBenchmark(finished);
            setCancelling(false);
            await startNextCase(saved);
        } catch (reason) {
            setError(String(reason));
            setCancelling(false);
            setIsRunning(false);
        }
    }

    useEffect(() => {
        const listener = Events.On(chatEventName, (event) => {
            const payload: ChatEvent = event.data;
            const activeRequest = requestRef.current;
            if (!activeRequest || payload.requestID !== activeRequest.requestID) return;
            const source = benchmarkRef.current;
            if (!source) return;

            if (payload.type === 'delta' && payload.delta) {
                replaceBenchmark(updateCase(source, activeRequest.caseID, (benchmarkCase) => ({
                    ...benchmarkCase,
                    content: benchmarkCase.content + payload.delta,
                })));
                return;
            }
            if (payload.type === 'usage' && payload.usage) {
                replaceBenchmark(updateCase(source, activeRequest.caseID, (benchmarkCase) => ({...benchmarkCase, usage: payload.usage})));
                return;
            }
            if (payload.type === 'completed') {
                void finishCase(activeRequest.caseID, 'complete', payload.metrics);
            } else if (payload.type === 'cancelled') {
                void finishCase(activeRequest.caseID, 'cancelled', payload.metrics);
            } else if (payload.type === 'failed') {
                void finishCase(activeRequest.caseID, 'failed', payload.metrics, payload.error || '테스트 응답 생성에 실패했습니다.');
            }
        });
        return listener;
    }, []);

    async function loadModels(): Promise<Model[]> {
        if (!selectedProfile) {
            setError('저장된 연결 프로필을 선택해 주세요.');
            return [];
        }
        if (loadingModels) return [];
        const operationID = ++modelLoadSequenceRef.current;
        try {
            setLoadingModels(true);
            setError('');
            const request = ChatService.ListModels({baseURL: selectedProfile.baseURL, apiKey});
            modelLoadPromiseRef.current = request;
            const loaded = await request;
            if (operationID !== modelLoadSequenceRef.current) return [];
            const nextModels = loaded || [];
            setModels(nextModels);
            if (usingOpenRouter) {
                setSelectedModel((current) => openRouterModelIDs.includes(current) ? current : '');
            } else {
                setSelectedModel((current) => nextModels.some((model) => model.id === current) ? current : nextModels[0]?.id || '');
            }
            return nextModels;
        } catch (reason) {
            if (operationID !== modelLoadSequenceRef.current) return [];
            setModels([]);
            setSelectedModel('');
            setError(String(reason));
            return [];
        } finally {
            if (operationID === modelLoadSequenceRef.current) {
                modelLoadPromiseRef.current = null;
                setLoadingModels(false);
            }
        }
    }

    function cancelModelLoad() {
        const request = modelLoadPromiseRef.current;
        if (!request) return;
        modelLoadSequenceRef.current += 1;
        modelLoadPromiseRef.current = null;
        setLoadingModels(false);
        setError('');
        void request.cancel('사용자가 모델 목록 불러오기를 취소했습니다');
    }

    async function openOpenRouterModelPicker() {
        if (isRunning || loadingModels) return;
        const availableModels = models.length > 0 ? models : await loadModels();
        if (availableModels.length > 0) {
            setOpenRouterModelPickerOpen(true);
        }
    }

    function changeProfile(nextProfileID: string) {
        setProfileID(nextProfileID);
        setModels([]);
        setSelectedModel('');
        setOpenRouterModelPickerOpen(false);
        setError('');
    }

    function updateCaseDraft(index: number, field: 'title' | 'prompt', value: string) {
        setCaseDrafts((current) => current.map((draft, draftIndex) => draftIndex === index ? {...draft, [field]: value} : draft));
    }

    function resetCaseDraft(index: number) {
        setCaseDrafts((current) => current.map((draft, draftIndex) => draftIndex === index ? {...selectedSuite.templates[index]} : draft));
    }

    function resetAllCaseDrafts() {
        setCaseDrafts(suiteCaseDrafts(selectedSuite));
    }

    function changeSuite(nextSuiteID: string) {
        const nextSuite = benchmarkSuites.find((suite) => suite.id === nextSuiteID) || benchmarkSuites[0];
        setSuiteID(nextSuite.id);
        setCaseDrafts(suiteCaseDrafts(nextSuite));
        setError('');
    }

    async function startBenchmark(event: FormEvent) {
        event.preventDefault();
        if (!selectedProfile || !selectedModel || isRunning) return;
        if (caseDrafts.some((draft) => draft.title.trim() === '' || draft.prompt.trim() === '')) {
            setError('모든 테스트 제목과 프롬프트를 입력해 주세요.');
            return;
        }
        const initial: ModelBenchmark = {
            id: '',
            imported: false,
            profileID: selectedProfile.id,
            profileName: selectedProfile.name,
            profileBaseURL: selectedProfile.baseURL,
            model: selectedModel,
            reasoningEffort,
            suiteName: selectedSuite.name,
            status: 'running',
            createdAt: '',
            updatedAt: '',
            cases: createBenchmarkCases(caseDrafts.map((draft) => ({
                ...draft,
                title: draft.title.trim(),
                prompt: draft.prompt.trim(),
            }))),
        };
        try {
            setError('');
            setExportMessage('');
            setRunExportMenuOpen(false);
            setIsRunning(true);
            runProfileRef.current = {baseURL: selectedProfile.baseURL, apiKey};
            const created = await ChatService.CreateModelBenchmark(initial);
            replaceBenchmark(created);
            upsertHistory(created);
            setView('run');
            await startNextCase(created);
        } catch (reason) {
            setError(String(reason));
            setIsRunning(false);
        }
    }

    async function cancelCurrentCase() {
        const request = requestRef.current;
        if (!request || cancelling) return;
        try {
            setCancelling(true);
            await ChatService.CancelChat(request.requestID);
        } catch (reason) {
            setCancelling(false);
            setError(String(reason));
        }
    }

    useEffect(() => {
        if (!openBenchmarkID || isRunning) return;

        void (async () => {
            try {
                setError('');
                setExportMessage('');
                setRunExportMenuOpen(false);
                const opened = await ChatService.OpenModelBenchmark(openBenchmarkID);
                replaceBenchmark(opened);
                setView('run');
            } catch (reason) {
                setError(String(reason));
            } finally {
                onOpenBenchmarkHandled();
            }
        })();
    }, [isRunning, onOpenBenchmarkHandled, openBenchmarkID]);

    function goHome() {
        setView('home');
        setRunExportMenuOpen(false);
        if (!isRunning) {
            replaceBenchmark(null);
        }
        setError('');
    }

    function showRun() {
        if (!benchmark) return;
        setExportMessage('');
        setRunExportMenuOpen(false);
        setView('run');
    }

    function showStoredBenchmark(record: ModelBenchmark) {
        if (isRunning) return;
        setExportMessage('');
        setRunExportMenuOpen(false);
        replaceBenchmark(record);
        setView('run');
    }

    async function exportBenchmarkReport(kind: BenchmarkExportKind, format: BenchmarkExportFormat, records: ModelBenchmark[]) {
        if (isRunning || exportingFormat || records.length === 0) return;
        const formatInfo = benchmarkExportFormatInfo(format);
        try {
            setExportingFormat(format);
            setExportMessage('');
            setError('');
            const path = await Dialogs.SaveFile({
                Title: `${benchmarkExportKindLabel(kind)} ${formatInfo.label} 저장`,
                ButtonText: '보고서 저장',
                Filename: benchmarkExportFilename(kind, format, records),
                Filters: [{DisplayName: formatInfo.filterName, Pattern: `*.${formatInfo.extension}`}],
            });
            if (!path) return;
            const contents = format === 'html'
                ? benchmarkHTMLReport(kind, records)
                : benchmarkMarkdownReport(kind, records);
            await ChatService.SaveBenchmarkExport(path, contents);
            setExportMessage(`${formatInfo.label}를 저장했습니다.`);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setExportingFormat(null);
        }
    }

    async function importBenchmarkReport() {
        if (isRunning || isImporting) return;
        try {
            setIsImporting(true);
            setImportMessage('');
            setError('');
            const path = await Dialogs.OpenFile({
                Title: '벤치마크 보고서 가져오기',
                ButtonText: '보고서 가져오기',
                Filters: [{DisplayName: '벤치마크 보고서', Pattern: '*.md;*.html'}],
            });
            if (!path) return;
            const result = await ChatService.ImportBenchmarkReport(path);
            const imported = result?.imported || [];
            const duplicateCount = result?.duplicateCount || 0;
            if (imported.length) {
                imported.forEach(upsertHistory);
                setAnalysisID(imported[0].id);
                setHomeTab('analysis');
            }
            if (imported.length && duplicateCount) {
                setImportMessage(`${imported.length}개의 벤치마크 결과를 가져왔습니다. 중복 ${duplicateCount}개는 제외했습니다.`);
            } else if (imported.length) {
                setImportMessage(`${imported.length}개의 벤치마크 결과를 가져왔습니다.`);
            } else if (duplicateCount) {
                setImportMessage(`이미 가져온 벤치마크 결과 ${duplicateCount}개입니다.`);
            }
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setIsImporting(false);
        }
    }

    function renderCase(benchmarkCase: ModelBenchmarkCase) {
        const speed = formatGenerationSpeed(benchmarkCase.usage, benchmarkCase.metrics);
        return (
            <article className="benchmark-case-card" key={benchmarkCase.id}>
                <div className="benchmark-case-heading">
                    <div>
                        <span>{benchmarkCase.category}</span>
                        <strong>{benchmarkCase.title}</strong>
                    </div>
                    <small className={`benchmark-case-status ${benchmarkCase.status}`}>{caseStatusText(benchmarkCase.status)}</small>
                </div>
                <details className="benchmark-case-prompt">
                    <summary>테스트 질문 보기</summary>
                    <p>{benchmarkCase.prompt}</p>
                </details>
                <div className="benchmark-case-output markdown-content">
                    {benchmarkCase.content ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{benchmarkCase.content}</ReactMarkdown> : (
                        <p className="benchmark-placeholder">{benchmarkCase.status === 'streaming' ? '응답을 생성하고 있습니다…' : benchmarkCase.error || '아직 실행하지 않았습니다.'}</p>
                    )}
                </div>
                <div className="benchmark-case-metrics">
                    {benchmarkCase.metrics && <span>응답 {formatDuration(benchmarkCase.metrics.totalDurationMs)}</span>}
                    {benchmarkCase.metrics && benchmarkCase.metrics.firstTokenDurationMs > 0 && <span>첫 토큰 {formatDuration(benchmarkCase.metrics.firstTokenDurationMs)}</span>}
                    {speed && <span>{speed}</span>}
                    {benchmarkCase.usage && <span>출력 {benchmarkCase.usage.completionTokens} 토큰</span>}
                </div>
            </article>
        );
    }

    if (benchmark && view === 'run') {
        const summary = benchmarkSummary(benchmark);
        const stoppedRun = benchmark.status === 'running' && !isRunning;
        const canExportRun = !isRunning && benchmark.status === 'completed';
        return (
            <section className="benchmark-page" aria-label="모델 벤치마크">
                <header className="benchmark-header">
                    <div>
                        <span className="eyebrow">MODEL BENCHMARK</span>
                        <h1>{isRunning ? '벤치마크 실행 중' : stoppedRun ? '중단된 벤치마크' : '벤치마크 결과'}</h1>
                    </div>
                    <div className="benchmark-run-actions">
                        <button className="text-button" type="button" onClick={goHome}>모델 실험실 홈</button>
                        {canExportRun && (
                            <div className="benchmark-run-export">
                                <button
                                    className="benchmark-run-export-trigger"
                                    type="button"
                                    aria-expanded={runExportMenuOpen}
                                    aria-controls="benchmark-run-export-menu"
                                    onClick={() => setRunExportMenuOpen((current) => !current)}
                                    disabled={exportingFormat !== null}
                                >
                                    {exportingFormat ? '저장 창 여는 중…' : '내보내기'} <span aria-hidden="true">⌄</span>
                                </button>
                                {runExportMenuOpen && (
                                    <div className="benchmark-run-export-menu" id="benchmark-run-export-menu" role="group" aria-label="결과 보고서 형식">
                                        <button type="button" onClick={() => {
                                            setRunExportMenuOpen(false);
                                            void exportBenchmarkReport('analysis', 'html', [benchmark]);
                                        }}>
                                            HTML 보고서
                                        </button>
                                        <button type="button" onClick={() => {
                                            setRunExportMenuOpen(false);
                                            void exportBenchmarkReport('analysis', 'markdown', [benchmark]);
                                        }}>
                                            Markdown
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                        {!isRunning && (
                            <div className="benchmark-destructive-action">
                                <button className="text-button danger" type="button" onClick={() => onRequestBenchmarkDelete(summary)}>기록 삭제</button>
                            </div>
                        )}
                    </div>
                </header>
                {error && <div className="error-banner" role="alert">{error}</div>}
                {exportMessage && <p className="benchmark-run-export-status" role="status">{exportMessage}</p>}
                <section className="benchmark-run-card">
                    <span>{benchmark.suiteName}</span>
                    <h2>{benchmark.model}</h2>
                    <div className="benchmark-run-identity">
                        <div><span>추론 강도</span><strong>{reasoningEffortLabel(benchmark.reasoningEffort)}</strong></div>
                        <div><span>연결 프로필</span><strong>{benchmark.profileName}</strong></div>
                        <div><span>서버 주소</span><code title={benchmark.profileBaseURL}>{benchmark.profileBaseURL}</code></div>
                    </div>
                    <small>테스트 {benchmark.cases?.length || 0}개 · {formatBenchmarkDate(benchmark.updatedAt)}</small>
                </section>
                {stoppedRun && <p className="benchmark-status-copy">이전 실행은 앱 종료 등으로 중단되었습니다. API 키를 저장하지 않으므로 안전하게 이어서 실행하지 않고, 새 벤치마크를 시작할 수 있습니다.</p>}
                <section className="benchmark-summary-grid" aria-label="벤치마크 요약">
                    <div><span>완료 항목</span><strong>{summary.completedCaseCount}/{summary.caseCount}</strong></div>
                    <div><span>평균 응답</span><strong>{summary.averageTotalDurationMs ? formatDuration(summary.averageTotalDurationMs) : '—'}</strong></div>
                    <div><span>평균 첫 토큰</span><strong>{summary.averageFirstTokenDurationMs ? formatDuration(summary.averageFirstTokenDurationMs) : '—'}</strong></div>
                    <div><span>전체 생성 속도</span><strong>{summary.averageGenerationSpeed ? `${new Intl.NumberFormat('ko-KR', {maximumFractionDigits: 1}).format(summary.averageGenerationSpeed)} tok/s` : '—'}</strong></div>
                </section>
                {isRunning && <p className="benchmark-status-copy">같은 조건을 유지하기 위해 선택한 질문지의 테스트 {benchmark.cases?.length || 0}개를 한 번에 하나씩 실행합니다.</p>}
                <div className="benchmark-case-grid">
                    {(benchmark.cases || []).map((benchmarkCase) => renderCase(benchmarkCase))}
                </div>
                {isRunning && (
                    <button className="benchmark-cancel-button" type="button" onClick={() => void cancelCurrentCase()} disabled={cancelling}>
                        {cancelling ? '중단 중…' : '현재 테스트 중단'}
                    </button>
                )}
            </section>
        );
    }

    const homeTitle = homeTab === 'run'
        ? '하나의 모델을 자세히 측정하세요'
        : homeTab === 'analysis'
            ? '벤치마크 결과를 시각적으로 분석하세요'
            : homeTab === 'comparison'
                ? '벤치마크 기록을 최대 세 개까지 비교하세요'
                : '문서와 개발 결과를 문항별로 비교하세요';
    const sameTestConfiguration = comparisonA && comparisonB
        ? hasSameTestConfiguration(comparisonA, comparisonB)
            && (!comparisonC || hasSameTestConfiguration(comparisonA, comparisonC))
        : false;
    const sameReasoningEffort = comparisonA && comparisonB
        ? comparisonA.reasoningEffort === comparisonB.reasoningEffort
            && (!comparisonC || comparisonA.reasoningEffort === comparisonC.reasoningEffort)
        : false;
    const sameServerProfile = comparisonA && comparisonB
        ? comparisonA.profileBaseURL === comparisonB.profileBaseURL
            && (!comparisonC || comparisonA.profileBaseURL === comparisonC.profileBaseURL)
        : false;
    const practicalA = practicalPairs.A;
    const practicalB = practicalPairs.B;
    const practicalC = practicalPairs.C;
    const hasCompletePracticalPairs = practicalA && practicalB
        ? isPracticalBenchmarkPairComplete(practicalA) && isPracticalBenchmarkPairComplete(practicalB)
            && (!practicalC || isPracticalBenchmarkPairComplete(practicalC))
        : false;
    const samePracticalTestConfiguration = practicalA && practicalB
        ? hasSamePracticalTestConfiguration(practicalA, practicalB)
            && (!practicalC || hasSamePracticalTestConfiguration(practicalA, practicalC))
        : false;
    const samePracticalReasoningEffort = practicalA && practicalB
        ? practicalA.document.reasoningEffort === practicalB.document.reasoningEffort
            && (!practicalC || practicalA.document.reasoningEffort === practicalC.document.reasoningEffort)
        : false;
    const samePracticalServerProfile = practicalA && practicalB
        ? practicalA.document.profileBaseURL === practicalB.document.profileBaseURL
            && (!practicalC || practicalA.document.profileBaseURL === practicalC.document.profileBaseURL)
        : false;
    const practicalExportRecords = [practicalA, practicalB, practicalC].flatMap((pair) => (
        pair ? [pair.document, pair.development] : []
    ));
    const practicalCaseCharts = practicalA && practicalB && hasCompletePracticalPairs
        ? (['document', 'development'] as PracticalBenchmarkSuite[]).flatMap((suite) => {
            const primaryCases = practicalA[suite].cases || [];
            const secondaryCases = practicalB[suite].cases || [];
            const tertiaryCases = practicalC?.[suite].cases || [];
            return primaryCases.map((primaryCase, index) => ({
                suite,
                primary: primaryCase,
                secondary: secondaryCases[index],
                tertiary: practicalC ? tertiaryCases[index] : undefined,
            }));
        })
        : [];

    return (
        <section className="benchmark-page benchmark-setup" aria-label="모델 벤치마크 설정">
            <header className="benchmark-header">
                <div>
                    <span className="eyebrow">MODEL BENCHMARK</span>
                    <h1>{homeTitle}</h1>
                </div>
                <div className="benchmark-header-actions">
                    <button className="secondary-button" type="button" onClick={() => void importBenchmarkReport()} disabled={isRunning || isImporting}>
                        {isImporting ? '가져오는 중…' : '보고서 가져오기'}
                    </button>
                </div>
            </header>
            {error && <div className="error-banner" role="alert">{error}</div>}
            {importMessage && <p className="benchmark-import-status" role="status">{importMessage}</p>}
            {isRunning && benchmark && (
                <section className="benchmark-home-running" aria-label="실행 중인 벤치마크">
                    <div>
                        <span>백그라운드 실행 중</span>
                        <strong>{benchmark.model}</strong>
                        <small>{completedCaseCount(benchmark.cases || [])}/{benchmark.cases?.length || 0}개 테스트 완료</small>
                    </div>
                    <button className="secondary-button" type="button" onClick={showRun}>실행 화면으로</button>
                </section>
            )}
            <nav className="benchmark-home-tabs" aria-label="모델 실험실 메뉴">
                <button className={homeTab === 'run' ? 'active' : ''} type="button" onClick={() => setHomeTab('run')}>벤치마크 실행</button>
                <button className={homeTab === 'analysis' ? 'active' : ''} type="button" onClick={() => setHomeTab('analysis')}>기록 분석</button>
                <button className={homeTab === 'comparison' ? 'active' : ''} type="button" onClick={() => setHomeTab('comparison')}>기록 비교</button>
                <button className={homeTab === 'practical' ? 'active' : ''} type="button" onClick={() => setHomeTab('practical')}>실무·개발 비교</button>
            </nav>
            {homeTab === 'run' && (
                <div className="benchmark-setup-grid">
                    <form className="benchmark-form" onSubmit={(event) => void startBenchmark(event)}>
                    <label>
                        저장된 연결 프로필
                        <select value={profileID} onChange={(event) => changeProfile(event.target.value)} disabled={isRunning}>
                            <option value="">프로필을 선택해 주세요</option>
                            {benchmarkProfiles.map((profile) => (
                                <option key={profile.id} value={profile.id}>
                                    {profile.id === openRouterProfileID ? `${profile.name} · 기본` : profile.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label>
                        API 키 <small>연결 화면의 입력값을 자동 사용 · 저장 안 됨</small>
                        <input value={apiKey} onChange={(event) => setAPIKey(event.target.value)} type="password" autoComplete="off" placeholder="필요한 경우 입력" disabled={isRunning} />
                    </label>
                    <div className="connection-model-actions">
                        <button className="secondary-button" type="button" onClick={() => void loadModels()} disabled={!selectedProfile || loadingModels || isRunning}>
                            {loadingModels ? '모델 불러오는 중…' : '모델 불러오기'}
                        </button>
                        {loadingModels && <button className="model-load-cancel-button" type="button" onClick={cancelModelLoad}>취소</button>}
                    </div>
                    <label>
                        측정할 모델
                        {usingOpenRouter ? (
                            <div className="openrouter-model-selection">
                                <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} disabled={!openRouterModelIDs.length || isRunning}>
                                    <option value="">모델을 선택하세요</option>
                                    {openRouterModelIDs.map((modelID) => <option key={modelID} value={modelID}>{modelID}</option>)}
                                </select>
                                <button type="button" onClick={() => void openOpenRouterModelPicker()} disabled={isRunning || loadingModels}>
                                    {loadingModels ? '모델 불러오는 중…' : '모델 관리'}
                                </button>
                                <small>{openRouterModelIDs.length}개 선택됨</small>
                            </div>
                        ) : (
                            <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} disabled={!models.length || isRunning}>
                                {!models.length && <option value="">먼저 모델을 불러와 주세요</option>}
                                {models.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
                            </select>
                        )}
                    </label>
                    <div className="benchmark-reasoning-field">
                        <label htmlFor="benchmark-reasoning-effort">추론 강도</label>
                        <small>모델·서버에 따라 지원하는 단계가 다를 수 있습니다.</small>
                        <select
                            id="benchmark-reasoning-effort"
                            value={reasoningEffort}
                            onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)}
                            disabled={isRunning}
                        >
                            {reasoningEffortOptions.map((option) => (
                                <option key={option.value || 'auto'} value={option.value}>{option.label}</option>
                            ))}
                        </select>
                        {benchmarkReasoningWarning && (
                            <p className="benchmark-reasoning-warning" role="status">⚠ {benchmarkReasoningWarning}</p>
                        )}
                    </div>
                    <label>
                        질문지 프로필
                        <select value={suiteID} onChange={(event) => changeSuite(event.target.value)} disabled={isRunning}>
                            {benchmarkSuites.map((suite) => <option key={suite.id} value={suite.id}>{suite.name}</option>)}
                        </select>
                        <small>{selectedSuite.description} 프로필을 바꾸면 편집 중인 질문은 새 기본 질문으로 바뀝니다.</small>
                    </label>
                    <section className="benchmark-suite-preview" aria-label={`${selectedSuite.name} 테스트 구성`}>
                        <div className="benchmark-suite-heading">
                            <div>
                                <span>선택한 질문지</span>
                                <strong>{selectedSuite.name}</strong>
                            </div>
                            <button type="button" onClick={resetAllCaseDrafts} disabled={isRunning}>전체 기본값 복원</button>
                        </div>
                        <p>테스트 제목과 질문은 실행 전에 자유롭게 바꿀 수 있으며, 실행한 질문지와 구성은 결과 기록에 함께 저장됩니다.</p>
                        <div className="benchmark-template-editor">
                            {caseDrafts.map((draft, index) => (
                                <section key={`${suiteID}-${index}`} className="benchmark-template-editor-item">
                                    <div>
                                        <span className="benchmark-template-editor-category">{index + 1}. {draft.category}</span>
                                        <label className="benchmark-template-editor-title">
                                            테스트 제목
                                            <input
                                                value={draft.title}
                                                onChange={(event) => updateCaseDraft(index, 'title', event.target.value)}
                                                disabled={isRunning}
                                                maxLength={80}
                                                aria-label={`${index + 1}번 테스트 제목`}
                                            />
                                        </label>
                                        <button type="button" onClick={() => resetCaseDraft(index)} disabled={isRunning}>기본값</button>
                                    </div>
                                    <textarea
                                        value={draft.prompt}
                                        onChange={(event) => updateCaseDraft(index, 'prompt', event.target.value)}
                                        disabled={isRunning}
                                        rows={8}
                                        aria-label={`${index + 1}번 테스트 프롬프트`}
                                    />
                                </section>
                            ))}
                        </div>
                        <p>이 결과는 공식 모델 순위가 아닌, 현재 서버와 설정에서의 실용적인 비교 기록입니다.</p>
                    </section>
                    <button className="benchmark-start-button" type="submit" disabled={!selectedProfile || !selectedModel || isRunning}>
                        벤치마크 시작
                    </button>
                    </form>
                </div>
            )}
            {homeTab === 'analysis' && (
                <section className="benchmark-visualization-panel" aria-label="벤치마크 기록 분석">
                    <div className="benchmark-visualization-controls">
                        <label>
                            분석할 벤치마크 기록
                            <select value={analysisID} onChange={(event) => setAnalysisID(event.target.value)} disabled={loadingHistory || completedHistory.length === 0}>
                                {completedHistory.length === 0 && <option value="">완료된 기록이 없습니다</option>}
                                {completedHistory.map((item) => <option key={item.id} value={item.id}>{benchmarkRecordLabel(item)}</option>)}
                            </select>
                        </label>
                    </div>
                    {loadingHistory || loadingAnalysis ? (
                        <div className="benchmark-visualization-empty">벤치마크 기록을 불러오는 중…</div>
                    ) : !analysisRecord ? (
                        <div className="benchmark-visualization-empty">완료된 벤치마크를 실행하면 이곳에서 결과를 시각화할 수 있습니다.</div>
                    ) : (
                        <>
                            <section className="benchmark-record-summary">
                                <div>
                                    <span>선택한 기록</span>
                                    <strong>{analysisRecord.model}</strong>
                                    <small title={analysisRecord.profileBaseURL}>추론 {reasoningEffortLabel(analysisRecord.reasoningEffort)} · {analysisRecord.profileName} · {analysisRecord.profileBaseURL} · {formatBenchmarkDate(analysisRecord.updatedAt)}</small>
                                </div>
                                <div className="benchmark-record-actions">
                                    <button className="text-button" type="button" onClick={() => showStoredBenchmark(analysisRecord)} disabled={isRunning}>상세 결과 보기</button>
                                    <div className="benchmark-destructive-action">
                                        <button className="text-button danger" type="button" onClick={() => onRequestBenchmarkDelete(benchmarkSummary(analysisRecord))} disabled={isRunning}>기록 삭제</button>
                                    </div>
                                </div>
                            </section>
                            <BenchmarkExportActions
                                kind="analysis"
                                exportingFormat={exportingFormat}
                                exportMessage={exportMessage}
                                disabled={isRunning}
                                onExport={(format) => { void exportBenchmarkReport('analysis', format, [analysisRecord]); }}
                            />
                            <BenchmarkVerticalChart
                                primary={analysisRecord}
                                metric={analysisMetric}
                                onMetricChange={setAnalysisMetric}
                                scale={analysisScale}
                                onScaleChange={setAnalysisScale}
                            />
                        </>
                    )}
                </section>
            )}
            {homeTab === 'comparison' && (
                <section className="benchmark-visualization-panel" aria-label="벤치마크 기록 비교">
                    <div className="benchmark-comparison-selectors">
                        <div className="benchmark-comparison-suite-filter">
                            <div>
                                <strong>비교할 벤치마크</strong>
                                <small>선택한 질문지의 기록만 아래 모델 선택에 표시합니다.</small>
                            </div>
                            <div className="benchmark-comparison-suite-switch" role="group" aria-label="비교할 벤치마크 선택">
                                {(['document', 'development'] as PracticalBenchmarkSuite[]).map((suite) => (
                                    <button
                                        className={comparisonSuite === suite ? 'active' : ''}
                                        key={suite}
                                        type="button"
                                        onClick={() => setComparisonSuite(suite)}
                                        disabled={isRunning}
                                    >
                                        {practicalBenchmarkSuiteLabels[suite]}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <label>
                            A 기록
                            <select value={comparisonAID} onChange={(event) => setComparisonAID(event.target.value)} disabled={loadingHistory || comparisonHistory.length < 2}>
                                {comparisonHistory.length < 2 && <option value="">비교할 기록이 부족합니다</option>}
                                {comparisonHistory.map((item) => (
                                    <option key={item.id} value={item.id} disabled={item.id === comparisonBID || item.id === comparisonCID}>{benchmarkComparisonRecordLabel(item)}</option>
                                ))}
                            </select>
                        </label>
                        <label>
                            B 기록
                            <select value={comparisonBID} onChange={(event) => setComparisonBID(event.target.value)} disabled={loadingHistory || comparisonHistory.length < 2}>
                                {comparisonHistory.length < 2 && <option value="">비교할 기록이 부족합니다</option>}
                                {comparisonHistory.map((item) => (
                                    <option key={item.id} value={item.id} disabled={item.id === comparisonAID || item.id === comparisonCID}>{benchmarkComparisonRecordLabel(item)}</option>
                                ))}
                            </select>
                        </label>
                        <label>
                            C 기록
                            <select value={comparisonCID} onChange={(event) => setComparisonCID(event.target.value)} disabled={loadingHistory || comparisonHistory.length < 3}>
                                <option value="">선택 안 함</option>
                                {comparisonHistory.map((item) => (
                                    <option key={item.id} value={item.id} disabled={item.id === comparisonAID || item.id === comparisonBID}>{benchmarkComparisonRecordLabel(item)}</option>
                                ))}
                            </select>
                        </label>
                    </div>
                    {loadingHistory || loadingComparison ? (
                        <div className="benchmark-visualization-empty">비교할 기록을 불러오는 중…</div>
                    ) : !comparisonA || !comparisonB ? (
                        <div className="benchmark-visualization-empty">완료된 {practicalBenchmarkSuiteLabels[comparisonSuite]} 기록이 2개 이상 필요합니다.</div>
                    ) : (
                        <>
                            <div className={`benchmark-comparison-records${comparisonC ? ' has-tertiary' : ''}`}>
                                <button
                                    className="benchmark-comparison-record primary"
                                    type="button"
                                    onClick={() => showStoredBenchmark(comparisonA)}
                                    disabled={isRunning}
                                    aria-label={`A 기록 ${comparisonA.model}의 상세 벤치마크 결과 보기`}
                                >
                                    <span>A</span>
                                    <strong>{comparisonA.model}</strong>
                                    <small title={comparisonA.profileBaseURL}>추론 {reasoningEffortLabel(comparisonA.reasoningEffort)} · {comparisonA.profileName} · {comparisonA.profileBaseURL} · {formatBenchmarkDate(comparisonA.updatedAt)}</small>
                                    <em>상세 결과 보기</em>
                                </button>
                                <button
                                    className="benchmark-comparison-record secondary"
                                    type="button"
                                    onClick={() => showStoredBenchmark(comparisonB)}
                                    disabled={isRunning}
                                    aria-label={`B 기록 ${comparisonB.model}의 상세 벤치마크 결과 보기`}
                                >
                                    <span>B</span>
                                    <strong>{comparisonB.model}</strong>
                                    <small title={comparisonB.profileBaseURL}>추론 {reasoningEffortLabel(comparisonB.reasoningEffort)} · {comparisonB.profileName} · {comparisonB.profileBaseURL} · {formatBenchmarkDate(comparisonB.updatedAt)}</small>
                                    <em>상세 결과 보기</em>
                                </button>
                                {comparisonC && (
                                    <button
                                        className="benchmark-comparison-record tertiary"
                                        type="button"
                                        onClick={() => showStoredBenchmark(comparisonC)}
                                        disabled={isRunning}
                                        aria-label={`C 기록 ${comparisonC.model}의 상세 벤치마크 결과 보기`}
                                    >
                                        <span>C</span>
                                        <strong>{comparisonC.model}</strong>
                                        <small title={comparisonC.profileBaseURL}>추론 {reasoningEffortLabel(comparisonC.reasoningEffort)} · {comparisonC.profileName} · {comparisonC.profileBaseURL} · {formatBenchmarkDate(comparisonC.updatedAt)}</small>
                                        <em>상세 결과 보기</em>
                                    </button>
                                )}
                            </div>
                            <p className={`benchmark-comparison-notice ${sameTestConfiguration && sameReasoningEffort ? 'compatible' : 'warning'}`}>
                                {!sameTestConfiguration
                                    ? '선택한 기록의 테스트 제목 또는 질문이 다릅니다. 수치는 참고용으로 비교해 주세요.'
                                    : !sameReasoningEffort
                                        ? '선택한 기록의 추론 강도가 다릅니다. 추론 조건 차이를 고려해 수치를 비교해 주세요.'
                                    : sameServerProfile
                                        ? '같은 테스트 구성과 연결 프로필에서 실행된 직접 비교 가능한 기록입니다.'
                                        : '테스트 구성은 같지만 연결 프로필이 달라 서버 환경 차이가 포함될 수 있습니다.'}
                            </p>
                            <BenchmarkExportActions
                                kind="comparison"
                                exportingFormat={exportingFormat}
                                exportMessage={exportMessage}
                                disabled={isRunning}
                                onExport={(format) => {
                                    void exportBenchmarkReport('comparison', format, [comparisonA, comparisonB, comparisonC].filter((record): record is ModelBenchmark => record !== null));
                                }}
                            />
                            <BenchmarkVerticalChart
                                primary={comparisonA}
                                secondary={comparisonB}
                                tertiary={comparisonC}
                                metric={comparisonMetric}
                                onMetricChange={setComparisonMetric}
                                scale={comparisonScale}
                                onScaleChange={setComparisonScale}
                            />
                        </>
                    )}
                </section>
            )}
            {homeTab === 'practical' && (
                <section className="benchmark-visualization-panel" aria-label="실무와 개발 벤치마크 비교">
                    <section className="benchmark-practical-intro">
                        <div>
                            <strong>문서·한국어 실무 4문항과 개발·지시 이행 4문항을 함께 비교합니다.</strong>
                            <small>같은 모델·서버·추론 강도의 문서·개발 기록을 하나의 비교 조건으로 자동 묶습니다.</small>
                        </div>
                    </section>
                    <div className="benchmark-practical-selectors">
                        {(['A', 'B', 'C'] as PracticalComparisonLabel[]).map((label) => {
                            const selectedID = label === 'A' ? practicalAID : label === 'B' ? practicalBID : practicalCID;
                            const usedIDs = [practicalAID, practicalBID, practicalCID].filter((id) => id && id !== selectedID);
                            const setSelectedID = label === 'A' ? setPracticalAID : label === 'B' ? setPracticalBID : setPracticalCID;
                            return (
                                <section className={`benchmark-practical-selector ${label === 'A' ? 'primary' : label === 'B' ? 'secondary' : 'tertiary'}`} key={label}>
                                    <div className="benchmark-practical-selector-heading">
                                        <span>{label}</span>
                                        <div>
                                            <strong>{label} 비교 조건</strong>
                                            <small>{label === 'C' ? '선택 안 함 가능' : '문서·개발 결과가 함께 있는 조건'}</small>
                                        </div>
                                    </div>
                                    <label>
                                        비교할 실행 조건
                                        <select value={selectedID} onChange={(event) => setSelectedID(event.target.value)} disabled={loadingHistory || isRunning || practicalPairCandidates.length === 0}>
                                            {label === 'C' && <option value="">선택 안 함</option>}
                                            {practicalPairCandidates.length === 0 && <option value="">짝지을 수 있는 기록이 없습니다</option>}
                                            {practicalPairCandidates.map((candidate) => (
                                                <option key={candidate.id} value={candidate.id} disabled={usedIDs.includes(candidate.id)}>{practicalBenchmarkPairCandidateLabel(candidate)}</option>
                                            ))}
                                        </select>
                                    </label>
                                </section>
                            );
                        })}
                    </div>
                    {loadingHistory || loadingPractical ? (
                        <div className="benchmark-visualization-empty">비교할 문서·개발 기록을 불러오는 중…</div>
                    ) : !practicalA || !practicalB ? (
                        <div className="benchmark-visualization-empty">같은 모델·서버·추론 강도로 실행한 문서·한국어 실무와 개발·지시 이행 기록 쌍이 두 개 이상 필요합니다.</div>
                    ) : !hasCompletePracticalPairs ? (
                        <div className="benchmark-visualization-empty">각 조건에는 문서·한국어 실무 4문항과 개발·지시 이행 4문항이 모두 있는 기록을 선택해 주세요.</div>
                    ) : (
                        <>
                            <div className={`benchmark-practical-conditions${practicalC ? ' has-tertiary' : ''}`}>
                                {(['A', 'B', 'C'] as PracticalComparisonLabel[]).map((label) => {
                                    const pair = practicalPairs[label];
                                    if (!pair) return null;
                                    return (
                                        <section className={`benchmark-practical-condition ${label === 'A' ? 'primary' : label === 'B' ? 'secondary' : 'tertiary'}`} key={label}>
                                            <span>{label} 비교 조건</span>
                                            <strong>{pair.document.model}</strong>
                                            <small title={pair.document.profileBaseURL}>추론 {reasoningEffortLabel(pair.document.reasoningEffort)} · {pair.document.profileName} · {pair.document.profileBaseURL}</small>
                                            <em>문서 {formatBenchmarkDate(pair.document.updatedAt)} · 개발 {formatBenchmarkDate(pair.development.updatedAt)}</em>
                                        </section>
                                    );
                                })}
                            </div>
                            <p className={`benchmark-comparison-notice ${samePracticalTestConfiguration && samePracticalReasoningEffort ? 'compatible' : 'warning'}`}>
                                {!samePracticalTestConfiguration
                                    ? '선택한 조건의 테스트 제목 또는 질문이 다릅니다. 그래프는 참고용으로 비교해 주세요.'
                                    : !samePracticalReasoningEffort
                                        ? '비교 조건의 추론 강도가 다릅니다. 추론 조건 차이를 고려해 그래프를 비교해 주세요.'
                                        : samePracticalServerProfile
                                            ? '두 질문지의 같은 테스트 구성과 실행 조건을 문항별로 직접 비교합니다.'
                                            : '테스트 구성과 추론 강도는 같지만 연결 프로필이 달라 서버 환경 차이가 포함될 수 있습니다.'}
                            </p>
                            <BenchmarkExportActions
                                kind="practical"
                                exportingFormat={exportingFormat}
                                exportMessage={exportMessage}
                                disabled={isRunning}
                                onExport={(format) => { void exportBenchmarkReport('practical', format, practicalExportRecords); }}
                            />
                            <section className="benchmark-practical-chart-controls" aria-label="실무와 개발 비교 그래프 설정">
                                <div>
                                    <strong>문항별 그래프 8개</strong>
                                    <small>{practicalScale === 'relative' ? relativeScaleDescription(practicalMetric) : (benchmarkMetricOptions.find((option) => option.key === practicalMetric) || benchmarkMetricOptions[0]).direction}</small>
                                </div>
                                <div className="benchmark-chart-controls">
                                    <div className="benchmark-scale-switch" role="group" aria-label="그래프 눈금">
                                        <button className={practicalScale === 'relative' ? 'active' : ''} type="button" onClick={() => setPracticalScale('relative')}>상대 비교</button>
                                        <button className={practicalScale === 'absolute' ? 'active' : ''} type="button" onClick={() => setPracticalScale('absolute')}>실측값</button>
                                    </div>
                                    <div className="benchmark-metric-switch" role="group" aria-label="그래프 지표">
                                        {benchmarkMetricOptions.map((option) => (
                                            <button className={practicalMetric === option.key ? 'active' : ''} key={option.key} type="button" onClick={() => setPracticalMetric(option.key)}>{option.label}</button>
                                        ))}
                                    </div>
                                </div>
                            </section>
                            <div className="benchmark-practical-chart-rows">
                                {(['document', 'development'] as PracticalBenchmarkSuite[]).map((suite) => {
                                    const suiteCharts = practicalCaseCharts.filter((chart) => chart.suite === suite);
                                    return (
                                        <section className="benchmark-practical-chart-row" key={suite}>
                                            <div className="benchmark-practical-chart-row-heading">
                                                <strong>{practicalBenchmarkSuiteLabels[suite]}</strong>
                                                <small>4문항</small>
                                            </div>
                                            <div className="benchmark-practical-chart-row-grid">
                                                {suiteCharts.map((chart, index) => chart.secondary && (
                                                    <PracticalBenchmarkCaseChart
                                                        key={`${chart.suite}-${index}-${chart.primary.id}`}
                                                        suite={chart.suite}
                                                        primary={chart.primary}
                                                        secondary={chart.secondary}
                                                        tertiary={chart.tertiary}
                                                        metric={practicalMetric}
                                                        scale={practicalScale}
                                                    />
                                                ))}
                                            </div>
                                        </section>
                                    );
                                })}
                            </div>
                        </>
                    )}
                </section>
            )}
            <OpenRouterModelPicker
                open={openRouterModelPickerOpen}
                models={models}
                selectedModel={selectedModel}
                selectedModelIDs={openRouterModelIDs}
                onClose={() => setOpenRouterModelPickerOpen(false)}
                onApply={onOpenRouterModelIDsChange}
            />
        </section>
    );
}

export default ModelBenchmarkWorkspace;
