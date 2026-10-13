import {useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {Dialogs, System} from '@wailsio/runtime';
import {App as ChatService} from '../bindings/github.com/taengson/agent-chat-desktop';
import {
    buildSystemOnePreview, createDecisionDraft, decisionDraftStorageKey, decisionTypeInfo, decisionTypes,
    parseDecisionSuite, restoreDecisionDraft, selectedDecisionCases, validateDecisionSuite, validateDecisionTargets,
    type DecisionCase, type DecisionDraft, type DecisionLanguage, type DecisionLanguageSelection,
    type DecisionSuite, type DecisionTarget, type DecisionType,
} from './decisionBenchmarkDraft';
import './DecisionBenchmark.css';

export type DecisionView = 'setup' | 'dataset' | 'results';
export interface DecisionSidebarState {
    targetCount: number;
    caseCount: number;
    language: string;
}

const languageLabels: Record<DecisionLanguageSelection, string> = {ko: '한국어', en: '영어', both: '한국어 + 영어'};

function Icon({kind}: {kind: 'models' | 'cases' | 'language' | 'choice' | 'noul' | 'score' | 'arrow' | 'empty'}) {
    const paths: Record<typeof kind, ReactNode> = {
        models: <><rect x="4" y="4" width="16" height="6" rx="2"/><rect x="4" y="14" width="16" height="6" rx="2"/><path d="M8 7h.01M8 17h.01M15 7h2M15 17h2"/></>,
        cases: <><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/></>,
        language: <><path d="M3 5h12M9 3v2M12 5c0 5-4 9-8 11M6 8c1 3 3 5 6 7M14 21l4-10 4 10M16 17h4"/></>,
        choice: <><path d="M4 6h2M10 6h10M4 12h2M10 12h10M4 18h2M10 18h10"/><path d="m3 11 2 2 3-4"/></>,
        noul: <><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></>,
        score: <><path d="M4 20V14h4v6M10 20V9h4v11M16 20V4h4v16M3 20h18"/></>,
        arrow: <><path d="M5 12h14m-5-5 5 5-5 5"/></>,
        empty: <><path d="M4 6h16v14H4zM8 6V3h8v3M8 11h8M8 15h5"/></>,
    };
    return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}

function loadDraft(): {draft: DecisionDraft; warning: string} {
    try {
        const stored = window.localStorage.getItem(decisionDraftStorageKey);
        return {draft: stored ? restoreDecisionDraft(stored) : createDecisionDraft(), warning: ''};
    } catch {
        return {draft: createDecisionDraft(), warning: '저장된 설정 초안을 읽을 수 없어 예제 구성을 열었습니다. JSON으로 내보낸 세트가 있다면 다시 가져와 주세요.'};
    }
}

function downloadFile(filename: string, contents: string, mime: string) {
    const url = URL.createObjectURL(new Blob([contents], {type: mime}));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function saveDatasetFile(format: 'json' | 'csv', contents: string): Promise<boolean> {
    const filename = format === 'json' ? 'decision-suite.json' : 'decision-cases.csv';
    if (System.IsMac() || System.IsWindows() || System.IsLinux() || System.IsMobile()) {
        const path = await Dialogs.SaveFile({
            Title: `Decision 테스트셋 ${format.toUpperCase()} 저장`,
            ButtonText: '저장', Filename: filename,
            Filters: [{DisplayName: `${format.toUpperCase()} 파일`, Pattern: `*.${format}`}],
        });
        if (!path) return false;
        await ChatService.SaveDecisionDatasetExport(path, contents);
    } else {
        downloadFile(filename, contents, format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8');
    }
    return true;
}

function expectedLabel(item: DecisionCase, suite: DecisionSuite) {
    const task = suite.tasks.find((entry) => entry.id === item.taskID);
    if (task?.type === 'noul') return item.expected === 'true' ? '예' : '아니오';
    if (task?.type === 'score') return `등급 ${item.expected}`;
    return item.expected;
}

export default function DecisionBenchmark({view, onViewChange, onSidebarChange}: {
    view: DecisionView;
    onViewChange: (view: DecisionView) => void;
    onSidebarChange: (state: DecisionSidebarState) => void;
}) {
    const [initial] = useState(loadDraft);
    const [draft, setDraft] = useState(initial.draft);
    const [message, setMessage] = useState(initial.warning);
    const [messageKind, setMessageKind] = useState<'error' | 'success'>('error');
    const [saveMessage, setSaveMessage] = useState('설정 초안 자동 저장');
    const [editLanguage, setEditLanguage] = useState<DecisionLanguage>('ko');
    const [activeTaskID, setActiveTaskID] = useState(initial.draft.suite.tasks[0]?.id || '');
    const [activeCaseID, setActiveCaseID] = useState('');
    const [search, setSearch] = useState('');
    const [previewTargetID, setPreviewTargetID] = useState('');
    const [previewCaseID, setPreviewCaseID] = useState('');
    const [apiKeys, setAPIKeys] = useState<Record<string, string>>({});
    const [isImporting, setIsImporting] = useState(false);
    const [exporting, setExporting] = useState<'json' | 'csv' | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const suite = draft.suite;
    const editable = suite.source === 'custom';
    const activeTask = suite.tasks.find((task) => task.id === activeTaskID) || suite.tasks[0];
    const selectedCases = useMemo(() => selectedDecisionCases(suite, draft.types, draft.language), [suite, draft.types, draft.language]);
    const selectedTargets = draft.targets.filter((target) => target.enabled);
    const visibleCases = suite.cases.filter((item) => item.taskID === activeTask?.id && item.language === editLanguage
        && `${item.id} ${item.text} ${item.expected}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    const activeCase = visibleCases.find((item) => item.id === activeCaseID) || visibleCases[0];
    const previewCase = selectedCases.find((item) => item.id === previewCaseID) || selectedCases[0];
    const previewTarget = draft.targets.find((target) => target.id === previewTargetID) || selectedTargets[0] || draft.targets[0];
    const preview = previewCase && previewTarget ? buildSystemOnePreview(suite, previewCase, previewTarget.model) : null;

    useEffect(() => {
        try {
            window.localStorage.setItem(decisionDraftStorageKey, JSON.stringify(draft));
            setSaveMessage('설정 초안 자동 저장');
        } catch {
            setSaveMessage('자동 저장 불가 · JSON 내보내기로 세트를 보관해 주세요');
        }
    }, [draft]);

    useEffect(() => {
        onSidebarChange({targetCount: selectedTargets.length, caseCount: selectedCases.length, language: languageLabels[draft.language]});
    }, [selectedTargets.length, selectedCases.length, draft.language, onSidebarChange]);

    function announce(text: string, kind: 'error' | 'success' = 'success') {
        setMessage(text);
        setMessageKind(kind);
    }

    function updateSuite(update: (current: DecisionSuite) => DecisionSuite) {
        if (!editable) return;
        setDraft((current) => ({...current, suite: update(current.suite)}));
        setMessage('');
    }

    function updateTarget(id: string, changes: Partial<DecisionTarget>) {
        setDraft((current) => ({...current, targets: current.targets.map((target) => target.id === id ? {...target, ...changes} : target)}));
        setMessage('');
    }

    function cloneSuite() {
        setDraft((current) => ({...current, suite: {...current.suite, source: 'custom', name: `${current.suite.name} · 내 세트`}}));
        announce('사용자 세트로 복제했습니다. 지시문, 선택지, 문항과 정답을 편집할 수 있습니다.');
    }

    function checkConfiguration() {
        const issues = [...validateDecisionSuite(suite), ...validateDecisionTargets(draft.targets)];
        if (!selectedCases.length) issues.push('선택한 유형·언어에 실행할 문항이 없습니다.');
        announce(issues.length ? issues.slice(0, 6).join('\n') : '입력 형식을 확인했습니다. 서버 연결·모델 실행은 백엔드 연결 후 사용할 수 있습니다.', issues.length ? 'error' : 'success');
    }

    async function importSuite(file: File) {
        if (file.size > 5 * 1024 * 1024) { announce('5MB 이하의 JSON 테스트셋을 선택해 주세요.', 'error'); return; }
        setIsImporting(true);
        try {
            const imported = parseDecisionSuite(await file.text());
            setDraft((current) => ({...current, suite: imported}));
            setActiveTaskID(imported.tasks[0].id);
            setActiveCaseID('');
            setSearch('');
            onViewChange('dataset');
            announce(`${imported.name} · ${imported.cases.length}개 문항을 가져왔습니다.`);
        } catch (reason) { announce(reason instanceof Error ? reason.message : '테스트셋을 가져오지 못했습니다.', 'error'); }
        finally { setIsImporting(false); }
    }

    async function exportSuite() {
        if (exporting) return;
        const issues = validateDecisionSuite(suite);
        if (issues.length) { announce(issues.slice(0, 5).join('\n'), 'error'); return; }
        setExporting('json');
        try {
            if (await saveDatasetFile('json', `${JSON.stringify(suite, null, 2)}\n`)) announce('테스트셋 JSON을 내보냈습니다. 서버 설정과 API 키는 포함되지 않습니다.');
        } catch (reason) { announce(reason instanceof Error ? reason.message : '테스트셋을 저장하지 못했습니다.', 'error'); }
        finally { setExporting(null); }
    }

    async function exportCases() {
        if (exporting) return;
        const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
        const rows = suite.cases.map(({id, pairID, taskID, language, text, expected}) => [id, pairID, taskID, language, text, expected].map(escape).join(','));
        setExporting('csv');
        try {
            if (await saveDatasetFile('csv', `\uFEFFid,pair_id,task_id,language,text,expected\r\n${rows.join('\r\n')}\r\n`)) announce('전체 문항을 CSV로 내보냈습니다. CSV에는 과제 지시문·선택지 정의가 포함되지 않습니다.');
        } catch (reason) { announce(reason instanceof Error ? reason.message : '문항을 저장하지 못했습니다.', 'error'); }
        finally { setExporting(null); }
    }

    function addCase() {
        if (!activeTask || !editable) return;
        const pairID = crypto.randomUUID();
        updateSuite((current) => ({...current, cases: [...current.cases, ...(['ko', 'en'] as const).map((language) => ({
            id: `${pairID}-${language}`, pairID, taskID: activeTask.id, language, text: '', expected: activeTask.options[0]?.key || '',
        }))]}));
        setActiveCaseID(`${pairID}-${editLanguage}`);
        setSearch('');
    }

    function updateCase(id: string, changes: Partial<DecisionCase>) {
        updateSuite((current) => ({...current, cases: current.cases.map((item) => item.id === id ? {...item, ...changes} : item)}));
    }

    function renameOption(index: number, key: string) {
        if (!activeTask || activeTask.type !== 'choice') return;
        const oldKey = activeTask.options[index].key;
        updateSuite((current) => ({...current,
            tasks: current.tasks.map((task) => task.id === activeTask.id ? {...task, options: task.options.map((option, optionIndex) => optionIndex === index ? {...option, key} : option)} : task),
            cases: current.cases.map((item) => item.taskID === activeTask.id && item.expected === oldKey ? {...item, expected: key} : item),
        }));
    }

    function removeOption(index: number) {
        if (!activeTask || activeTask.type === 'noul' || activeTask.options.length <= 2) return;
        const removedKey = activeTask.options[index].key;
        updateSuite((current) => ({...current,
            tasks: current.tasks.map((task) => task.id === activeTask.id ? {...task, options: task.options.filter((_, optionIndex) => optionIndex !== index).map((option, optionIndex) => task.type === 'score' ? {...option, key: String(optionIndex)} : option)} : task),
            cases: current.cases.map((item) => {
                if (item.taskID !== activeTask.id) return item;
                if (item.expected === removedKey) return {...item, expected: ''};
                if (activeTask.type === 'score' && item.expected !== '' && Number(item.expected) > index) return {...item, expected: String(Number(item.expected) - 1)};
                return item;
            }),
        }));
    }

    const typeCounts = Object.fromEntries(decisionTypes.map((type) => [type, selectedDecisionCases(suite, [type], draft.language).length])) as Record<DecisionType, number>;

    return <section className="benchmark-page decision-page" aria-label="Decision Benchmark">
        <header className="decision-header">
            <div>
                <span className="eyebrow">MODEL LAB / DECISION</span>
                <h1>Decision Benchmark</h1>
                <p>같은 질문, 같은 기준. 모델마다 다른 판단을 비교하세요.</p>
            </div>
            <span className="decision-stage-badge"><span/>실행 기능 준비 중</span>
        </header>

        <nav className="decision-tabs" aria-label="Decision Benchmark 메뉴">
            {([['setup', '실험 설정'], ['dataset', '테스트셋'], ['results', '결과 비교']] as const).map(([tab, label]) =>
                <button key={tab} type="button" className={view === tab ? 'active' : ''} aria-current={view === tab ? 'page' : undefined} onClick={() => onViewChange(tab)}>{label}</button>)}
            <small>{saveMessage}</small>
        </nav>

        {message && <div className={`decision-message ${messageKind}`} role={messageKind === 'error' ? 'alert' : 'status'}>{message}</div>}

        {view === 'setup' && <>
            <div className="decision-summary" aria-label="선택한 실험 구성">
                <div><Icon kind="models"/><span>평가 대상<strong>{selectedTargets.length}<small>개 모델</small></strong></span></div>
                <div><Icon kind="cases"/><span>선택한 문항<strong>{selectedCases.length}<small>개 문항 · {draft.types.length}개 유형</small></strong></span></div>
                <div><Icon kind="language"/><span>평가 언어<strong className="decision-summary-language">{languageLabels[draft.language]}</strong></span></div>
            </div>

            <section className="decision-section" aria-labelledby="decision-target-heading">
                <div className="decision-section-heading">
                    <div><span className="decision-step">01</span><h2 id="decision-target-heading">평가 대상</h2><p>동일한 테스트셋을 각 서버의 모델에 전달합니다.</p></div>
                    <button className="secondary-button" type="button" onClick={() => {
                        const id = crypto.randomUUID();
                        setDraft((current) => ({...current, targets: [...current.targets, {id, name: '새 평가 대상', runtime: 'systemone', baseURL: '', model: '', environment: '', enabled: true}]}));
                    }}>+ 모델 추가</button>
                </div>
                <div className="decision-target-grid">
                    {draft.targets.map((target, index) => <article className={`decision-target-card ${target.enabled ? 'selected' : ''}`} key={target.id}>
                        <div className="decision-target-title">
                            <span className="decision-target-letter">{String.fromCharCode(65 + index % 26)}</span>
                            <label className="decision-target-toggle"><input type="checkbox" checked={target.enabled} onChange={(event) => updateTarget(target.id, {enabled: event.target.checked})}/><span>{target.name || '이름 없는 대상'}</span></label>
                            <button type="button" className="decision-icon-button" aria-label={`${target.name || '평가 대상'} 삭제`} onClick={() => {
                                setDraft((current) => ({...current, targets: current.targets.filter((item) => item.id !== target.id)}));
                                setAPIKeys((current) => {const next = {...current}; delete next[target.id]; return next;});
                            }}>×</button>
                        </div>
                        <div className="decision-field-row">
                            <label>대상 이름<input value={target.name} onChange={(event) => updateTarget(target.id, {name: event.target.value})} placeholder="결과에 표시할 이름"/></label>
                            <label>서버 종류<select value={target.runtime} onChange={(event) => updateTarget(target.id, {runtime: event.target.value as DecisionTarget['runtime']})}><option value="laya">Laya Serve</option><option value="ollama">Ollama</option><option value="systemone">System One 호환</option></select></label>
                        </div>
                        <label>서버 주소<input type="url" value={target.baseURL} onChange={(event) => updateTarget(target.id, {baseURL: event.target.value})} placeholder={target.runtime === 'laya' ? 'http://192.168.0.10:12300' : 'http://localhost:11434'} spellCheck={false}/></label>
                        <label>모델 ID<input value={target.model} onChange={(event) => updateTarget(target.id, {model: event.target.value})} placeholder="서버에서 사용하는 모델 이름" spellCheck={false}/></label>
                        <details className="decision-target-details"><summary>실행 환경 · 인증 설정</summary>
                            <label>실행 환경<input value={target.environment} onChange={(event) => updateTarget(target.id, {environment: event.target.value})} placeholder="장비 · 런타임 버전 · 정밀도"/></label>
                            <label>API 키 <small>선택 사항 · 저장하지 않음</small><input type="password" autoComplete="off" value={apiKeys[target.id] || ''} onChange={(event) => setAPIKeys((current) => ({...current, [target.id]: event.target.value}))} placeholder="인증이 필요한 서버에서만 입력"/></label>
                        </details>
                        <div className="decision-target-footer"><span className="decision-unverified"><span/>연결 미확인</span><button className="text-button" type="button" disabled title="백엔드 연결 후 사용할 수 있습니다">연결 테스트</button></div>
                    </article>)}
                    {!draft.targets.length && <div className="decision-empty-targets"><Icon kind="models"/><p>비교할 모델을 추가해 주세요.</p></div>}
                </div>
            </section>

            <section className="decision-section decision-config-card" aria-labelledby="decision-suite-heading">
                <div className="decision-section-heading"><div><span className="decision-step">02</span><h2 id="decision-suite-heading">테스트 구성</h2><p>판단 유형과 언어를 선택해 평가 범위를 정합니다.</p></div><button className="text-button" type="button" onClick={() => onViewChange('dataset')}>문항 확인 <Icon kind="arrow"/></button></div>
                <div className="decision-suite-banner"><Icon kind="cases"/><div><strong>{suite.name}</strong><span>{suite.source === 'example' ? '화면 확인용 예제 · 정식 기본 벤치마크 선정 예정' : '사용자 테스트셋 · 정답과 기준을 검토해 주세요'}</span></div><span className="decision-tag">{suite.source === 'example' ? '예제' : '사용자 세트'}</span></div>
                <div className="decision-type-grid" aria-label="평가 유형 선택">
                    {decisionTypes.map((type) => <label key={type} className={`decision-type-card ${draft.types.includes(type) ? 'selected' : ''}`}>
                        <div><Icon kind={type}/><input type="checkbox" checked={draft.types.includes(type)} onChange={(event) => setDraft((current) => ({...current, types: event.target.checked ? [...current.types, type] : current.types.filter((item) => item !== type)}))}/></div>
                        <strong>{decisionTypeInfo[type].label}<code>{type}</code></strong><p>{decisionTypeInfo[type].description}</p><span>{typeCounts[type]}개 문항</span>
                    </label>)}
                </div>
                <fieldset className="decision-language-field"><legend>평가 언어</legend><div className="decision-language-options">
                    {(['ko', 'en', 'both'] as const).map((language) => <label key={language} className={draft.language === language ? 'selected' : ''}><input type="radio" name="decision-language" value={language} checked={draft.language === language} onChange={() => setDraft((current) => ({...current, language}))}/><span>{languageLabels[language]}</span>{language === 'ko' && <small>기본</small>}{language === 'both' && <small>대응 문항 비교</small>}</label>)}
                </div></fieldset>
            </section>

            <details className="decision-request-preview"><summary><span>요청 미리보기</span><code>POST /v1/systemone</code><span className="decision-preview-caret">⌄</span></summary>
                <p>실제 전송될 JSON 구성입니다. 미리보기에서는 서버를 호출하지 않습니다.</p>
                <div className="decision-field-row"><label>평가 대상<select value={previewTarget?.id || ''} onChange={(event) => setPreviewTargetID(event.target.value)}>{draft.targets.map((target) => <option key={target.id} value={target.id}>{target.name} · {target.model}</option>)}</select></label><label>문항<select value={previewCase?.id || ''} onChange={(event) => setPreviewCaseID(event.target.value)}>{selectedCases.map((item) => <option key={item.id} value={item.id}>{item.language.toUpperCase()} · {item.text.slice(0, 45)}</option>)}</select></label></div>
                <pre>{preview ? JSON.stringify(preview, null, 2) : '미리보기할 모델과 문항을 선택해 주세요.'}</pre>
            </details>

            <footer className="decision-launch-bar"><div><strong>{selectedTargets.length}개 모델 × {selectedCases.length}개 문항</strong><span>측정 요청 {selectedTargets.length * selectedCases.length}회 · 준비 요청 별도</span></div><div><button className="secondary-button" type="button" onClick={checkConfiguration}>설정 확인</button><button className="primary-button" type="button" disabled>벤치마크 실행 <Icon kind="arrow"/></button></div><p>서버 호출·채점·실행 기록 기능은 다음 단계에서 연결됩니다.</p></footer>
        </>}

        {view === 'dataset' && <>
            <div className="decision-dataset-toolbar"><div><h2>{suite.name}</h2><p>{suite.cases.length}개 문항 · 한국어 / 영어 대응 구성</p></div><div className="decision-toolbar-actions"><button className="secondary-button" type="button" onClick={() => fileRef.current?.click()} disabled={isImporting || exporting !== null}>{isImporting ? '가져오는 중…' : 'JSON 가져오기'}</button><button className="secondary-button" type="button" onClick={() => void exportSuite()} disabled={exporting !== null || isImporting}>{exporting === 'json' ? '저장하는 중…' : 'JSON 내보내기'}</button><button className="text-button" type="button" onClick={() => void exportCases()} disabled={exporting !== null || isImporting}>{exporting === 'csv' ? '저장하는 중…' : 'CSV 내보내기'}</button></div></div>
            <div className="decision-dataset-note"><span className="decision-tag">{editable ? '사용자 세트' : '예제 세트'}</span><p>{editable ? '수정한 내용은 설정 초안으로 자동 저장됩니다. 두 언어의 문항과 정답은 각각 검토해 주세요.' : '아래 문항은 화면과 요청 형식 확인용입니다. 정식 평가 데이터셋이 아니며, 복제 후 편집할 수 있습니다.'}</p>{!editable && <button className="secondary-button" type="button" onClick={cloneSuite}>사용자 세트로 복제</button>}</div>
            {editable && <label className="decision-suite-name">테스트셋 이름<input value={suite.name} onChange={(event) => updateSuite((current) => ({...current, name: event.target.value}))}/></label>}

            <div className="decision-editor-layout">
                <aside className="decision-task-list" aria-label="편집할 평가 과제">
                    <span>평가 과제</span>{suite.tasks.map((task) => <button key={task.id} type="button" className={activeTask?.id === task.id ? 'active' : ''} aria-pressed={activeTask?.id === task.id} onClick={() => {setActiveTaskID(task.id); setSearch(''); setActiveCaseID('');}}><Icon kind={task.type}/><span><strong>{task.name}</strong><small>{task.type} · {suite.cases.filter((item) => item.taskID === task.id).length}문항</small></span><span aria-hidden="true">›</span></button>)}
                    <small>각 유형의 기준과 정답을<br/>같은 조건으로 비교합니다.</small>
                </aside>
                {activeTask && <div className="decision-editor-main">
                    <section className="decision-task-definition"><div className="decision-section-heading"><div><h2>{activeTask.name}</h2><span className="decision-definition-meta">{activeTask.type} · {decisionTypeInfo[activeTask.type].metric}</span></div><div className="decision-language-mini" role="group" aria-label="편집 언어">{(['ko', 'en'] as const).map((language) => <button key={language} type="button" aria-pressed={editLanguage === language} className={editLanguage === language ? 'active' : ''} onClick={() => {setEditLanguage(language); setActiveCaseID(''); setSearch('');}}>{languageLabels[language]}</button>)}</div></div>
                        {editable && <label>과제 이름<input value={activeTask.name} onChange={(event) => updateSuite((current) => ({...current, tasks: current.tasks.map((task) => task.id === activeTask.id ? {...task, name: event.target.value} : task)}))}/></label>}
                        <label>판단 지시문<textarea rows={3} readOnly={!editable} value={activeTask.instructions[editLanguage]} onChange={(event) => updateSuite((current) => ({...current, tasks: current.tasks.map((task) => task.id === activeTask.id ? {...task, instructions: {...task.instructions, [editLanguage]: event.target.value}} : task)}))}/></label>
                        <div className="decision-option-heading"><span>{activeTask.type === 'score' ? '등급 기준 · 낮은 등급부터' : '선택지와 판단 기준'}</span><small>{activeTask.options.length}개</small></div>
                        <div className="decision-options-editor">{activeTask.options.map((option, index) => <div key={index}>
                            {editable && activeTask.type === 'choice' ? <input aria-label={`${index + 1}번째 선택지 키`} value={option.key} onChange={(event) => renameOption(index, event.target.value)} spellCheck={false}/> : <code>{option.key}</code>}
                            <textarea aria-label={`${option.key} ${languageLabels[editLanguage]} 판단 기준`} rows={2} readOnly={!editable} value={option.descriptions[editLanguage]} onChange={(event) => updateSuite((current) => ({...current, tasks: current.tasks.map((task) => task.id === activeTask.id ? {...task, options: task.options.map((entry, optionIndex) => optionIndex === index ? {...entry, descriptions: {...entry.descriptions, [editLanguage]: event.target.value}} : entry)} : task)}))}/>
                            {editable && activeTask.type !== 'noul' && <button className="decision-icon-button" type="button" disabled={activeTask.options.length <= 2} aria-label={`${option.key} ${activeTask.type === 'score' ? '등급' : '선택지'} 삭제`} onClick={() => removeOption(index)}>×</button>}
                        </div>)}</div>
                        {editable && activeTask.type !== 'noul' && <button className="text-button decision-add-option" type="button" disabled={activeTask.options.length >= 26} onClick={() => updateSuite((current) => ({...current, tasks: current.tasks.map((task) => {
                            if (task.id !== activeTask.id) return task;
                            const key = task.type === 'score' ? String(task.options.length) : `label_${crypto.randomUUID().slice(0, 8)}`;
                            return {...task, options: [...task.options, {key, descriptions: {ko: '', en: ''}}]};
                        })}))}>+ {activeTask.type === 'score' ? '등급' : '선택지'} 추가</button>}
                    </section>
                    <section className="decision-cases-section"><div className="decision-section-heading"><div><h2>테스트 문항 <small>{visibleCases.length}</small></h2></div><button className="secondary-button" type="button" disabled={!editable} onClick={addCase}>+ 대응 문항 추가</button></div>
                        <input className="decision-case-search" type="search" aria-label="테스트 문항 검색" placeholder="문항 내용 · ID · 정답 검색" value={search} onChange={(event) => setSearch(event.target.value)}/>
                        <div className="decision-case-list">{visibleCases.map((item, index) => <button type="button" key={item.id} className={activeCase?.id === item.id ? 'active' : ''} aria-pressed={activeCase?.id === item.id} onClick={() => setActiveCaseID(item.id)}><span className="decision-case-index">{String(index + 1).padStart(2, '0')}</span><span>{item.text || '새 문항 · 텍스트를 입력하세요'}</span><code>{expectedLabel(item, suite)}</code></button>)}{!visibleCases.length && <p className="decision-muted">표시할 문항이 없습니다.</p>}</div>
                        {activeCase && <div className="decision-case-editor"><div><span className="decision-tag">{activeCase.language.toUpperCase()}</span><code title={activeCase.pairID}>{activeCase.id}</code>{editable && <button className="text-button danger" type="button" onClick={() => updateSuite((current) => ({...current, cases: current.cases.filter((item) => item.id !== activeCase.id)}))}>이 문항 삭제</button>}</div><label>입력 텍스트<textarea rows={3} readOnly={!editable} value={activeCase.text} onChange={(event) => updateCase(activeCase.id, {text: event.target.value})}/></label><label>기대 정답<select value={activeCase.expected} disabled={!editable} onChange={(event) => updateCase(activeCase.id, {expected: event.target.value})}><option value="">정답을 선택하세요</option>{activeTask.options.map((option) => <option key={option.key} value={option.key}>{option.key} · {option.descriptions[editLanguage]}</option>)}</select></label><small>정답은 채점에만 사용하며 모델 요청에는 포함되지 않습니다.</small></div>}
                    </section>
                </div>}
            </div>
        </>}

        {view === 'results' && <>
            <section className="decision-results-intro"><div><h2>판단 품질과 처리 시간을 함께 비교합니다.</h2><p>동일한 테스트셋 · 언어 · 채점 기준의 기록을 최대 3개까지 비교합니다.</p></div><button className="secondary-button" type="button" disabled>보고서 내보내기</button></section>
            <div className="decision-comparison-slots">{['A', 'B', 'C'].map((letter) => <label key={letter}><span>비교 기록 <strong>{letter}</strong></span><select disabled value=""><option value="">저장된 실행 기록 없음</option></select></label>)}</div>
            <div className="decision-result-metrics" aria-label="실행 후 제공할 지표"><div><span>판단 품질</span><strong>—</strong><small>정확도 · F1 · 등급 오차</small></div><div><span>확률 신뢰도</span><strong>—</strong><small>Brier score · ECE</small></div><div><span>왕복 처리 시간</span><strong>—</strong><small>평균 · p50 · p95</small></div></div>
            <section className="decision-results-empty"><div className="decision-empty-icon"><Icon kind="empty"/></div><h2>아직 실행 기록이 없습니다</h2><p>서버 실행 기능이 연결되면 실제 측정 결과가 여기에 표시됩니다.<br/>지금은 평가할 모델과 한국어·영어 테스트셋을 구성할 수 있습니다.</p><button className="primary-button" type="button" onClick={() => onViewChange('setup')}>실험 설정으로 <Icon kind="arrow"/></button></section>
            <div className="decision-result-capabilities">{decisionTypes.map((type) => <div key={type}><Icon kind={type}/><strong>{decisionTypeInfo[type].label}</strong><p>{decisionTypeInfo[type].metric}</p></div>)}</div>
            <p className="decision-results-note">한국어·영어 결과는 각각 표시합니다. 다른 실행 환경의 처리 시간은 참고값으로 비교합니다.</p>
        </>}
        <input ref={fileRef} type="file" accept=".json,application/json" hidden aria-label="Decision 테스트셋 JSON 파일" onChange={(event) => {const file = event.target.files?.[0]; event.target.value = ''; if (file) void importSuite(file);}}/>
    </section>;
}
