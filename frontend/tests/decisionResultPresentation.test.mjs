import test from 'node:test';
import assert from 'node:assert/strict';
import {decisionTaskOverview,decisionAnswerLabel,decisionQuestionText} from '../.vite/test/decisionResultPresentation.js';
const result=(targetID,caseID,correct,status='completed',truncated=false)=>({targetID,caseID,taskID:'business-domain-membership',status,labelValid:true,correct,truncated,predicted:'true'});
const record=(results)=>({suite:{tasks:[{id:'business-domain-membership',type:'noul'},{id:'business-domain-choice',type:'choice'},{id:'business-domain-fit',type:'score'}]},targets:[{id:'a',model:'A'},{id:'b',model:'B'}],results});
test('comparison sentence counts only the same scorable cases and excludes skipped or truncated inputs',()=>{
 const b=record([result('a','one',true),result('b','one',false),result('a','two',true),result('b','two',true,'skipped'),result('a','three',true,'completed',true),result('b','three',true)]);
 const overview=decisionTaskOverview(b,'business-domain-membership');
 assert.equal(overview.sharedCount,1);assert.equal(overview.models[0].count,2);assert.equal(overview.models[0].sharedCorrect,1);assert.equal(overview.models[1].sharedCorrect,0);
 assert.match(overview.conclusion,/공통 1문항/);assert.match(overview.conclusion,/1문항 차이/);
});
test('constant-answer pattern and ties are shown as observations without claiming broad model superiority',()=>{
 const overview=decisionTaskOverview(record([result('a','one',true),result('a','two',false),result('b','one',false),result('b','two',true)]),'business-domain-membership');
 assert.equal(overview.models[0].constantAnswer,'해당함');assert.match(overview.conclusion,/모든 모델이 1문항/);
 const disjoint=decisionTaskOverview(record([result('a','one',true),result('b','two',true)]),'business-domain-membership');assert.match(disjoint.conclusion,/직접 비교할 수 없습니다/);
});
test('answers use readable domain names and preserve custom scales, while previews show the request',()=>{
 const b=record([]);assert.equal(decisionAnswerLabel(b,'business-domain-choice','D01'),'HW 개발');assert.equal(decisionAnswerLabel(b,'business-domain-fit','1'),'불명확');
 b.suite.tasks.push({id:'custom-scale',type:'score',options:[{key:'1',descriptions:{ko:'보통'}}]});assert.equal(decisionAnswerLabel(b,'custom-scale','1'),'보통');
 assert.equal(decisionQuestionText('후보 업무영역: D01\n요청: 회로도를 수정해 주세요.\n후보 기준: 회로 설계'),'회로도를 수정해 주세요.');
});

import {decisionIdentification,decisionResultLabel} from '../.vite/test/decisionResultPresentation.js';
const rankingRecord=()=>({suite:{tasks:[{id:'rank',type:'ranking',options:[{key:'A'},{key:'B'},{key:'C'},{key:'D'}]}]},targets:[{id:'a',model:'A'}],results:[]});
const rankResult=(caseID,predicted,probabilities={A:.8,B:.1,C:.06,D:.04})=>({targetID:'a',taskID:'rank',caseID,status:'completed',expected:'A|B',predicted,correct:predicted==='A|B',labelValid:true,probabilityValid:true,probabilities});
test('ranking distinguishes full, partial and failed identification with attention as an independent flag',()=>{
 const b=rankingRecord();const full=rankResult('one','A|B'),partial=rankResult('two','A|C'),miss=rankResult('three','C|D');
 assert.equal(decisionResultLabel(b,full),'전체 식별');assert.equal(decisionResultLabel(b,partial),'일부 식별');assert.equal(decisionResultLabel(b,miss),'식별 실패');
 assert.deepEqual(decisionIdentification(b,full).low,['B']);assert.equal(decisionIdentification(b,partial).hits,1);
 b.results=[full,partial,miss];const overview=decisionTaskOverview(b,'rank');assert.deepEqual([overview.models[0].full,overview.models[0].partial,overview.models[0].miss],[1,1,1]);assert.equal(overview.models[0].attention,3);assert.match(overview.conclusion,/업무를 모두 식별/);
});
test('attention uses strict uniform baseline, rejects invalid probabilities and excludes unscorable cases',()=>{
 const b=rankingRecord();const r=rankResult('one','A|B',{A:.25,B:.25,C:.25,D:.25});assert.deepEqual(decisionIdentification(b,r).low,[]);
 r.probabilities.B=.24;assert.deepEqual(decisionIdentification(b,r).low,['B']);r.probabilityValid=false;assert.deepEqual(decisionIdentification(b,r).low,[]);
 r.probabilityValid=true;r.truncated=true;assert.equal(decisionIdentification(b,r).category,'unavailable');assert.deepEqual(decisionIdentification(b,r).low,[]);
 b.results=[r,{...r,truncated:false,labelValid:false}];assert.equal(decisionTaskOverview(b,'rank').models[0].count,0);
});

import {decisionCandidateAssessment} from '../.vite/test/decisionResultPresentation.js';
test('candidate inclusion and probability allocation are independent, including the exact baseline',()=>{
 const b=rankingRecord();const r=rankResult('one','A|B',{A:.3,B:.1,C:.4,D:.2});
 assert.equal(decisionCandidateAssessment(b,r,'A').label,'상위 후보 포함 · 기준 충족');
 assert.equal(decisionCandidateAssessment(b,r,'B').label,'상위 후보 포함 · 기준 미달');
 assert.equal(decisionCandidateAssessment(b,r,'C').label,'상위 후보 미포함 · 기준 충족');
 assert.equal(decisionCandidateAssessment(b,r,'D').label,'상위 후보 미포함 · 기준 미달');
 r.probabilities.B=.25;assert.equal(decisionCandidateAssessment(b,r,'B').allocation,'기준 충족');
 r.probabilityValid=false;assert.equal(decisionCandidateAssessment(b,r,'B').allocation,'확인 불가');
 r.truncated=true;assert.equal(decisionCandidateAssessment(b,r,'B').selection,'채점 불가');
});

import {decisionRankingSegments} from '../.vite/test/decisionResultPresentation.js';
test('ranking donut uses all expected probabilities for full identification and only missing probabilities for partial identification',()=>{
 const b=rankingRecord();const high={A:.25,B:.25,C:.25,D:.25},low={A:.6,B:.1,C:.2,D:.1};
 const rows=['A|B','A|C','C|D'].flatMap((predicted,i)=>[rankResult(i+'met',predicted,high),rankResult(i+'low',predicted,low)]);
 const segments=decisionRankingSegments(b,'rank',rows);assert.deepEqual(segments.map(s=>s.count),[1,1,1,1,2]);assert.equal(segments.reduce((n,s)=>n+s.count,0),6);
 const invalid={...rows[0],probabilityValid:false};const excluded={...rows[0],truncated:true};const unknown=decisionRankingSegments(b,'rank',[invalid,excluded]);assert.equal(unknown.find(s=>s.key==='unknown').count,1);assert.equal(unknown.reduce((n,s)=>n+s.count,0),1);
});

test('partial identification is split by missing labels, ignoring low probabilities of found labels',()=>{
 const b=rankingRecord();const r=rankResult('one','A|C',{A:.1,B:.3,C:.4,D:.2});
 let segments=decisionRankingSegments(b,'rank',[r]);assert.equal(segments.find(s=>s.key==='partial-met').count,1);assert.equal(segments.find(s=>s.key==='partial-low').count,0);
 r.expected='A|B|D';r.predicted='A|C';segments=decisionRankingSegments(b,'rank',[r]);assert.equal(segments.find(s=>s.key==='partial-low').count,1);
 r.probabilities.D=.25;segments=decisionRankingSegments(b,'rank',[r]);assert.equal(segments.find(s=>s.key==='partial-met').count,1);
});
