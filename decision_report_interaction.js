// Offline report interaction: user data remains escaped HTML, never executable code.
(function () {
 'use strict';
 document.querySelectorAll('.case-browser').forEach(function (browser) {
  var choices=Array.from(browser.querySelectorAll('.case-choice'));
  var panels=Array.from(browser.querySelectorAll('.case-panel'));
  var controls={};browser.querySelectorAll('[data-filter]').forEach(function (control) {controls[control.dataset.filter]=control;});
  var placeholder=browser.querySelector('.case-placeholder');
  var empty=browser.querySelector('.case-empty');
  function select(choice) {
   choices.forEach(function (item) {item.setAttribute('aria-pressed',String(item===choice));});
   panels.forEach(function (panel) {panel.hidden=!choice || panel.dataset.panel!==choice.dataset.case;});
   placeholder.hidden=!!choice;
   browser.querySelector('.case-panels').scrollTop=0;
  }
  function filter() {
   var query=controls.search.value.trim().toLocaleLowerCase();
   choices.forEach(function (choice) {
    var kind=controls.result.value;
    choice.hidden=!(controls.model.value==='all'||choice.dataset.model===controls.model.value)||!(controls.task.value==='all'||choice.dataset.task===controls.task.value)||!(kind==='all'||(kind==='attention'?choice.dataset.attention==='true':choice.dataset.result===kind))||!choice.textContent.toLocaleLowerCase().includes(query);
   });
   var visible=choices.filter(function (choice) {return !choice.hidden;});
   empty.hidden=visible.length>0;
   var current=visible.find(function (choice) {return choice.getAttribute('aria-pressed')==='true';});
   select(current||visible[0]||null);
  }
  choices.forEach(function (choice) {choice.addEventListener('click',function () {select(choice);});});
  Object.values(controls).forEach(function (control) {control.addEventListener(control.dataset.filter==='search'?'input':'change',filter);});
  filter();
 });
})();
