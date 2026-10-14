interface DecisionCaseView {targetID:string;caseID:string;taskID:string;status:string;labelValid:boolean;correct:boolean;truncated?:boolean|null;predicted:string;}
interface DecisionRecordView {suite:{tasks?:{id:string;type:string;options?:{key:string;descriptions?:Record<string,string|undefined>|null}[]|null}[]|null};targets?:{id:string;model:string}[]|null;results?:DecisionCaseView[]|null;}
const domains = ['HW 개발','펌웨어 개발','응용 소프트웨어 개발','회계','자금 관리','제조','인사','급여','개발 품질','양산 품질','제품 출하','프로젝트 수행','총무','영업','부품 구매','부품 창고·수불','홍보·IR','감사','프로젝트 기획','지식 관리'];
export function decisionAnswerLabel(b:DecisionRecordView, taskID:string, key:string):string {
 if(!key) return '판단 없음';
 const task=b.suite.tasks?.find(t=>t.id===taskID);
 if(task?.type==='noul') return key==='true'?'해당함':key==='false'?'해당하지 않음':key;
 if(taskID==='business-domain-fit') return ({'0':'부적합','1':'불명확','2':'적합'}[key] || key);
 if(taskID==='business-domain-choice' && /^D(0[1-9]|1[0-9]|20)$/.test(key)) return domains[Number(key.slice(1))-1];
 return task?.options?.find(o=>o.key===key)?.descriptions?.ko || key;
}
export function isDecisionScorable(r:DecisionCaseView):boolean {return r.status==='completed' && r.labelValid && r.truncated!==true;}
export function decisionTaskOverview(b:DecisionRecordView,taskID:string) {
 const targets=b.targets || [];
 const eligible=targets.map(t=>(b.results || []).filter(r=>r.targetID===t.id && r.taskID===taskID && isDecisionScorable(r)));
 const shared=eligible.length?eligible[0].filter(r=>eligible.every(rows=>rows.some(other=>other.caseID===r.caseID))).map(r=>r.caseID):[];
 const common=new Set(shared);
 const models=targets.map((t,i)=>{
  const rows=eligible[i];const matched=rows.filter(r=>common.has(r.caseID));
  const predictions=new Map<string,number>();for(const r of rows)predictions.set(r.predicted,(predictions.get(r.predicted)||0)+1);
  const dominant=[...predictions.entries()].sort((a,b)=>b[1]-a[1])[0];
  return {id:t.id, model:t.model, count:rows.length, correct:rows.filter(r=>r.correct).length, sharedCount:matched.length, sharedCorrect:matched.filter(r=>r.correct).length,
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
 return {models,sharedCount:shared.length,conclusion};
}
export function decisionQuestionText(text:string):string {return text.split('\n').find(line=>line.startsWith('요청:'))?.slice(3).trim() || text;}
