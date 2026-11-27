"use strict";

import { S } from "../core/state.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { esc } from "../ui/format.js";

export function _getAllTimezones(){
  if(S._tzListCache)return S._tzListCache;
  try{S._tzListCache=Intl.supportedValuesOf('timeZone');}
  catch{S._tzListCache=['UTC','America/New_York','America/Chicago','America/Denver','America/Los_Angeles','America/Sao_Paulo','America/Toronto','America/Vancouver','America/Mexico_City','America/Buenos_Aires','America/Bogota','America/Lima','Europe/London','Europe/Paris','Europe/Berlin','Europe/Madrid','Europe/Rome','Europe/Amsterdam','Europe/Brussels','Europe/Vienna','Europe/Warsaw','Europe/Zurich','Europe/Moscow','Europe/Istanbul','Europe/Athens','Europe/Helsinki','Europe/Bucharest','Europe/Prague','Europe/Stockholm','Europe/Oslo','Europe/Copenhagen','Europe/Dublin','Europe/Lisbon','Asia/Dubai','Asia/Kolkata','Asia/Shanghai','Asia/Tokyo','Asia/Singapore','Asia/Hong_Kong','Asia/Seoul','Asia/Bangkok','Asia/Jakarta','Asia/Karachi','Asia/Riyadh','Asia/Tehran','Asia/Baghdad','Asia/Taipei','Asia/Manila','Asia/Kuala_Lumpur','Asia/Ho_Chi_Minh','Africa/Cairo','Africa/Lagos','Africa/Johannesburg','Africa/Nairobi','Africa/Casablanca','Australia/Sydney','Australia/Melbourne','Australia/Brisbane','Australia/Perth','Australia/Adelaide','Pacific/Auckland','Pacific/Honolulu','Pacific/Fiji'];}
  return S._tzListCache;
}

export function _ensureTzDatalist(){
  if(S._sharedTzDatalistId&&document.getElementById(S._sharedTzDatalistId))return S._sharedTzDatalistId;
  S._sharedTzDatalistId='tz-datalist-shared';
  const existing=document.getElementById(S._sharedTzDatalistId);
  if(existing)existing.remove();
  const dl=document.createElement('datalist');
  dl.id=S._sharedTzDatalistId;
  const zones=_getAllTimezones();
  setSafeHtml(dl, zones.map(tz=>{
    try{const off=new Date().toLocaleString('en-US',{timeZone:tz,timeZoneName:'shortOffset'}).split(' ').pop();
      return`<option value="${esc(tz)}">${esc(tz)} (${esc(off)})</option>`;}
    catch{return`<option value="${esc(tz)}">${esc(tz)}</option>`;}
  }).join(''));
  document.body.appendChild(dl);
  return S._sharedTzDatalistId;
}

export const _validTzSet=new Set(_getAllTimezones());

// v7.21.11 — preserve a stored value the vocabulary does not contain.
//
// `country` is deliberately FREE TEXT on the server (v7.21.1 A7: nothing computes
// with it, and a stale ISO-3166 allowlist is a lockout rather than a hardening),
// but every client edit surface is a closed <select> over COUNTRY_TZ. So a
// participant whose country arrived by participant-import or invited-LinkedIn
// capture — neither of which is constrained to that vocabulary, and the repo's
// own fixtures carry "UK" while the key is "GB" — saw the field render BLANK.
// Country is required client-side, so they could not save their own profile at
// all without first overwriting their real country with a listed one. The same
// happened to their TIMEZONE, because the timezone list is rebuilt from the
// country and an unknown country left it empty.
//
// Appending the stored value as a selected option fixes the lockout without
// changing the country→timezone narrowing that the <select> exists for: the
// value round-trips untouched if they do not care, and picking a listed country
// still works. `label` lets the caller mark it as unrecognised in the UI.
export function _preserveUnlistedOption(sel, value, label) {
  if (!sel || !value) return false;
  if ([...sel.options].some(o => o.value === value)) { sel.value = value; return false; }
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label ? `${value} — ${label}` : value;
  opt.selected = true;
  sel.insertBefore(opt, sel.firstChild);
  sel.value = value;
  return true;
}

export function _buildTzInput(id,cls){
  const dlId=_ensureTzDatalist();
  const local=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const attr=id?`id="${esc(id)}"`:`class="${esc(cls)}"`;
  const handler=id?`data-change-action="comp-form-update-end-time"`:`data-change-action="session-form-update-end"`;
  return`<input ${attr} list="${esc(dlId)}" value="${esc(local)}" style="min-width:200px" placeholder="Type to search..." aria-label="Timezone" ${handler}/>`;
}

export function _isValidTz(tz){
  if(typeof tz!=='string'||!tz)return false;
  if(_validTzSet.has(tz))return true;
  // v7.15.23 — `Intl.supportedValuesOf('timeZone')` enumerates canonical zones
  // and OMITS "UTC", while `Intl.DateTimeFormat().resolvedOptions().timeZone`
  // RETURNS "UTC" on a machine set to it. The competition form pre-fills the
  // field from the latter and validates with the former, so on any UTC host —
  // a container, a CI runner, plenty of plain Linux installs — the field came
  // up looking correctly filled and Save was refused with "Please select a
  // valid timezone", pointing at a field that looked fine. Found by CI; it is
  // a real user-facing bug, not a test artefact.
  //
  // Accept anything the platform's own Intl accepts, which is the authority
  // the rest of the app (and the server) ultimately uses.
  try{new Intl.DateTimeFormat('en',{timeZone:tz});return true;}catch{return false;}
}

// ext-audit v7.21.1 (A3) — the ONE wall-clock → UTC conversion behind the admin
// competition form and the session rows. It replaced FOUR copies of a one-pass
// version that was wrong around every DST transition.
//
// The bug: the offset was sampled at the NAIVE instant (the typed wall clock
// read as if it were UTC) rather than at the instant the conversion produces.
// Those two are |offset| hours apart, so any entry within |offset| hours of a
// transition picked up the wrong side of it. Measured: 2026-03-08 03:30 in
// America/New_York — half an hour after the spring-forward — was sampled at
// 03:30Z, where New York is still EST (-05), and stored as 08:30Z, i.e.
// 04:30 local. An hour late, silently, on the one field that decides when
// participants can get in.
//
// Two passes fix it: convert once with the naive-instant offset to land near
// the answer, then re-sample the offset AT that instant and convert again.
//
// Why the v7.15.31 tests did not catch it, since this file's own note claimed
// the arithmetic was covered: that table deliberately picks dates "unambiguously
// inside or outside DST … rather than near a boundary", which is exactly the
// region where one-pass and two-pass agree. It also pins the BROWSER to a
// foreign zone to prove the browser's offset cancels — and it does cancel, but
// only away from a transition. The old code built browser-LOCAL Dates out of
// the formatted parts (`new Date(y,m,d,…)`), so the browser's offset entered
// twice, at two different local wall times; those cancel only while the browser
// zone has no transition between them. So NOTHING here may build a browser-local
// Date — every value below is either a UTC epoch or Date.UTC of formatted parts.
//
// Returns null on a missing/malformed date or time (the callers' existing
// contract). If Intl refuses the zone — the timezone box is free text, so a
// half-typed zone reaches here on every keystroke — it falls back to reading
// the wall clock as UTC, which keeps the row usable and lets the save path
// raise its own named error.
export function wallClockToUtc(dateVal,timeVal,tz){
  if(typeof dateVal!=='string'||typeof timeVal!=='string')return null;
  const dm=/^(\d{4,6})-(\d{2})-(\d{2})$/.exec(dateVal.trim());
  const tm=/^(\d{1,2}):(\d{2})/.exec(timeVal.trim());
  if(!dm||!tm)return null;
  const wall=Date.UTC(+dm[1],+dm[2]-1,+dm[3],+tm[1],+tm[2]);
  if(!Number.isFinite(wall))return null;
  try{
    const fmt=new Intl.DateTimeFormat('en-US',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
    // Offset of `tz` at the instant t, in ms east of UTC.
    const offAt=t=>{
      const parts=fmt.formatToParts(new Date(t));
      const p=k=>parseInt(parts.find(x=>x.type===k)?.value,10)||0;
      // `hour12:false` renders midnight as "24" under the h24 cycle. Feeding
      // that to Date.UTC rolls the date forward a day and reports a 24-hour
      // offset error; the existing render paths already special-case it.
      const hh=p('hour')===24?0:p('hour');
      return Date.UTC(p('year'),p('month')-1,p('day'),hh,p('minute'),p('second'))-t;
    };
    const near=wall-offAt(wall);
    // A wall clock inside a spring-forward GAP never happened, so no instant is
    // right; the second sample lands it an hour either side of the gap depending
    // on the zone. Every wall clock that DOES exist — the only kind an admin can
    // mean — converts exactly, which is what this is for.
    //
    // v7.21.19 (audit F2) — callers that need to know may use
    // wallClockToUtcChecked() below, which reports whether the time exists at
    // all rather than silently returning an adjacent instant.
    return new Date(wall-offAt(near));
  }catch{
    return new Date(wall);
  }
}

/**
 * wallClockToUtc, plus whether the wall clock the admin typed actually EXISTS.
 *
 * v7.21.19 (audit F2). On a spring-forward day a whole hour of wall clock never
 * happens — in America/New_York on 2026-03-08 the clocks go straight from 02:00
 * to 03:00 — and the conversion above quietly returns an adjacent instant for
 * anything inside it. Measured: typing 02:30 stored the SAME instant as 01:30
 * and rendered back as 01:30. The admin types one time, saves successfully, and
 * the form shows another, with nothing to say why.
 *
 * The test is a ROUND TRIP, not a table of transition dates: convert, render the
 * result back in the same zone, and compare. If the wall clock that comes back
 * is not the one that went in, the time does not exist. That needs no DST
 * database of its own and cannot drift as zones change their rules.
 *
 * `ambiguous` covers the other side of the year: on a fall-back day a wall clock
 * happens TWICE, and the conversion picks the first (the pre-transition offset).
 * The round trip matches in that case, so it is not an error — both instants are
 * real and one of them has to be chosen. It is reported so a caller can SAY so
 * rather than decide silently; it is deliberately not treated as a refusal,
 * because refusing would leave the admin no way to express a time that is
 * perfectly legitimate.
 */
/**
 * v8.6.3 — the INVERSE of wallClockToUtc: an instant, rendered as the wall clock
 * a `<input type=date>` / `<input type=time>` pair should show for `tz`.
 *
 * It lives here because this module owns the forward direction, and because the
 * pairing is the whole point: a field written by one and read by the other must
 * use the SAME zone or the value silently shifts by the offset. Three sites had
 * hand-rolled it — the competition end-time preview, the session end-time preview
 * and (twice) the late-entry deadline.
 *
 * SCOPED HONESTLY. The two late-entry copies used the BROWSER's wall clock for a
 * field that is read back in `#comp-tz`, which was correct only BY COINCIDENCE:
 * that box seeds from the browser, and nothing re-ran those fills afterwards, so
 * the two zones were always equal at the only moment they ran. v8.6.3 makes the
 * late-entry pair follow a timezone change, which is exactly when the coincidence
 * ends — so the fix is a prerequisite for that feature rather than a live bug it
 * repaired.
 *
 * Returns null rather than throwing when the zone is unusable, so a caller that
 * is mid-type in the timezone box clears its preview instead of showing a wrong
 * one — the v7.15.31 rule for these fields.
 *
 * `hour12:false` can render midnight as "24" on some engines; that is normalised
 * to "00", which is the behaviour all three original copies already had.
 */
export function utcToWallClock(instant,tz){
  if(!(instant instanceof Date)||isNaN(instant.getTime()))return null;
  try{
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:tz,year:'numeric',month:'2-digit',
      day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(instant);
    const p=k=>parts.find(x=>x.type===k)?.value||'';
    const hr=p('hour')==='24'?'00':p('hour');
    if(!p('year')||!p('month')||!p('day')||!hr||!p('minute'))return null;
    return{date:`${p('year')}-${p('month')}-${p('day')}`,
           time:`${String(parseInt(hr,10)).padStart(2,'0')}:${p('minute')}`};
  }catch{ return null; }
}

export function wallClockToUtcChecked(dateVal,timeVal,tz){
  const date=wallClockToUtc(dateVal,timeVal,tz);
  if(!(date instanceof Date)||isNaN(date.getTime()))return{date,exists:false,ambiguous:false};
  const dm=/^(\d{4,6})-(\d{2})-(\d{2})$/.exec(String(dateVal).trim());
  const tm=/^(\d{1,2}):(\d{2})/.exec(String(timeVal).trim());
  if(!dm||!tm)return{date,exists:false,ambiguous:false};
  const want={y:+dm[1],mo:+dm[2],d:+dm[3],h:+tm[1],mi:+tm[2]};
  const readBack=(inst,opts)=>{
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:tz,hour12:false,...opts}).formatToParts(inst);
    const p=k=>parseInt(parts.find(x=>x.type===k)?.value,10)||0;
    return{y:p('year'),mo:p('month'),d:p('day'),h:p('hour')===24?0:p('hour'),mi:p('minute')};
  };
  let back;
  try{
    back=readBack(date,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  }catch{
    // No usable Intl for this zone — the caller gets the answer it always got
    // rather than a spurious refusal.
    return{date,exists:true,ambiguous:false};
  }
  const exists=back.y===want.y&&back.mo===want.mo&&back.d===want.d&&back.h===want.h&&back.mi===want.mi;
  // Ambiguous = the same wall clock ALSO maps to a different instant an hour
  // later. Only meaningful when the time exists at all.
  let ambiguous=false;
  if(exists){
    try{
      const other=readBack(new Date(date.getTime()+3600000),{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
      ambiguous=other.y===want.y&&other.mo===want.mo&&other.d===want.d&&other.h===want.h&&other.mi===want.mi;
    }catch{ ambiguous=false; }
  }
  return{date,exists,ambiguous};
}

export const COUNTRY_TZ={
"AF":{"n":"Afghanistan","tz":[["Asia/Kabul","Kabul (UTC+4:30)"]],"d":"Asia/Kabul"},
"AL":{"n":"Albania","tz":[["Europe/Tirane","Tirana (UTC+1)"]],"d":"Europe/Tirane"},
"DZ":{"n":"Algeria","tz":[["Africa/Algiers","Algiers (UTC+1)"]],"d":"Africa/Algiers"},
"AD":{"n":"Andorra","tz":[["Europe/Andorra","Andorra la Vella (UTC+1)"]],"d":"Europe/Andorra"},
"AO":{"n":"Angola","tz":[["Africa/Luanda","Luanda (UTC+1)"]],"d":"Africa/Luanda"},
"AG":{"n":"Antigua and Barbuda","tz":[["America/Antigua","St. John's (UTC-4)"]],"d":"America/Antigua"},
"AR":{"n":"Argentina","tz":[["America/Argentina/Buenos_Aires","Buenos Aires (UTC-3)"],["America/Argentina/Cordoba","Cordoba (UTC-3)"],["America/Argentina/Mendoza","Mendoza (UTC-3)"]],"d":"America/Argentina/Buenos_Aires"},
"AM":{"n":"Armenia","tz":[["Asia/Yerevan","Yerevan (UTC+4)"]],"d":"Asia/Yerevan"},
"AU":{"n":"Australia","tz":[["Australia/Sydney","Sydney / Canberra (UTC+10)"],["Australia/Melbourne","Melbourne (UTC+10)"],["Australia/Brisbane","Brisbane (UTC+10)"],["Australia/Adelaide","Adelaide (UTC+9:30)"],["Australia/Perth","Perth (UTC+8)"],["Australia/Darwin","Darwin (UTC+9:30)"],["Australia/Hobart","Hobart (UTC+10)"]],"d":"Australia/Sydney"},
"AT":{"n":"Austria","tz":[["Europe/Vienna","Vienna (UTC+1)"]],"d":"Europe/Vienna"},
"AZ":{"n":"Azerbaijan","tz":[["Asia/Baku","Baku (UTC+4)"]],"d":"Asia/Baku"},
"BS":{"n":"Bahamas","tz":[["America/Nassau","Nassau (UTC-5)"]],"d":"America/Nassau"},
"BH":{"n":"Bahrain","tz":[["Asia/Bahrain","Manama (UTC+3)"]],"d":"Asia/Bahrain"},
"BD":{"n":"Bangladesh","tz":[["Asia/Dhaka","Dhaka (UTC+6)"]],"d":"Asia/Dhaka"},
"BB":{"n":"Barbados","tz":[["America/Barbados","Bridgetown (UTC-4)"]],"d":"America/Barbados"},
"BY":{"n":"Belarus","tz":[["Europe/Minsk","Minsk (UTC+3)"]],"d":"Europe/Minsk"},
"BE":{"n":"Belgium","tz":[["Europe/Brussels","Brussels (UTC+1)"]],"d":"Europe/Brussels"},
"BZ":{"n":"Belize","tz":[["America/Belize","Belmopan (UTC-6)"]],"d":"America/Belize"},
"BJ":{"n":"Benin","tz":[["Africa/Porto-Novo","Porto-Novo (UTC+1)"]],"d":"Africa/Porto-Novo"},
"BT":{"n":"Bhutan","tz":[["Asia/Thimphu","Thimphu (UTC+6)"]],"d":"Asia/Thimphu"},
"BO":{"n":"Bolivia","tz":[["America/La_Paz","La Paz (UTC-4)"]],"d":"America/La_Paz"},
"BA":{"n":"Bosnia and Herzegovina","tz":[["Europe/Sarajevo","Sarajevo (UTC+1)"]],"d":"Europe/Sarajevo"},
"BW":{"n":"Botswana","tz":[["Africa/Gaborone","Gaborone (UTC+2)"]],"d":"Africa/Gaborone"},
"BR":{"n":"Brazil","tz":[["America/Sao_Paulo","Sao Paulo / Brasilia (UTC-3)"],["America/Manaus","Manaus (UTC-4)"],["America/Belem","Belem (UTC-3)"],["America/Fortaleza","Fortaleza (UTC-3)"],["America/Recife","Recife (UTC-3)"],["America/Cuiaba","Cuiaba (UTC-4)"],["America/Rio_Branco","Rio Branco (UTC-5)"]],"d":"America/Sao_Paulo"},
"BN":{"n":"Brunei","tz":[["Asia/Brunei","Bandar Seri Begawan (UTC+8)"]],"d":"Asia/Brunei"},
"BG":{"n":"Bulgaria","tz":[["Europe/Sofia","Sofia (UTC+2)"]],"d":"Europe/Sofia"},
"BF":{"n":"Burkina Faso","tz":[["Africa/Ouagadougou","Ouagadougou (UTC+0)"]],"d":"Africa/Ouagadougou"},
"BI":{"n":"Burundi","tz":[["Africa/Bujumbura","Gitega (UTC+2)"]],"d":"Africa/Bujumbura"},
"CV":{"n":"Cabo Verde","tz":[["Atlantic/Cape_Verde","Praia (UTC-1)"]],"d":"Atlantic/Cape_Verde"},
"KH":{"n":"Cambodia","tz":[["Asia/Phnom_Penh","Phnom Penh (UTC+7)"]],"d":"Asia/Phnom_Penh"},
"CM":{"n":"Cameroon","tz":[["Africa/Douala","Yaounde (UTC+1)"]],"d":"Africa/Douala"},
"CA":{"n":"Canada","tz":[["America/Toronto","Toronto / Ottawa (UTC-5)"],["America/Vancouver","Vancouver (UTC-8)"],["America/Edmonton","Edmonton (UTC-7)"],["America/Winnipeg","Winnipeg (UTC-6)"],["America/Halifax","Halifax (UTC-4)"],["America/St_Johns","St. John's (UTC-3:30)"],["America/Regina","Regina (UTC-6)"]],"d":"America/Toronto"},
"CF":{"n":"Central African Republic","tz":[["Africa/Bangui","Bangui (UTC+1)"]],"d":"Africa/Bangui"},
"TD":{"n":"Chad","tz":[["Africa/Ndjamena","N'Djamena (UTC+1)"]],"d":"Africa/Ndjamena"},
"CL":{"n":"Chile","tz":[["America/Santiago","Santiago (UTC-4)"],["Pacific/Easter","Easter Island (UTC-6)"]],"d":"America/Santiago"},
"CN":{"n":"China","tz":[["Asia/Shanghai","Beijing / Shanghai (UTC+8)"],["Asia/Urumqi","Urumqi (UTC+6)"]],"d":"Asia/Shanghai"},
"CO":{"n":"Colombia","tz":[["America/Bogota","Bogota (UTC-5)"]],"d":"America/Bogota"},
"KM":{"n":"Comoros","tz":[["Indian/Comoro","Moroni (UTC+3)"]],"d":"Indian/Comoro"},
"CG":{"n":"Congo (Republic)","tz":[["Africa/Brazzaville","Brazzaville (UTC+1)"]],"d":"Africa/Brazzaville"},
"CD":{"n":"Congo (DRC)","tz":[["Africa/Kinshasa","Kinshasa (UTC+1)"],["Africa/Lubumbashi","Lubumbashi (UTC+2)"]],"d":"Africa/Kinshasa"},
"CR":{"n":"Costa Rica","tz":[["America/Costa_Rica","San Jose (UTC-6)"]],"d":"America/Costa_Rica"},
"CI":{"n":"Cote d'Ivoire","tz":[["Africa/Abidjan","Yamoussoukro (UTC+0)"]],"d":"Africa/Abidjan"},
"HR":{"n":"Croatia","tz":[["Europe/Zagreb","Zagreb (UTC+1)"]],"d":"Europe/Zagreb"},
"CU":{"n":"Cuba","tz":[["America/Havana","Havana (UTC-5)"]],"d":"America/Havana"},
"CY":{"n":"Cyprus","tz":[["Asia/Nicosia","Nicosia (UTC+2)"]],"d":"Asia/Nicosia"},
"CZ":{"n":"Czech Republic","tz":[["Europe/Prague","Prague (UTC+1)"]],"d":"Europe/Prague"},
"DK":{"n":"Denmark","tz":[["Europe/Copenhagen","Copenhagen (UTC+1)"]],"d":"Europe/Copenhagen"},
"DJ":{"n":"Djibouti","tz":[["Africa/Djibouti","Djibouti (UTC+3)"]],"d":"Africa/Djibouti"},
"DM":{"n":"Dominica","tz":[["America/Dominica","Roseau (UTC-4)"]],"d":"America/Dominica"},
"DO":{"n":"Dominican Republic","tz":[["America/Santo_Domingo","Santo Domingo (UTC-4)"]],"d":"America/Santo_Domingo"},
"EC":{"n":"Ecuador","tz":[["America/Guayaquil","Quito (UTC-5)"],["Pacific/Galapagos","Galapagos (UTC-6)"]],"d":"America/Guayaquil"},
"EG":{"n":"Egypt","tz":[["Africa/Cairo","Cairo (UTC+2)"]],"d":"Africa/Cairo"},
"SV":{"n":"El Salvador","tz":[["America/El_Salvador","San Salvador (UTC-6)"]],"d":"America/El_Salvador"},
"GQ":{"n":"Equatorial Guinea","tz":[["Africa/Malabo","Malabo (UTC+1)"]],"d":"Africa/Malabo"},
"ER":{"n":"Eritrea","tz":[["Africa/Asmara","Asmara (UTC+3)"]],"d":"Africa/Asmara"},
"EE":{"n":"Estonia","tz":[["Europe/Tallinn","Tallinn (UTC+2)"]],"d":"Europe/Tallinn"},
"SZ":{"n":"Eswatini","tz":[["Africa/Mbabane","Mbabane (UTC+2)"]],"d":"Africa/Mbabane"},
"ET":{"n":"Ethiopia","tz":[["Africa/Addis_Ababa","Addis Ababa (UTC+3)"]],"d":"Africa/Addis_Ababa"},
"FJ":{"n":"Fiji","tz":[["Pacific/Fiji","Suva (UTC+12)"]],"d":"Pacific/Fiji"},
"FI":{"n":"Finland","tz":[["Europe/Helsinki","Helsinki (UTC+2)"]],"d":"Europe/Helsinki"},
"FR":{"n":"France","tz":[["Europe/Paris","Paris (UTC+1)"]],"d":"Europe/Paris"},
"GA":{"n":"Gabon","tz":[["Africa/Libreville","Libreville (UTC+1)"]],"d":"Africa/Libreville"},
"GM":{"n":"Gambia","tz":[["Africa/Banjul","Banjul (UTC+0)"]],"d":"Africa/Banjul"},
"GE":{"n":"Georgia","tz":[["Asia/Tbilisi","Tbilisi (UTC+4)"]],"d":"Asia/Tbilisi"},
"DE":{"n":"Germany","tz":[["Europe/Berlin","Berlin (UTC+1)"]],"d":"Europe/Berlin"},
"GH":{"n":"Ghana","tz":[["Africa/Accra","Accra (UTC+0)"]],"d":"Africa/Accra"},
"GR":{"n":"Greece","tz":[["Europe/Athens","Athens (UTC+2)"]],"d":"Europe/Athens"},
"GD":{"n":"Grenada","tz":[["America/Grenada","St. George's (UTC-4)"]],"d":"America/Grenada"},
"GT":{"n":"Guatemala","tz":[["America/Guatemala","Guatemala City (UTC-6)"]],"d":"America/Guatemala"},
"GN":{"n":"Guinea","tz":[["Africa/Conakry","Conakry (UTC+0)"]],"d":"Africa/Conakry"},
"GW":{"n":"Guinea-Bissau","tz":[["Africa/Bissau","Bissau (UTC+0)"]],"d":"Africa/Bissau"},
"GY":{"n":"Guyana","tz":[["America/Guyana","Georgetown (UTC-4)"]],"d":"America/Guyana"},
"HT":{"n":"Haiti","tz":[["America/Port-au-Prince","Port-au-Prince (UTC-5)"]],"d":"America/Port-au-Prince"},
"HN":{"n":"Honduras","tz":[["America/Tegucigalpa","Tegucigalpa (UTC-6)"]],"d":"America/Tegucigalpa"},
"HU":{"n":"Hungary","tz":[["Europe/Budapest","Budapest (UTC+1)"]],"d":"Europe/Budapest"},
"IS":{"n":"Iceland","tz":[["Atlantic/Reykjavik","Reykjavik (UTC+0)"]],"d":"Atlantic/Reykjavik"},
"IN":{"n":"India","tz":[["Asia/Kolkata","New Delhi / Kolkata (UTC+5:30)"]],"d":"Asia/Kolkata"},
"ID":{"n":"Indonesia","tz":[["Asia/Jakarta","Jakarta (UTC+7)"],["Asia/Makassar","Makassar (UTC+8)"],["Asia/Jayapura","Jayapura (UTC+9)"]],"d":"Asia/Jakarta"},
"IR":{"n":"Iran","tz":[["Asia/Tehran","Tehran (UTC+3:30)"]],"d":"Asia/Tehran"},
"IQ":{"n":"Iraq","tz":[["Asia/Baghdad","Baghdad (UTC+3)"]],"d":"Asia/Baghdad"},
"IE":{"n":"Ireland","tz":[["Europe/Dublin","Dublin (UTC+0)"]],"d":"Europe/Dublin"},
"IL":{"n":"Israel","tz":[["Asia/Jerusalem","Jerusalem (UTC+2)"]],"d":"Asia/Jerusalem"},
"IT":{"n":"Italy","tz":[["Europe/Rome","Rome (UTC+1)"]],"d":"Europe/Rome"},
"JM":{"n":"Jamaica","tz":[["America/Jamaica","Kingston (UTC-5)"]],"d":"America/Jamaica"},
"JP":{"n":"Japan","tz":[["Asia/Tokyo","Tokyo (UTC+9)"]],"d":"Asia/Tokyo"},
"JO":{"n":"Jordan","tz":[["Asia/Amman","Amman (UTC+3)"]],"d":"Asia/Amman"},
"KZ":{"n":"Kazakhstan","tz":[["Asia/Almaty","Astana / Almaty (UTC+5)"],["Asia/Aqtau","Aqtau (UTC+5)"],["Asia/Aqtobe","Aqtobe (UTC+5)"]],"d":"Asia/Almaty"},
"KE":{"n":"Kenya","tz":[["Africa/Nairobi","Nairobi (UTC+3)"]],"d":"Africa/Nairobi"},
"KI":{"n":"Kiribati","tz":[["Pacific/Tarawa","Tarawa (UTC+12)"]],"d":"Pacific/Tarawa"},
"KP":{"n":"North Korea","tz":[["Asia/Pyongyang","Pyongyang (UTC+9)"]],"d":"Asia/Pyongyang"},
"KR":{"n":"South Korea","tz":[["Asia/Seoul","Seoul (UTC+9)"]],"d":"Asia/Seoul"},
"KW":{"n":"Kuwait","tz":[["Asia/Kuwait","Kuwait City (UTC+3)"]],"d":"Asia/Kuwait"},
"KG":{"n":"Kyrgyzstan","tz":[["Asia/Bishkek","Bishkek (UTC+6)"]],"d":"Asia/Bishkek"},
"LA":{"n":"Laos","tz":[["Asia/Vientiane","Vientiane (UTC+7)"]],"d":"Asia/Vientiane"},
"LV":{"n":"Latvia","tz":[["Europe/Riga","Riga (UTC+2)"]],"d":"Europe/Riga"},
"LB":{"n":"Lebanon","tz":[["Asia/Beirut","Beirut (UTC+2)"]],"d":"Asia/Beirut"},
"LS":{"n":"Lesotho","tz":[["Africa/Maseru","Maseru (UTC+2)"]],"d":"Africa/Maseru"},
"LR":{"n":"Liberia","tz":[["Africa/Monrovia","Monrovia (UTC+0)"]],"d":"Africa/Monrovia"},
"LY":{"n":"Libya","tz":[["Africa/Tripoli","Tripoli (UTC+2)"]],"d":"Africa/Tripoli"},
"LI":{"n":"Liechtenstein","tz":[["Europe/Vaduz","Vaduz (UTC+1)"]],"d":"Europe/Vaduz"},
"LT":{"n":"Lithuania","tz":[["Europe/Vilnius","Vilnius (UTC+2)"]],"d":"Europe/Vilnius"},
"LU":{"n":"Luxembourg","tz":[["Europe/Luxembourg","Luxembourg City (UTC+1)"]],"d":"Europe/Luxembourg"},
"MG":{"n":"Madagascar","tz":[["Indian/Antananarivo","Antananarivo (UTC+3)"]],"d":"Indian/Antananarivo"},
"MW":{"n":"Malawi","tz":[["Africa/Blantyre","Lilongwe (UTC+2)"]],"d":"Africa/Blantyre"},
"MY":{"n":"Malaysia","tz":[["Asia/Kuala_Lumpur","Kuala Lumpur (UTC+8)"]],"d":"Asia/Kuala_Lumpur"},
"MV":{"n":"Maldives","tz":[["Indian/Maldives","Male (UTC+5)"]],"d":"Indian/Maldives"},
"ML":{"n":"Mali","tz":[["Africa/Bamako","Bamako (UTC+0)"]],"d":"Africa/Bamako"},
"MT":{"n":"Malta","tz":[["Europe/Malta","Valletta (UTC+1)"]],"d":"Europe/Malta"},
"MH":{"n":"Marshall Islands","tz":[["Pacific/Majuro","Majuro (UTC+12)"]],"d":"Pacific/Majuro"},
"MR":{"n":"Mauritania","tz":[["Africa/Nouakchott","Nouakchott (UTC+0)"]],"d":"Africa/Nouakchott"},
"MU":{"n":"Mauritius","tz":[["Indian/Mauritius","Port Louis (UTC+4)"]],"d":"Indian/Mauritius"},
"MX":{"n":"Mexico","tz":[["America/Mexico_City","Mexico City (UTC-6)"],["America/Cancun","Cancun (UTC-5)"],["America/Chihuahua","Chihuahua (UTC-6)"],["America/Tijuana","Tijuana (UTC-8)"]],"d":"America/Mexico_City"},
"FM":{"n":"Micronesia","tz":[["Pacific/Pohnpei","Palikir (UTC+11)"]],"d":"Pacific/Pohnpei"},
"MD":{"n":"Moldova","tz":[["Europe/Chisinau","Chisinau (UTC+2)"]],"d":"Europe/Chisinau"},
"MC":{"n":"Monaco","tz":[["Europe/Monaco","Monaco (UTC+1)"]],"d":"Europe/Monaco"},
"MN":{"n":"Mongolia","tz":[["Asia/Ulaanbaatar","Ulaanbaatar (UTC+8)"],["Asia/Hovd","Hovd (UTC+7)"]],"d":"Asia/Ulaanbaatar"},
"ME":{"n":"Montenegro","tz":[["Europe/Podgorica","Podgorica (UTC+1)"]],"d":"Europe/Podgorica"},
"MA":{"n":"Morocco","tz":[["Africa/Casablanca","Rabat (UTC+1)"]],"d":"Africa/Casablanca"},
"MZ":{"n":"Mozambique","tz":[["Africa/Maputo","Maputo (UTC+2)"]],"d":"Africa/Maputo"},
"MM":{"n":"Myanmar","tz":[["Asia/Yangon","Naypyidaw (UTC+6:30)"]],"d":"Asia/Yangon"},
"NA":{"n":"Namibia","tz":[["Africa/Windhoek","Windhoek (UTC+2)"]],"d":"Africa/Windhoek"},
"NR":{"n":"Nauru","tz":[["Pacific/Nauru","Yaren (UTC+12)"]],"d":"Pacific/Nauru"},
"NP":{"n":"Nepal","tz":[["Asia/Kathmandu","Kathmandu (UTC+5:45)"]],"d":"Asia/Kathmandu"},
"NL":{"n":"Netherlands","tz":[["Europe/Amsterdam","Amsterdam (UTC+1)"]],"d":"Europe/Amsterdam"},
"NZ":{"n":"New Zealand","tz":[["Pacific/Auckland","Wellington / Auckland (UTC+12)"],["Pacific/Chatham","Chatham Islands (UTC+12:45)"]],"d":"Pacific/Auckland"},
"NI":{"n":"Nicaragua","tz":[["America/Managua","Managua (UTC-6)"]],"d":"America/Managua"},
"NE":{"n":"Niger","tz":[["Africa/Niamey","Niamey (UTC+1)"]],"d":"Africa/Niamey"},
"NG":{"n":"Nigeria","tz":[["Africa/Lagos","Abuja (UTC+1)"]],"d":"Africa/Lagos"},
"MK":{"n":"North Macedonia","tz":[["Europe/Skopje","Skopje (UTC+1)"]],"d":"Europe/Skopje"},
"NO":{"n":"Norway","tz":[["Europe/Oslo","Oslo (UTC+1)"]],"d":"Europe/Oslo"},
"OM":{"n":"Oman","tz":[["Asia/Muscat","Muscat (UTC+4)"]],"d":"Asia/Muscat"},
"PK":{"n":"Pakistan","tz":[["Asia/Karachi","Islamabad / Karachi (UTC+5)"]],"d":"Asia/Karachi"},
"PW":{"n":"Palau","tz":[["Pacific/Palau","Ngerulmud (UTC+9)"]],"d":"Pacific/Palau"},
"PS":{"n":"Palestine","tz":[["Asia/Gaza","Gaza (UTC+2)"],["Asia/Hebron","Hebron (UTC+2)"]],"d":"Asia/Gaza"},
"PA":{"n":"Panama","tz":[["America/Panama","Panama City (UTC-5)"]],"d":"America/Panama"},
"PG":{"n":"Papua New Guinea","tz":[["Pacific/Port_Moresby","Port Moresby (UTC+10)"]],"d":"Pacific/Port_Moresby"},
"PY":{"n":"Paraguay","tz":[["America/Asuncion","Asuncion (UTC-3)"]],"d":"America/Asuncion"},
"PE":{"n":"Peru","tz":[["America/Lima","Lima (UTC-5)"]],"d":"America/Lima"},
"PH":{"n":"Philippines","tz":[["Asia/Manila","Manila (UTC+8)"]],"d":"Asia/Manila"},
"PL":{"n":"Poland","tz":[["Europe/Warsaw","Warsaw (UTC+1)"]],"d":"Europe/Warsaw"},
"PT":{"n":"Portugal","tz":[["Europe/Lisbon","Lisbon (UTC+0)"],["Atlantic/Azores","Azores (UTC-1)"]],"d":"Europe/Lisbon"},
"QA":{"n":"Qatar","tz":[["Asia/Qatar","Doha (UTC+3)"]],"d":"Asia/Qatar"},
"RO":{"n":"Romania","tz":[["Europe/Bucharest","Bucharest (UTC+2)"]],"d":"Europe/Bucharest"},
"RU":{"n":"Russia","tz":[["Europe/Moscow","Moscow (UTC+3)"],["Europe/Kaliningrad","Kaliningrad (UTC+2)"],["Europe/Samara","Samara (UTC+4)"],["Asia/Yekaterinburg","Yekaterinburg (UTC+5)"],["Asia/Omsk","Omsk (UTC+6)"],["Asia/Krasnoyarsk","Krasnoyarsk (UTC+7)"],["Asia/Irkutsk","Irkutsk (UTC+8)"],["Asia/Yakutsk","Yakutsk (UTC+9)"],["Asia/Vladivostok","Vladivostok (UTC+10)"],["Asia/Kamchatka","Kamchatka (UTC+12)"]],"d":"Europe/Moscow"},
"RW":{"n":"Rwanda","tz":[["Africa/Kigali","Kigali (UTC+2)"]],"d":"Africa/Kigali"},
"KN":{"n":"Saint Kitts and Nevis","tz":[["America/St_Kitts","Basseterre (UTC-4)"]],"d":"America/St_Kitts"},
"LC":{"n":"Saint Lucia","tz":[["America/St_Lucia","Castries (UTC-4)"]],"d":"America/St_Lucia"},
"VC":{"n":"Saint Vincent and the Grenadines","tz":[["America/St_Vincent","Kingstown (UTC-4)"]],"d":"America/St_Vincent"},
"WS":{"n":"Samoa","tz":[["Pacific/Apia","Apia (UTC+13)"]],"d":"Pacific/Apia"},
"SM":{"n":"San Marino","tz":[["Europe/San_Marino","San Marino (UTC+1)"]],"d":"Europe/San_Marino"},
"ST":{"n":"Sao Tome and Principe","tz":[["Africa/Sao_Tome","Sao Tome (UTC+0)"]],"d":"Africa/Sao_Tome"},
"SA":{"n":"Saudi Arabia","tz":[["Asia/Riyadh","Riyadh (UTC+3)"]],"d":"Asia/Riyadh"},
"SN":{"n":"Senegal","tz":[["Africa/Dakar","Dakar (UTC+0)"]],"d":"Africa/Dakar"},
"RS":{"n":"Serbia","tz":[["Europe/Belgrade","Belgrade (UTC+1)"]],"d":"Europe/Belgrade"},
"SC":{"n":"Seychelles","tz":[["Indian/Mahe","Victoria (UTC+4)"]],"d":"Indian/Mahe"},
"SL":{"n":"Sierra Leone","tz":[["Africa/Freetown","Freetown (UTC+0)"]],"d":"Africa/Freetown"},
"SG":{"n":"Singapore","tz":[["Asia/Singapore","Singapore (UTC+8)"]],"d":"Asia/Singapore"},
"SK":{"n":"Slovakia","tz":[["Europe/Bratislava","Bratislava (UTC+1)"]],"d":"Europe/Bratislava"},
"SI":{"n":"Slovenia","tz":[["Europe/Ljubljana","Ljubljana (UTC+1)"]],"d":"Europe/Ljubljana"},
"SB":{"n":"Solomon Islands","tz":[["Pacific/Guadalcanal","Honiara (UTC+11)"]],"d":"Pacific/Guadalcanal"},
"SO":{"n":"Somalia","tz":[["Africa/Mogadishu","Mogadishu (UTC+3)"]],"d":"Africa/Mogadishu"},
"ZA":{"n":"South Africa","tz":[["Africa/Johannesburg","Pretoria / Johannesburg (UTC+2)"]],"d":"Africa/Johannesburg"},
"SS":{"n":"South Sudan","tz":[["Africa/Juba","Juba (UTC+2)"]],"d":"Africa/Juba"},
"ES":{"n":"Spain","tz":[["Europe/Madrid","Madrid (UTC+1)"],["Atlantic/Canary","Canary Islands (UTC+0)"]],"d":"Europe/Madrid"},
"LK":{"n":"Sri Lanka","tz":[["Asia/Colombo","Sri Jayawardenepura Kotte (UTC+5:30)"]],"d":"Asia/Colombo"},
"SD":{"n":"Sudan","tz":[["Africa/Khartoum","Khartoum (UTC+2)"]],"d":"Africa/Khartoum"},
"SR":{"n":"Suriname","tz":[["America/Paramaribo","Paramaribo (UTC-3)"]],"d":"America/Paramaribo"},
"SE":{"n":"Sweden","tz":[["Europe/Stockholm","Stockholm (UTC+1)"]],"d":"Europe/Stockholm"},
"CH":{"n":"Switzerland","tz":[["Europe/Zurich","Bern / Zurich (UTC+1)"]],"d":"Europe/Zurich"},
"SY":{"n":"Syria","tz":[["Asia/Damascus","Damascus (UTC+3)"]],"d":"Asia/Damascus"},
"TW":{"n":"Taiwan","tz":[["Asia/Taipei","Taipei (UTC+8)"]],"d":"Asia/Taipei"},
"TJ":{"n":"Tajikistan","tz":[["Asia/Dushanbe","Dushanbe (UTC+5)"]],"d":"Asia/Dushanbe"},
"TZ":{"n":"Tanzania","tz":[["Africa/Dar_es_Salaam","Dodoma (UTC+3)"]],"d":"Africa/Dar_es_Salaam"},
"TH":{"n":"Thailand","tz":[["Asia/Bangkok","Bangkok (UTC+7)"]],"d":"Asia/Bangkok"},
"TL":{"n":"Timor-Leste","tz":[["Asia/Dili","Dili (UTC+9)"]],"d":"Asia/Dili"},
"TG":{"n":"Togo","tz":[["Africa/Lome","Lome (UTC+0)"]],"d":"Africa/Lome"},
"TO":{"n":"Tonga","tz":[["Pacific/Tongatapu","Nukualofa (UTC+13)"]],"d":"Pacific/Tongatapu"},
"TT":{"n":"Trinidad and Tobago","tz":[["America/Port_of_Spain","Port of Spain (UTC-4)"]],"d":"America/Port_of_Spain"},
"TN":{"n":"Tunisia","tz":[["Africa/Tunis","Tunis (UTC+1)"]],"d":"Africa/Tunis"},
"TR":{"n":"Turkey","tz":[["Europe/Istanbul","Ankara / Istanbul (UTC+3)"]],"d":"Europe/Istanbul"},
"TM":{"n":"Turkmenistan","tz":[["Asia/Ashgabat","Ashgabat (UTC+5)"]],"d":"Asia/Ashgabat"},
"TV":{"n":"Tuvalu","tz":[["Pacific/Funafuti","Funafuti (UTC+12)"]],"d":"Pacific/Funafuti"},
"UG":{"n":"Uganda","tz":[["Africa/Kampala","Kampala (UTC+3)"]],"d":"Africa/Kampala"},
"UA":{"n":"Ukraine","tz":[["Europe/Kyiv","Kyiv (UTC+2)"]],"d":"Europe/Kyiv"},
"AE":{"n":"United Arab Emirates","tz":[["Asia/Dubai","Abu Dhabi / Dubai (UTC+4)"]],"d":"Asia/Dubai"},
"GB":{"n":"United Kingdom","tz":[["Europe/London","London (UTC+0)"]],"d":"Europe/London"},
"US":{"n":"United States","tz":[["America/New_York","New York / Washington D.C. (UTC-5)"],["America/Chicago","Chicago (UTC-6)"],["America/Denver","Denver (UTC-7)"],["America/Los_Angeles","Los Angeles (UTC-8)"],["America/Phoenix","Phoenix (UTC-7)"],["America/Anchorage","Anchorage (UTC-9)"],["Pacific/Honolulu","Honolulu (UTC-10)"]],"d":"America/New_York"},
"UY":{"n":"Uruguay","tz":[["America/Montevideo","Montevideo (UTC-3)"]],"d":"America/Montevideo"},
"UZ":{"n":"Uzbekistan","tz":[["Asia/Tashkent","Tashkent (UTC+5)"]],"d":"Asia/Tashkent"},
"VU":{"n":"Vanuatu","tz":[["Pacific/Efate","Port Vila (UTC+11)"]],"d":"Pacific/Efate"},
"VA":{"n":"Vatican City","tz":[["Europe/Vatican","Vatican City (UTC+1)"]],"d":"Europe/Vatican"},
"VE":{"n":"Venezuela","tz":[["America/Caracas","Caracas (UTC-4)"]],"d":"America/Caracas"},
"VN":{"n":"Vietnam","tz":[["Asia/Ho_Chi_Minh","Hanoi / Ho Chi Minh City (UTC+7)"]],"d":"Asia/Ho_Chi_Minh"},
"YE":{"n":"Yemen","tz":[["Asia/Aden","Sana'a (UTC+3)"]],"d":"Asia/Aden"},
"ZM":{"n":"Zambia","tz":[["Africa/Lusaka","Lusaka (UTC+2)"]],"d":"Africa/Lusaka"},
"ZW":{"n":"Zimbabwe","tz":[["Africa/Harare","Harare (UTC+2)"]],"d":"Africa/Harare"}
};

export function autoDetectCountryTz(countrySelectId, tzSelectId, updateFn){
  try{
    // Browsers still report some legacy zone names (Chromium: Asia/Calcutta);
    // the table uses the current ones.
    const _ALIAS={'Asia/Calcutta':'Asia/Kolkata','Asia/Katmandu':'Asia/Kathmandu','Asia/Saigon':'Asia/Ho_Chi_Minh','Europe/Kiev':'Europe/Kyiv','Asia/Rangoon':'Asia/Yangon','America/Buenos_Aires':'America/Argentina/Buenos_Aires'};
    const rawTz=Intl.DateTimeFormat().resolvedOptions().timeZone||'';
    const browserTz=_ALIAS[rawTz]||rawTz;
    if(!browserTz)return;
    let bestCountry='';
    for(const[cc,c]of Object.entries(COUNTRY_TZ)){
      if(c.tz.some(([tz])=>tz===browserTz)){bestCountry=cc;break;}
    }
    if(bestCountry){
      const cs=document.getElementById(countrySelectId);
      if(cs&&!cs.value){cs.value=bestCountry;if(updateFn)updateFn();document.getElementById(tzSelectId).value=browserTz;}
    }
  }catch(e){
    console.warn('autoDetectCountryTz failed:',e);
  }
}

export function updateTimezones(){
  const cc=document.getElementById('reg-country').value;
  const sel=document.getElementById('reg-tz');
  if(!cc||!COUNTRY_TZ[cc]){
    setSafeHtml(sel, '<option value="">Select timezone...</option>');
    return;
  }
  setSafeHtml(sel, '');
  const c=COUNTRY_TZ[cc];
  c.tz.forEach(([val,label])=>{
    const o=document.createElement('option');o.value=val;o.textContent=label;
    if(val===c.d)o.selected=true;
    sel.appendChild(o);
  });
}

// v7.3.0 — international dialing codes (E.164), keyed by the same ISO alpha-2 codes
// as COUNTRY_TZ, so the optional phone field can be prefilled from the browser
// locale exactly like the (mandatory) country field.
export const DIAL_CODES={
  AF:"+93",AL:"+355",DZ:"+213",AD:"+376",AO:"+244",AG:"+1",AR:"+54",AM:"+374",AU:"+61",AT:"+43",
  AZ:"+994",BS:"+1",BH:"+973",BD:"+880",BB:"+1",BY:"+375",BE:"+32",BZ:"+501",BJ:"+229",BT:"+975",
  BO:"+591",BA:"+387",BW:"+267",BR:"+55",BN:"+673",BG:"+359",BF:"+226",BI:"+257",CV:"+238",KH:"+855",
  CM:"+237",CA:"+1",CF:"+236",TD:"+235",CL:"+56",CN:"+86",CO:"+57",KM:"+269",CG:"+242",CD:"+243",
  CR:"+506",CI:"+225",HR:"+385",CU:"+53",CY:"+357",CZ:"+420",DK:"+45",DJ:"+253",DM:"+1",DO:"+1",
  EC:"+593",EG:"+20",SV:"+503",GQ:"+240",ER:"+291",EE:"+372",SZ:"+268",ET:"+251",FJ:"+679",FI:"+358",
  FR:"+33",GA:"+241",GM:"+220",GE:"+995",DE:"+49",GH:"+233",GR:"+30",GD:"+1",GT:"+502",GN:"+224",
  GW:"+245",GY:"+592",HT:"+509",HN:"+504",HU:"+36",IS:"+354",IN:"+91",ID:"+62",IR:"+98",IQ:"+964",
  IE:"+353",IL:"+972",IT:"+39",JM:"+1",JP:"+81",JO:"+962",KZ:"+7",KE:"+254",KI:"+686",KP:"+850",
  KR:"+82",KW:"+965",KG:"+996",LA:"+856",LV:"+371",LB:"+961",LS:"+266",LR:"+231",LY:"+218",LI:"+423",
  LT:"+370",LU:"+352",MG:"+261",MW:"+265",MY:"+60",MV:"+960",ML:"+223",MT:"+356",MH:"+692",MR:"+222",
  MU:"+230",MX:"+52",FM:"+691",MD:"+373",MC:"+377",MN:"+976",ME:"+382",MA:"+212",MZ:"+258",MM:"+95",
  NA:"+264",NR:"+674",NP:"+977",NL:"+31",NZ:"+64",NI:"+505",NE:"+227",NG:"+234",MK:"+389",NO:"+47",
  OM:"+968",PK:"+92",PW:"+680",PS:"+970",PA:"+507",PG:"+675",PY:"+595",PE:"+51",PH:"+63",PL:"+48",
  PT:"+351",QA:"+974",RO:"+40",RU:"+7",RW:"+250",KN:"+1",LC:"+1",VC:"+1",WS:"+685",SM:"+378",
  ST:"+239",SA:"+966",SN:"+221",RS:"+381",SC:"+248",SL:"+232",SG:"+65",SK:"+421",SI:"+386",SB:"+677",
  SO:"+252",ZA:"+27",SS:"+211",ES:"+34",LK:"+94",SD:"+249",SR:"+597",SE:"+46",CH:"+41",SY:"+963",
  TW:"+886",TJ:"+992",TZ:"+255",TH:"+66",TL:"+670",TG:"+228",TO:"+676",TT:"+1",TN:"+216",TR:"+90",
  TM:"+993",TV:"+688",UG:"+256",UA:"+380",AE:"+971",GB:"+44",US:"+1",UY:"+598",UZ:"+998",VU:"+678",
  VA:"+39",VE:"+58",VN:"+84",YE:"+967",ZM:"+260",ZW:"+263",
};

export function dialCodeForCountry(cc){ return (cc&&DIAL_CODES[cc])||""; }

// Prefill the phone field's dialing-code prefix from the (locale-detected or
// manually-chosen) country — but ONLY when the field is empty or still holds a
// bare dial code, so a user-typed number is never clobbered.
export function autoFillDialCode(countrySelId, phoneInputId){
  const cs=document.getElementById(countrySelId);
  const ph=document.getElementById(phoneInputId);
  if(!cs||!ph)return;
  const code=dialCodeForCountry(cs.value);
  if(!code)return;
  const cur=(ph.value||"").trim();
  if(cur===''||/^\+\d{1,4}$/.test(cur)){ ph.value=code+' '; }
}

/**
 * The message to show when an admin types a wall clock that does not exist.
 *
 * v7.21.19 (audit F2). Shared so the competition form and the session form
 * refuse in the same words — they are the same mistake and the remedy is the
 * same, and two hand-written versions of one sentence is how the alert copy in
 * v7.21.14 came to disagree with itself.
 */
export function dstGapMessage(timeVal, tz){
  return `${timeVal} does not exist on that date in ${tz} — the clocks jump forward, `
       + `so that hour is skipped. Pick a time before or after the change.`;
}
