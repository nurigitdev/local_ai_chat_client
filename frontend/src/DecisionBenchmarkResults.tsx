import {decisionAnswerLabel, decisionTaskOverview, decisionQuestionText, isDecisionScorable} from './decisionResultPresentation';
import {neutralDecisionText} from './decisionBenchmarkDraft';
import {useEffect, useRef, useState} from 'react';
import {Dialogs, System} from '@wailsio/runtime';
import {App as Service} from '../bindings/github.com/taengson/agent-chat-desktop';
import type {DecisionBenchmark, DecisionBenchmarkSummary, DecisionComparison} from '../bindings/github.com/taengson/agent-chat-desktop/models';

const percent = (n: number | null) => n == null ? '—' : (n * 100).toFixed(1) + '%';
const value = (n: number | null) => n == null ? '—' : n.toFixed(3);
const time = (n: number | null) => n == null ? '—' : n.toFixed(0) + ' ms';
const statuses: Record<string, string> = {running:'실행 중',completed:'완료',partial:'일부 실패',failed:'실패',cancelled:'취소',interrupted:'중단',pending:'대기',skipped:'미실행',error:'오류'};
const typeNames: Record<string,string> = {choice:'업무영역 분류',noul:'업무영역 해당 여부',score:'업무 적합도 평가'};
function Metrics({s,b}: {s:DecisionBenchmarkSummary;b:DecisionBenchmark}) {
    const metrics=[
        ['영역별 균형 성능 (Macro F1)',value(s.macroF1),'각 정답 종류의 성능을 같은 비중으로 평균합니다. 1에 가까울수록 좋습니다.'],
        ['확률 오차 (Brier)',value(s.brier),'정답에 부여한 확률의 오차입니다. 0에 가까울수록 좋습니다.'],
        ['확신과 실제 정답률의 차이 (ECE)',value(s.ece),'높게 확신한 판단이 실제로도 맞는지 확인합니다. 0에 가까울수록 좋습니다.'],
        ...(s.type==='score'?[
            ['등급 차이 (MAE)',value(s.topMAE),'선택한 등급과 정답 등급의 평균 간격입니다. 0은 일치, 1은 평균 한 단계 차이입니다.'],
            ['확률을 반영한 등급 차이',value(s.expectedMAE),'각 등급의 확률을 반영한 기대 점수와 정답의 평균 간격입니다. 낮을수록 좋습니다.']
        ]:[]),
        ...(s.type==='noul'?[
            ['잘못 해당한다고 판단한 비율',percent(s.falsePositiveRate),'해당하지 않는 문항 중 해당한다고 판단한 비율입니다. 낮을수록 좋습니다.'],
            ['해당하는 요청을 놓친 비율',percent(s.falseNegativeRate),'해당하는 문항 중 해당하지 않는다고 판단한 비율입니다. 낮을수록 좋습니다.']
        ]:[]),
    ];
    return <section className="decision-analysis-task"><h4>{typeNames[s.type]}</h4><div className="decision-explained-metrics">{metrics.map(([name,n,explanation])=><div key={name}><span>{name}</span><strong>{n}</strong><p>{explanation}</p></div>)}</div>
        <p className="decision-analysis-denominator">정답 평가 {s.scorable}문항 · 확률 평가 {s.probabilityCount}문항 · 입력 잘림으로 제외 {s.truncated}문항</p>
        <details><summary>어떤 정답을 잘 찾았는지 보기</summary><p>정밀도는 이 답을 선택했을 때 맞은 비율, 재현율은 실제 이 답인 문항을 찾은 비율입니다.</p><div className="decision-table-scroll"><table><thead><tr><th>정답 종류</th><th>정답 문항 수</th><th>정밀도</th><th>재현율</th><th>균형 점수 (F1)</th></tr></thead><tbody>{(s.classes || []).map(c=><tr key={c.key}><th>{decisionAnswerLabel(b,s.taskID,c.key)}</th><td>{c.support}</td><td>{percent(c.precision)}</td><td>{percent(c.recall)}</td><td>{value(c.f1)}</td></tr>)}</tbody></table></div>
        <h4>다른 답으로 판단한 경우</h4>{(s.confusion || []).flatMap((row,i)=>(row || []).map((n,j)=>i!==j && n>0?<p key={i+':'+j}>{decisionAnswerLabel(b,s.taskID,s.classes?.[i]?.key || '')} → {decisionAnswerLabel(b,s.taskID,s.classes?.[j]?.key || '')} · {n}문항</p>:null)).filter(Boolean)}{!s.scorable && <p>채점된 문항이 없습니다.</p>}</details>
    </section>;
}
function AccuracyDonut({correct,count}: {correct:number;count:number}) {
    const rate=count ? 100*correct/count : 0;
    return <figure className={'decision-accuracy-donut '+(!count?'unavailable':'')}>
        <div className="decision-donut-visual">
            <svg viewBox="0 0 160 160" aria-hidden="true" focusable="false">
                <circle className="decision-donut-remainder" cx="80" cy="80" r="65" fill="none" strokeWidth="14"/>
                {count>0 && <circle className="decision-donut-correct" cx="80" cy="80" r="65" fill="none" strokeWidth="14" pathLength="100" strokeDasharray={rate+' '+(100-rate)} transform="rotate(-90 80 80)"/>}
            </svg>
            <div className="decision-donut-center"><b>{count?percent(correct/count):'평가 불가'}</b><span>{count?'정답률':'채점 문항 없음'}</span></div>
        </div>
        <figcaption>{count>0?<><strong>{count}문항 중 {correct}문항 정답</strong><div className="decision-donut-legend"><span><i className="correct" aria-hidden="true"/>정답 {correct}</span><span><i className="wrong" aria-hidden="true"/>오답 {count-correct}</span></div></>:<p>채점 가능한 결과가 없습니다.</p>}</figcaption>
    </figure>;
}
function ModelResults({b}: {b:DecisionBenchmark}) {
    const [analysis,setAnalysis]=useState(false);
    const tasks=(b.suite.tasks || []).filter(t=>b.types?.includes(t.type));
    return <div className="decision-readable-results">
        <div className="decision-result-mode" role="group" aria-label="결과 보기"><button aria-pressed={!analysis} className={!analysis?'active':''} onClick={()=>setAnalysis(false)}>결과 요약</button><button aria-pressed={analysis} className={analysis?'active':''} onClick={()=>setAnalysis(true)}>상세 분석</button></div>
        {!analysis?<>
        <div className="decision-outcome-intro"><h3>어떤 판단을 더 잘했나요?</h3><p>세 가지 판단을 각각 비교합니다. 모델 간 정답 차이는 모두가 채점된 같은 문항으로 계산합니다.</p></div>
        {tasks.map(task=>{
            const overview=decisionTaskOverview(b,task.id);
            const purpose=task.type==='choice'?'요청을 담당할 업무영역을 골랐는지':task.type==='noul'?'후보 업무영역에 해당하는 요청인지 구분했는지':'부적합·불명확·적합을 기준에 맞게 판단했는지';
            return <section className="decision-outcome-task" key={task.id}><header><h3>{typeNames[task.type]}</h3><p>{purpose}</p></header>
                <div className="decision-outcome-models">{overview.models.map(m=><div key={m.id}><strong>{m.model}</strong><AccuracyDonut correct={m.correct} count={m.count}/>{m.constantAnswer && <p className="decision-pattern-note">{m.count}문항 모두 ‘{m.constantAnswer}’로 판단했습니다. 한 답에 치우친 결과인지 문항별로 확인하세요.</p>}</div>)}</div>
                <p className="decision-outcome-conclusion">{overview.conclusion}</p>
                {overview.models.length>1 && overview.models.some(m=>m.count!==overview.sharedCount) && <p className="decision-results-caption">위 비율은 각 모델의 채점 가능 문항 기준입니다. 비교 문장은 공통 {overview.sharedCount}문항만 사용합니다.</p>}
            </section>;
        })}
        <p className="decision-results-caption">{b.suite.reviewStatus==='unreviewed' ? '정답 기준은 검토 전 초안입니다. ' : ''}이 세트의 결과만으로 모델의 전반적인 업무 능력을 확정하지 않습니다.</p>
        </>:<><div className="decision-outcome-intro"><h3>판단 품질 상세 분석</h3><p>지표의 의미와 평가에 사용한 문항 수를 함께 확인하세요. —는 계산할 표본이 없다는 뜻입니다.</p></div>{(b.targets || []).map(t=><section className="decision-model-analysis" key={t.id}><h3>{t.model}</h3>{(b.summaries || []).filter(s=>s.targetID===t.id).map(s=><Metrics key={s.taskID} s={s} b={b}/>)}</section>)}</>}
        {(b.targets || []).some(t=>(b.warmups || []).some(r=>r.targetID===t.id&&(r.status!=='completed'||!r.labelValid))) && <div className="decision-result-alert" role="alert"><strong>일부 유형의 준비 요청이 실패했습니다</strong>{(b.warmups || []).filter(r=>r.status!=='completed'||!r.labelValid).map((r,i)=><p key={i}>{b.targets?.find(t=>t.id===r.targetID)?.model} · {typeNames[b.suite.tasks?.find(task=>task.id===r.taskID)?.type || '']}: {r.error || r.probabilityError || '응답을 채점할 수 없습니다'}</p>)}<small>미실행 문항은 오답으로 계산하지 않습니다.</small></div>}
        <details className="decision-execution-detail"><summary>실행 상태와 응답 속도</summary><div className="decision-table-scroll"><table><thead><tr><th>모델</th><th>유형</th><th>응답 완료</th><th>오류</th><th>미실행</th><th>평균 응답 시간</th></tr></thead><tbody>{(b.summaries || []).map(s=><tr key={s.targetID+s.taskID}><th>{b.targets?.find(t=>t.id===s.targetID)?.model}</th><td>{typeNames[s.type]}</td><td>{s.completed} / {s.planned}</td><td>{s.errors}</td><td>{s.skipped}</td><td>{time(s.meanMs)}</td></tr>)}</tbody></table></div><p>응답 시간은 네트워크를 포함하며, 실행 환경이 다르면 속도만으로 모델 성능을 비교할 수 없습니다.</p></details>
    </div>;
}
function CaseResults({b}: {b:DecisionBenchmark}) {
    const [model,setModel]=useState('all');
    const [task,setTask]=useState('all');
    const [filter,setFilter]=useState('wrong');
    const [page,setPage]=useState(0);
    const [focus,setFocus]=useState('');
    const rows=(b.results || []).filter(r=>(model==='all'||r.targetID===model)&&(task==='all'||r.taskID===task)&&(filter==='all'||filter==='wrong'&&isDecisionScorable(r)&&!r.correct||filter==='error'&&(r.status==='error'||r.status==='cancelled'||r.status==='completed'&&!r.labelValid)||filter==='skipped'&&r.status==='skipped'||filter==='truncated'&&r.truncated));
    useEffect(()=>{setPage(0);setFocus('');},[model,task,filter]);
    const current=Math.min(page,Math.max(0,Math.ceil(rows.length/20)-1));
    const chosen=rows.find(r=>r.targetID+':'+r.caseID===focus);
    const c=b.suite.cases?.find(c=>c.id===chosen?.caseID);
    const criteria=b.suite.tasks?.find(t=>t.id===chosen?.taskID);

    return <section className="decision-case-results"><h3>틀린 판단을 확인하세요</h3><p className="decision-results-caption">오답을 먼저 표시합니다. 정답 기준과 모델이 고른 답을 질문과 함께 확인하세요.</p><div className="decision-result-filters">
        <label>모델<select value={model} onChange={e=>setModel(e.target.value)}><option value="all">모든 모델</option>{(b.targets || []).map(t=><option key={t.id} value={t.id}>{t.model}</option>)}</select></label>
        <label>판단 유형<select value={task} onChange={e=>setTask(e.target.value)}><option value="all">모든 유형</option>{(b.suite.tasks || []).filter(t=>b.types?.includes(t.type)).map(t=><option key={t.id} value={t.id}>{typeNames[t.type]}</option>)}</select></label>
        <label>결과<select value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">전체</option><option value="wrong">오답</option><option value="error">오류·채점 불가</option><option value="skipped">미실행</option><option value="truncated">잘린 입력</option></select></label>
    </div><div className="decision-table-scroll"><table><thead><tr><th>질문 / 모델</th><th>결과</th><th>정답</th><th>판단</th><th>상세</th></tr></thead><tbody>{rows.slice(current*20,current*20+20).map(r=>{
        const item=b.suite.cases?.find(c=>c.id===r.caseID);
        const key=r.targetID+':'+r.caseID;
        return <tr key={key} className={focus===key?'selected':''}><td className="decision-question-cell">{decisionQuestionText(item?.text || r.caseID)}<small>{b.targets?.find(t=>t.id===r.targetID)?.model}{item?.candidate ? ' · 후보 '+decisionAnswerLabel(b,'business-domain-choice',item.candidate):''}</small></td><td><span className={'decision-result-tag '+(r.status==='error'?'error':r.status==='skipped'?'skipped':r.labelValid&&r.correct?'correct':'')}>{r.status==='completed'?(r.truncated?'잘림':r.labelValid?(r.correct?'정답':'오답'):'채점 불가'):statuses[r.status] || r.status}</span></td><td>{decisionAnswerLabel(b,r.taskID,r.expected)}</td><td>{r.predicted?decisionAnswerLabel(b,r.taskID,r.predicted):'—'}</td><td><button type="button" onClick={()=>setFocus(focus===key?'':key)}>{focus===key?'닫기':'보기'}</button></td></tr>;
    })}</tbody></table></div>{!rows.length && <p>해당하는 문항이 없습니다.</p>}
    <div className="decision-pagination"><span>{rows.length}건 · {current+1} / {Math.max(1,Math.ceil(rows.length/20))}페이지</span><button disabled={current===0} onClick={()=>setPage(current-1)}>이전</button><button disabled={(current+1)*20>=rows.length} onClick={()=>setPage(current+1)}>다음</button></div>
    {chosen && <article className="decision-case-detail"><h4>선택한 질문의 판단 근거</h4><p>정답: <strong>{decisionAnswerLabel(b,chosen.taskID,chosen.expected)}</strong> · 모델 판단: <strong>{decisionAnswerLabel(b,chosen.taskID,chosen.predicted)}</strong></p>{chosen.error && <div className="decision-result-alert">{chosen.error}</div>}<pre>{c?.text}</pre><p>정답 근거: {c?.rationale || '미기재'}</p><p>{chosen.probabilityError} {chosen.modelWarning}</p>{chosen.status==='completed' && <p>왕복 {chosen.durationMs}ms · {chosen.truncated===null?'잘림 여부 미확인':chosen.truncated?'잘림: 품질 집계 제외':'잘리지 않음'}</p>}<details><summary>판단 기준</summary><pre>{c?.instructions?.ko || criteria?.instructions?.ko}</pre>{criteria?.context?.ko && <><p>공통 업무 설명</p><pre>{criteria.context.ko}</pre></>}<pre>{JSON.stringify(criteria?.options,null,2)}</pre></details><details><summary>확률과 원본 응답</summary><p>반환 모델 {chosen.returnedModel || '미확인'} · 라우팅 모델 {chosen.routingModel || '미확인'}</p><pre>{JSON.stringify(chosen.probabilities,null,2)}</pre><pre>{JSON.stringify(chosen.raw,null,2)}</pre></details></article>}
    </section>;
}
export default function DecisionBenchmarkResults({activeRun, refreshKey, onError}: {activeRun: DecisionBenchmark | null; refreshKey:number; onError:(s:string)=>void}) {
    const [records,setRecords]=useState<DecisionBenchmark[]>([]);
    const [selected,setSelected]=useState<string[]>([]);
    const [busy,setBusy]=useState(false);
    const [comparison,setComparison]=useState<DecisionComparison | null>(null);
    const file=useRef<HTMLInputElement>(null);
    const error=useRef(onError);error.current=onError;
    async function reload(){const data=await Service.ListDecisionBenchmarks();setRecords(data || []);setSelected(current=>{const available=current.filter(id=>data?.some(b=>b.id===id));return available.length ? available : data?.[0] ? [data[0].id] : [];});}
    useEffect(()=>{void reload().catch(e=>error.current(String(e)));},[refreshKey,activeRun?.id,activeRun?.status]);
    const visible=records.map(b=>activeRun?.id===b.id ? activeRun : b).filter(b=>selected.includes(b.id));
    const compatible=visible.every(b=>b.fingerprint===visible[0]?.fingerprint && b.scoringVersion===visible[0]?.scoringVersion);
    const comparable=compatible && visible.length > 1;
    useEffect(()=>{
        let disposed=false;setComparison(null);
        if(comparable && visible.every(b=>b.status!=='running')) void Service.CompareDecisionBenchmarks(selected).then(result=>{if(!disposed)setComparison(result);}).catch(e=>{if(!disposed)error.current(String(e));});
        return ()=>{disposed=true;};
    },[selected.join('|'),records,activeRun?.status]);
    async function exportRecord(b:DecisionBenchmark | null,format:'md'|'html'){
        setBusy(true);try{const text=b ? await Service.ExportDecisionBenchmark(b.id,format) : await Service.ExportDecisionComparison(selected,format);
        const reportID=b?.id || 'comparison';
        if(System.IsWindows() || System.IsMac() || System.IsLinux() || System.IsMobile()) {const path=await Dialogs.SaveFile({Title:'Decision 보고서 저장',Filename:'decision-'+reportID+'.'+format,Filters:[{DisplayName:format.toUpperCase(),Pattern:'*.'+format}]});if(path)await Service.SaveDecisionReport(path,text);}
        else{const url=URL.createObjectURL(new Blob([text],{type:format==='html'?'text/html':'text/markdown'}));const a=document.createElement('a');a.href=url;a.download='decision-'+reportID+'.'+format;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
        }catch(e){error.current(String(e));}finally{setBusy(false);}
    }
    return <div className="decision-results"><section className="decision-results-intro"><div><h2>실행 기록과 결과</h2><p>기록을 선택해 확인하세요. 같은 질문 구성의 기록은 최대 3개까지 비교할 수 있습니다.</p></div><button type="button" disabled={busy} onClick={()=>file.current?.click()}>보고서 가져오기</button></section>
    <input type="file" ref={file} hidden accept=".md,.html" onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(!f)return;if(f.size>64*1024*1024){error.current('보고서는 64MiB 이하여야 합니다.');return;}setBusy(true);void f.text().then(text=>Service.ImportDecisionReports(text)).then(()=>reload()).catch(e=>error.current(String(e))).finally(()=>setBusy(false));}}/>
    <div className="decision-record-list">{records.map(record=>{const b=activeRun?.id===record.id?activeRun:record;return <label className={'decision-record-choice '+(selected.includes(b.id)?'selected':'')} key={b.id}><input type="checkbox" checked={selected.includes(b.id)} disabled={!selected.includes(b.id)&&selected.length>=3} onChange={e=>setSelected(current=>e.target.checked?[...current,b.id]:current.filter(id=>id!==b.id))}/><span><strong>{neutralDecisionText(b.experimentName || b.suite.name)}</strong><small>{new Date(b.createdAt).toLocaleString()} · {b.targets?.length || 0}개 모델</small></span><span className="decision-result-tag">{statuses[b.status] || b.status}</span></label>;})}</div>
    {!records.length && <p className="decision-results-empty">실행 기록이 없습니다. 실험 설정에서 서버와 모델을 선택해 실행하세요.</p>}
    {!compatible && <p className="decision-result-alert" role="alert">질문 구성 또는 채점 기준이 달라 동일 조건 비교를 할 수 없습니다. 아래는 각 기록의 결과입니다.</p>}
    {comparison && <section className="decision-record"><h2>동일 문항 비교 · {comparison.commonCaseCount}문항</h2><div className="decision-toolbar-actions"><button type="button" disabled={busy} onClick={()=>void exportRecord(null,'md')}>비교 Markdown 저장</button><button type="button" disabled={busy} onClick={()=>void exportRecord(null,'html')}>비교 HTML 저장</button></div><p>{comparison.warning}</p>{(comparison.records || []).map(b=><div key={b.id}><h3>{neutralDecisionText(b.experimentName || b.suite.name)}</h3><ModelResults b={b}/></div>)}</section>}
    {comparable && !comparison && <p>완료된 기록의 공통 문항을 확인합니다.</p>}
    {visible.map(b=><section className="decision-record" key={b.id}><div className="decision-record-heading"><div><h2>{neutralDecisionText(b.experimentName || b.suite.name)}</h2><p>{statuses[b.status] || b.status} · {new Date(b.createdAt).toLocaleString()} · {(b.suite.questionStyle==='compact'?'간결한 질문':b.suite.questionStyle==='detailed'?'상세한 기준':'기존 질문 구성')}</p></div><div className="decision-toolbar-actions"><button type="button" disabled={busy || b.status==='running'} onClick={()=>void exportRecord(b,'md')}>Markdown 저장</button><button type="button" disabled={busy || b.status==='running'} onClick={()=>void exportRecord(b,'html')}>HTML 저장</button><button type="button" className="decision-delete-record" disabled={busy || b.status==='running'} onClick={()=>{setBusy(true);void Service.DeleteDecisionBenchmark(b.id).then(()=>reload()).catch(e=>error.current(String(e))).finally(()=>setBusy(false));}}>기록 삭제</button></div></div>
    {b.error && <p className="decision-result-alert" role="alert">{b.error}</p>}
    <ModelResults b={b}/>
    <details className="decision-record-metadata"><summary>실험 정보와 준비 요청</summary><p>{neutralDecisionText(b.suite.name)} · {b.suite.revision || '사용자 세트'} · {b.suite.reviewStatus==='unreviewed'?'정답 검토 전':b.suite.reviewStatus || '검토 정보 없음'} · 요청 제한 {b.timeoutSeconds}초</p><p>출처: {neutralDecisionText(b.suite.sourceDocument || '미기재')}</p>{b.imported && <p>가져온 기록 · 원본 ID {b.originID || b.id}</p>}{(b.targets || []).filter(t=>t.environment).map(t=><p key={t.id}>{t.model} 과거 환경 메모: {t.environment} · 사용자 입력</p>)}<p>준비 요청은 측정 집계에서 제외됩니다.</p>{(b.warmups || []).map((r,i)=><p key={i}>{b.targets?.find(t=>t.id===r.targetID)?.model} · {typeNames[b.suite.tasks?.find(t=>t.id===r.taskID)?.type || '']} · {statuses[r.status] || r.status} · {r.error}</p>)}</details>
    <CaseResults b={b}/></section>)}</div>;
}
