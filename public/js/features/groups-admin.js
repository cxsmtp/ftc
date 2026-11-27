"use strict";

import { S } from "../core/state.js";
import { csrfHeaders, fetchJsonList, fetchJsonObject } from "../core/api.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { loadAdminParticipants } from "./participants-admin.js";
import { compareCompsForPicker } from "./competitions-admin.js"; // v7.16.7 — shared picker order
import { compDisplayCategory, COMP_CATEGORY_LABEL } from "./competition-picker.js"; // v8.12.6 — the late-entry bucket
import { esc } from "../ui/format.js";
import { ICO } from "../ui/icons.js"; // v8.12.0 — the competing note in the Members dialog
import { adminCan } from "../ui/nav.js"; // RBAC — the one permission predicate (read inside functions only)
import { overlayDismiss, applyDialogAria, showModal } from "../ui/modal.js";
import { showPrompt, showToast } from "../ui/toast.js";
import { colspanFor, countHtml, matchesQuery, paginate, paginationHtml, paintSortIcons, pickerFilterHtml, renderLoadFailure, setListCount, wirePickerFilter } from "../ui/list-controls.js";

export async function loadAdminGroups(){
  const tbody=document.getElementById('groups-tbody');
  if(!tbody)return;
  if(!adminCan('groups.view'))return;   // RBAC — a role that may not read groups sends no read
  // RBAC — making a group is a `groups.manage` route (the rows' Rename and
  // Delete ask the same, renderAdminGroups).
  { const nb=document.querySelector('#admin-groups-tab [data-action="group-create"]'); if(nb)nb.style.display=adminCan('groups.manage')?'':'none'; }
  const groups=await fetch('/api/admin/groups').then(r=>r.json()).catch(()=>null);
  if(!Array.isArray(groups)){
    // v8.11.11 — through the SHARED helper, with a retry. Measured: this pane
    // makes 1 request at entry and 1 after 20 s, so it does not self-heal and a
    // failed load was terminal.
    renderLoadFailure('groups-tbody',{colspan:colspanFor('groups-tbody'),
      noun:'groups',retryAction:'retry-load-admin-groups',
      resetModel:()=>{S.adminGroupsData=[];}});
    return;
  }
  S.adminGroupsData=groups;
  renderAdminGroups();
}

/**
 * v7.17.2 — render the rows the current search / sort / page selects.
 *
 * Separate from loadAdminGroups because sorting and paging must NOT refetch:
 * the list is already in hand, and a round trip per click would make the
 * controls feel broken on a slow link. Every mutation path still calls
 * loadAdminGroups(), so the data cannot go stale.
 */
export function renderAdminGroups(){
  const tbody=document.getElementById('groups-tbody');
  if(!tbody)return;
  const all=S.adminGroupsData||[];
  // The input is the source of truth for the query, exactly as the other three
  // admin tables do it — mirroring it into state buys nothing and can drift.
  const q=(document.getElementById('groups-search')?.value||'').trim();
  const filtered=all.filter(g=>matchesQuery(g,q,r=>[r.name]));

  let rows=filtered;
  if(S.gSortCol){
    const dir=S.gSortAsc?1:-1;
    rows=rows.slice().sort((a,b)=>{
      if(S.gSortCol==='name')return dir*String(a.name||'').localeCompare(String(b.name||''),undefined,{sensitivity:'base'});
      const key=S.gSortCol==='members'?'member_count':'competition_count';
      return dir*((a[key]||0)-(b[key]||0));
    });
  }

  const {visible,total,totalPages,page}=paginate(rows,{page:S.gPage,pageSize:S.gPageSize});
  S.gPage=page; // paginate() clamps; write the clamp back so Next/Prev stay honest

  // RBAC — Rename and Delete are `groups.manage` routes; Members and Events open
  // the group's own reads.
  const canManage=adminCan('groups.manage');
  if(!all.length){
    setSafeHtml(tbody,`<tr><td colspan="4" class="table-empty-row">No groups yet.${canManage?' Click <strong>New Group</strong> to create one.':''}</td></tr>`);
  }else if(!visible.length){
    setSafeHtml(tbody,`<tr><td colspan="4" class="table-empty-row">No groups match "${esc(q)}".</td></tr>`);
  }else{
    setSafeHtml(tbody,visible.map(g=>`<tr>
    <td style="font-weight:var(--fw-semibold)">${esc(g.name)}</td>
    <td style="text-align:center">${g.member_count}</td>
    <td style="text-align:center">${g.competition_count}</td>
    <td><div class="action-cell" style="gap:6px;justify-content:flex-end">
      <button class="btn sm secondary" data-action="group-manage-members" data-group-id="${esc(g.id)}" data-group-name="${esc(g.name)}"${(g.can_write===false&&!g.competing)?' disabled title="This group is also used by an event you do not manage, so its membership cannot be changed here."':''}>Members</button>
      <button class="btn sm secondary" data-action="group-bind-comps" data-group-id="${esc(g.id)}" data-group-name="${esc(g.name)}">Events</button>
      ${canManage?`<button class="btn sm secondary" data-action="group-rename" data-group-id="${esc(g.id)}" data-group-name="${esc(g.name)}"${(g.can_write===false&&!g.competing)?' disabled title="This group is also used by an event you do not manage, so it cannot be renamed here."':''}>Rename</button>
      <button class="btn sm danger" data-action="group-delete" data-group-id="${esc(g.id)}" data-group-name="${esc(g.name)}"${g.competing?` disabled title="You are competing in “${esc(g.competing.competition_name||'an event')}”, which this group is bound to, so it cannot be deleted from here."`:(g.can_delete===false?' disabled title="You can only delete groups you created. Ask an administrator to delete this one."':'')}>Delete</button>`:''}
    </div></td>
  </tr>`).join(''));
  }

  setListCount('groups-search',{matched:total,total:all.length,filtered:!!q});
  const pag=document.getElementById('groups-pagination');
  if(pag){
    setSafeHtml(pag,all.length?paginationHtml('groups',{
      page,totalPages,
      totalLabel:q?`${total} of ${all.length}`:`${total} total`,
      pageSize:S.gPageSize,
    }):'');
  }
  paintSortIcons('groups',{col:S.gSortCol,asc:S.gSortAsc});
}

export async function createGroupDialog(){
  const name=await showPrompt({title:'New Group',label:'Group name',placeholder:'e.g. APAC Cohort, Acme Corp',confirmText:'Create'});
  if(!name||!name.trim())return;
  const r=await fetch('/api/admin/groups',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({name:name.trim()})});
  if(r.ok){showToast('Group created.','success');loadAdminGroups();}
  else showToast((await r.json().catch(()=>({}))).error||'Failed to create group.','error');
}

export async function renameGroupDialog(groupId,currentName){
  const name=await showPrompt({title:'Rename Group',label:'Group name',value:currentName,confirmText:'Save'});
  if(!name||!name.trim()||name.trim()===currentName)return;
  const r=await fetch(`/api/admin/groups/${groupId}`,{method:'PUT',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({name:name.trim()})});
  if(r.ok){showToast('Group renamed.','success');loadAdminGroups();}
  else showToast((await r.json().catch(()=>({}))).error||'Failed to rename group.','error');
}

export async function deleteGroup(groupId,name){
  const ok=await showModal({title:'Delete Group?',message:`Delete the group "${esc(name)}"? This removes the group and unbinds it from any events. Participants are not deleted, but group-only members are removed from events this group was bound to.`,confirmText:'Delete',confirmClass:'danger'});
  if(!ok)return;
  const r=await fetch(`/api/admin/groups/${groupId}`,{method:'DELETE',headers:csrfHeaders()});
  if(r.ok){showToast('Group deleted.','success');loadAdminGroups();}
  // v8.12.0 — the server's own reason, not a bare failure: a delete is refused
  // by name when the group is bound to an event the actor competes in (and by
  // the ownership and scope rules before that), and "Failed" says none of it.
  else showToast((await r.json().catch(()=>({}))).error||'Failed to delete group.','error');
}

export async function manageGroupMembers(groupId,groupName){
  const PAGE_SIZE=50;
  let offset=0;
  let search='';
  // v8.12.0 — READ-ONLY for a competitor. `GET /api/admin/groups` folds the
  // competitor lock into `can_write` and names the event in `competing`; every
  // add and remove is refused server-side for such a group, so the dialog shows
  // the membership and withholds the controls with the reason (v7.14.2) rather
  // than offering a click that ends in a refusal.
  const _grp=(S.adminGroupsData||[]).find(g=>g.id===groupId);
  const _competing=_grp&&_grp.competing?_grp.competing:null;
  // RBAC — READ-ONLY for a role that may not change groups: every add and remove
  // is a `groups.manage` route. The same shape as the competitor's, with its own
  // reason.
  const _readOnly=!!_competing||!adminCan('groups.manage');
  // v7.17.2 — the MEMBERS half had no controls at all. The picker endpoint
  // returns members in full BY DESIGN (the admin must be able to see everyone
  // who is in the group), so a 400-member cohort rendered 400 rows into a
  // 240px-tall scroller with no way to find anyone. Both are client-side: the
  // full list is already in hand, so filtering it needs no round trip.
  let memberSearch='';
  let memberPage=1;
  const MEMBER_PAGE_SIZE=25;
  let picker=null;          // last picker payload (members + candidates + counts)
  const checked=new Set();  // sticky across page/search changes
  // v7.20.10 — the debounce handle lives with the dialog, NOT inside render().
  //
  // It used to be declared per render, so each rebuild created a fresh binding:
  // a keystroke that landed on the doomed input scheduled its timer in the OLD
  // closure, and the next render's clearTimeout saw the NEW closure's null and
  // could not cancel it. The orphan then fired and re-rendered the box back to a
  // value the user had already typed past — which is why the reported symptom
  // included text moving backwards, not merely characters going missing.
  let dbTimer=null;
  // v7.20.10 — stale-response guard, the same shape as the admin list loaders
  // (S._partFetchSeq / _taskFetchSeq / _compFetchSeq, v7.15.13). A debounced
  // search and a pager click can be in flight together and this dialog assigned
  // `picker` unconditionally, so whichever the NETWORK happened to deliver last
  // won — leaving the admin looking at a page they had already navigated away
  // from, with nothing on screen saying so.
  let pickerSeq=0;
  const overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;top:0;right:0;bottom:0;left:0;background:var(--overlay);z-index:3000;display:flex;align-items:center;justify-content:center;padding:24px;overflow-y:auto';
  document.body.appendChild(overlay);
  const close=()=>{clearTimeout(dbTimer);overlay.remove();};
  overlayDismiss(overlay,close); // focus-trap + Escape immediately; ARIA is applied by mount() below
  const nameOf=u=>`${u.first_name||''} ${u.last_name||''}`.trim()||u.nickname||u.email;
  async function loadPicker(){
    const mySeq=++pickerSeq;
    const qs=new URLSearchParams({limit:String(PAGE_SIZE),offset:String(offset)});
    if(search)qs.set('search',search);
    const body=await fetchJsonObject(`/api/admin/groups/${encodeURIComponent(groupId)}/picker?${qs.toString()}`);
    if(mySeq!==pickerSeq||!overlay.isConnected)return null; // superseded, or closed by the admin
    // A failed load is reported the way this file's other group dialogs report one.
    if(!body){showToast('Failed to load members.','error');close();return null;}
    picker=body;
    return picker;
  }
  // v7.20.10 — MOUNT the chrome once; render() writes only the list containers.
  //
  // THE BUG THIS FIXES. render() used to setSafeHtml the WHOLE card, search
  // inputs and all, re-emitting `value="${search}"` from the variable captured
  // when the debounce fired. So every character typed during the 200 ms wait AND
  // the picker round trip landed in an input that was about to be replaced, and
  // was overwritten — swallowed. The caret was then restored from an offset read
  // before the rebuild, so against the shorter value the browser clamped it and
  // the cursor jumped left. Two reported symptoms, one cause.
  //
  // This is the shape v7.17.1 already established for the admin tables: the
  // search box and pagination are STATIC markup beside the row container, so
  // writing the rows never touches the input and its value, caret, selection,
  // IME composition and native undo stack all survive for free — rather than
  // being reconstructed by hand, which is what the deleted focus/caret
  // restoration block was trying and failing to do.
  //
  // Consequence worth stating: #gm-member-search is now ALWAYS in the DOM rather
  // than conditional on the member count. It used to vanish mid-use when a
  // Remove dropped the count back below one page.
  function mount(){
    setSafeHtml(overlay,`<div class="card" style="max-width:min(560px, calc(100vw - 32px));width:100%;border-top-color:var(--accent);max-height:calc(100vh - 48px);max-height:calc(100dvh - 48px);overflow:auto">
      <h3 style="margin-bottom:4px">Members — ${esc(groupName)}</h3>
      <p class="settings-help" style="margin:0 0 12px" id="gm-member-count"></p>
      <input id="gm-member-search" aria-label="Search members by name or email" placeholder="Search members…" style="width:100%;margin:0 0 8px"/>
      <p class="settings-help" style="margin:0 0 6px">${countHtml('gm-member-search',{noun:'member'})}</p>
      <div id="gm-members" style="max-height:240px;overflow:auto"></div>
      <div id="gm-member-pager"></div>
      ${_competing?`<p class="settings-help" id="gm-competing-note" style="margin:12px 0 0">${ICO.lock} You are competing in “${esc(_competing.competition_name||'an event')}”, which this group is bound to — its members are enrolled there, so they cannot be added or removed from here.</p>`:_readOnly?`<p class="settings-help" id="gm-readonly-note" style="margin:12px 0 0">${ICO.lock} Your role can see this group's members, not add or remove them.</p>`:`<div style="margin-top:16px;border-top:1px solid var(--border);padding-top:12px">
        <label for="gm-search" id="gm-add-label" style="font-size:var(--fs-13);font-weight:var(--fw-semibold);display:block;margin-bottom:6px">Add participants</label>
        <input id="gm-search" aria-label="Search all participants by name, email, or tag" placeholder="Search all participants by name, email, or tag…" style="width:100%;margin-bottom:8px"/>
        <p class="settings-help" style="margin:0 0 6px">${countHtml('gm-search',{noun:'participant'})}</p>
        <div id="gm-candidates" style="max-height:240px;overflow:auto"></div>
        <div id="gm-cand-pager"></div>
      </div>`}
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
        <button class="btn sm secondary" id="gm-close">Close</button>
        ${_readOnly?'':'<button class="btn sm" id="gm-add">Add Selected</button>'}
      </div>
    </div>`);
    // Applied ONCE now, because the card is no longer replaced. (It cannot move
    // into overlayDismiss above — the card does not exist at that point.)
    applyDialogAria(overlay);
    // Server-side debounced search — every keystroke after 200 ms refetches.
    // `dbTimer` is dialog-scoped, so a timer scheduled by one keystroke is
    // always cancellable by the next.
    const _gmSearch=document.getElementById('gm-search');
    if(_gmSearch)_gmSearch.oninput=e=>{
      const v=e.target.value;
      clearTimeout(dbTimer);
      dbTimer=setTimeout(async()=>{search=v;offset=0;await loadPicker();render();},200);
    };
    // Purely client-side, so no debounce is needed and none is wanted: the list
    // is already in memory and a delay would just feel laggy.
    document.getElementById('gm-member-search').oninput=e=>{memberSearch=e.target.value;memberPage=1;render();};
    document.getElementById('gm-close').onclick=close;
    const _gmAdd=document.getElementById('gm-add');
    if(_gmAdd)_gmAdd.onclick=async()=>{
      const ids=[...checked];
      if(!ids.length){close();return;}
      const r=await fetch(`/api/admin/groups/${encodeURIComponent(groupId)}/members`,{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({userIds:ids})});
      if(!r.ok){
        const d=await r.json().catch(()=>({}));
        if(r.status===409&&d.clash){await showMemberClashModal(d.clash);return;}
        showToast(d.error||'Failed to add members.','error');return;
      }
      showToast('Members added.','success');
      checked.clear();
      await loadPicker();render();loadAdminGroups();
    };
  }
  function render(){
    // Not after a close: a failed reload closes the dialog with `picker` still
    // holding the previous page, and a load can land after the admin closed it.
    if(!picker||!overlay.isConnected)return;
    const allMembers=picker.members||[];
    const mq=memberSearch.trim().toLowerCase();
    const members=mq?allMembers.filter(m=>[m.first_name,m.last_name,m.nickname,m.email].some(v=>v&&String(v).toLowerCase().includes(mq))):allMembers;
    const mTotalPages=Math.max(1,Math.ceil(members.length/MEMBER_PAGE_SIZE));
    if(memberPage>mTotalPages)memberPage=mTotalPages;
    const memberPageRows=members.slice((memberPage-1)*MEMBER_PAGE_SIZE,memberPage*MEMBER_PAGE_SIZE);
    const candidates=picker.candidates||[];
    const total=picker.candidatesTotal||0;
    const page=Math.floor((picker.candidatesOffset||0)/(picker.candidatesLimit||PAGE_SIZE))+1;
    const totalPages=Math.max(1,Math.ceil(total/(picker.candidatesLimit||PAGE_SIZE)));
    const memberList=memberPageRows.length?memberPageRows.map(m=>`<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 0;border-top:1px solid var(--border)">
      <span style="font-size:var(--fs-14);min-width:0;word-break:break-word">${esc(nameOf(m))} <span style="color:var(--muted);font-size:var(--fs-12)">${esc(m.email)}</span></span>
      ${_readOnly?'':`<button class="btn sm danger" data-rm="${esc(m.id)}" style="flex-shrink:0">Remove</button>`}
    </div>`).join(''):(allMembers.length?`<p class="settings-help" style="margin:6px 0">No members match "${esc(memberSearch)}".</p>`:'<p class="settings-help" style="margin:6px 0">No members yet.</p>');
    const memberPager=mTotalPages>1?`<div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;font-size:var(--fs-12);color:var(--muted)">
      <span>Showing ${memberPageRows.length} of ${members.length}${mq?' matches':' members'} — page ${memberPage}/${mTotalPages}</span>
      <span style="display:flex;gap:4px">
        <button class="btn sm secondary" id="gm-m-prev" ${memberPage<=1?'disabled':''}>Prev</button>
        <button class="btn sm secondary" id="gm-m-next" ${memberPage>=mTotalPages?'disabled':''}>Next</button>
      </span>
    </div>`:'';
    const candList=candidates.length?candidates.map(u=>`<label style="display:block;padding:6px 0;font-size:var(--fs-14);cursor:pointer;border-top:1px solid var(--border);word-break:break-word">
      <input type="checkbox" class="gm-cb" value="${esc(u.id)}" ${checked.has(u.id)?'checked':''} style="width:16px;height:16px;vertical-align:middle;margin-right:8px;accent-color:var(--accent)"/><span style="vertical-align:middle">${esc(nameOf(u))} <span style="color:var(--muted);font-size:var(--fs-12)">${esc(u.email)}</span>${(u.tags||[]).map(t=>` <span class="tag" style="font-size:var(--fs-12);padding:0 6px">${esc(t)}</span>`).join('')}</span>
    </label>`).join(''):'<p class="settings-help" style="margin:4px 0">No matching participants.</p>';
    const checkedCount=checked.size;
    const pager=total>candidates.length||offset>0?`<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;font-size:var(--fs-12);color:var(--muted)">
      <span>Showing ${candidates.length} of ${total}${search?' matches':' participants'} — page ${page}/${totalPages}</span>
      <span style="display:flex;gap:4px">
        <button class="btn sm secondary" id="gm-prev" ${offset===0?'disabled':''}>Prev</button>
        <button class="btn sm secondary" id="gm-next" ${(offset+(picker.candidatesLimit||PAGE_SIZE))>=total?'disabled':''}>Next</button>
      </span>
    </div>`:'';
    // The four dynamic regions — and NOTHING else. Every input above survives.
    setSafeHtml(document.getElementById('gm-members'), memberList);
    setSafeHtml(document.getElementById('gm-member-pager'), memberPager);
    document.getElementById('gm-member-count').textContent=`${allMembers.length} member(s).${_readOnly?'':' Changes sync to any bound events immediately.'}`;
    // v7.20.10 — the match counts (see ui/list-controls.js countText).
    setListCount('gm-member-search',{matched:members.length,total:allMembers.length,filtered:!!memberSearch.trim()});
    // v8.12.0 — the ADD half is not mounted read-only (see mount()).
    if(!_readOnly){
      setSafeHtml(document.getElementById('gm-candidates'), candList);
      setSafeHtml(document.getElementById('gm-cand-pager'), pager);
      document.getElementById('gm-add-label').textContent=`Add participants${checkedCount?` (${checkedCount} selected)`:''}`;
      document.getElementById('gm-add').textContent=checkedCount?`Add ${checkedCount}`:'Add Selected';
      // The candidates half is filtered SERVER-side, so the unfiltered size is not
      // knowable here — `total:null` makes it say "N participants match" rather
      // than invent a denominator.
      setListCount('gm-search',{matched:total,total:null,filtered:!!search.trim()});
    }
    overlay.querySelectorAll('.gm-cb').forEach(cb=>{
      cb.onchange=()=>{
        if(cb.checked)checked.add(cb.value);else checked.delete(cb.value);
        document.getElementById('gm-add').textContent=checked.size?`Add ${checked.size}`:'Add Selected';
        document.getElementById('gm-add-label').textContent=`Add participants${checked.size?` (${checked.size} selected)`:''}`;
      };
    });
    const mPrev=document.getElementById('gm-m-prev');
    if(mPrev)mPrev.onclick=()=>{memberPage=Math.max(1,memberPage-1);render();};
    const mNext=document.getElementById('gm-m-next');
    if(mNext)mNext.onclick=()=>{memberPage=memberPage+1;render();};
    const prev=document.getElementById('gm-prev');
    if(prev)prev.onclick=async()=>{offset=Math.max(0,offset-(picker.candidatesLimit||PAGE_SIZE));await loadPicker();render();};
    const next=document.getElementById('gm-next');
    if(next)next.onclick=async()=>{offset=offset+(picker.candidatesLimit||PAGE_SIZE);await loadPicker();render();};
    overlay.querySelectorAll('[data-rm]').forEach(btn=>btn.onclick=async()=>{
      const uid=btn.dataset.rm;
      const r=await fetch(`/api/admin/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(uid)}`,{method:'DELETE',headers:csrfHeaders()});
      if(r.ok){await loadPicker();render();loadAdminGroups();}
      else showToast((await r.json().catch(()=>({}))).error||'Failed to remove member.','error'); // v8.12.0 — the named reason (competitor lock, scope, peer)
    });
  }
  mount();
  await loadPicker();render();
}

export async function manageGroupCompetitions(groupId,groupName){
  // v8.3.20 — this DID check r.ok, and then substituted `{competitions:[]}` for
  // the failure, which is the same wrong answer by a shorter route: "this group
  // is bound to nothing" on a screen where an admin decides whether to bind it.
  // Worse than a bare empty list, because a subsequent save would then be made
  // against a set the admin believes is complete.
  const payload=await fetchJsonObject(`/api/admin/groups/${encodeURIComponent(groupId)}/competitions`);
  if(!payload){showToast('Could not load this group\'s events. Check your connection and try again.','error');return;}
  // v7.16.7 — the endpoint returns these name-sorted (routes/groups.js). Re-sort
  // to the shared picker order so this dialog agrees with every other event
  // picker (an event taking late entries sorts after the upcoming ones).
  const list=(payload.competitions||[]).slice().sort(compareCompsForPicker);
  const current=new Set(list.filter(c=>c.bound).map(c=>c.id));
  // RBAC — binding the group to an event is an enrol (POST …/competitions/assign,
  // `participants.enrol`) and taking it off one a group write (DELETE
  // …/competitions/:id/groups/:groupId, `groups.manage`). A box whose change the
  // role may not make is disabled, the reason is said, and with neither there is
  // no Save.
  const canBind=adminCan('participants.enrol'), canUnbind=adminCan('groups.manage');
  const permNote=(canBind&&canUnbind)?''
    :`<p class="settings-help" id="gc-perm-note" style="margin:0 0 12px">${ICO.lock} ${canBind?'Your role can add this group to an event, not take it off one.':canUnbind?'Your role can take this group off an event, not add it to one.':'Your role can see which events this group is in, not change them.'}</p>`;
  const overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;top:0;right:0;bottom:0;left:0;background:var(--overlay);z-index:3000;display:flex;align-items:center;justify-content:center;padding:24px;overflow-y:auto';
  setSafeHtml(overlay,`<div class="card" style="max-width:min(520px, calc(100vw - 32px));width:100%;border-top-color:var(--accent);max-height:calc(100vh - 48px);max-height:calc(100dvh - 48px);overflow:auto">
    <h3 style="margin-bottom:4px">Events — ${esc(groupName)}</h3>
    <p class="settings-help" style="margin:0 0 12px">Checked events are bound to this group (live-synced). Finished events are not shown; an event still taking late entries is, and anyone this group adds to it joins as a late entrant.</p>
    ${permNote}
    ${list.length>8?pickerFilterHtml('gc-filter',{placeholder:'Filter events…',label:'Filter events'}):''}
    ${list.length?`<div id="gc-list">${list.map(c=>{
      // v8.12.6 — the endpoint now lists an ended Booth Event whose late-entry
      // window is open (its row carries the server's own late_entry_window_open flag),
      // so the badge is the BUCKET a human is shown, from the one label table —
      // the raw status would read a joinable event as plain "ended".
      const cat=c.status?compDisplayCategory(c):'upcoming';
      const competing=!!c.competing;
      const locked=competing||(current.has(c.id)?!canUnbind:!canBind);   // RBAC — see canBind/canUnbind above
      return`<label data-search="${esc((c.tags||[]).join(' '))}" data-late-entry="${cat==='late-entry'?'1':''}" class="${locked?'is-disabled':''}"${competing?' title="You are competing in this event — you cannot change its participants."':''} style="display:block;padding:6px 0;font-size:var(--fs-14);cursor:${locked?'not-allowed':'pointer'};word-break:break-word">
      <input type="checkbox" class="gc-cb" value="${esc(c.id)}" ${current.has(c.id)?'checked':''} ${locked?'disabled':''} style="width:16px;height:16px;vertical-align:middle;margin-right:8px;accent-color:var(--accent)"/><span style="vertical-align:middle"><strong>${esc(c.name)}</strong> <span class="status-badge ${esc(cat)}">${esc(COMP_CATEGORY_LABEL[cat]||cat)}</span>${competing?' <span class="picker-row-flag">You compete here</span>':''}</span>
    </label>`;}).join('')}</div>`:'<p class="settings-help">No live, upcoming or late-entry events.</p>'}
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
      <button class="btn sm secondary" id="gc-close">Close</button>
      ${(canBind||canUnbind)?'<button class="btn sm" id="gc-save">Save</button>':''}
    </div>
  </div>`);
  document.body.appendChild(overlay);
  // v7.20.8 — filter the bound-competitions list. Hides rows rather than
  // re-rendering, so ticks already made survive every keystroke.
  if(document.getElementById('gc-filter'))
    wirePickerFilter(overlay,'gc-filter','#gc-list label',{emptyText:'No event matches that filter.',noun:'event'});
  const close=()=>overlay.remove();
  overlay.querySelector('#gc-close').onclick=close;
  overlayDismiss(overlay,close);
  const _gcSave=overlay.querySelector('#gc-save');
  if(_gcSave)_gcSave.onclick=async()=>{
    const checked=new Set([...overlay.querySelectorAll('.gc-cb:checked')].map(c=>c.value));
    const toBind=[...checked].filter(id=>!current.has(id));
    const toUnbind=[...current].filter(id=>!checked.has(id));
    let failure=null;
    if(toBind.length){
      const br=await fetch('/api/admin/competitions/assign',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({groupIds:[groupId],competitionIds:toBind})});
      if(!br.ok){
        const bd=await br.json().catch(()=>({}));
        // v7.11.0 (req 7) — a participant is in ≥2 groups bound to the same
        // competition (would double-count them in the group leaderboard). Present a
        // descriptive, BLOCKING alert (names + the groups + how to fix) and abort the
        // whole save; the binding was NOT applied server-side.
        if(br.status===409&&bd.clash){
          const rows=(bd.clash.conflicts||[]).map(c=>`<li><strong>${esc(c.nickname)}</strong> — in ${c.groups.map(esc).join(' + ')}</li>`).join('');
          await showModal({title:'Group members clash',confirmText:'OK',cancelText:'',confirmClass:'',message:`This group can't be added to <strong>${esc(bd.clash.competitionName)}</strong> because the same participant is in more than one of its groups:<ul style="margin:8px 0;padding-left:20px">${rows}</ul>Remove each listed participant from all but one of those groups (either the group already on the event, or this one) before proceeding.`});
          loadAdminGroups();return;
        }
        failure=bd.error||'Failed to bind one or more events.';
      }
    }
    if(!failure){
      for(const cid of toUnbind){
        const ur=await fetch(`/api/admin/competitions/${cid}/groups/${groupId}`,{method:'DELETE',headers:csrfHeaders()});
        if(!ur.ok){const ud=await ur.json().catch(()=>({}));failure=ud.error||'Failed to unbind one or more events.';break;}
      }
    }
    if(failure){showToast(failure,'error');loadAdminGroups();return;}
    showToast('Group event bindings updated.','success');
    close();loadAdminGroups();
  };
}

// v7.11.1 — descriptive, blocking alert when a member-add would put a participant
// in ≥2 groups bound to the same competition (spec req 7 back-door guard). Shared by
// the manage-members dialog, the bulk add-to-group dialog, and the per-participant
// group chip. clash = { groupName, conflicts:[{nickname, conflicts:[{competitionName, groups:[]}]}] }.
export async function showMemberClashModal(clash){
  const rows=(clash.conflicts||[]).map(c=>{
    const where=(c.conflicts||[]).map(x=>`${x.groups.map(esc).join(' + ')} on <strong>${esc(x.competitionName)}</strong>`).join('; ');
    return `<li><strong>${esc(c.nickname)}</strong> — already in ${where}</li>`;
  }).join('');
  await showModal({title:'Group members clash',confirmText:'OK',cancelText:'',confirmClass:'',message:`<strong>${esc(clash.groupName)}</strong> can't take these members — a participant can only be in one group per event:<ul style="margin:8px 0;padding-left:20px">${rows}</ul>Remove each listed participant from the other group(s), or unbind a group from the event, then try again.`});
}

export async function bulkAddToGroup(){
  const ids=[...S.selectedParticipants];
  if(!ids.length){showToast('Select participants first.','error');return;}
  // v8.3.20 — REFUSE rather than offer a dialog that lists no groups: with an
  // unchecked r.ok, a 500's error object reached the render and an empty list
  // read as "you have no groups", on the screen whose whole purpose is to pick
  // one.
  const allGroups=await fetchJsonList('/api/admin/groups');
  if(!allGroups){showToast('Could not load groups. Check your connection and try again.','error');return;}
  const overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;top:0;right:0;bottom:0;left:0;background:var(--overlay);z-index:3000;display:flex;align-items:center;justify-content:center;padding:24px;overflow-y:auto';
  setSafeHtml(overlay,`<div class="card" style="max-width:min(420px, calc(100vw - 32px));width:100%;border-top-color:var(--accent)">
    <h3 style="margin-bottom:4px">Add ${ids.length} to Group</h3>
    <p class="settings-help" style="margin:0 0 12px">Choose an existing group or create a new one.</p>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <input id="bg-input" maxlength="80" placeholder="Create new group..." style="flex:1" data-enter-click-id="bg-create"/>
      <button class="btn sm" id="bg-create">Create</button>
    </div>
    ${allGroups.length?`<div style="margin-bottom:8px;font-size:var(--fs-12);color:var(--muted)">Or choose existing:</div>
    <div style="display:flex;flex-wrap:wrap;gap:4px">${allGroups.map(g=>`<span class="group-tag" style="cursor:pointer" role="button" tabindex="0" aria-label="${esc(g.name)} — add to this group" data-group-id="${esc(g.id)}">${esc(g.name)}</span>`).join('')}</div>`:''}
    <div style="display:flex;justify-content:flex-end;margin-top:16px"><button class="btn sm secondary" id="bg-cancel">Cancel</button></div>
  </div>`);
  document.body.appendChild(overlay);
  const close=()=>overlay.remove();
  document.getElementById('bg-cancel').onclick=close;
  overlayDismiss(overlay,close);
  async function done(r){
    if(r.ok){showToast('Added to group.','success');S.selectedParticipants.clear();await loadAdminParticipants();close();return;}
    const d=await r.json().catch(()=>({}));
    close();
    if(r.status===409&&d.clash){await showMemberClashModal(d.clash);return;}
    showToast(d.error||'Failed to add to group.','error');
  }
  document.getElementById('bg-create').onclick=async()=>{
    const name=document.getElementById('bg-input').value.trim();
    if(!name)return;
    done(await fetch('/api/admin/groups',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({name,userIds:ids})}));
  };
  overlay.querySelectorAll('[data-group-id]').forEach(el=>{
    const act=async()=>done(await fetch(`/api/admin/groups/${el.dataset.groupId}/members`,{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({userIds:ids})}));
    el.onclick=act;
    el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();act();}};
  });
  document.getElementById('bg-input').focus();
}
