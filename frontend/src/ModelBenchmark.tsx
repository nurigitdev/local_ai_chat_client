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
const benchmarkSuiteName = '기본 실용 벤치마크';

const benchmarkTemplates: Array<Pick<ModelBenchmarkCase, 'category' | 'title' | 'prompt'>> = [
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

type BenchmarkCaseDraft = Pick<ModelBenchmarkCase, 'category' | 'title' | 'prompt'>;

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
    if (!usage || !metrics || usage.completionTokens <= 0) {
        return null;
    }
    const generationDuration = metrics.totalDurationMs - metrics.firstTokenDurationMs;
    if (generationDuration <= 0) {
        return null;
    }
    const tokensPerSecond = usage.completionTokens / (generationDuration / 1_000);
    return `${new Intl.NumberFormat('ko-KR', {maximumFractionDigits: 1}).format(tokensPerSecond)} tok/s`;
}

function defaultCaseDrafts(): BenchmarkCaseDraft[] {
    return benchmarkTemplates.map((template) => ({...template}));
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
    const [caseDrafts, setCaseDrafts] = useState<BenchmarkCaseDraft[]>(defaultCaseDrafts);
    const [history, setHistory] = useState<ModelBenchmarkSummary[]>([]);
    const [loadingHistory, setLoadingHistory] = useState(true);
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

    function updateCaseDraft(index: number, prompt: string) {
        setCaseDrafts((current) => current.map((draft, draftIndex) => draftIndex === index ? {...draft, prompt} : draft));
    }

    function resetCaseDraft(index: number) {
        setCaseDrafts((current) => current.map((draft, draftIndex) => draftIndex === index ? {...benchmarkTemplates[index]} : draft));
    }

    function resetAllCaseDrafts() {
        setCaseDrafts(defaultCaseDrafts());
    }

    async function startBenchmark(event: FormEvent) {
        event.preventDefault();
        if (!selectedProfile || !selectedModel || isRunning) return;
        if (caseDrafts.some((draft) => draft.prompt.trim() === '')) {
            setError('모든 테스트 프롬프트를 입력해 주세요.');
            return;
        }
        const initial: ModelBenchmark = {
            id: '',
            profileID: selectedProfile.id,
            profileName: selectedProfile.name,
            profileBaseURL: selectedProfile.baseURL,
            model: selectedModel,
            suiteName: benchmarkSuiteName,
            status: 'running',
            createdAt: '',
            updatedAt: '',
            cases: createBenchmarkCases(caseDrafts.map((draft) => ({...draft, prompt: draft.prompt.trim()}))),
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
                {isRunning && <p className="benchmark-status-copy">같은 조건을 유지하기 위해 표준 테스트 4개를 한 번에 하나씩 실행합니다.</p>}
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

    return (
        <section className="benchmark-page benchmark-setup" aria-label="모델 벤치마크 설정">
            <header className="benchmark-header">
                <div>
                    <span className="eyebrow">MODEL BENCHMARK</span>
                    <h1>하나의 모델을 자세히 측정하세요</h1>
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
                    <section className="benchmark-suite-preview" aria-label="기본 테스트 구성">
                        <div className="benchmark-suite-heading">
                            <strong>{benchmarkSuiteName}</strong>
                            <button type="button" onClick={resetAllCaseDrafts} disabled={isRunning}>전체 기본값 복원</button>
                        </div>
                        <p>질문은 실행 전에 자유롭게 바꿀 수 있으며, 실행한 질문은 결과 기록에 함께 저장됩니다.</p>
                        <div className="benchmark-template-editor">
                            {caseDrafts.map((draft, index) => (
                                <section key={draft.title} className="benchmark-template-editor-item">
                                    <div>
                                        <strong>{index + 1}. {draft.category} · {draft.title}</strong>
                                        <button type="button" onClick={() => resetCaseDraft(index)} disabled={isRunning}>기본값</button>
                                    </div>
                                    <textarea
                                        value={draft.prompt}
                                        onChange={(event) => updateCaseDraft(index, event.target.value)}
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
        </section>
    );
}

export default ModelBenchmarkWorkspace;
