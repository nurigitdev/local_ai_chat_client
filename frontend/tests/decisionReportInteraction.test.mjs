import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const script=await readFile(new URL('../../decision_report_interaction.js',import.meta.url),'utf8');
function element(dataset={},textContent='') {return {dataset,textContent,hidden:false,value:'all',attrs:{},handlers:{},setAttribute(k,v){this.attrs[k]=v;},getAttribute(k){return this.attrs[k];},addEventListener(k,f){this.handlers[k]=f;}};}
function browser() {
 const choices=[element({case:'0',model:'a',task:'rank',result:'partial',attention:'true'},'R01 재무 계획'),element({case:'1',model:'b',task:'rank',result:'full',attention:'false'},'R02 급여 감사'),element({case:'2',model:'a',task:'choice',result:'full',attention:'false'},'C01 회로 설계')];
 const panels=choices.map(c=>element({panel:c.dataset.case}));const controls=['model','task','result','search'].map(filter=>element({filter}));controls[3].value='';
 const empty=element(),placeholder=element(),container={scrollTop:100};
 return {choices,panels,controls,empty,placeholder,querySelectorAll(selector){return ({'.case-choice':choices,'.case-panel':panels,'[data-filter]':controls})[selector];},querySelector(selector){return ({'.case-empty':empty,'.case-placeholder':placeholder,'.case-panels':container})[selector];}};
}
test('offline report selects one panel, filters results and search, and handles empty matches',()=>{
 const b=browser();vm.runInNewContext(script,{document:{querySelectorAll:()=>[b]}});
 assert.deepEqual(b.panels.map(p=>p.hidden),[false,true,true]);b.choices[1].handlers.click();assert.deepEqual(b.panels.map(p=>p.hidden),[true,false,true]);
 b.controls[0].value='a';b.controls[0].handlers.change();assert.deepEqual(b.choices.map(c=>c.hidden),[false,true,false]);assert.equal(b.panels[0].hidden,false);
 b.controls[2].value='attention';b.controls[2].handlers.change();assert.deepEqual(b.choices.map(c=>c.hidden),[false,true,true]);
 b.controls[3].value='없는 질문';b.controls[3].handlers.input();assert.equal(b.empty.hidden,false);assert.ok(b.panels.every(p=>p.hidden));assert.equal(b.placeholder.hidden,false);
 b.controls[3].value=' R01 ';b.controls[3].handlers.input();assert.equal(b.panels[0].hidden,false);
 b.controls[1].value='choice';b.controls[1].handlers.change();assert.equal(b.empty.hidden,false);
});
test('multiple report records maintain independent selections',()=>{
 const a=browser(),b=browser();vm.runInNewContext(script,{document:{querySelectorAll:()=>[a,b]}});a.choices[2].handlers.click();assert.equal(a.panels[2].hidden,false);assert.equal(b.panels[0].hidden,false);assert.equal(b.panels[2].hidden,true);
});
