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
