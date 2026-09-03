import {FormEvent, useEffect, useMemo, useRef, useState} from 'react';
import {Events} from '@wailsio/runtime';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {App as ChatService} from '../bindings/github.com/taengson/agent-chat-desktop';
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

const chatEventName = 'chat:event';

type BenchmarkCaseDraft = Pick<ModelBenchmarkCase, 'category' | 'title' | 'prompt'>;
type BenchmarkSuite = {
    id: string;
    name: string;
    description: string;
    templates: BenchmarkCaseDraft[];
};
type BenchmarkHomeTab = 'run' | 'analysis' | 'comparison';
type BenchmarkMetric = 'totalDuration' | 'firstToken' | 'generationSpeed' | 'outputTokens';

const quickBenchmarkTemplates: BenchmarkCaseDraft[] = [
    {
        category: '지시 이행',
        title: '구조화된 출력',
        prompt: `다음 두 고객 문의를 각각 한 문장으로 요약하세요. 반드시 JSON 배열만 출력하고, 각 객체는 "id"와 "summary" 키만 가져야 합니다.\n\n1. "어제 주문한 무선 키보드가 아직 배송 준비 중입니다. 언제 받을 수 있나요?"\n2. "정기 결제 금액이 예상보다 높습니다. 이번 달 청구 내역을 설명해 주세요."`,
    },
    {
        category: '추론',
        title: '제약 조건 추론',
        prompt: `A, B, C, D 네 작업을 한 줄로 배치하려고 합니다. A는 B보다 앞에 있어야 하고, D는 C보다 앞에 있어야 하며, B는 마지막이어야 합니다. 가능한 배치 하나를 제시한 뒤 각 조건을 짧게 확인하세요.`,
    },
    {
        category: '코드',
        title: '안전한 입력 처리',
        prompt: `TypeScript로 parsePositiveIntegers(input: string): number[] 함수를 작성하세요. 쉼표로 구분한 입력에서 양의 정수만 반환하고, 공백·빈 항목·0·음수·소수·문자는 제외해야 합니다. 코드와 두 줄 이내의 설명만 제공하세요.`,
    },
    {
        category: '한국어 설명',
        title: '비개발자 대상 요약',
        prompt: `비개발자에게 "로컬 AI 모델은 내 컴퓨터에서 실행되어 데이터가 외부 서버로 전송되지 않을 수 있지만, 컴퓨터 성능과 모델 선택에 따라 응답 속도와 품질이 달라진다"는 내용을 3개의 짧은 글머리표로 설명하세요. 과장된 표현은 피하세요.`,
    },
];

const benchmarkSuites: BenchmarkSuite[] = [
    {
        id: 'practical',
        name: '실용 종합 · 8문항',
        description: '지시 이행, 추론, 요약, 정보 정리, 코드, 한국어 설명을 고르게 확인합니다.',
        templates: [
            ...quickBenchmarkTemplates.slice(0, 2),
            {
                category: '요약',
                title: '결정과 후속 작업 요약',
                prompt: `다음 회의 메모를 바탕으로 "결정된 내용", "후속 작업", "주의할 점"을 각각 최대 2개의 글머리표로 정리하세요. 회의 메모에 없는 내용은 추측하지 마세요.\n\n- 모바일 앱 출시일은 6월 18일로 유지한다.\n- 결제 오류 재현 결과는 금요일 오전까지 공유한다.\n- 디자인팀은 새 아이콘 시안을 수요일에 전달한다.\n- 번역 검수가 늦어지면 일본어 출시는 다음 배포로 미룰 수 있다.`,
            },
            {
                category: '정보 정리',
                title: '표 형식 변환',
                prompt: `아래 주문 정보를 Markdown 표로 바꾸세요. 열은 "주문 번호", "상태", "다음 조치" 세 개만 사용하세요.\n\n- A-104: 결제 완료, 오늘 출고 예정\n- B-208: 주소 오류, 고객 확인 필요\n- C-311: 배송 완료, 조치 없음`,
            },
            quickBenchmarkTemplates[2],
            {
                category: '코드 검토',
                title: '태그 정규화 함수',
                prompt: `TypeScript로 normalizeTags(input: string): string[] 함수를 작성하세요. 쉼표로 나뉜 태그를 앞뒤 공백 제거 후 소문자로 바꾸고, 빈 값과 중복은 제외하되 처음 등장한 순서는 유지해야 합니다. 코드와 간단한 예시 2개만 제공하세요.`,
            },
            quickBenchmarkTemplates[3],
            {
                category: '문체 제어',
                title: '간결한 위험 안내',
                prompt: `제품 담당자에게 캐시 기능의 장점과 주의점을 안내하세요. 제목 한 줄과 글머리표 3개만 사용하고, 전문 용어는 처음 나올 때 쉬운 말로 풀어 쓰세요. 장점은 2개, 주의점은 1개여야 합니다.`,
            },
        ],
    },
    {
        id: 'quick',
        name: '빠른 확인 · 4문항',
        description: '현재 연결과 모델의 반응 속도를 짧게 확인하는 핵심 질문 묶음입니다.',
        templates: quickBenchmarkTemplates,
    },
    {
        id: 'code',
        name: '코드 집중 · 6문항',
        description: 'TypeScript 작성, 수정, 테스트와 코드 설명 능력을 중심으로 확인합니다.',
        templates: [
            quickBenchmarkTemplates[2],
            {
                category: '코드 작성',
                title: '안전한 그룹화',
                prompt: `TypeScript로 groupBy<T>(items: T[], keyOf: (item: T) => string): Record<string, T[]> 함수를 작성하세요. 빈 배열도 안전하게 처리해야 합니다. 코드와 사용 예시 하나만 제공하세요.`,
            },
            {
                category: '디버깅',
                title: '중앙값 계산 수정',
                prompt: `다음 TypeScript 함수의 문제를 고치세요. 원본 배열을 변경하면 안 되고, 숫자는 오름차순으로 정렬되어야 합니다. 코드와 문제 설명 한 문장만 제공하세요.\n\nfunction median(values: number[]): number {\n  const sorted = values.sort();\n  return sorted[Math.floor(sorted.length / 2)];\n}`,
            },
            {
                category: '테스트',
                title: '경계값 테스트 작성',
                prompt: `formatPrice(amount: number): string 함수는 0 이상 금액을 한국 원화 표기 문자열로 반환합니다. Vitest 문법으로 0, 세 자리 수, 큰 수를 검증하는 테스트 3개를 작성하세요. 테스트 코드만 제공하세요.`,
            },
            {
                category: '리팩터링',
                title: '중복 제거 리팩터링',
                prompt: `다음 배열에서 id가 중복된 항목을 제거하되 마지막 항목을 유지하는 TypeScript 함수를 작성하세요. 반환값의 순서는 원래 배열 순서를 유지해야 합니다. 코드와 설명 두 줄 이내로 제공하세요.\n\ntype Item = { id: string; value: string };`,
            },
            {
                category: '코드 설명',
                title: '비개발자 대상 설명',
                prompt: `비개발자에게 "입력값 검증"이 왜 필요한지 온라인 주문 양식 예시를 들어 한국어 글머리표 3개로 설명하세요. 각 글머리표는 한 문장으로 제한하세요.`,
            },
        ],
    },
];

const defaultBenchmarkSuiteID = 'practical';

const benchmarkMetricOptions: Array<{key: BenchmarkMetric; label: string; direction: string}> = [
    {key: 'totalDuration', label: '총 응답 시간', direction: '낮을수록 빠름'},
    {key: 'firstToken', label: '첫 토큰 시간', direction: '낮을수록 빠름'},
    {key: 'generationSpeed', label: '생성 속도', direction: '높을수록 빠름'},
    {key: 'outputTokens', label: '출력 토큰', direction: '응답 길이 참고'},
];

export interface ModelBenchmarkSidebarState {
    model: string;
    profileName: string;
    status: 'idle' | 'running';
    completedCaseCount: number;
    caseCount: number;
    recent: ModelBenchmarkSummary[];
    isHistoryLoading: boolean;
}

interface ModelBenchmarkProps {
    profiles: SavedConnectionProfile[];
    onBusyChange: (busy: boolean) => void;
    onSidebarChange: (state: ModelBenchmarkSidebarState) => void;
    openBenchmarkID: string | null;
    onOpenBenchmarkHandled: () => void;
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
    return `${summary.model} · ${summary.suiteName} · ${formatBenchmarkDate(summary.updatedAt)}`;
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
        suiteName: benchmark.suiteName,
        model: benchmark.model,
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

function BenchmarkBarPlot({
    primary,
    secondary,
    tertiary,
    metric,
}: {
    primary: ModelBenchmark;
    secondary?: ModelBenchmark | null;
    tertiary?: ModelBenchmark | null;
    metric: BenchmarkMetric;
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
                <span>{formatBenchmarkMetric(metric, maximumValue)}</span>
                <span>0</span>
            </div>
            <div className="benchmark-chart-groups">
                {groups.map(({primaryCase, secondaryCase, tertiaryCase}, index) => {
                    const primaryValue = benchmarkMetricValue(primaryCase, metric);
                    const secondaryValue = benchmarkMetricValue(secondaryCase, metric);
                    const tertiaryValue = benchmarkMetricValue(tertiaryCase, metric);
                    return (
                        <div className="benchmark-chart-group" key={index}>
                            <div className="benchmark-chart-bars">
                                <div className="benchmark-chart-column">
                                    <span>{formatBenchmarkMetric(metric, primaryValue)}</span>
                                    <div className="benchmark-chart-track">
                                        {primaryValue !== undefined && (
                                            <div
                                                className="benchmark-chart-bar primary"
                                                style={{height: `${Math.max(3, primaryValue / maximumValue * 100)}%`}}
                                                title={`A · ${formatBenchmarkMetric(metric, primaryValue)}`}
                                            />
                                        )}
                                    </div>
                                    <small>A</small>
                                </div>
                                {secondary && (
                                    <div className="benchmark-chart-column">
                                        <span>{formatBenchmarkMetric(metric, secondaryValue)}</span>
                                        <div className="benchmark-chart-track">
                                            {secondaryValue !== undefined && (
                                                <div
                                                    className="benchmark-chart-bar secondary"
                                                    style={{height: `${Math.max(3, secondaryValue / maximumValue * 100)}%`}}
                                                    title={`B · ${formatBenchmarkMetric(metric, secondaryValue)}`}
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
                                            {tertiaryValue !== undefined && (
                                                <div
                                                    className="benchmark-chart-bar tertiary"
                                                    style={{height: `${Math.max(3, tertiaryValue / maximumValue * 100)}%`}}
                                                    title={`C · ${formatBenchmarkMetric(metric, tertiaryValue)}`}
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
                                <small>{comparisonSummary(metric, [
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
}: {
    primary: ModelBenchmark;
    secondary?: ModelBenchmark | null;
    tertiary?: ModelBenchmark | null;
    metric: BenchmarkMetric;
    onMetricChange: (metric: BenchmarkMetric) => void;
}) {
    const metricOption = benchmarkMetricOptions.find((option) => option.key === metric) || benchmarkMetricOptions[0];

    return (
        <section className="benchmark-visual-card" aria-label={`${metricOption.label} 세로 막대 그래프`}>
            <div className="benchmark-visual-card-heading">
                <div>
                    <strong>{metricOption.label}</strong>
                    <small>{metricOption.direction}</small>
                </div>
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
            <div className="benchmark-chart-legend">
                <span className="primary">A · {primary.model}</span>
                {secondary && <span className="secondary">B · {secondary.model}</span>}
                {tertiary && <span className="tertiary">C · {tertiary.model}</span>}
            </div>
            <BenchmarkBarPlot primary={primary} secondary={secondary} tertiary={tertiary} metric={metric} />
        </section>
    );
}

function ModelBenchmarkWorkspace({
    profiles,
    onBusyChange,
    onSidebarChange,
    openBenchmarkID,
    onOpenBenchmarkHandled,
}: ModelBenchmarkProps) {
    const [profileID, setProfileID] = useState('');
    const [apiKey, setAPIKey] = useState('');
    const [models, setModels] = useState<Model[]>([]);
    const [selectedModel, setSelectedModel] = useState('');
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
    const [comparisonAID, setComparisonAID] = useState('');
    const [comparisonBID, setComparisonBID] = useState('');
    const [comparisonCID, setComparisonCID] = useState('');
    const [comparisonA, setComparisonA] = useState<ModelBenchmark | null>(null);
    const [comparisonB, setComparisonB] = useState<ModelBenchmark | null>(null);
    const [comparisonC, setComparisonC] = useState<ModelBenchmark | null>(null);
    const [comparisonMetric, setComparisonMetric] = useState<BenchmarkMetric>('totalDuration');
    const [loadingAnalysis, setLoadingAnalysis] = useState(false);
    const [loadingComparison, setLoadingComparison] = useState(false);
    const [isRunning, setIsRunning] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [error, setError] = useState('');

    const benchmarkRef = useRef<ModelBenchmark | null>(null);
    const requestRef = useRef<{requestID: string; caseID: string} | null>(null);
    const runProfileRef = useRef<ConnectionProfile | null>(null);

    const selectedProfile = useMemo(
        () => profiles.find((profile) => profile.id === profileID),
        [profileID, profiles],
    );
    const selectedSuite = useMemo(
        () => benchmarkSuites.find((suite) => suite.id === suiteID) || benchmarkSuites[0],
        [suiteID],
    );
    const completedHistory = useMemo(
        () => history.filter((item) => item.status === 'completed' && item.caseCount > 0),
        [history],
    );

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
        void loadHistory();
    }, []);

    useEffect(() => {
        const availableIDs = completedHistory.map((item) => item.id);
        if (!availableIDs.includes(analysisID)) {
            setAnalysisID(availableIDs[0] || '');
        }

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
    }, [analysisID, comparisonAID, comparisonBID, comparisonCID, completedHistory]);

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
        onBusyChange(isRunning);
        return () => onBusyChange(false);
    }, [isRunning, onBusyChange]);

    useEffect(() => {
        const summary = benchmark ? benchmarkSummary(benchmark) : undefined;
        onSidebarChange({
            model: isRunning ? benchmark?.model || '' : '',
            profileName: isRunning ? benchmark?.profileName || '' : '',
            status: isRunning ? 'running' : 'idle',
            completedCaseCount: isRunning ? summary?.completedCaseCount || 0 : 0,
            caseCount: isRunning ? summary?.caseCount || 0 : 0,
            recent: history.slice(0, 8),
            isHistoryLoading: loadingHistory,
        });
    }, [benchmark, history, isRunning, loadingHistory, onSidebarChange]);

    useEffect(() => () => onSidebarChange({
        model: '',
        profileName: '',
        status: 'idle',
        completedCaseCount: 0,
        caseCount: 0,
        recent: [],
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

    async function loadModels() {
        if (!selectedProfile) {
            setError('저장된 연결 프로필을 선택해 주세요.');
            return;
        }
        try {
            setLoadingModels(true);
            setError('');
            const loaded = await ChatService.ListModels({baseURL: selectedProfile.baseURL, apiKey});
            const nextModels = loaded || [];
            setModels(nextModels);
            setSelectedModel((current) => nextModels.some((model) => model.id === current) ? current : nextModels[0]?.id || '');
        } catch (reason) {
            setModels([]);
            setSelectedModel('');
            setError(String(reason));
        } finally {
            setLoadingModels(false);
        }
    }

    function changeProfile(nextProfileID: string) {
        setProfileID(nextProfileID);
        setModels([]);
        setSelectedModel('');
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
            profileID: selectedProfile.id,
            profileName: selectedProfile.name,
            profileBaseURL: selectedProfile.baseURL,
            model: selectedModel,
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
        if (!isRunning) {
            replaceBenchmark(null);
        }
        setError('');
    }

    function showRun() {
        if (benchmark) setView('run');
    }

    function showStoredBenchmark(record: ModelBenchmark) {
        if (isRunning) return;
        replaceBenchmark(record);
        setView('run');
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
        return (
            <section className="benchmark-page" aria-label="모델 벤치마크">
                <header className="benchmark-header">
                    <div>
                        <span className="eyebrow">MODEL BENCHMARK</span>
                        <h1>{isRunning ? '벤치마크 실행 중' : stoppedRun ? '중단된 벤치마크' : '벤치마크 결과'}</h1>
                    </div>
                    <button className="text-button" type="button" onClick={goHome}>모델 실험실 홈</button>
                </header>
                {error && <div className="error-banner" role="alert">{error}</div>}
                <section className="benchmark-run-card">
                    <span>{benchmark.suiteName}</span>
                    <h2>{benchmark.model}</h2>
                    <small>{benchmark.profileName} · 테스트 {benchmark.cases?.length || 0}개</small>
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
            : '벤치마크 기록을 최대 세 개까지 비교하세요';
    const sameTestConfiguration = comparisonA && comparisonB
        ? hasSameTestConfiguration(comparisonA, comparisonB)
            && (!comparisonC || hasSameTestConfiguration(comparisonA, comparisonC))
        : false;
    const sameServerProfile = comparisonA && comparisonB
        ? comparisonA.profileID === comparisonB.profileID
            && comparisonA.profileBaseURL === comparisonB.profileBaseURL
            && (!comparisonC || (comparisonA.profileID === comparisonC.profileID && comparisonA.profileBaseURL === comparisonC.profileBaseURL))
        : false;

    return (
        <section className="benchmark-page benchmark-setup" aria-label="모델 벤치마크 설정">
            <header className="benchmark-header">
                <div>
                    <span className="eyebrow">MODEL BENCHMARK</span>
                    <h1>{homeTitle}</h1>
                </div>
            </header>
            {error && <div className="error-banner" role="alert">{error}</div>}
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
            </nav>
            {homeTab === 'run' && (
                <div className="benchmark-setup-grid">
                    <form className="benchmark-form" onSubmit={(event) => void startBenchmark(event)}>
                    <label>
                        저장된 연결 프로필
                        <select value={profileID} onChange={(event) => changeProfile(event.target.value)} disabled={isRunning}>
                            <option value="">프로필을 선택해 주세요</option>
                            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                        </select>
                    </label>
                    <label>
                        API 키 <small>필요한 경우 입력 · 저장 안 됨</small>
                        <input value={apiKey} onChange={(event) => setAPIKey(event.target.value)} type="password" autoComplete="off" placeholder="필요한 경우 입력" disabled={isRunning} />
                    </label>
                    <button className="secondary-button" type="button" onClick={() => void loadModels()} disabled={!selectedProfile || loadingModels || isRunning}>
                        {loadingModels ? '모델 불러오는 중…' : '모델 불러오기'}
                    </button>
                    <label>
                        측정할 모델
                        <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} disabled={!models.length || isRunning}>
                            {!models.length && <option value="">먼저 모델을 불러와 주세요</option>}
                            {models.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
                        </select>
                    </label>
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
                                <section key={index} className="benchmark-template-editor-item">
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
                                    <small>{analysisRecord.profileName} · {formatBenchmarkDate(analysisRecord.updatedAt)}</small>
                                </div>
                                <button className="text-button" type="button" onClick={() => showStoredBenchmark(analysisRecord)} disabled={isRunning}>상세 결과 보기</button>
                            </section>
                            <BenchmarkVerticalChart
                                primary={analysisRecord}
                                metric={analysisMetric}
                                onMetricChange={setAnalysisMetric}
                            />
                        </>
                    )}
                </section>
            )}
            {homeTab === 'comparison' && (
                <section className="benchmark-visualization-panel" aria-label="벤치마크 기록 비교">
                    <div className="benchmark-comparison-selectors">
                        <label>
                            A 기록
                            <select value={comparisonAID} onChange={(event) => setComparisonAID(event.target.value)} disabled={loadingHistory || completedHistory.length < 2}>
                                {completedHistory.length < 2 && <option value="">비교할 기록이 부족합니다</option>}
                                {completedHistory.map((item) => (
                                    <option key={item.id} value={item.id} disabled={item.id === comparisonBID || item.id === comparisonCID}>{benchmarkRecordLabel(item)}</option>
                                ))}
                            </select>
                        </label>
                        <label>
                            B 기록
                            <select value={comparisonBID} onChange={(event) => setComparisonBID(event.target.value)} disabled={loadingHistory || completedHistory.length < 2}>
                                {completedHistory.length < 2 && <option value="">비교할 기록이 부족합니다</option>}
                                {completedHistory.map((item) => (
                                    <option key={item.id} value={item.id} disabled={item.id === comparisonAID || item.id === comparisonCID}>{benchmarkRecordLabel(item)}</option>
                                ))}
                            </select>
                        </label>
                        <label>
                            C 기록
                            <select value={comparisonCID} onChange={(event) => setComparisonCID(event.target.value)} disabled={loadingHistory || completedHistory.length < 3}>
                                <option value="">선택 안 함</option>
                                {completedHistory.map((item) => (
                                    <option key={item.id} value={item.id} disabled={item.id === comparisonAID || item.id === comparisonBID}>{benchmarkRecordLabel(item)}</option>
                                ))}
                            </select>
                        </label>
                    </div>
                    {loadingHistory || loadingComparison ? (
                        <div className="benchmark-visualization-empty">비교할 기록을 불러오는 중…</div>
                    ) : !comparisonA || !comparisonB ? (
                        <div className="benchmark-visualization-empty">완료된 벤치마크 기록이 2개 이상 필요합니다.</div>
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
                                    <small>{comparisonA.profileName} · {formatBenchmarkDate(comparisonA.updatedAt)}</small>
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
                                    <small>{comparisonB.profileName} · {formatBenchmarkDate(comparisonB.updatedAt)}</small>
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
                                        <small>{comparisonC.profileName} · {formatBenchmarkDate(comparisonC.updatedAt)}</small>
                                        <em>상세 결과 보기</em>
                                    </button>
                                )}
                            </div>
                            <p className={`benchmark-comparison-notice ${sameTestConfiguration ? 'compatible' : 'warning'}`}>
                                {!sameTestConfiguration
                                    ? '선택한 기록의 테스트 제목 또는 질문이 다릅니다. 수치는 참고용으로 비교해 주세요.'
                                    : sameServerProfile
                                        ? '같은 테스트 구성과 연결 프로필에서 실행된 직접 비교 가능한 기록입니다.'
                                        : '테스트 구성은 같지만 연결 프로필이 달라 서버 환경 차이가 포함될 수 있습니다.'}
                            </p>
                            <BenchmarkVerticalChart
                                primary={comparisonA}
                                secondary={comparisonB}
                                tertiary={comparisonC}
                                metric={comparisonMetric}
                                onMetricChange={setComparisonMetric}
                            />
                        </>
                    )}
                </section>
            )}
        </section>
    );
}

export default ModelBenchmarkWorkspace;
