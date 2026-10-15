import {Fragment,useId} from 'react';
import type {DecisionCaseView} from './decisionResultPresentation.js';
interface CaseDetailRecord {
 suite:{tasks?:{id:string;type:string;instructions?:Record<string,string|undefined>|null;context?:Record<string,string|undefined>|null;options?:{key:string;descriptions?:Record<string,string|undefined>|null}[]|null}[]|null;cases?:{id:string;text:string;rationale?:string;instructions?:Record<string,string|undefined>|null}[]|null};
 targets?:{id:string;model:string}[]|null;
}
interface CaseDetailResult extends DecisionCaseView {expected:string;error?:string;probabilityError?:string;modelWarning?:string;returnedModel?:string;routingModel?:string;durationMs?:number;raw?:unknown;}
import {decisionAnswerLabel,decisionIdentification,decisionQuestionText,decisionRationaleText,decisionResultLabel,isDecisionScorable} from './decisionResultPresentation.js';
const percent=(p:number|null|undefined)=>p==null?'—':(p*100).toFixed(1)+'%';

export default function DecisionCaseResultRow({b,r,expanded,onToggle}:{b:CaseDetailRecord;r:CaseDetailResult;expanded:boolean;onToggle:()=>void}) {
 const detailID=useId();
 const item=b.suite.cases?.find(c=>c.id===r.caseID);
 const task=b.suite.tasks?.find(t=>t.id===r.taskID);
 const model=b.targets?.find(t=>t.id===r.targetID)?.model || '모델 미기재';
 const identification=decisionIdentification(b,r);
 const ranking=task?.type==='ranking';
 const expected=r.expected.split('|').filter(Boolean),selected=r.predicted.split('|').filter(Boolean);
 const missing=expected.filter(key=>!selected.includes(key));
 const extra=selected.filter(key=>!expected.includes(key));
 const answer=(key:string)=>decisionAnswerLabel(b,r.taskID,key);
 return <Fragment>
  <tr className={expanded?'selected':''}>
   <td className="decision-question-cell">{decisionQuestionText(item?.text || r.caseID)}<small>{model}</small></td>
   <td><span className={'decision-result-tag '+(r.status==='error'?'error':r.status==='skipped'?'skipped':r.labelValid&&r.correct?'correct':'')}>{decisionResultLabel(b,r)}</span>{identification.low.length>0 && <small>확률 배분 주의</small>}</td>
   <td>{answer(r.expected)}</td><td>{r.predicted?answer(r.predicted):'—'}</td>
   <td><button type="button" aria-expanded={expanded} aria-controls={detailID} onClick={onToggle}>{expanded?'접기':'펼치기'}</button></td>
  </tr>
  {expanded && <tr className="decision-inline-detail-row"><td colSpan={5} className="decision-inline-detail-cell"><article id={detailID} className="decision-case-detail">
   <h4>문항 상세 · {model}</h4><pre>{item?.text}</pre>
   <section className="decision-case-section"><h4>평가 세트의 정답과 설명</h4><p className="decision-results-caption">평가 세트에 작성된 정답입니다. 모델이 작성한 설명이 아니며, 정답과 정답 설명은 모델 요청에 포함되지 않습니다.</p>
    <p>정답 업무: <strong>{answer(r.expected)}</strong></p><p>{decisionRationaleText(b,r.taskID,item?.rationale || '정답 설명이 기재되지 않았습니다.')}</p>
    <ul className="decision-domain-definitions">{expected.map(key=><li key={key}><strong>{answer(key)}</strong>: {task?.options?.find(o=>o.key===key)?.descriptions?.ko || '후보 설명 미기재'}</li>)}</ul>
   </section>
   <section className="decision-case-section"><h4>앱이 계산한 평가 결과</h4><p><strong>{decisionResultLabel(b,r)}</strong>{ranking && isDecisionScorable(r) && <> · 필요한 업무 {identification.total}개 중 {identification.hits}개가 상위 {identification.total}개 후보에 포함되었습니다.</>}</p>
    <p>{ranking?'평가에 사용한 상위 후보':'모델이 선택한 업무'}: <strong>{answer(r.predicted)}</strong></p>
    {ranking && isDecisionScorable(r) && <><p>빠진 정답 업무: {missing.length?missing.map(answer).join(' · '):'없음'}</p><p>정답에 없는 후보: {extra.length?extra.map(answer).join(' · '):'없음'}</p></>}
    {identification.low.length>0 && <p className="decision-pattern-note">확률 배분 주의: {identification.low.map(key=>answer(key)+' '+percent(r.probabilities?.[key])).join(' · ')}<small>앱이 균등 배분 기준 {percent(identification.baseline)} 미만의 정답 업무를 표시했습니다. 식별 결과와는 별도로 확인합니다.</small></p>}
    {r.error && <p className="decision-result-alert">{r.error}</p>}{r.modelWarning && <p>{r.modelWarning}</p>}
   </section>
   <section className="decision-case-section"><h4>모델이 반환한 업무별 확률 · {model}</h4>
    <p className="decision-results-caption">{ranking?'모델이 반환한 확률을 앱이 높은 순서로 정렬한 표입니다. ‘평가에 사용한 후보’는 앱이 정답 업무 개수만큼 상위에서 고른 목록입니다.':'모델이 반환한 업무별 확률과 선택 결과입니다.'}</p>
    <p>정답 업무에 부여한 확률: {expected.map(key=>answer(key)+' '+percent(r.probabilities?.[key])).join(' · ')}</p>{r.probabilityValid!==true && <p className="decision-result-alert">확률 응답을 평가할 수 없습니다. {r.probabilityError}</p>}
    {Object.keys(r.probabilities || {}).length>0?<details className="decision-probability-disclosure"><summary>전체 업무별 확률 펼치기</summary><div className="decision-table-scroll"><table><thead><tr><th>확률 순위</th><th>업무영역</th><th>확률</th><th>정답</th><th>{ranking?'상위 후보':'모델 선택'}</th></tr></thead><tbody>{Object.entries(r.probabilities || {}).sort((a,b)=>(b[1] || 0)-(a[1] || 0)).map(([key,p],i)=><tr key={key}><td>{i+1}</td><td>{answer(key)}</td><td>{percent(p)}</td><td>{expected.includes(key)?'정답 업무':'—'}</td><td>{selected.includes(key)?'포함':'—'}</td></tr>)}</tbody></table></div></details>:<p>반환된 확률이 없습니다.</p>}
   </section>
   <details className="decision-case-section"><summary>모델에 전달한 질문과 후보 설명</summary><p className="decision-results-caption">아래는 모델 요청에 담긴 내용입니다. 위의 정답 설명과는 별개입니다.</p><h4>판단 질문</h4><pre>{item?.instructions?.ko || task?.instructions?.ko}</pre>{task?.context?.ko && <><h4>함께 전달한 공통 설명</h4><pre>{task.context.ko}</pre></>}<h4>모델에 제시한 후보</h4><div className="decision-table-scroll"><table><thead><tr><th>업무영역</th><th>모델에 전달한 후보 설명</th></tr></thead><tbody>{(task?.options || []).map(option=><tr key={option.key}><td>{answer(option.key)}</td><td>{option.descriptions?.ko}</td></tr>)}</tbody></table></div></details>
   <details className="decision-case-section"><summary>실행 정보와 원본 응답</summary><p>요청한 모델 {model} · 서버가 응답에 표시한 모델 {r.returnedModel || '미기재'} · 라우팅 모델 {r.routingModel || '미기재'}</p><p>서버 왕복 시간 {r.durationMs}ms · {r.truncated==null?'입력 잘림 여부 미확인':r.truncated?'입력 잘림: 집계 제외':'입력 잘림 없음'}</p><pre>{JSON.stringify(r.raw,null,2)}</pre></details>
  </article></td></tr>}
 </Fragment>;
}
