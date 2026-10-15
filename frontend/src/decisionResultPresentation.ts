export interface DecisionCaseView {targetID:string;caseID:string;taskID:string;status:string;labelValid:boolean;correct:boolean;truncated?:boolean|null;predicted:string;expected?:string;probabilityValid?:boolean;probabilities?:Record<string,number|null|undefined>|null;}
export interface DecisionRecordView {suite:{tasks?:{id:string;type:string;options?:{key:string;descriptions?:Record<string,string|undefined>|null}[]|null}[]|null};targets?:{id:string;model:string}[]|null;results?:DecisionCaseView[]|null;}
const domains = ['HW 개발','펌웨어 개발','응용 소프트웨어 개발','회계','자금 관리','제조','인사','급여','개발 품질','양산 품질','제품 출하','프로젝트 수행','총무','영업','부품 구매','부품 창고·수불','홍보·IR','감사','프로젝트 기획','지식 관리'];
export function decisionAnswerLabel(b:DecisionRecordView, taskID:string, key:string):string {
 if(!key) return '판단 없음';
 if(key.includes('|')) return key.split('|').map(label=>decisionAnswerLabel(b,taskID,label)).join(' · ');
 const task=b.suite.tasks?.find(t=>t.id===taskID);
 if(task?.type==='noul') return key==='true'?'해당함':key==='false'?'해당하지 않음':key;
 if(taskID==='business-domain-fit') return ({'0':'부적합','1':'불명확','2':'적합'}[key] || key);
 if((taskID==='business-domain-choice'||taskID==='business-domain-ranking') && /^D(0[1-9]|1[0-9]|20)$/.test(key)) return domains[Number(key.slice(1))-1];
 return task?.options?.find(o=>o.key===key)?.descriptions?.ko || key;
}
export function isDecisionScorable(r:DecisionCaseView):boolean {return r.status==='completed' && r.labelValid && r.truncated!==true;}
export function decisionTaskOverview(b:DecisionRecordView,taskID:string) {
 const targets=b.targets || [];
 const eligible=targets.map(t=>(b.results || []).filter(r=>r.targetID===t.id && r.taskID===taskID && isDecisionScorable(r)));
 const shared=eligible.length?eligible[0].filter(r=>eligible.every(rows=>rows.some(other=>other.caseID===r.caseID))).map(r=>r.caseID):[];
 const common=new Set(shared);
 const ranking=b.suite.tasks?.find(t=>t.id===taskID)?.type==='ranking';
 const models=targets.map((t,i)=>{
  const rows=eligible[i];const identified=rows.map(r=>decisionIdentification(b,r));const matched=rows.filter(r=>common.has(r.caseID));
  const predictions=new Map<string,number>();for(const r of rows)predictions.set(r.predicted,(predictions.get(r.predicted)||0)+1);
  const dominant=[...predictions.entries()].sort((a,b)=>b[1]-a[1])[0];
  return {segments:ranking?decisionRankingSegments(b,taskID,rows):[],full:identified.filter(r=>r.category==='full').length,partial:identified.filter(r=>r.category==='partial').length,miss:identified.filter(r=>r.category==='miss').length,attention:identified.filter(r=>r.low.length>0).length,id:t.id, model:t.model, count:rows.length, correct:rows.filter(r=>r.correct).length, sharedCount:matched.length, sharedCorrect:matched.filter(r=>r.correct).length,
   constantAnswer:rows.length>=2 && dominant?.[1]===rows.length?decisionAnswerLabel(b,taskID,dominant[0]):null};
 });
 let conclusion='채점 가능한 결과가 아직 없습니다.';
 if(models.some(m=>m.count)){
  if(models.length===1)conclusion=models[0].count+'문항 중 '+models[0].correct+'문항을 맞혔습니다.';
  else if(!shared.length)conclusion='모든 모델이 함께 채점된 문항이 없어 직접 비교할 수 없습니다.';
  else {
   const best=Math.max(...models.map(m=>m.sharedCorrect)),worst=Math.min(...models.map(m=>m.sharedCorrect));
   const winners=models.filter(m=>m.sharedCorrect===best);
   conclusion=best===worst?'공통 '+shared.length+'문항에서 모든 모델이 '+best+'문항을 맞혔습니다.':winners.map(m=>m.model).join(', ')+'의 정답이 더 많습니다. 공통 '+shared.length+'문항에서 '+best+'문항 정답, 최소 정답 모델보다 '+(best-worst)+'문항 차이입니다.';
  }
 }
 if(ranking)conclusion=conclusion.split('문항을 맞혔습니다.').join('문항의 업무를 모두 식별했습니다.').replace('의 정답이 더 많습니다.','의 전체 식별 문항이 더 많습니다.').replace('문항 정답, 최소 정답 모델보다','문항 전체 식별, 가장 적게 식별한 모델보다');
 return {models,sharedCount:shared.length,conclusion};
}
export function decisionQuestionText(text:string):string {return text.split('\n').find(line=>line.startsWith('요청:'))?.slice(3).trim() || text;}

export function decisionIdentification(b:DecisionRecordView,r:DecisionCaseView) {
 const task=b.suite.tasks?.find(t=>t.id===r.taskID);
 const expected=[...new Set((r.expected || '').split('|').filter(Boolean))];
 const selected=new Set(r.predicted.split('|').filter(Boolean));
 const hits=expected.filter(key=>selected.has(key)).length;
 const category=!isDecisionScorable(r)?'unavailable':task?.type!=='ranking'?(r.correct?'full':'miss'):hits===expected.length && expected.length>0?'full':hits>0?'partial':'miss';
 const baseline=task?.options?.length?1/task.options.length:0;
 const low=task?.type==='ranking' && isDecisionScorable(r) && r.probabilityValid===true && baseline>0?expected.filter(key=>{const p=r.probabilities?.[key];return p!=null && Number.isFinite(p) && p<baseline;}):[];
 return {category,hits,total:expected.length,low,baseline};
}
export function decisionResultLabel(b:DecisionRecordView,r:DecisionCaseView):string {
 if(r.truncated===true)return '입력 잘림 · 집계 제외';
 if(r.status!=='completed')return ({error:'오류',skipped:'미실행',cancelled:'취소',pending:'대기'} as Record<string,string>)[r.status] || r.status;
 if(!isDecisionScorable(r))return '채점 불가';
 if(b.suite.tasks?.find(t=>t.id===r.taskID)?.type!=='ranking')return r.correct?'정답':'오답';
 return ({full:'전체 식별',partial:'일부 식별',miss:'식별 실패',unavailable:'채점 불가'})[decisionIdentification(b,r).category] || '채점 불가';
}

// Rationale is evaluation-set metadata; it is never a model explanation.
export function decisionRationaleText(b:DecisionRecordView,taskID:string,text:string):string {
 if(taskID!=='business-domain-choice' && taskID!=='business-domain-ranking')return text;
 return text.replace(/\bD(?:0[1-9]|1[0-9]|20)\b/g,key=>decisionAnswerLabel(b,taskID,key));
}

export function decisionCandidateAssessment(b:DecisionRecordView,r:DecisionCaseView,key:string) {
 const task=b.suite.tasks?.find(t=>t.id===r.taskID);
 const baseline=task?.options?.length?1/task.options.length:0;
 const probability=r.probabilities?.[key];
 const selection=!isDecisionScorable(r)?'채점 불가':r.predicted.split('|').includes(key)?'상위 후보 포함':'상위 후보 미포함';
 const allocation=r.probabilityValid!==true || baseline===0 || probability==null || !Number.isFinite(probability)?'확인 불가':probability<baseline?'기준 미달':'기준 충족';
 return {selection,allocation,baseline,label:selection+' · '+allocation};
}

export function decisionRankingSegments(b:DecisionRecordView,taskID:string,rows:DecisionCaseView[]) {
 const n=b.suite.tasks?.find(t=>t.id===taskID)?.options?.length || 0;
 const threshold=n?(100/n).toFixed(1).replace(/\.0$/,'')+'%':'배분 기준';
 const segments=[
  {key:'full-met',label:'전체 식별 · 모든 정답 업무 '+threshold+' 이상',color:'#24704E',count:0},
  {key:'full-low',label:'전체 식별 · 일부 정답 업무 '+threshold+' 미만',color:'#7FB99B',count:0},
  {key:'partial-met',label:'일부 누락 · 누락 업무 '+threshold+' 이상',color:'#C76D18',count:0},
  {key:'partial-low',label:'일부 누락 · 누락 업무 '+threshold+' 미만',color:'#F0B45B',count:0},
  {key:'miss',label:'모든 업무 누락',color:'#C9504C',count:0},
  {key:'unknown',label:'확률 확인 불가',color:'#7B8794',count:0},
 ];
 for(const r of rows){
  if(r.taskID!==taskID || !isDecisionScorable(r))continue;
  const identified=decisionIdentification(b,r);
  let key=identified.category;
  if(key==='full'||key==='partial'){
   const selected=new Set(r.predicted.split('|'));
   const labels=(r.expected || '').split('|').filter(label=>label && (key==='full'||!selected.has(label)));
   const assessments=labels.map(key=>decisionCandidateAssessment(b,r,key));
   key=!labels.length || assessments.some(a=>a.allocation==='확인 불가')?'unknown':key+(assessments.some(a=>a.allocation==='기준 미달')?'-low':'-met');
  }
  const segment=segments.find(s=>s.key===key);if(segment)segment.count++;
 }
 return segments.filter(s=>s.key!=='unknown'||s.count>0);
}
