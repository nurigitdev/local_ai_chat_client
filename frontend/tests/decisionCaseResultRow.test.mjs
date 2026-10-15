import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import Row from '../.vite/test/DecisionCaseResultRow.js';
const b={suite:{tasks:[{id:'business-domain-ranking',type:'ranking',instructions:{ko:'이 요청에 필요한 업무를 평가하세요.'},options:[{key:'D04',descriptions:{ko:'회계 기록결산'}},{key:'D05',descriptions:{ko:'자금 계획조달'}},{key:'D12',descriptions:{ko:'프로젝트 관리'}}]}],cases:[{id:'r',text:'결산하고 조달 계획을 작성해 주세요.',rationale:'요청된 핵심 작업은 D04, D05 소관이다.'}]},targets:[{id:'a',model:'test-model'}]};
const r={targetID:'a',caseID:'r',taskID:'business-domain-ranking',status:'completed',labelValid:true,probabilityValid:true,correct:false,expected:'D04|D05',predicted:'D04|D12',probabilities:{D04:.7,D12:.25,D05:.05},truncated:false};
test('expanded detail is placed immediately after its result row and explains authorship',()=>{
 const html=renderToStaticMarkup(createElement(Row,{b,r,expanded:true,onToggle(){}}));
 assert.match(html,/<\/tr><tr class="decision-inline-detail-row"><td colSpan="5"/);
 assert.match(html,/aria-expanded="true"/);assert.match(html,/평가 세트의 정답과 설명/);assert.match(html,/모델이 작성한 설명이 아니며/);
 assert.match(html,/회계, 자금 관리 소관/);assert.doesNotMatch(html,/D04, D05 소관/);
 assert.match(html,/빠진 정답 업무: 자금 관리/);assert.match(html,/정답에 없는 후보: 프로젝트 수행/);
 assert.match(html,/모델이 반환한 업무별 확률/);assert.match(html,/모델에 전달한 질문과 후보 설명/);assert.match(html,/모델에 전달한 후보 설명/);
 assert.ok(html.indexOf('앱이 계산한 평가 결과')<html.indexOf('모델이 반환한 업무별 확률'));
 assert.doesNotMatch(html,/<details[^>]* open=""/);
});
test('closed result has a disclosure button without a detached detail block',()=>{
 const html=renderToStaticMarkup(createElement(Row,{b,r,expanded:false,onToggle(){}}));assert.match(html,/aria-expanded="false"/);assert.match(html,/펼치기/);assert.doesNotMatch(html,/decision-case-detail/);
});
