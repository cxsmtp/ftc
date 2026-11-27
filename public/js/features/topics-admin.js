"use strict";

// ── Topics: how the Question bank is organised (stage B) ─────────────────────
//
// A question belongs to at most one topic; a topic holds many questions
// (routes/topics.js, lib/topics.js). Participants see a question's topic as its
// category. This module owns the client side: the topic list (S.adminTopics,
// read with the bank), the bank's Topic filter, the Topics dialog (create,
// rename, delete — moving the questions first) and the editor's topic picker.
//
// Every control asks the server's own answer: rename and delete are offered
// per topic from `can_manage`, and refused with `manage_refusal` beside it.

import { S } from "../core/state.js";
import { csrfHeaders, fetchJsonList } from "../core/api.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { esc } from "../ui/format.js";
import { overlayDismiss, showModal } from "../ui/modal.js";
import { showToast, showPrompt } from "../ui/toast.js";
import { adminCan } from "../ui/nav.js";

/** Read every topic. null on failure (the list keeps its last good value). */
export async function loadTopics(){
  const list=await fetchJsonList('/api/admin/topics');
  if(list===null)return null;
  S.adminTopics=list;
  return list;
}

/** The topic filter's values: '' every topic, '__none__' no topic, else a topic id. */
export const NO_TOPIC='__none__';

/** Does question `t` pass Topic filter value `f` ('' every topic, NO_TOPIC, a topic id)?
 *  One definition for every topic filter: the bank's and the template editor's. */
export function taskInTopic(t,f){
  if(!f)return true;
  if(f===NO_TOPIC)return !t.topic_id;
  return t.topic_id===f;
}

/** Does question `t` pass the bank's Topic filter? */
export function taskInTopicFilter(t){ return taskInTopic(t,S.tTopicFilter||''); }

/**
 * Paint a Topic filter `<select>` (the bank's, the template editor's): All topics,
 * No topic, then every topic with its count (the reader's own bank questions).
 * A value naming a topic that is gone falls back to every topic; returns the
 * value it shows. Repaints only when the options changed (focus and the open
 * list survive a poll).
 */
export function paintTopicFilter(sel,value){
  if(!sel)return '';
  const topics=Array.isArray(S.adminTopics)?S.adminTopics:[];
  const cur=(value&&value!==NO_TOPIC&&!topics.some(x=>x.id===value))?'':(value||'');
  const html=`<option value="">All topics</option><option value="${NO_TOPIC}">No topic</option>`
    +topics.map(x=>`<option value="${esc(x.id)}">${esc(x.name)} (${Number(x.question_count)||0})</option>`).join('');
  if(sel.dataset.painted!==html){setSafeHtml(sel,html);sel.dataset.painted=html;}
  sel.value=cur;
  return cur;
}

/** Paint the bank's Topic filter's options. */
export function renderTopicFilter(){
  S.tTopicFilter=paintTopicFilter(document.getElementById('task-topic-filter'),S.tTopicFilter||'');
}

/** The editor's picker: every topic, the question's own selected. */
export function renderTopicPicker(selectedId){
  const sel=document.getElementById('tf-topic');
  if(!sel)return;
  const topics=Array.isArray(S.adminTopics)?S.adminTopics.slice():[];
  // A topic the list does not hold (it could not be read) is still the question's.
  if(selectedId&&!topics.some(x=>x.id===selectedId)){
    const t=(S.adminTasksData||[]).find(x=>x.topic_id===selectedId);
    topics.push({id:selectedId,name:(t&&t.topic_name)||'Current topic'});
  }
  setSafeHtml(sel,'<option value="">No topic</option>'+topics.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join(''));
  sel.value=selectedId||'';
  sel.dataset.loaded=Array.isArray(S.adminTopics)?'1':'';
}

/** The name of topic `id`, or ''. */
export function topicName(id){
  const t=(Array.isArray(S.adminTopics)?S.adminTopics:[]).find(x=>x.id===id);
  return t?t.name:'';
}

async function _postTopic(name){
  const r=await fetch('/api/admin/topics',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({name})});
  const d=await r.json().catch(()=>({}));
  if(r.ok)return {id:d.id,name:d.name};
  // An existing topic of that name is the one meant: use it.
  if(r.status===409&&d.code==='topic_exists'&&d.id)return {id:d.id,name:d.name,existed:true};
  showToast(d.error||'Could not add the topic.','error');
  return null;
}

/** The editor's "+ New topic": name it, make it, select it. */
export async function newTopicFromEditor(){
  const name=await showPrompt({title:'New topic',label:'Topic name',placeholder:'For example: Web security',confirmText:'Add topic'});
  if(name==null||!String(name).trim())return;
  const made=await _postTopic(String(name).trim());
  if(!made)return;
  await loadTopics();
  renderTopicPicker(made.id);
  renderTopicFilter();
  showToast(made.existed?`Filed under the existing topic “${made.name}”.`:`Topic “${made.name}” added.`,'success');
}

let _onTopicsChanged=null;
/** The bank's re-read after a topic changed (set by challenges-admin.js). */
export function setTopicsChangedHook(fn){_onTopicsChanged=fn;}

function _listHtml(){
  const topics=Array.isArray(S.adminTopics)?S.adminTopics:null;
  if(topics===null)return '<li class="topics-empty">Could not load the topics. Close this and try again.</li>';
  if(!topics.length)return '<li class="topics-empty">No topics yet. Add one above, then file questions under it from the question editor.</li>';
  const canEdit=adminCan('challenges.edit');
  return topics.map(x=>{
    const n=Number(x.question_count)||0;
    const acts=!canEdit?'':(x.can_manage
      ?`<button type="button" class="btn sm secondary" data-topic-act="rename" data-topic-id="${esc(x.id)}" aria-label="Rename ${esc(x.name)}">Rename</button>`
       +`<button type="button" class="btn sm secondary" data-topic-act="delete" data-topic-id="${esc(x.id)}" aria-label="Delete ${esc(x.name)}">Delete</button>`
      :`<span class="topics-note">${esc(x.manage_refusal||'')}</span>`);
    return `<li class="topics-row"><span class="topics-name">${esc(x.name)}</span><span class="topics-count">${n} question${n===1?'':'s'}</span><span class="topics-acts">${acts}</span></li>`;
  }).join('');
}

/** The Topics dialog (the bank's "Topics" button). */
export async function openTopicsDialog(){
  document.getElementById('topics-overlay')?.remove();
  const overlay=document.createElement('div');
  overlay.id='topics-overlay';
  overlay.className='picker-overlay';
  const canEdit=adminCan('challenges.edit');
  setSafeHtml(overlay,`<div class="card topics-card" role="dialog" aria-modal="true" aria-labelledby="topics-title">
    <h3 id="topics-title">Topics</h3>
    <p class="settings-help">A topic groups questions in the Question bank. Participants see a question's topic as its category.</p>
    ${canEdit?`<div class="topics-add"><label for="topic-new-name">New topic</label><div class="topics-add-row"><input id="topic-new-name" maxlength="60" placeholder="For example: Web security" data-enter-click-id="topic-new-add"/><button type="button" class="btn sm" id="topic-new-add">Add topic</button></div></div>`:''}
    <ul class="topics-list" id="topics-list" aria-label="Topics"><li class="topics-empty">Loading…</li></ul>
    <div class="modal-foot"><button type="button" class="btn sm secondary" id="topics-close">Close</button></div>
  </div>`);
  document.body.appendChild(overlay);
  const close=()=>overlay.remove();
  overlay.querySelector('#topics-close').onclick=close;
  overlayDismiss(overlay,close);
  const list=overlay.querySelector('#topics-list');
  const paint=()=>setSafeHtml(list,_listHtml());
  const changed=async()=>{await loadTopics();paint();renderTopicFilter();if(_onTopicsChanged)_onTopicsChanged();};
  await loadTopics();
  paint();
  (overlay.querySelector('#topic-new-name')||overlay.querySelector('#topics-close')).focus();
  const add=overlay.querySelector('#topic-new-add');
  if(add)add.onclick=async()=>{
    const inp=overlay.querySelector('#topic-new-name');
    const name=(inp.value||'').trim();
    if(!name){showToast('Type a name for the topic first.','error');inp.focus();return;}
    const made=await _postTopic(name);
    if(!made)return;
    if(made.existed){showToast(`A topic called “${made.name}” already exists.`,'error');return;}
    inp.value='';
    showToast(`Topic “${made.name}” added.`,'success');
    await changed();
  };
  list.addEventListener('click',async(e)=>{
    const b=e.target.closest('[data-topic-act]');
    if(!b)return;
    const topic=(S.adminTopics||[]).find(x=>x.id===b.dataset.topicId);
    if(!topic)return;
    if(b.dataset.topicAct==='rename'){
      const name=await showPrompt({title:'Rename topic',label:'Topic name',value:topic.name,confirmText:'Rename'});
      if(name==null||!String(name).trim()||String(name).trim()===topic.name)return;
      const r=await fetch(`/api/admin/topics/${encodeURIComponent(topic.id)}`,{method:'PUT',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({name:String(name).trim()})});
      const d=await r.json().catch(()=>({}));
      if(!r.ok){showToast(d.error||'Could not rename the topic.','error');return;}
      showToast(`Renamed to “${d.name}”.`,'success');
      await changed();
      return;
    }
    if(b.dataset.topicAct==='delete')await _deleteTopic(topic,changed);
  });
}

async function _deleteTopic(topic,changed){
  const ok=await showModal({title:'Delete topic',message:`Delete the topic <strong>${esc(topic.name)}</strong>? Questions are never deleted with it.`,confirmText:'Delete topic',confirmClass:'danger'});
  if(!ok)return;
  const send=(body)=>fetch(`/api/admin/topics/${encodeURIComponent(topic.id)}`,{method:'DELETE',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify(body||{})});
  let r=await send();
  let d=await r.json().catch(()=>({}));
  if(r.status===409&&d.code==='topic_not_empty'&&d.can_move){
    const moveTo=await _pickMoveTarget(topic,d.questions);
    if(moveTo===undefined)return;
    r=await send({move_to:moveTo});
    d=await r.json().catch(()=>({}));
  }
  if(!r.ok){showToast(d.error||'Could not delete the topic.','error');return;}
  showToast(d.moved?`Topic deleted; ${d.moved} question${d.moved===1?'':'s'} moved to ${d.moved_to?`“${d.moved_to.name}”`:'no topic'}.`:'Topic deleted.','success');
  await changed();
}

/** Where a deleted topic's questions go: a topic id, null for none, undefined for Cancel. */
function _pickMoveTarget(topic,n){
  return new Promise(resolve=>{
    document.getElementById('topic-move-overlay')?.remove();
    const overlay=document.createElement('div');
    overlay.id='topic-move-overlay';
    overlay.className='picker-overlay';
    overlay.style.zIndex='3100';
    const others=(S.adminTopics||[]).filter(x=>x.id!==topic.id);
    setSafeHtml(overlay,`<div class="card topics-card" role="dialog" aria-modal="true" aria-labelledby="topic-move-title">
      <h3 id="topic-move-title">Move ${Number(n)||0} question${n===1?'':'s'} first</h3>
      <p class="settings-help"><strong>${esc(topic.name)}</strong> still holds questions, in the bank or inside events. Choose where they go, then the topic is deleted.</p>
      <div class="form-group"><label for="topic-move-to">Move them to</label>
        <select id="topic-move-to"><option value="">No topic</option>${others.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></div>
      <div class="modal-foot"><button type="button" class="btn sm secondary" id="topic-move-cancel">Cancel</button><button type="button" class="btn sm danger" id="topic-move-ok">Move and delete</button></div>
    </div>`);
    document.body.appendChild(overlay);
    let settled=false;
    const done=(v)=>{if(settled)return;settled=true;overlay.remove();resolve(v);};
    overlay.querySelector('#topic-move-cancel').onclick=()=>done(undefined);
    overlay.querySelector('#topic-move-ok').onclick=()=>{const v=overlay.querySelector('#topic-move-to').value;done(v||null);};
    overlayDismiss(overlay,()=>done(undefined));
    overlay.querySelector('#topic-move-to').focus();
  });
}
