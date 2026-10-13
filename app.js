import { createStore } from "./store.js?v=4";

/* =====================================================================
   智取店排班系統 v2
   - 各區域資料分開：regions/{rid}/cfg/{master|employees|leave}、months/{ym}、leave/{ym_eid}
   - 母店、門市都由使用者自己輸入；頂部選單一次選一家母店
   - 班表格子：cells["yyyymmdd_員工id"] = { s: "am"|"pm"|"off", st: [門市id…], n: "備註" }
   ===================================================================== */
const SHIFT = { am: "早班", pm: "晚班" };
const SH1 = { am: "早", pm: "晚", any: "早晚" };
const WD = ["日", "一", "二", "三", "四", "五", "六"];
const DEFAULT_RULES = { capAm: 0, capPm: 0, maxStores: 0, maxKm: 0, maxDays: 5, maxConsec: 6 };
const S = {
  store: null, user: undefined, regions: undefined, rid: null, reg: null,
  master: undefined, emps: undefined, leaveCfg: null,
  hub: null, tab: "overview", ym: "", ovStart: "", ovShift: "am", onlyMiss: false,
  months: {}, monthSubs: {}, leaves: {}, leaveSubs: {}, subs: [], plan: null, showAllEmps: false,
};
const $ = s => document.querySelector(s);
const main = $("#main");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

/* ================= 日期 ================= */
const pad = n => String(n).padStart(2, "0");
const toDs = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const fromDs = ds => new Date(+ds.slice(0, 4), +ds.slice(4, 6) - 1, +ds.slice(6, 8));
const ymOf = ds => `${ds.slice(0, 4)}-${ds.slice(4, 6)}`;
const addDays = (ds, n) => { const d = fromDs(ds); d.setDate(d.getDate() + n); return toDs(d); };
const todayDs = () => toDs(new Date());
const dLabel = ds => { const d = fromDs(ds); return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`; };
const isoOf = ds => `${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6, 8)}`;
const shiftYm = (ym, n) => { const [y, m] = ym.split("-").map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const mondayOf = ds => { const d = fromDs(ds); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return toDs(d); };
const dayInfo = ds => { const d = fromDs(ds); return { ds, d: d.getDate(), m: d.getMonth() + 1, wd: WD[d.getDay()], we: d.getDay() === 0 || d.getDay() === 6, today: ds === todayDs() }; };
const range = (start, n) => Array.from({ length: n }, (_, i) => dayInfo(addDays(start, i)));
function monthDays(ym) { const [y, m] = ym.split("-").map(Number); return range(`${y}${pad(m)}01`, new Date(y, m, 0).getDate()); }

/* ================= 衍生資料 ================= */
const P = (...x) => `regions/${S.rid}/` + x.join("/");
const isOwner = () => !!S.user && S.user.email === S.store.owner;
const isAdmin = () => isOwner() || (!!S.user && (S.reg?.admins || []).includes(S.user.email));
const M = () => S.master || { hubs: [], stores: [], rules: DEFAULT_RULES };
const rules = () => ({ ...DEFAULT_RULES, ...(M().rules || {}) });
const hubs = () => M().hubs || [];
const hubBy = id => hubs().find(h => h.id === id);
const stores = () => M().stores || [];
const storeBy = id => stores().find(s => s.id === id);
const storesOf = hub => stores().filter(s => s.hub === hub);
const sName = id => storeBy(id)?.name || "（已刪除）";
const emps = () => S.emps || [];
const empBy = id => emps().find(e => e.id === id);
const empsOf = hub => emps().filter(e => e.hub === hub);
const cell = (ds, eid) => (S.months[ymOf(ds)] || {})[ds + "_" + eid] || null;
const needs = (s, sh) => s[sh === "am" ? "needAm" : "needPm"] !== false;
const loadOf = (s, sh) => +(s[sh === "am" ? "loadAm" : "loadPm"]) || 1;
// 某天某班，每家店由誰負責（整個區域的人都算，跨店支援也算）
function coverage(ds, sh, src) {
  const cov = {};
  for (const e of emps()) {
    const c = src ? src(ds, e.id) : cell(ds, e.id);
    if (c && c.s === sh) for (const st of c.st || []) (cov[st] ||= []).push(e);
  }
  return cov;
}
const missing = (ds, sh, hub, src) => { const cov = coverage(ds, sh, src); return storesOf(hub).filter(s => needs(s, sh) && !cov[s.id]); };
// 畫休：員工送出就生效
const AVL = { off: "畫休：休假", am: "畫休：只能早班", pm: "畫休：只能晚班", any: "畫休：早晚都可以" };
const AV = { off: "休", am: "早", pm: "晚", any: "皆" };
const avOf = (ds, eid) => S.leaves[ymOf(ds)]?.[eid]?.days?.[ds] || null;
const avBad = (av, sh) => av === "off" || (av === "am" && sh === "pm") || (av === "pm" && sh === "am");
const avTag = av => av ? `<span class="av av-${av}" title="${AVL[av]}">${AV[av]}</span>` : "";
// 距離（公里）
const hasXY = s => s && isFinite(s.lat) && isFinite(s.lng) && s.lat !== null && s.lng !== null && s.lat !== "";
function km(a, b) {
  if (!hasXY(a) || !hasXY(b)) return null;
  const R = 6371, r = x => x * Math.PI / 180, dLa = r(b.lat - a.lat), dLo = r(b.lng - a.lng);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ================= 啟動 ================= */
grabApollo();
init();
async function init() {
  const now = new Date();
  S.ym = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  S.ovStart = mondayOf(todayDs());
  S.autoStart = mondayOf(addDays(todayDs(), 7)); S.autoDays = 14;
  S.tab = ls.get("zq2-tab") || "overview";
  try { S.store = await createStore(); }
  catch (e) { main.innerHTML = `<div class="card">無法連線到 Firebase：${esc(e.message)}</div>`; return; }
  if (S.store.mode === "local") { const b = $("#banner"); b.hidden = false; b.innerHTML = "目前是<b>本機試用模式</b>：資料只存在這台電腦的瀏覽器。"; }
  S.store.setErrorHandler(e => toast(e.code === "permission-denied" ? "沒有權限讀取這份資料" : "連線錯誤：" + e.message));
  S.store.onAuth(u => { S.user = u; stopAll(); if (u) watchRegions(); else S.regions = undefined; render(); });
  $("#tabs").onclick = e => { const b = e.target.closest("button[data-tab]"); if (b) setTab(b.dataset.tab); };
  $("#topCtl").onchange = onTopChange;
  $("#topCtl").onclick = onTopClick;
  main.onclick = onClick;
  main.onchange = onChange;
  main.oninput = onInput;
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });
}
function stopAll() {
  S.subs.forEach(f => f && f()); S.subs = [];
  stopRegion();
}
function stopRegion() {
  (S.rsubs || []).forEach(f => f && f()); S.rsubs = [];
  Object.values(S.monthSubs).forEach(f => f && f()); S.monthSubs = {}; S.months = {};
  Object.values(S.leaveSubs).forEach(f => f && f()); S.leaveSubs = {}; S.leaves = {};
  S.reg = null; S.master = undefined; S.emps = undefined; S.leaveCfg = null; S.plan = null;
}
function watchRegions() {
  S.regions = undefined;
  const em = S.user.email;
  if (isOwner()) {
    S.subs.push(S.store.watchList("regions", null, null, null, l => setRegions(l)));
  } else {
    let a = null, v = null;
    const done = () => { if (a && v) setRegions([...a, ...v.filter(x => !a.some(y => y.id === x.id))]); };
    S.subs.push(S.store.watchList("regions", "admins", "array-contains", em, l => { a = l; done(); }));
    S.subs.push(S.store.watchList("regions", "viewers", "array-contains", em, l => { v = l; done(); }));
  }
}
function setRegions(list) {
  S.regions = list.sort((a, b) => (a.name || "").localeCompare(b.name || "", "zh-Hant"));
  const want = S.rid && list.some(r => r.id === S.rid) ? S.rid : (list.find(r => r.id === ls.get("zq2-rid")) || list[0])?.id || null;
  if (want !== S.rid) openRegion(want);
  else { S.reg = list.find(r => r.id === S.rid) || null; render(); }
}
function openRegion(rid) {
  stopRegion();
  S.rid = rid;
  if (!rid) return render();
  ls.set("zq2-rid", rid);
  S.reg = S.regions.find(r => r.id === rid) || null;
  S.rsubs.push(S.store.watch(P("cfg", "master"), m => { S.master = m || { hubs: [], stores: [], rules: { ...DEFAULT_RULES } }; fixHub(); render(); }));
  S.rsubs.push(S.store.watch(P("cfg", "employees"), d => { S.emps = d?.list || []; render(); }));
  S.rsubs.push(S.store.watch(P("cfg", "leave"), d => { S.leaveCfg = d; render(); }, true));
  watchMonths();
}
function fixHub() {
  const k = "zq2-hub-" + S.rid;
  if (!hubBy(S.hub)) S.hub = hubBy(ls.get(k)) ? ls.get(k) : hubs()[0]?.id || null;
}
// 依畫面需要訂閱月份（總覽 14 天、自動排班範圍可能跨月）
function neededMonths() {
  const need = new Set([S.ym, ymOf(todayDs())]);
  const add = (s, n) => { for (let i = -7; i < n; i += 7) need.add(ymOf(addDays(s, i))); need.add(ymOf(addDays(s, n - 1))); };
  add(S.ovStart, 14);
  if (S.autoStart) add(S.autoStart, S.autoDays || 14);
  return need;
}
function watchMonths() {
  if (!S.rid) return;
  const need = neededMonths();
  for (const ym of need) {
    if (!S.monthSubs[ym]) S.monthSubs[ym] = S.store.watch(P("months", ym), d => { S.months[ym] = d?.cells || {}; render(); });
    if (!S.leaveSubs[ym] && isAdmin()) S.leaveSubs[ym] = S.store.watchList(P("leave"), "ym", "==", ym, l => { S.leaves[ym] = Object.fromEntries(l.map(x => [x.eid, x])); render(); });
  }
}
const monthsReady = list => [...list].every(ym => S.months[ym]);
function setTab(t) { S.tab = t; ls.set("zq2-tab", t); render(); }

/* ================= 畫面 ================= */
const TABS = [["overview", "漏排總覽"], ["grid", "班表"], ["auto", "自動排班", 1], ["people", "人員", 1], ["stores", "門市", 1], ["leave", "畫休", 1], ["settings", "設定", 1]];
function render() {
  if (S.renderQueued) return;
  S.renderQueued = true;
  queueMicrotask(() => { S.renderQueued = false; renderNow(); });
}
function renderNow() {
  renderTop();
  const admin = isAdmin();
  if (!admin && TABS.find(t => t[0] === S.tab)?.[2]) S.tab = "overview";
  $("#tabs").innerHTML = S.rid && S.master ? TABS.filter(t => admin || !t[2]).map(([k, v]) => `<button data-tab="${k}" class="${S.tab === k ? "active" : ""}">${v}</button>`).join("") : "";
  if (S.user === undefined) return html(`<div class="loading">載入中…</div>`);
  if (!S.user) return html(loginHtml());
  if (S.regions === undefined) return html(`<div class="loading">讀取區域…</div>`);
  if (!S.rid) return html(noRegionHtml());
  if (S.master === undefined || S.emps === undefined) return html(`<div class="loading">載入資料中…</div>`);
  watchMonths();
  if (S.apolloPending && admin) setTimeout(runApolloPending);
  if (!hubs().length && S.tab !== "settings") return html(admin ? firstHubHtml() : `<div class="card login"><h2>這個區域還沒有設定母店</h2><p class="muted">請主管先到「設定」新增母店。</p></div>`);
  const keep = keepScroll();
  const v = { overview: overviewHtml, grid: gridHtml, auto: autoHtml, people: peopleHtml, stores: storesHtml, leave: leaveHtml, settings: settingsHtml }[S.tab] || overviewHtml;
  html(v());
  keep();
}
function html(h) { main.innerHTML = h; }
function keepScroll() {
  const sc = main.querySelector(".scroll"), key = S.tab + S.ym + S.hub + S.ovStart;
  const pos = sc && S.lastKey === key ? [sc.scrollLeft, sc.scrollTop] : null;
  const y = window.scrollY;
  return () => {
    const n = main.querySelector(".scroll");
    if (n && pos) { n.scrollLeft = pos[0]; n.scrollTop = pos[1]; }
    else if (n) { const t = n.querySelector("th.today"); if (t) n.scrollLeft = Math.max(0, t.offsetLeft - 160); }
    S.lastKey = key; window.scrollTo(0, y);
  };
}
function renderTop() {
  const box = $("#topCtl");
  const regionSel = S.regions && S.regions.length > 1
    ? `<select id="regionSel" title="區域">${S.regions.map(r => `<option value="${r.id}" ${r.id === S.rid ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select>`
    : S.reg ? `<span class="rname">${esc(S.reg.name)}</span>` : "";
  const hubSel = S.rid && hubs().length ? `<label class="hubpick">母店 <select id="hubSel">${hubs().map(h => `<option value="${h.id}" ${h.id === S.hub ? "selected" : ""}>${esc(h.name)}</option>`).join("")}</select></label>` : "";
  const user = !S.user ? "" : `<span class="role">${S.store.mode === "local" ? "本機試用" : isOwner() ? "最高管理者" : isAdmin() ? "主管" : "檢視"}</span>${S.store.mode === "local" ? "" : `<button class="btn small" id="logout" title="${esc(S.user.email)}">登出</button>`}`;
  box.innerHTML = `${regionSel}${hubSel}<span class="spacer"></span><span class="user-box">${user}</span>`;
}
function onTopChange(e) {
  const t = e.target;
  if (t.id === "regionSel") { openRegion(t.value); render(); }
  if (t.id === "hubSel") { S.hub = t.value; ls.set("zq2-hub-" + S.rid, t.value); S.plan = null; render(); }
}
function onTopClick(e) { if (e.target.id === "logout") S.store.signOut(); }
function loginHtml() {
  return `<div class="card login"><img src="icon.svg" width="56" height="56" alt=""><h2>智取店排班系統</h2>
    <p class="muted">請用 Google 帳號登入</p><button class="btn primary" data-act="login">使用 Google 登入</button></div>`;
}
function noRegionHtml() {
  if (isOwner()) return `<div class="card login"><h2>建立第一個區域</h2><p class="muted">每個區域的母店、門市、人員、班表都分開，各區主管只看得到自己的區域。</p>
    <div class="row" style="justify-content:center"><input type="text" id="newRegion" placeholder="區域名稱，例如 新莊區" style="width:200px"><button class="btn primary" data-act="addRegion">建立</button></div></div>`;
  return `<div class="card login"><h2>帳號尚未開通</h2><p class="muted">你目前登入的是<br><b>${esc(S.user.email)}</b></p>
    <p class="muted small">請把這個 Email 傳給管理者，加到你負責的區域後就可以使用。</p><button class="btn" data-act="switchUser">換一個帳號</button></div>`;
}
function firstHubHtml() {
  return `<div class="card login"><h2>先新增母店</h2><p class="muted">母店是排班的單位，例如「榮華店」。新增後再到「門市」把各家衛星門市掛到母店底下。</p>
    <div class="row" style="justify-content:center"><input type="text" id="newHub" placeholder="母店名稱" style="width:180px"><button class="btn primary" data-act="addHub">新增母店</button></div></div>`;
}

/* ---------- 漏排總覽 ---------- */
function overviewHtml() {
  const sh = S.ovShift, days = range(S.ovStart, 14), list = storesOf(S.hub).filter(s => needs(s, sh));
  const ready = monthsReady(new Set(days.map(d => ymOf(d.ds))));
  const covs = Object.fromEntries(days.map(d => [d.ds, coverage(d.ds, sh)]));
  const missOf = ds => list.filter(s => !covs[ds][s.id]);
  const per = Object.fromEntries(days.map(d => [d.ds, missOf(d.ds)]));
  const total = days.reduce((n, d) => n + per[d.ds].length, 0);
  const todayMiss = per[todayDs()]?.length;
  const rowsMiss = new Set(days.flatMap(d => per[d.ds].map(s => s.id)));
  const shown = list.filter(s => !S.onlyMiss || rowsMiss.has(s.id));
  const rows = shown.map(s => `<tr><td class="sticky"><span class="sname">${esc(s.name)}</span></td>${days.map(d => {
    const c = covs[d.ds][s.id];
    const tip = `${dLabel(d.ds)} ${s.name} ${SHIFT[sh]}：${c ? c.map(e => e.name).join("、") : "尚未有人負責"}`;
    return `<td class="ck ${c ? "ok" : "no"} ${d.today ? "tcol" : ""}" ${isAdmin() ? `data-act="assign" data-ds="${d.ds}" data-store="${s.id}" data-sh="${sh}"` : ""} title="${esc(tip)}">${c ? "✓" : "✕"}</td>`;
  }).join("")}</tr>`).join("");
  return `<div class="ovbar">${["am", "pm"].map(k => `<button class="ovtab ${sh === k ? "on" : ""}" data-act="ovShift" data-sh="${k}">總覽・${SHIFT[k]}</button>`).join("")}</div>
  <div class="row toolbar" style="margin:12px 0">
    <button class="btn" data-act="ovMove" data-n="-14">◀ 往前14天</button><button class="btn" data-act="ovToday">回到今天</button><button class="btn" data-act="ovMove" data-n="14">往後14天 ▶</button>
    <span class="muted">${days[0].m}/${days[0].d} — ${days[13].m}/${days[13].d}</span><span class="spacer"></span>
    <span class="ovsum">今天${SHIFT[sh]}漏排 <b class="${todayMiss ? "bad" : "good"}">${todayMiss ?? "—"}</b> 家・這 14 天共 <b class="${total ? "bad" : "good"}">${total}</b> 店次</span>
    <label class="small"><input type="checkbox" data-ch="onlyMiss" ${S.onlyMiss ? "checked" : ""}> 只顯示有漏排的門市</label>
  </div>
  ${!ready ? `<div class="loading">載入班表中…</div>` : !list.length ? `<div class="card">「${esc(hubBy(S.hub)?.name)}」底下還沒有需要${SHIFT[sh]}的門市，請到「門市」新增。</div>` : `
  <div class="scroll"><table class="ov">
    <thead><tr><th class="sticky corner">${esc(hubBy(S.hub)?.name)}</th>${days.map(d => `<th class="${d.today ? "today" : ""}">${d.m}/${d.d}<br>${d.wd}</th>`).join("")}</tr></thead>
    <tbody>${rows || `<tr><td class="sticky" colspan="15" style="padding:20px">這 14 天沒有漏排 🎉</td></tr>`}</tbody>
    <tfoot><tr><td class="sticky">漏排家數</td>${days.map(d => { const m = per[d.ds].length; return `<td class="${m ? "bad" : "good"}">${m || "✓"}</td>`; }).join("")}</tr></tfoot>
  </table></div>
  <p class="muted small">${isAdmin() ? "點 ✕ 可以直接指派人；點 ✓ 可以看是誰負責。" : ""}</p>`}`;
}

/* ---------- 班表（人 × 日期） ---------- */
function cellInner(c, av) {
  if (!c) return avTag(av);
  if (c.s === "off") return avTag(av) + `<span class="offt">休</span>`;
  return avTag(av) + `<span class="shtag sh-${c.s}">${SH1[c.s]}</span>` + (c.st || []).map(id => `<span class="st">${esc(sName(id))}</span>`).join("") + (c.n ? `<div class="note">${esc(c.n)}</div>` : "");
}
function personRows(list, days, src, changed) {
  return list.map(e => {
    let work = 0, cnt = 0;
    const tds = days.map(d => {
      const c = src(d.ds, e.id), av = avOf(d.ds, e.id);
      if (c && c.s !== "off") { work++; cnt += (c.st || []).length; }
      const bad = av && c && c.s !== "off" && avBad(av, c.s);
      const ch = changed && changed(d.ds, e.id);
      return `<td class="c ${c?.s === "off" ? "off" : ""} ${bad ? "avbad" : ""} ${ch ? "chg" : ""} ${d.we ? "we" : ""}" ${src === cell && isAdmin() ? `data-act="editCell" data-e="${e.id}" data-ds="${d.ds}"` : ""} title="${esc(e.name + " " + dLabel(d.ds) + (av ? "\n" + AVL[av] : ""))}">${cellInner(c, av)}</td>`;
    }).join("");
    return `<tr><td class="sticky">${esc(e.name)}${e.hub !== S.hub ? ` <span class="muted small">(${esc(hubBy(e.hub)?.name || "未分母店")})</span>` : ""}${e.active === false ? ' <span class="muted small">(停用)</span>' : ""}</td>${tds}<td class="tot">${work}天<br><span class="small">${cnt}店次</span></td></tr>`;
  }).join("");
}
function missRow(days, src) {
  return ["am", "pm"].map(sh => `<tr class="missrow"><th class="sticky">${SHIFT[sh]}漏排</th>${days.map(d => {
    const m = missing(d.ds, sh, S.hub, src);
    return `<th><span class="missbtn ${m.length ? "bad" : "good"}" title="${m.length ? "漏排：" + m.map(s => s.name).join("、") : "全部排滿"}">${m.length ? "漏" + m.length : "✓"}</span></th>`;
  }).join("")}<th></th></tr>`).join("");
}
// 這個母店的人＋這段期間有來支援的人
function rowsFor(days, src) {
  const own = empsOf(S.hub).filter(e => e.active !== false || days.some(d => src(d.ds, e.id)));
  const ids = new Set(storesOf(S.hub).map(s => s.id));
  const help = emps().filter(e => e.hub !== S.hub && days.some(d => (src(d.ds, e.id)?.st || []).some(x => ids.has(x))));
  return [...own, ...help];
}
function gridHtml() {
  const days = monthDays(S.ym);
  const [y, m] = S.ym.split("-");
  if (!S.months[S.ym]) return monthNav(y, m) + `<div class="loading">載入班表中…</div>`;
  const list = rowsFor(days, cell);
  return monthNav(y, m) + `
  <div class="scroll"><table class="sg">
    <thead><tr><th class="sticky">${esc(hubBy(S.hub)?.name)}（${list.length}人）</th>${days.map(d => `<th class="${d.today ? "today" : ""} ${d.we ? "we" : ""}">${d.d}<br>${d.wd}</th>`).join("")}<th>合計</th></tr>
    ${missRow(days, cell)}</thead>
    <tbody>${personRows(list, days, cell) || `<tr><td class="sticky" style="padding:20px" colspan="${days.length + 2}">這家母店還沒有人員，請到「人員」新增或從 Apollo 匯入。</td></tr>`}</tbody>
  </table></div>
  <div class="legend" style="margin-top:8px"><span><span class="shtag sh-am">早</span>早班</span><span><span class="shtag sh-pm">晚</span>晚班</span><span>右上角小標＝員工畫休</span>${isAdmin() ? "<span>點格子可以修改</span>" : ""}</div>`;
}
function monthNav(y, m) {
  return `<div class="row toolbar" style="margin-bottom:10px">
    <button class="icon-btn" data-act="month" data-n="-1">‹</button><b style="font-size:16px">${y}年${+m}月</b><button class="icon-btn" data-act="month" data-n="1">›</button>
    <span class="spacer"></span><button class="btn" data-act="exportX">匯出 Excel</button><button class="btn" onclick="window.print()">列印</button></div>`;
}

/* ---------- 自動排班 ---------- */
function autoHtml() {
  const r = rules(), hub = hubBy(S.hub), st = storesOf(S.hub), people = empsOf(S.hub).filter(e => e.active !== false);
  S.autoStart ||= mondayOf(addDays(todayDs(), 7)); S.autoDays ||= 14;
  const noXY = st.filter(s => !hasXY(s)).length;
  const p = S.plan && S.plan.hub === S.hub ? S.plan : null;
  const setup = `<div class="card"><h3>自動排班・${esc(hub?.name)}</h3>
    <div class="row">
      <label>從哪天開始<br><input type="date" data-ch="autoStart" value="${isoOf(S.autoStart)}"></label>
      <label>排幾天<br><select data-ch="autoDays">${[7, 14, 21, 28].map(n => `<option value="${n}" ${n === S.autoDays ? "selected" : ""}>${n} 天</option>`).join("")}</select></label>
      <label class="small" style="align-self:flex-end"><input type="checkbox" id="autoKeep" ${S.autoKeep !== false ? "checked" : ""} data-ch="autoKeep"> 保留已經排好的格子（只補空的）</label>
      <span class="spacer"></span>
      <button class="btn primary big" data-act="autoRun">產生班表</button>
    </div>
    <div class="small muted" style="margin-top:10px;line-height:1.8">
      這家母店：門市 <b>${st.length}</b> 家（早班要排 ${st.filter(s => needs(s, "am")).length}、晚班要排 ${st.filter(s => needs(s, "pm")).length}）・可排人員 <b>${people.length}</b> 人
      （只上早班 ${people.filter(e => e.shift === "am").length}、只上晚班 ${people.filter(e => e.shift === "pm").length}、早晚都可 ${people.filter(e => !e.shift || e.shift === "any").length}）<br>
      條件：每人每週最多 <b>${r.maxDays}</b> 天、最多連上 <b>${r.maxConsec}</b> 天${r.maxStores ? `、每班最多 <b>${r.maxStores}</b> 家店` : ""}${r.capAm || r.capPm ? `、每班工作量上限 早 <b>${r.capAm || "不限"}</b>／晚 <b>${r.capPm || "不限"}</b>` : ""}${r.maxKm ? `、同一人負責的店相距 <b>${r.maxKm}</b> 公里內` : ""}
      <a href="#" data-act="goSettings">修改條件</a><br>
      ${noXY ? `<span style="color:var(--warn)">有 ${noXY} 家門市還沒有座標，分配時無法依距離分組（會照門市列表的順序分）。<a href="#" data-act="goStores">去補座標</a></span>` : "所有門市都有座標，會把距離近的店分給同一個人。"}
    </div></div>`;
  if (!p) return setup + `<div class="card muted">按「產生班表」後，這裡會先顯示預覽，確認沒問題再按「確認寫入」。</div>`;
  const days = range(p.start, p.days);
  const src = (ds, eid) => p.cells[ds + "_" + eid] !== undefined ? p.cells[ds + "_" + eid] : cell(ds, eid);
  const changed = (ds, eid) => p.cells[ds + "_" + eid] !== undefined && JSON.stringify(p.cells[ds + "_" + eid]) !== JSON.stringify(cell(ds, eid));
  const list = rowsFor(days, src);
  const miss = days.reduce((n, d) => n + missing(d.ds, "am", S.hub, src).length + missing(d.ds, "pm", S.hub, src).length, 0);
  const nChg = Object.keys(p.cells).filter(k => { const [ds, eid] = k.split("_"); return changed(ds, eid); }).length;
  return setup + `<div class="card"><h3>預覽 ${days[0].m}/${days[0].d} — ${days[days.length - 1].m}/${days[days.length - 1].d}</h3>
    <div class="row" style="margin-bottom:8px">
      <span>會變更 <b>${nChg}</b> 格・排完仍漏排 <b class="${miss ? "bad" : "good"}">${miss}</b> 店次</span>
      ${p.notes.length ? `<span class="small" style="color:var(--warn)">${p.notes.map(esc).join("；")}</span>` : ""}
      <span class="spacer"></span><button class="btn" data-act="autoCancel">取消</button><button class="btn" data-act="autoRun">重新產生</button><button class="btn primary big" data-act="autoSave" ${nChg ? "" : "disabled"}>確認寫入</button>
    </div>
    <p class="muted small">黃底是這次會改的格子。確認寫入後還是可以到「班表」點格子手動調整。</p>
    <div class="scroll"><table class="sg">
      <thead><tr><th class="sticky">${esc(hub?.name)}</th>${days.map(d => `<th class="${d.today ? "today" : ""} ${d.we ? "we" : ""}">${d.m}/${d.d}<br>${d.wd}</th>`).join("")}<th>合計</th></tr>${missRow(days, src)}</thead>
      <tbody>${personRows(list, days, src, changed)}</tbody></table></div></div>`;
}
// 把要排的店依距離與工作量分成一組一組（一組給一個人）
// target：希望當天用幾個人（平均分攤一週的上班天數）；條件不允許時組數可以超過 target
function buildRoutes(list, sh, people) {
  const r = rules(), cap = +(sh === "am" ? r.capAm : r.capPm) || 0, maxSt = +r.maxStores || 0, maxKm = +r.maxKm || 0;
  if (!list.length || !people) return [];
  const total = list.reduce((n, s) => n + loadOf(s, sh), 0);
  const limit = Math.min(cap || Infinity, Math.max(total / people, ...list.map(s => loadOf(s, sh))));
  const xy = list.every(hasXY);
  const rest = [...list], routes = [];
  const center = xy ? { lat: rest.reduce((n, s) => n + +s.lat, 0) / rest.length, lng: rest.reduce((n, s) => n + +s.lng, 0) / rest.length } : null;
  while (rest.length) {
    // 起點：離中心最遠的店（外圍先排，避免最後剩下零散的遠店）；沒座標就照列表順序
    let si = 0;
    if (xy) { let best = -1; rest.forEach((s, i) => { const d = km(s, center); if (d > best) { best = d; si = i; } }); }
    const seed = rest.splice(si, 1)[0], route = { stores: [seed], load: loadOf(seed, sh) };
    for (;;) {
      if (maxSt && route.stores.length >= maxSt) break;
      let bi = -1, bd = Infinity;
      rest.forEach((s, i) => {
        if (route.load + loadOf(s, sh) > Math.min(cap || Infinity, limit * 1.15) + 1e-9) return;
        if (maxKm && xy && km(s, seed) > maxKm) return;
        const d = xy ? Math.min(...route.stores.map(x => km(x, s))) : i;
        if (d < bd) { bd = d; bi = i; }
      });
      if (bi < 0) break;
      const s = rest.splice(bi, 1)[0]; route.stores.push(s); route.load += loadOf(s, sh);
    }
    routes.push(route);
  }
  // 組數比人多：試著把小組併到最近、還裝得下的組
  routes.sort((a, b) => a.load - b.load);
  const hardCap = cap || Infinity;
  while (routes.length > people) {
    const small = routes[0]; let bj = -1, bd = Infinity;
    for (let j = 1; j < routes.length; j++) {
      const t = routes[j];
      if (t.load + small.load > hardCap) continue;
      if (maxSt && t.stores.length + small.stores.length > maxSt) continue;
      if (maxKm && xy && small.stores.some(s => km(s, t.stores[0]) > maxKm)) continue;
      const d = xy ? Math.min(...small.stores.flatMap(s => t.stores.map(x => km(s, x)))) : j;
      if (d < bd) { bd = d; bj = j; }
    }
    if (bj < 0) break;
    const t = routes[bj]; t.stores.push(...small.stores); t.load += small.load; routes.shift();
    routes.sort((a, b) => a.load - b.load);
  }
  return routes.sort((a, b) => b.load - a.load);
}
function autoPlan() {
  const r = rules(), start = S.autoStart, n = S.autoDays, keep = S.autoKeep !== false;
  const days = range(start, n).map(d => d.ds);
  const people = empsOf(S.hub).filter(e => e.active !== false);
  const hubStores = storesOf(S.hub);
  const plan = {}, notes = [];
  const get = (ds, eid) => plan[ds + "_" + eid] !== undefined ? plan[ds + "_" + eid] : cell(ds, eid);
  const working = c => c && c.s && c.s !== "off";
  const daysInWeek = (eid, ds) => { const w = mondayOf(ds); let k = 0; for (let i = 0; i < 7; i++) { const d = addDays(w, i); if (d !== ds && working(get(d, eid))) k++; } return k; };
  const streak = (eid, ds) => { let k = 0, d = addDays(ds, -1); while (k < 14 && working(get(d, eid))) { k++; d = addDays(d, -1); } return k; };
  const lastStores = (eid, ds, sh) => { const c = get(addDays(ds, -1), eid); return c && c.s === sh ? c.st || [] : []; };
  // 不保留：先把這段期間這家母店人員的格子清空
  if (!keep) for (const ds of days) for (const e of people) plan[ds + "_" + e.id] = null;
  for (const ds of days) {
    const used = new Set(people.filter(e => { const c = get(ds, e.id); return keep && c; }).map(e => e.id));
    for (const sh of ["am", "pm"]) {
      const cov = coverage(ds, sh, get);
      const need = hubStores.filter(s => needs(s, sh) && !cov[s.id]);
      if (!need.length) continue;
      const cand = people.filter(e => {
        if (used.has(e.id)) return false;
        if (e.shift && e.shift !== "any" && e.shift !== sh) return false;
        const av = avOf(ds, e.id); if (av && avBad(av, sh)) return false;
        if (daysInWeek(e.id, ds) >= (+e.maxDays || r.maxDays)) return false;
        if (streak(e.id, ds) >= r.maxConsec) return false;
        return true;
      });
      // 一天要用幾個人：讓大家的上班天數平均攤在一週 7 天（早晚都可的人兩班各算一半）
      const pool = people.filter(e => !e.shift || e.shift === "any" || e.shift === sh);
      const slots = pool.reduce((n, e) => n + (+e.maxDays || r.maxDays) / 7 * (e.shift === sh ? 1 : 0.5), 0);
      const target = Math.max(1, Math.min(cand.length, Math.round(slots)));
      const routes = buildRoutes(need, sh, target);
      for (const rt of routes) {
        const ids = rt.stores.map(s => s.id);
        let best = null, bs = -Infinity;
        for (const e of cand) {
          if (used.has(e.id)) continue;
          if ((e.stores || []).length && !ids.every(id => e.stores.includes(id))) continue;
          const last = lastStores(e.id, ds, sh);
          const score = -10 * daysInWeek(e.id, ds) + 4 * ids.filter(id => last.includes(id)).length + (e.shift === sh ? 3 : 0) - 0.5 * streak(e.id, ds) + Math.random() * 0.1;
          if (score > bs) { bs = score; best = e; }
        }
        if (!best) continue;
        used.add(best.id);
        plan[ds + "_" + best.id] = { s: sh, st: ids };
      }
    }
    // 沒排到班的人標「休」（保留模式下不動原本的格子）
    for (const e of people) if (!get(ds, e.id)) plan[ds + "_" + e.id] = { s: "off", st: [] };
  }
  if (!people.length) notes.push("這家母店沒有啟用中的人員");
  if (!hubStores.length) notes.push("這家母店沒有門市");
  return { hub: S.hub, start, days: n, cells: plan, notes };
}
async function autoSave() {
  const p = S.plan; if (!p) return;
  const byYm = {};
  for (const [k, v] of Object.entries(p.cells)) {
    const [ds, eid] = k.split("_");
    if (JSON.stringify(v) === JSON.stringify(cell(ds, eid))) continue;
    (byYm[ymOf(ds)] ||= {})[k] = v;
  }
  try {
    for (const [ym, map] of Object.entries(byYm)) await S.store.setCells(P("months", ym), map);
    S.plan = null; toast("已寫入班表"); S.ym = ymOf(p.start); setTab("grid");
  } catch (e) { toast("寫入失敗：" + e.message); }
}

/* ---------- 人員 ---------- */
function peopleHtml() {
  const hubOpts = sel => `<option value="">（未分母店）</option>` + hubs().map(h => `<option value="${h.id}" ${h.id === sel ? "selected" : ""}>${esc(h.name)}</option>`).join("");
  const list = S.showAllEmps ? emps() : emps().filter(e => e.hub === S.hub || !hubBy(e.hub));
  const rows = list.map(e => `<tr>
    <td><input type="text" value="${esc(e.name)}" data-ch="eName" data-id="${e.id}" style="width:90px"></td>
    <td><input type="text" value="${esc(e.code || "")}" data-ch="eCode" data-id="${e.id}" placeholder="工號" style="width:100px"></td>
    <td><select data-ch="eHub" data-id="${e.id}">${hubOpts(e.hub)}</select></td>
    <td><select data-ch="eShift" data-id="${e.id}">${[["any", "早晚都可"], ["am", "只上早班"], ["pm", "只上晚班"]].map(([k, v]) => `<option value="${k}" ${(e.shift || "any") === k ? "selected" : ""}>${v}</option>`).join("")}</select></td>
    <td><input type="number" min="1" max="7" value="${e.maxDays || ""}" placeholder="${rules().maxDays}" data-ch="eMax" data-id="${e.id}" style="width:56px"></td>
    <td><button class="btn small" data-act="eStores" data-id="${e.id}">${(e.stores || []).length ? `${e.stores.length} 家` : "不限"}</button></td>
    <td><input type="checkbox" data-ch="eAct" data-id="${e.id}" ${e.active !== false ? "checked" : ""}></td>
    <td><button class="btn small danger" data-act="eDel" data-id="${e.id}">刪</button></td></tr>`).join("");
  const act = emps().filter(e => e.active !== false);
  return `<div class="card"><h3>人員・${esc(hubBy(S.hub)?.name)}（${empsOf(S.hub).filter(e => e.active !== false).length} 人）</h3>
    <div class="row" style="margin-bottom:10px">
      <button class="btn primary" data-act="apolloHelp">從 Apollo「我的部屬」匯入…</button>
      <button class="btn" data-act="empPaste">批次貼上名單…</button>
      <span class="spacer"></span>
      <label class="small"><input type="checkbox" data-ch="showAll" ${S.showAllEmps ? "checked" : ""}> 顯示全區域人員（${act.length} 人）</label>
    </div>
    <div class="row" style="margin-bottom:10px">
      <input type="text" id="newEmp" placeholder="姓名" style="width:100px"><input type="text" id="newEmpCode" placeholder="工號" style="width:110px">
      <button class="btn" data-act="addEmp">新增到「${esc(hubBy(S.hub)?.name)}」</button>
    </div>
    <div class="scrollx"><table class="list emp"><tr><th>姓名</th><th>工號</th><th>主要門市（母店）</th><th>班別</th><th>每週最多天</th><th>可去門市</th><th>啟用</th><th></th></tr>${rows || `<tr><td colspan="8" class="muted" style="padding:16px">還沒有人員</td></tr>`}</table></div>
    <p class="muted small">「主要門市」決定這個人排在哪家母店。離職的人取消「啟用」就好，歷史班表會保留。「可去門市」不限＝母店底下每一家都可以排。</p></div>`;
}

/* ---------- 門市 ---------- */
function storesHtml() {
  const hub = hubBy(S.hub), list = storesOf(S.hub);
  const hubOpts = sel => hubs().map(h => `<option value="${h.id}" ${h.id === sel ? "selected" : ""}>${esc(h.name)}</option>`).join("");
  const rows = list.map((s, i) => `<tr>
    <td class="muted">${i + 1}</td>
    <td><input type="text" value="${esc(s.name)}" data-ch="sName" data-id="${s.id}" style="width:90px"></td>
    <td><input type="text" value="${esc(s.addr || "")}" data-ch="sAddr" data-id="${s.id}" placeholder="地址" style="width:220px"></td>
    <td><input type="text" value="${hasXY(s) ? `${(+s.lat).toFixed(5)},${(+s.lng).toFixed(5)}` : ""}" data-ch="sXY" data-id="${s.id}" placeholder="緯度,經度 或 Google 地圖網址" style="width:150px" class="${hasXY(s) ? "" : "warnbox"}"></td>
    <td class="nowrap"><input type="checkbox" data-ch="sNeedAm" data-id="${s.id}" ${needs(s, "am") ? "checked" : ""}> <input type="number" min="0" step="any" value="${s.loadAm ?? ""}" placeholder="1" data-ch="sLoadAm" data-id="${s.id}" style="width:60px"></td>
    <td class="nowrap"><input type="checkbox" data-ch="sNeedPm" data-id="${s.id}" ${needs(s, "pm") ? "checked" : ""}> <input type="number" min="0" step="any" value="${s.loadPm ?? ""}" placeholder="1" data-ch="sLoadPm" data-id="${s.id}" style="width:60px"></td>
    <td><select data-ch="sHub" data-id="${s.id}">${hubOpts(s.hub)}</select></td>
    <td class="nowrap"><button class="btn small" data-act="sMove" data-id="${s.id}" data-n="-1">↑</button> <button class="btn small" data-act="sMove" data-id="${s.id}" data-n="1">↓</button> <button class="btn small danger" data-act="sDel" data-id="${s.id}">刪</button></td></tr>`).join("");
  const noXY = list.filter(s => !hasXY(s) && s.addr).length;
  return `<div class="card"><h3>門市・${esc(hub?.name)}（${list.length} 家）</h3>
    <div class="row" style="margin-bottom:10px">
      <input type="text" id="newStore" placeholder="門市名稱" style="width:110px"><input type="text" id="newStoreAddr" placeholder="地址（選填）" style="width:220px">
      <button class="btn primary" data-act="addStore">新增門市</button>
      <button class="btn" data-act="storePaste">批次貼上門市…</button>
      <span class="spacer"></span>
      <button class="btn" data-act="geocode" ${noXY ? "" : "disabled"}>依地址自動找座標${noXY ? `（${noXY} 家）` : ""}</button>
    </div>
    <div class="scrollx"><table class="list emp"><tr><th>#</th><th>門市</th><th>地址</th><th>座標</th><th>早班要排／工作量</th><th>晚班要排／工作量</th><th>母店</th><th></th></tr>${rows || `<tr><td colspan="8" class="muted" style="padding:16px">還沒有門市</td></tr>`}</table></div>
    <p class="muted small" style="line-height:1.8">
      <b>座標</b>用來把距離近的店分給同一個人。可以按「依地址自動找座標」，找不到的話在 Google 地圖對門市按右鍵，複製「緯度, 經度」貼到座標欄（也可以直接貼 Google 地圖網址）。<br>
      <b>工作量</b>是自動排班平均分配的依據，單位自訂（例如包裹量、預估分鐘），沒填當 1。取消勾選＝這個班別不用排這家店。<br>
      列表順序也是分組依據：沒有座標時，會照順序把相鄰的店分給同一個人。</p></div>`;
}

/* ---------- 畫休（主管端） ---------- */
function leaveLink() { return location.href.split("#")[0].split("?")[0].replace(/[^/]*$/, "") + "leave.html?r=" + S.rid; }
function leaveHtml() {
  const c = S.leaveCfg, ym = S.leaveYm || (c?.open ? c.ym : shiftYm(ymOf(todayDs()), 1)), open = !!(c?.open && c.ym === ym);
  S.leaveYm = ym; watchMonthsFor(ym);
  const subs = S.leaves[ym], days = monthDays(ym);
  const list = empsOf(S.hub).filter(e => e.active !== false);
  const done = list.filter(e => subs?.[e.id]), todo = list.filter(e => !subs?.[e.id]);
  const rows = list.map(e => {
    const x = subs?.[e.id], t = x?.submittedAt ? new Date(x.submittedAt) : null;
    return `<tr><td class="sticky">${esc(e.name)}${x?.note ? ` <span class="notei" title="${esc(x.note)}">💬</span>` : ""}</td>
      <td class="sub">${t ? `${t.getMonth() + 1}/${t.getDate()} ${pad(t.getHours())}:${pad(t.getMinutes())}${x.late ? ' <span class="late">逾期</span>' : ""}` : '<span class="todo">未送出</span>'}</td>
      ${days.map(d => { const v = x?.days?.[d.ds]; return `<td class="lvc ${v ? "c-" + v : ""}">${v ? AV[v] : ""}</td>`; }).join("")}</tr>`;
  }).join("");
  return `<div class="grid2">
    <div class="card"><h3>畫休設定 ${open ? '<span class="okpill">開放中</span>' : '<span class="todo">未開放</span>'}</h3>
      <div class="row"><label>畫休月份<br><input type="month" data-ch="lvYm" value="${ym}"></label>
        <label>截止日<br><input type="date" id="lvDl" value="${c?.ym === ym && c.deadline ? isoOf(c.deadline) : ""}"></label>
        <label>每人最多休幾天<br><input type="number" id="lvMax" min="0" style="width:80px" value="${c?.ym === ym && c.maxOff ? c.maxOff : ""}" placeholder="不限"></label></div>
      <label class="small muted" style="display:block;margin-top:8px">給員工的說明（選填）</label>
      <input type="text" id="lvMsg" style="width:100%" value="${esc(c?.ym === ym ? c.note || "" : "")}">
      <div class="row" style="margin-top:12px"><button class="btn primary" data-act="lvOpen">${open ? "更新設定" : "開放畫休"}</button>${open ? '<button class="btn danger" data-act="lvClose">關閉畫休</button>' : ""}</div>
      <p class="muted small">開放時會把整個區域「啟用」的人員名單給員工選。員工送出後，班表和自動排班會直接照畫休排，不用另外匯入。</p></div>
    <div class="card"><h3>給員工的畫休網址</h3>
      <div class="row"><input type="text" readonly id="lvLink" style="flex:1;min-width:0" value="${esc(leaveLink())}"><button class="btn" data-act="lvCopy">複製</button></div>
      <p class="muted small">傳到群組就可以，員工不用登入。</p>
      <div class="kpis" style="margin-top:12px"><div class="kpi"><div class="label">${esc(hubBy(S.hub)?.name)} 已送出</div><div class="value good">${done.length}<span class="muted" style="font-size:14px"> / ${list.length}</span></div></div>
        <div class="kpi"><div class="label">未送出</div><div class="value ${todo.length ? "bad" : "good"}">${todo.length}</div></div></div>
      ${todo.length ? `<div class="small muted" style="margin-top:6px">未送出：${todo.map(e => esc(e.name)).join("、")}</div>` : ""}</div></div>
    <div class="legend">${Object.entries(AVL).map(([k, v]) => `<span><i class="c-${k}"></i>${v.replace("畫休：", "")}</span>`).join("")}</div>
    <div class="scroll"><table class="lvt"><thead><tr><th class="sticky">姓名</th><th>送出時間</th>${days.map(d => `<th class="${d.we ? "we" : ""}">${d.d}<br>${d.wd}</th>`).join("")}</tr></thead>
      <tbody>${subs === undefined ? `<tr><td class="sticky" colspan="${days.length + 2}" style="padding:20px">載入中…</td></tr>` : rows}</tbody></table></div>`;
}
function watchMonthsFor(ym) {
  if (!S.leaveSubs[ym] && isAdmin()) S.leaveSubs[ym] = S.store.watchList(P("leave"), "ym", "==", ym, l => { S.leaves[ym] = Object.fromEntries(l.map(x => [x.eid, x])); render(); });
}
async function leaveSet(open) {
  const ym = S.leaveYm, dl = ($("#lvDl")?.value || "").replace(/-/g, ""), max = parseInt($("#lvMax")?.value, 10) || 0, note = ($("#lvMsg")?.value || "").trim();
  const roster = emps().filter(e => e.active !== false).map(e => ({ id: e.id, name: e.name, group: hubBy(e.hub)?.name || "其他" }));
  try { await S.store.set(P("cfg", "leave"), { ym, deadline: dl, maxOff: max, note, roster, open, region: S.reg?.name || "", updatedAt: new Date().toISOString() }); toast(open ? "已開放畫休，把網址傳給員工吧" : "已關閉畫休"); }
  catch (e) { toast("儲存失敗：" + e.message); }
}

/* ---------- 設定 ---------- */
function settingsHtml() {
  const r = rules(), owner = isOwner();
  const hubRows = hubs().map(h => `<tr><td><input type="text" value="${esc(h.name)}" data-ch="hName" data-id="${h.id}" style="width:140px"></td>
    <td class="muted">${storesOf(h.id).length} 家門市・${empsOf(h.id).filter(e => e.active !== false).length} 人</td>
    <td><button class="btn small danger" data-act="hDel" data-id="${h.id}">刪除</button></td></tr>`).join("");
  const num = (k, label, hint) => `<label class="rule"><span>${label}</span><input type="number" min="0" step="any" data-ch="rule" data-k="${k}" value="${r[k] || ""}" placeholder="不限" style="width:80px"><small class="muted">${hint}</small></label>`;
  return `<div class="grid2"><div>
    <div class="card"><h3>母店</h3>
      <div class="row" style="margin-bottom:8px"><input type="text" id="newHub" placeholder="母店名稱" style="width:160px"><button class="btn primary" data-act="addHub">新增母店</button></div>
      <table class="list">${hubRows || `<tr><td class="muted">還沒有母店</td></tr>`}</table>
      <p class="muted small">母店底下的衛星門市請到「門市」分頁新增。</p></div>
    <div class="card"><h3>自動排班條件</h3>
      <div class="rules">
        ${num("maxDays", "每人每週最多上幾天", "人員那邊可以個別設定")}
        ${num("maxConsec", "最多連續上幾天", "")}
        ${num("maxStores", "每人每班最多負責幾家店", "")}
        ${num("capAm", "早班每人工作量上限", "門市工作量加總不超過這個數")}
        ${num("capPm", "晚班每人工作量上限", "")}
        ${num("maxKm", "同一人負責的店最遠相距幾公里", "需要門市座標")}
      </div>
      <p class="muted small">沒填＝不限。工作量上限沒填時，會把當天的工作量平均分給可以上班的人。</p></div>
  </div><div>
    <div class="card"><h3>權限・${esc(S.reg?.name)}</h3>
      <p class="small">最高管理者：<b>${esc(S.store.owner)}</b>（看得到所有區域）</p>
      <label class="small">這個區域的主管（可編輯）Email，一行一個</label>
      <textarea id="admins">${esc((S.reg?.admins || []).join("\n"))}</textarea>
      <label class="small">檢視者（只能看）Email，一行一個</label>
      <textarea id="viewers">${esc((S.reg?.viewers || []).join("\n"))}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn primary" data-act="saveAccess">儲存權限</button></div>
      <p class="muted small">各區域的資料完全分開，主管只看得到自己被加入的區域。</p></div>
    ${owner ? `<div class="card"><h3>區域管理（最高管理者）</h3>
      <table class="list">${(S.regions || []).map(x => `<tr><td><input type="text" value="${esc(x.name)}" data-ch="rName" data-id="${x.id}" style="width:140px"></td><td class="muted small">${(x.admins || []).length} 位主管</td>
        <td>${x.id === S.rid ? '<span class="okpill">使用中</span>' : `<button class="btn small" data-act="rOpen" data-id="${x.id}">切換</button>`}</td></tr>`).join("")}</table>
      <div class="row" style="margin-top:8px"><input type="text" id="newRegion" placeholder="新區域名稱" style="width:160px"><button class="btn" data-act="addRegion">建立區域</button></div>
      <p class="muted small">建立後切換過去，在「權限」加入那一區主管的 Email。</p></div>` : ""}
    <div class="card"><h3>資料</h3>
      <div class="row"><button class="btn" data-act="backup">下載這個區域的備份</button><label class="btn">從備份還原<input type="file" data-ch="restore" accept=".json" hidden></label></div></div>
  </div></div>`;
}

/* ================= 事件 ================= */
const ACT = {
  login: () => S.store.signIn().catch(e => toast("登入失敗：" + e.message)),
  switchUser: async () => { await S.store.signOut(); S.store.signIn(); },
  addRegion: async () => {
    const name = ($("#newRegion")?.value || "").trim(); if (!name) return toast("請輸入區域名稱");
    const id = uid("r");
    try { await S.store.set(`regions/${id}`, { name, admins: [], viewers: [], createdAt: new Date().toISOString() }); S.rid = null; ls.set("zq2-rid", id); openRegionLater(id); toast("已建立區域「" + name + "」"); }
    catch (e) { toast("建立失敗：" + e.message); }
  },
  rOpen: el => { openRegion(el.dataset.id); render(); },
  ovShift: el => { S.ovShift = el.dataset.sh; render(); },
  ovMove: el => { S.ovStart = addDays(S.ovStart, +el.dataset.n); render(); },
  ovToday: () => { S.ovStart = mondayOf(todayDs()); render(); },
  month: el => { S.ym = shiftYm(S.ym, +el.dataset.n); render(); },
  assign: el => openAssign(el.dataset.store, el.dataset.ds, el.dataset.sh),
  editCell: el => openCellEditor(el.dataset.e, el.dataset.ds),
  exportX: () => exportExcel(),
  goSettings: (el, e) => { e.preventDefault(); setTab("settings"); },
  goStores: (el, e) => { e.preventDefault(); setTab("stores"); },
  autoRun: async () => {
    watchMonths();
    for (let i = 0; i < 50 && !monthsReady(neededMonths()); i++) await new Promise(r => setTimeout(r, 100));
    if (!monthsReady(neededMonths())) { toast("班表載入中，請稍等一下再按"); return; }
    S.plan = autoPlan(); render();
  },
  autoCancel: () => { S.plan = null; render(); },
  autoSave: () => autoSave(),
  addHub: () => {
    const name = ($("#newHub")?.value || "").trim(); if (!name) return toast("請輸入母店名稱");
    if (hubs().some(h => h.name === name)) return toast("已經有同名的母店");
    const id = uid("h"); S.hub = id; ls.set("zq2-hub-" + S.rid, id);
    saveMaster({ hubs: [...hubs(), { id, name }] }); toast("已新增母店「" + name + "」");
  },
  hDel: el => {
    const h = hubBy(el.dataset.id), n = storesOf(h.id).length, m = empsOf(h.id).length;
    if (!confirm(`刪除母店「${h.name}」？${n ? `\n底下 ${n} 家門市也會一起刪除。` : ""}${m ? `\n${m} 位人員會變成「未分母店」。` : ""}`)) return;
    saveMaster({ hubs: hubs().filter(x => x.id !== h.id), stores: stores().filter(s => s.hub !== h.id) });
    if (m) saveEmps(emps().map(e => e.hub === h.id ? { ...e, hub: "" } : e));
  },
  addStore: () => {
    const name = ($("#newStore")?.value || "").trim(), addr = ($("#newStoreAddr")?.value || "").trim();
    if (!name) return toast("請輸入門市名稱");
    if (stores().some(s => s.name === name)) return toast("已經有同名的門市");
    saveMaster({ stores: [...stores(), { id: uid("s"), name, addr, hub: S.hub }] });
  },
  sDel: el => { const s = storeBy(el.dataset.id); if (confirm(`刪除門市「${s.name}」？`)) saveMaster({ stores: stores().filter(x => x.id !== s.id) }); },
  sMove: el => {
    const l = [...stores()], i = l.findIndex(s => s.id === el.dataset.id), dir = +el.dataset.n;
    let j = i + dir; while (j >= 0 && j < l.length && l[j].hub !== l[i].hub) j += dir;
    if (j < 0 || j >= l.length) return; [l[i], l[j]] = [l[j], l[i]]; saveMaster({ stores: l });
  },
  storePaste: () => openStorePaste(),
  geocode: () => geocodeAll(),
  addEmp: () => {
    const name = ($("#newEmp")?.value || "").trim(), code = ($("#newEmpCode")?.value || "").trim().toUpperCase();
    if (!name) return toast("請輸入姓名");
    saveEmps([...emps(), { id: uid("e"), name, code, hub: S.hub, shift: "any", active: true }]); toast("已新增 " + name);
  },
  eDel: el => { const e = empBy(el.dataset.id); if (confirm(`刪除「${e.name}」？只是離職的話，建議取消「啟用」就好。`)) saveEmps(emps().filter(x => x.id !== e.id)); },
  eStores: el => openEmpStores(el.dataset.id),
  apolloHelp: () => openApolloHelp(),
  empPaste: () => openEmpPaste(),
  lvOpen: () => leaveSet(true),
  lvClose: () => leaveSet(false),
  lvCopy: () => { const i = $("#lvLink"); i.select(); navigator.clipboard?.writeText(i.value).then(() => toast("已複製網址"), () => toast("請手動複製")); },
  saveAccess: async () => {
    const list = id => [...new Set(($(id).value || "").split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(x => x.includes("@")))];
    try { await S.store.set(`regions/${S.rid}`, { admins: list("#admins"), viewers: list("#viewers") }, true); toast("已儲存權限"); }
    catch (e) { toast("儲存失敗：" + e.message); }
  },
  backup: () => backup(),
};
const CH = {
  onlyMiss: t => { S.onlyMiss = t.checked; render(); },
  showAll: t => { S.showAllEmps = t.checked; render(); },
  autoStart: t => { if (t.value) { S.autoStart = t.value.replace(/-/g, ""); S.plan = null; watchMonths(); render(); } },
  autoDays: t => { S.autoDays = +t.value; S.plan = null; watchMonths(); render(); },
  autoKeep: t => { S.autoKeep = t.checked; S.plan = null; render(); },
  hName: t => { const nm = t.value.trim(); if (!nm) return render(); saveMaster({ hubs: hubs().map(h => h.id === t.dataset.id ? { ...h, name: nm } : h) }); },
  rule: t => saveMaster({ rules: { ...rules(), [t.dataset.k]: t.value === "" ? 0 : +t.value } }),
  rName: t => { const nm = t.value.trim(); if (nm) S.store.set(`regions/${t.dataset.id}`, { name: nm }, true); },
  sName: t => { const nm = t.value.trim(); if (!nm || stores().some(s => s.name === nm && s.id !== t.dataset.id)) { toast("名稱空白或重複"); return render(); } patchStore(t.dataset.id, { name: nm }); },
  sAddr: t => patchStore(t.dataset.id, { addr: t.value.trim() }),
  sXY: t => { const xy = parseXY(t.value); if (t.value.trim() && !xy) { toast("看不懂這個座標，請貼「緯度,經度」或 Google 地圖網址"); return; } patchStore(t.dataset.id, xy || { lat: null, lng: null }); },
  sNeedAm: t => patchStore(t.dataset.id, { needAm: t.checked }),
  sNeedPm: t => patchStore(t.dataset.id, { needPm: t.checked }),
  sLoadAm: t => patchStore(t.dataset.id, { loadAm: t.value === "" ? null : +t.value }),
  sLoadPm: t => patchStore(t.dataset.id, { loadPm: t.value === "" ? null : +t.value }),
  sHub: t => patchStore(t.dataset.id, { hub: t.value }),
  eName: t => { const nm = t.value.trim(); if (!nm) return render(); patchEmp(t.dataset.id, { name: nm }); },
  eCode: t => patchEmp(t.dataset.id, { code: t.value.trim().toUpperCase() }),
  eHub: t => patchEmp(t.dataset.id, { hub: t.value }),
  eShift: t => patchEmp(t.dataset.id, { shift: t.value }),
  eMax: t => patchEmp(t.dataset.id, { maxDays: t.value === "" ? null : +t.value }),
  eAct: t => patchEmp(t.dataset.id, { active: t.checked }),
  lvYm: t => { if (t.value) { S.leaveYm = t.value; render(); } },
  restore: t => { const f = t.files[0]; t.value = ""; if (f) restore(f); },
};
function onClick(e) {
  const el = e.target.closest("[data-act]");
  if (el && ACT[el.dataset.act]) ACT[el.dataset.act](el, e);
}
function onChange(e) { const t = e.target; if (t.dataset.ch && CH[t.dataset.ch]) CH[t.dataset.ch](t); }
function onInput() {}
function openRegionLater(id) { S.pendingRid = id; const t = setInterval(() => { if (S.regions?.some(r => r.id === id)) { clearInterval(t); openRegion(id); render(); } }, 200); setTimeout(() => clearInterval(t), 8000); }

/* ================= 存檔 ================= */
async function saveMaster(patch) {
  const m = { hubs: hubs(), stores: stores(), rules: rules(), ...patch };
  try { await S.store.set(P("cfg", "master"), m); } catch (e) { toast("儲存失敗：" + e.message); }
}
const patchStore = (id, patch) => saveMaster({ stores: stores().map(s => s.id === id ? { ...s, ...patch } : s) });
async function saveEmps(list) { try { await S.store.set(P("cfg", "employees"), { list }); } catch (e) { toast("儲存失敗：" + e.message); } }
const patchEmp = (id, patch) => saveEmps(emps().map(e => e.id === id ? { ...e, ...patch } : e));
async function writeCell(ds, eid, v) {
  try { await S.store.setCells(P("months", ymOf(ds)), { [ds + "_" + eid]: v }); return true; }
  catch (e) { toast("儲存失敗：" + (e.code === "permission-denied" ? "沒有編輯權限" : e.message)); return false; }
}
function parseXY(v) {
  const t = String(v || "").trim(); if (!t) return null;
  const m = t.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || t.match(/[?&](?:q|query|ll)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/) || t.match(/(-?\d{1,3}\.\d+)\s*[,，\s]\s*(-?\d{1,3}\.\d+)/);
  if (!m) return null;
  const lat = +m[1], lng = +m[2];
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

/* ================= 對話框 ================= */
function openModal(h, cls) {
  $("#modalRoot").innerHTML = `<div class="modal-bg"><div class="modal ${cls || ""}">${h}</div></div>`;
  const bg = $("#modalRoot .modal-bg");
  bg.addEventListener("mousedown", e => { if (e.target === bg) closeModal(); });
  return $("#modalRoot .modal");
}
function closeModal() { $("#modalRoot").innerHTML = ""; }
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2600); }

// 編輯某人某天
function openCellEditor(eid, ds) {
  const e = empBy(eid), c = cell(ds, eid) || {}, av = avOf(ds, eid);
  let s = c.s || "", sel = new Set(c.st || []);
  const draw = () => {
    const own = storesOf(e.hub || S.hub), other = stores().filter(x => !own.includes(x));
    const cov = s === "am" || s === "pm" ? coverage(ds, s) : {};
    const btn = x => { const by = (cov[x.id] || []).filter(p => p.id !== eid); return `<button class="pbtn ${sel.has(x.id) ? "on" : ""} ${needs(x, s) && !by.length && !sel.has(x.id) ? "need" : ""}" data-st="${x.id}">${esc(x.name)}${by.length ? `<small>${esc(by.map(p => p.name).join("、"))}</small>` : needs(x, s) ? "<small>沒人</small>" : ""}</button>`; };
    m.innerHTML = `<h2>${esc(e.name)}・${dLabel(ds)}</h2>
      ${av ? `<div class="avline">${AVL[av]}</div>` : ""}
      <div class="seg" style="margin:8px 0">${[["", "清空"], ["off", "休"], ["am", "早班"], ["pm", "晚班"]].map(([k, v]) => `<button class="${s === k ? "on" : ""}" data-s="${k}">${v}</button>`).join("")}</div>
      ${s === "am" || s === "pm" ? `<div class="sub">選負責的門市（紅框＝這班還沒人負責）</div><div class="picker">${own.map(btn).join("")}</div>
        ${other.length ? `<details style="margin-top:8px"><summary class="small muted" style="cursor:pointer">其他母店的門市（支援）</summary><div class="picker" style="margin-top:6px">${other.map(btn).join("")}</div></details>` : ""}
        <input type="text" id="ceNote" placeholder="備註（選填）" value="${esc(c.n || "")}" style="width:100%;margin-top:10px">` : ""}
      <div class="actions"><span class="spacer"></span><button class="btn" data-x="cancel">取消</button><button class="btn primary" data-x="save">儲存</button></div>`;
  };
  const m = openModal("", "");
  draw();
  m.onclick = async ev => {
    const b = ev.target.closest("button"); if (!b) return;
    if (b.dataset.s !== undefined) { s = b.dataset.s; draw(); return; }
    if (b.dataset.st) { sel.has(b.dataset.st) ? sel.delete(b.dataset.st) : sel.add(b.dataset.st); draw(); return; }
    if (b.dataset.x === "cancel") return closeModal();
    if (b.dataset.x === "save") {
      const note = (m.querySelector("#ceNote")?.value || "").trim();
      const v = !s ? null : s === "off" ? { s: "off", st: [] } : { s, st: [...sel], ...(note ? { n: note } : {}) };
      if (await writeCell(ds, eid, v)) closeModal();
    }
  };
}
// 指派某家店（從漏排總覽點 ✕）
function openAssign(storeId, ds, sh) {
  const st = storeBy(storeId), cov = coverage(ds, sh)[storeId] || [];
  const pool = emps().filter(e => e.active !== false);
  const rowsOf = list => list.map(e => {
    const c = cell(ds, e.id), av = avOf(ds, e.id), on = c?.s === sh, has = on && (c.st || []).includes(storeId);
    const busy = c && c.s && c.s !== sh && c.s !== "off";
    const info = has ? "已負責" : on ? `已排：${(c.st || []).map(sName).join("、")}` : c?.s === "off" ? "排休" : busy ? `已排${SHIFT[c.s]}` : "還沒排";
    return `<button class="pbtn ${has ? "on" : ""}" data-e="${e.id}" ${busy || has ? "disabled" : ""}>${esc(e.name)}${avTag(av)}<small>${esc(info)}</small></button>`;
  }).join("");
  const own = pool.filter(e => e.hub === st.hub && (!e.shift || e.shift === "any" || e.shift === sh)), other = pool.filter(e => !own.includes(e));
  const m = openModal(`<h2>${esc(st.name)}・${dLabel(ds)} ${SHIFT[sh]}</h2>
    <div class="sub">${cov.length ? "目前負責：" + cov.map(e => esc(e.name)).join("、") : "目前沒有人負責，點一個人指派給他"}</div>
    <div class="picker">${rowsOf(own) || '<span class="muted small">這家母店沒有可以上這個班的人</span>'}</div>
    ${other.length ? `<details style="margin-top:8px"><summary class="small muted" style="cursor:pointer">其他人（支援）</summary><div class="picker" style="margin-top:6px">${rowsOf(other)}</div></details>` : ""}
    <div class="actions"><span class="spacer"></span><button class="btn" data-x="close">關閉</button></div>`);
  m.onclick = async ev => {
    const b = ev.target.closest("button"); if (!b || b.disabled) return;
    if (b.dataset.x) return closeModal();
    const eid = b.dataset.e; if (!eid) return;
    const c = cell(ds, eid);
    const v = c?.s === sh ? { ...c, st: [...new Set([...(c.st || []), storeId])] } : { s: sh, st: [storeId] };
    if (await writeCell(ds, eid, v)) { closeModal(); toast(`已指派 ${empBy(eid).name}`); }
  };
}
// 某人可以去哪些門市
function openEmpStores(eid) {
  const e = empBy(eid); const sel = new Set(e.stores || []);
  const draw = () => { m.innerHTML = `<h2>${esc(e.name)} 可以去的門市</h2><div class="sub">都不選＝主要門市底下每一家都可以。</div>
    ${hubs().map(h => storesOf(h.id).length ? `<div class="pgroup">${esc(h.name)}</div><div class="picker">${storesOf(h.id).map(s => `<button class="pbtn ${sel.has(s.id) ? "on" : ""}" data-st="${s.id}">${esc(s.name)}</button>`).join("")}</div>` : "").join("")}
    <div class="actions"><button class="btn" data-x="clear">全部取消（不限）</button><span class="spacer"></span><button class="btn" data-x="cancel">取消</button><button class="btn primary" data-x="save">儲存</button></div>`; };
  const m = openModal(""); draw();
  m.onclick = ev => {
    const b = ev.target.closest("button"); if (!b) return;
    if (b.dataset.st) { sel.has(b.dataset.st) ? sel.delete(b.dataset.st) : sel.add(b.dataset.st); draw(); return; }
    if (b.dataset.x === "clear") { sel.clear(); draw(); return; }
    if (b.dataset.x === "cancel") return closeModal();
    if (b.dataset.x === "save") { patchEmp(eid, { stores: [...sel] }); closeModal(); }
  };
}
// 批次貼上門市：門市名稱、地址、早班工作量、晚班工作量（Excel 直接複製）
function openStorePaste() {
  const m = openModal(`<h2>批次貼上門市・${esc(hubBy(S.hub)?.name)}</h2>
    <div class="sub">從 Excel 複製貼上，一行一家。欄位：<b>門市名稱</b>、<b>地址</b>、<b>早班工作量</b>、<b>晚班工作量</b>（後面幾欄可以不填）。第一行是標題也沒關係。<br>同名的門市會更新地址和工作量。</div>
    <textarea id="spText" style="min-height:180px" placeholder="福壽\t新北市新莊區福壽街1號\t30\t20"></textarea>
    <div id="spPrev" class="small muted" style="margin-top:6px"></div>
    <div class="actions"><button class="btn" data-x="check">試算看看</button><span class="spacer"></span><button class="btn" data-x="cancel">取消</button><button class="btn primary" data-x="go">套用</button></div>`);
  const parse = () => {
    const lines = m.querySelector("#spText").value.split("\n").map(l => l.split(/\t|,|，/).map(x => x.trim())).filter(c => c[0]);
    let col = { name: 0, addr: 1, am: 2, pm: 3 };
    if (lines[0] && lines[0].some(c => /門市|店名|名稱/.test(c))) {
      const h = lines.shift(), f = re => h.findIndex(c => re.test(c));
      col = { name: f(/門市|店名|名稱/), addr: f(/地址/), am: f(/早/), pm: f(/晚/) };
    }
    return lines.map(c => ({ name: c[col.name] || "", addr: col.addr >= 0 ? c[col.addr] || "" : "", loadAm: col.am >= 0 && c[col.am] !== "" && c[col.am] != null ? +c[col.am] : null, loadPm: col.pm >= 0 && c[col.pm] !== "" && c[col.pm] != null ? +c[col.pm] : null })).filter(r => r.name);
  };
  const plan = rows => { const upd = rows.filter(r => stores().some(s => s.name === r.name)); return { upd, add: rows.filter(r => !upd.includes(r)) }; };
  m.onclick = async ev => {
    const b = ev.target.closest("button"); if (!b) return;
    const rows = parse(), p = plan(rows);
    if (b.dataset.x === "check") { m.querySelector("#spPrev").innerHTML = `讀到 ${rows.length} 家：新增 ${p.add.length}、更新 ${p.upd.length}${p.add.length ? "<br>新增：" + p.add.map(r => esc(r.name)).join("、") : ""}`; return; }
    if (b.dataset.x === "cancel") return closeModal();
    if (b.dataset.x === "go") {
      if (!rows.length) return toast("沒有讀到門市");
      const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== "" && !Number.isNaN(v)));
      const list = stores().map(s => { const r = p.upd.find(x => x.name === s.name); return r ? { ...s, ...clean({ addr: r.addr, loadAm: r.loadAm, loadPm: r.loadPm }) } : s; });
      for (const r of p.add) list.push({ id: uid("s"), hub: S.hub, ...clean(r) });
      await saveMaster({ stores: list }); closeModal(); toast(`已新增 ${p.add.length} 家、更新 ${p.upd.length} 家`);
    }
  };
}
// 依地址找座標（OpenStreetMap，免金鑰；台灣地址不一定找得到）
async function geocodeAll() {
  const list = storesOf(S.hub).filter(s => !hasXY(s) && s.addr);
  if (!list.length) return;
  let ok = 0, fail = [];
  for (const [i, s] of list.entries()) {
    toast(`找座標中… ${i + 1}/${list.length}`);
    const tries = [s.addr, s.addr.replace(/(\d+)號.*$/, "$1號"), s.addr.replace(/[\d\-之]+號.*$/, "")];
    let hit = null;
    for (const q of [...new Set(tries)]) {
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=tw&accept-language=zh-TW&q=${encodeURIComponent(q)}`);
        const j = await r.json(); if (j[0]) { hit = { lat: +j[0].lat, lng: +j[0].lon }; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 1100));
    }
    if (hit) { ok++; await patchStore(s.id, hit); } else fail.push(s.name);
    await new Promise(r => setTimeout(r, 1100));
  }
  openModal(`<h2>找座標完成</h2><div class="sub">找到 ${ok} 家${fail.length ? `，<b>${fail.length} 家找不到</b>：${fail.map(esc).join("、")}` : ""}</div>
    ${fail.length ? `<p class="small">找不到的請在 Google 地圖搜尋門市 → 在位置上按右鍵 → 點第一行的「緯度, 經度」就會複製 → 貼到座標欄。</p>` : ""}
    <div class="actions"><span class="spacer"></span><button class="btn primary" onclick="document.getElementById('modalRoot').innerHTML=''">知道了</button></div>`);
}

/* ================= 匯出／備份 ================= */
async function loadXLSX() {
  if (!window.XLSX) {
    toast("載入 Excel 元件中…");
    await new Promise((ok, bad) => { const s = document.createElement("script"); s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"; s.onload = ok; s.onerror = bad; document.head.appendChild(s); });
  }
  return window.XLSX;
}
async function exportExcel() {
  const X = await loadXLSX(), wb = X.utils.book_new(), days = monthDays(S.ym), hubN = hubBy(S.hub)?.name || "";
  const txt = c => !c ? "" : c.s === "off" ? "休" : `${SH1[c.s]} ${(c.st || []).map(sName).join("、")}${c.n ? `（${c.n}）` : ""}`;
  const rows = [[hubN, ...days.map(d => `${d.d}(${d.wd})`)]];
  for (const e of rowsFor(days, cell)) rows.push([e.name, ...days.map(d => txt(cell(d.ds, e.id)))]);
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(rows), "班表");
  const miss = [["", ...days.map(d => `${d.d}(${d.wd})`)]];
  for (const sh of ["am", "pm"]) miss.push([`${SHIFT[sh]}漏排`, ...days.map(d => missing(d.ds, sh, S.hub).map(s => s.name).join(" ") || "✓")]);
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(miss), "漏排");
  X.writeFile(wb, `排班_${hubN}_${S.ym}.xlsx`);
}
async function backup() {
  toast("整理備份中…");
  const months = {};
  for (let i = -12; i <= 6; i++) { const ym = shiftYm(S.ym, i); const d = await S.store.get(P("months", ym)); if (d?.cells && Object.keys(d.cells).length) months[ym] = d.cells; }
  const data = { version: 2, region: S.reg?.name, exportedAt: new Date().toISOString(), master: S.master, employees: emps(), months };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
  a.download = `排班備份_${S.reg?.name || ""}_${todayDs()}.json`; a.click();
}
async function restore(f) {
  try {
    const d = JSON.parse(await f.text());
    if (d.version !== 2 || !d.master) throw new Error("這不是新版的備份檔");
    if (!confirm(`用備份還原「${S.reg?.name}」？（${d.master.stores?.length || 0} 家門市、${d.employees?.length || 0} 位人員、${Object.keys(d.months || {}).length} 個月班表）\n目前這個區域的資料會被覆蓋。`)) return;
    await S.store.set(P("cfg", "master"), d.master);
    await S.store.set(P("cfg", "employees"), { list: d.employees || [] });
    for (const [ym, cells] of Object.entries(d.months || {})) await S.store.set(P("months", ym), { cells });
    toast("已還原");
  } catch (e) { toast("還原失敗：" + e.message); }
}

/* ================= 人員名單解析（Apollo／貼上共用） ================= */
const NAME_RE = /^[一-鿿·．]{2,6}$/;
const CODE_RE = /\b(SPX?\d{3,}|[A-Z]{1,3}\d{4,})\b/i;
function rowFromCells(cells) {
  const r = { code: "", name: "", wage: "", unit: "" };
  for (const raw of cells) {
    const c = String(raw ?? "").trim(); if (!c) continue;
    if (CODE_RE.test(c) && !r.code && c.length <= 12) r.code = c.match(CODE_RE)[1].toUpperCase();
    else if (/時薪|月薪/.test(c)) r.wage = (c.match(/(假日)?(早班|晚班|跑點)?時薪|月薪/) || [c])[0];
    else if (/店|部|組|課|處/.test(c) && c.length > 2 && !r.unit && !NAME_RE.test(c.replace(/店$/, "店X"))) r.unit = c;
    else if (/^\d+$/.test(c) || /@/.test(c)) { /* 公司代碼、Email 略過 */ }
    else if (!r.name && NAME_RE.test(c)) r.name = c;
  }
  return r;
}
// 部門名稱含母店名（例：新莊公園 - 智取店 → 公園店）就放到那家母店
const hubFromDept = d => { const t = String(d || ""); return [...hubs()].sort((a, b) => b.name.length - a.name.length).find(h => { const k = h.name.replace(/[店組]$/, ""); return k.length >= 2 && t.includes(k); })?.id || ""; };
const shiftOfWage = w => /早/.test(w || "") ? "am" : /晚/.test(w || "") ? "pm" : "any";
function planRows(rows) {
  const add = [], upd = [], skip = [];
  for (const r of rows) {
    let e = r.code && emps().find(x => (x.code || "").toUpperCase() === r.code);
    if (!e && r.name) {
      const same = emps().filter(x => x.name === r.name);
      if (same.length === 1) e = same[0];
      else if (same.length > 1) { skip.push(`${r.name}（系統有 ${same.length} 個同名）`); continue; }
    }
    if (e) upd.push([e, r]); else if (r.name) add.push(r);
  }
  return { add, upd, skip };
}
async function applyRows(rows, hub, syncActive) {
  const { add, upd } = planRows(rows);
  let off = 0;
  const list = emps().map(e => {
    const hit = upd.find(([x]) => x.id === e.id);
    if (!hit) { if (syncActive && e.hub === hub && e.active !== false) { off++; return { ...e, active: false }; } return e; }
    const r = hit[1];
    return { ...e, ...(syncActive ? { active: true } : {}), code: r.code || e.code || "", wage: r.wage || e.wage || "", unit: r.unit || e.unit || "", hub: e.hub || hub };
  });
  for (const r of add) list.push({ id: uid("e"), name: r.name, code: r.code || "", wage: r.wage || "", unit: r.unit || "", hub: hubFromDept(r.unit) || hub, shift: shiftOfWage(r.wage), active: true });
  await saveEmps(list);
  closeModal(); toast(`已更新 ${upd.length} 人、新增 ${add.length} 人${off ? `、停用 ${off} 人` : ""}`);
}
function importModal(title, sub, rows) {
  const hubOpts = hubs().map(h => `<option value="${h.id}" ${h.id === S.hub ? "selected" : ""}>${esc(h.name)}</option>`).join("");
  const { add, upd, skip } = planRows(rows);
  const tag = r => { const u = upd.find(([, x]) => x === r); if (u) return `<span class="muted">已有（${esc(hubBy(u[0].hub)?.name || "未分母店")}）</span>`; const h = hubFromDept(r.unit); return `<span style="color:var(--ok)">新增${h ? "→" + esc(hubBy(h).name) : ""}</span>`; };
  const m = openModal(`<h2>${title}</h2><div class="sub">${sub}</div>
    <div class="scrollx" style="max-height:300px;overflow:auto"><table class="list"><tr><th>#</th><th>姓名</th><th>工號</th><th>部門</th><th>時薪類別</th><th></th></tr>
      ${rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${esc(r.code) || '<span class="muted">—</span>'}</td><td>${esc(r.unit)}</td><td>${esc(r.wage)}</td><td>${tag(r)}</td></tr>`).join("")}</table></div>
    <div class="row" style="margin-top:10px"><label>部門認不出母店的新人放到 <select id="imHub">${hubOpts}</select></label></div>
    <label class="small" style="display:block;margin-top:6px"><input type="checkbox" id="imSync"> 同步在職狀態：這家母店裡、名單上<b>沒有</b>的人設為停用</label>
    <div class="small muted" style="margin-top:8px">更新 ${upd.length} 人、新增 ${add.length} 人${skip.length ? `、<span style="color:var(--warn)">${skip.length} 筆同名要手動處理：${skip.map(esc).join("、")}</span>` : ""}。已經在系統裡的人只補工號和時薪類別，主要門市不會變。</div>
    <div class="actions"><span class="spacer"></span><button class="btn" data-x="cancel">取消</button><button class="btn primary" data-x="go">直接匯入</button></div>`);
  m.onclick = ev => {
    const b = ev.target.closest("button"); if (!b) return;
    if (b.dataset.x === "cancel") return closeModal();
    if (b.dataset.x === "go") {
      const hub = m.querySelector("#imHub").value, sync = m.querySelector("#imSync").checked;
      if (sync) { const keep = new Set(upd.map(([e]) => e.id)); const n = emps().filter(e => e.hub === hub && e.active !== false && !keep.has(e.id)).length; if (n && !confirm(`會把 ${n} 位不在名單上的人設為停用，確定嗎？`)) return; }
      applyRows(rows, hub, sync);
    }
  };
}
function openEmpPaste() {
  const m = openModal(`<h2>批次貼上名單</h2><div class="sub">從 Excel 複製貼上，一行一個人，欄位順序不拘（姓名、工號、部門、時薪類別）。</div>
    <textarea id="epText" style="min-height:160px" placeholder="王小明\tSP0102\t新莊中平店\t早班時薪"></textarea>
    <div class="actions"><span class="spacer"></span><button class="btn" data-x="cancel">取消</button><button class="btn primary" data-x="next">下一步</button></div>`);
  m.onclick = ev => {
    const b = ev.target.closest("button"); if (!b) return;
    if (b.dataset.x === "cancel") return closeModal();
    const txt = m.querySelector("#epText").value;
    let rows = txt.split("\n").map(l => rowFromCells(l.split(/\t|,|\s{2,}/))).filter(r => r.name);
    const cards = rowsFromApolloCards(txt); if (cards.length > rows.length) rows = cards;
    if (!rows.length) return toast("沒有讀到人員");
    importModal("確認匯入", `讀到 ${rows.length} 人`, rows);
  };
}

/* ================= Apollo「我的部屬」匯入 =================
   主管在自己的瀏覽器登入 Apollo、打開「我的部屬」，點書籤列上的「Apollo→排班」小書籤。
   小書籤把頁面上的名單（含頁面載入的人員資料）打包，開新分頁回到本網站（#apollo=…），
   網站顯示預覽，主管按「直接匯入」才寫入。帳密完全不經過本網站。 */
const siteBase = () => location.href.split("#")[0].split("?")[0].replace(/[^/]*$/, "");
function grabApollo() {
  const h = location.hash;
  if (h.startsWith("#apollo=")) {
    const raw = h.slice(8);
    try { sessionStorage.setItem("zq-apollo", raw); } catch {}
    S.apolloPending = raw;
    history.replaceState(null, "", location.pathname + location.search);
  } else { try { S.apolloPending = sessionStorage.getItem("zq-apollo") || null; } catch {} }
}
function runApolloPending() {
  const raw = S.apolloPending; if (!raw || !S.emps || !S.master) return;
  S.apolloPending = null;
  try { sessionStorage.removeItem("zq-apollo"); } catch {}
  let p;
  try { p = JSON.parse(decodeURIComponent(raw)); } catch { try { p = JSON.parse(raw); } catch { return toast("Apollo 資料讀取失敗，請再點一次小書籤"); } }
  if (S.tab !== "people") setTab("people");
  openApolloImport(p);
}
function apolloBookmarklet() {
  const site = siteBase();
  // 點一下：在 Apollo 頁面右上角出現小框，並開始記錄這個頁面「自己」載入的部屬名單（含工號）。
  // 只留下姓名、工號、部門、職稱、是否離職；按「送到排班網站」才會帶走。不讀任何登入資訊。
  const code = `(function(){var S=${JSON.stringify(site)};if(S.indexOf(location.host+'/')>=0){alert('請到 Apollo「我的部屬」頁面再點這個書籤。');return}
if(window.__zq){window.__zq.box.style.display='block';return}
var got={},Z=window.__zq={};
function take(t){try{var j=JSON.parse(t),d=j&&j.Data;if(!Array.isArray(d)||!d.length||d[0].EmployeeName===undefined)return;d.forEach(function(x){got[x.EmployeeNumber||x.EmployeeName]={name:x.EmployeeName||'',code:x.EmployeeNumber||'',dept:x.DeptName||'',title:x.JobTitle||'',leave:!!x.IsLeave}});upd()}catch(e){}}
var of=window.fetch;if(of)window.fetch=function(){return of.apply(this,arguments).then(function(r){try{r.clone().text().then(take)}catch(e){}return r})};
var os=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.send=function(){this.addEventListener('load',function(){try{if(!this.responseType||this.responseType==='text')take(this.responseText);else if(this.responseType==='json')take(JSON.stringify(this.response))}catch(e){}});return os.apply(this,arguments)};
var b=Z.box=document.createElement('div');b.style.cssText='position:fixed;top:12px;right:12px;z-index:2147483647;background:#fff;border:2px solid #2563eb;border-radius:12px;padding:14px 16px;width:300px;font:14px/1.6 sans-serif;color:#1f2937;box-shadow:0 8px 30px rgba(0,0,0,.25)';
b.innerHTML='<b style="font-size:15px">📥 匯入排班網站</b><div id="zqm" style="margin:6px 0 10px">請<b>勾一下（或取消）「含轄下」</b>，讓名單重新載入一次。</div><button id="zqg" disabled style="background:#2563eb;color:#fff;border:0;border-radius:8px;padding:6px 12px;opacity:.5">送到排班網站</button> <button id="zqt" style="border:1px solid #ccc;background:#fff;border-radius:8px;padding:6px 10px">只用畫面文字</button> <a href="#" id="zqx" style="float:right;color:#888">關閉</a>';
document.body.appendChild(b);
function upd(){var n=Object.keys(got).length;b.querySelector('#zqm').innerHTML='已讀到 <b>'+n+'</b> 人（含工號）。<br>名單如果要往下捲才會載入更多，捲到底再按送出。';var g=b.querySelector('#zqg');g.disabled=false;g.style.opacity=1}
function send(p){var w=window.open(S+'#apollo='+encodeURIComponent(JSON.stringify(p)),'_blank');if(!w)alert('瀏覽器擋住了新分頁，請允許彈出視窗後再按一次。')}
b.querySelector('#zqg').onclick=function(){var l=[];for(var k in got)l.push(got[k]);send({v:3,from:location.host,people:l})};
b.querySelector('#zqt').onclick=function(){send({v:3,from:location.host,text:(document.body.innerText||'').slice(0,90000)})};
b.querySelector('#zqx').onclick=function(e){e.preventDefault();b.style.display='none'};
})()`.replace(/\n/g, "");
  return "javascript:" + encodeURIComponent(code);
}
function openApolloHelp() {
  const m = openModal(`<h2>從 Apollo「我的部屬」匯入人員</h2>
    <div class="sub">第一次要先把小書籤放到書籤列（只要做一次），之後每次更新名單只要兩步。</div>
    <p><b>第一次設定：</b>把下面這顆按鈕<b>用滑鼠拖到瀏覽器上方的書籤列</b>。<br><span class="small muted">看不到書籤列：Mac 按 ⌘+Shift+B、Windows 按 Ctrl+Shift+B。<b>以前拖過的舊書籤請刪掉、重拖這一顆</b>（新版才讀得到工號）。</span></p>
    <p style="text-align:center;margin:14px 0"><a class="btn primary" id="apolloBm" href="${esc(apolloBookmarklet())}" draggable="true">📥 Apollo→排班</a></p>
    <ol class="small" style="padding-left:20px;line-height:1.8">
      <li>登入 Apollo，打開「我的部屬」。</li>
      <li>在 <b>Apollo 那一頁</b>點書籤列的「📥 Apollo→排班」，右上角會出現小框。</li>
      <li>照小框說的<b>勾一下（或取消）「含轄下」</b>，小框顯示「已讀到 N 人」後按「送到排班網站」→ 預覽 → 「直接匯入」。</li></ol>
    <p class="small muted">小書籤只記下名單上的姓名、工號、部門、職稱，不會讀取或傳送你的 Apollo 帳號密碼。</p>
    <div class="actions"><span class="spacer"></span><button class="btn" data-x="close">關閉</button></div>`);
  m.querySelector("#apolloBm").onclick = e => { e.preventDefault(); toast("請把這顆按鈕拖到書籤列，不是在這裡點"); };
  m.querySelector("[data-x=close]").onclick = closeModal;
}
function rowsFromTables(tables) {
  const ts = [];
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    if (t.length === 1 && /姓名|工號|員工/.test(t[0].join(" ")) && tables[i + 1]) { ts.push([t[0], ...tables[i + 1]]); i++; } else ts.push(t);
  }
  let best = [];
  for (const t of ts) {
    const hi = t.findIndex(r => r.some(c => /姓名/.test(c))), H = hi >= 0 ? t[hi] : [];
    const cName = H.findIndex(c => /^\s*(員工)?姓名\s*$/.test(c)), cCode = H.findIndex(c => /工號|員工編號/.test(c)), cUnit = H.findIndex(c => /部門|單位|組織/.test(c));
    const rows = [];
    for (const r of t.slice(hi + 1)) {
      const x = rowFromCells(r.flatMap(c => String(c).split(/\n|\s*[／/]\s*|\s{2,}/)));
      if (cName >= 0 && r[cName]) x.name = r[cName].split("\n")[0].trim();
      if (cCode >= 0 && r[cCode]) x.code = r[cCode].trim().toUpperCase();
      if (cUnit >= 0 && r[cUnit]) x.unit = r[cUnit].split("\n")[0].trim();
      if (x.name && NAME_RE.test(x.name)) rows.push(x);
    }
    if (rows.length > best.length) best = rows;
  }
  return best;
}
// 卡片：姓名、部門（新莊中平店）、職稱「門市人員(早班時薪)」、分機、Email
function rowsFromApolloCards(text) {
  const L = String(text || "").split("\n").map(x => x.trim()).filter(Boolean);
  const out = [], seen = new Set();
  L.forEach((l, i) => {
    if (!/(時薪|月薪|門市人員|專員|主任|店長|督導)/.test(l) || l.length > 30) return;
    let name = "", unit = "", code = "";
    for (let k = i - 1; k >= Math.max(0, i - 4); k--) {
      const t = L[k], cm = t.match(CODE_RE);
      if (cm && !code) { const rest = t.replace(cm[0], "").replace(/[()（）\s\-]/g, ""); code = cm[1].toUpperCase(); if (NAME_RE.test(rest)) { name = rest; unit = L.slice(k + 1, i).join(" "); break; } continue; }
      if (NAME_RE.test(t) && !/(店|部|組|課|處|區)$/.test(t)) { name = t; unit = L.slice(k + 1, i).filter(x => !CODE_RE.test(x)).join(" "); break; }
    }
    if (!name || seen.has(name + unit)) return;
    seen.add(name + unit);
    if (!code) { const after = L.slice(i + 1, i + 4).join(" ").match(CODE_RE); if (after) code = after[1].toUpperCase(); }
    out.push({ code, name, wage: (l.match(/(假日)?(早班|晚班|跑點)?時薪|月薪/) || [""])[0], unit });
  });
  return out;
}
function openApolloImport(p) {
  if (p.from === location.host) return openModal(`<h2>要在 Apollo 頁面點小書籤</h2><div class="sub">剛剛是在排班網站上點的，請切到 Apollo「我的部屬」那一頁再點。</div><div class="actions"><span class="spacer"></span><button class="btn primary" onclick="document.getElementById('modalRoot').innerHTML=''">知道了</button></div>`);
  let rows = [], left = [];
  if (Array.isArray(p.people)) {
    for (const x of p.people) {
      const r = { name: String(x.name || "").trim(), code: String(x.code || "").trim().toUpperCase(), unit: String(x.dept || "").trim(), wage: (String(x.title || "").match(/(假日)?(早班|晚班|跑點)?時薪|月薪/) || [""])[0] };
      if (!r.name) continue;
      if (x.leave) left.push(r.name); else rows.push(r);
    }
  } else {
    rows = rowsFromTables(p.tables || []);
    const cards = rowsFromApolloCards(p.text); if (cards.length > rows.length) rows = cards;
  }
  // 頁面屬性裡的「工號 姓名」配對，補到沒有工號的人身上
  for (const a of p.attrs || []) { const cm = a.match(CODE_RE); if (!cm) continue; const nm = a.replace(cm[0], "").replace(/[()（）\s\-]/g, ""); const r = rows.find(x => x.name === nm && !x.code); if (r) r.code = cm[1].toUpperCase(); }
  if (!rows.length) return openModal(`<h2>Apollo 名單讀不到</h2><div class="sub">小書籤有執行，但畫面上找不到人員名單。請確認「我的部屬」的卡片已經顯示出來再點一次；還是不行的話，把畫面截圖給 Claude。</div><div class="actions"><span class="spacer"></span><button class="btn primary" onclick="document.getElementById('modalRoot').innerHTML=''">知道了</button></div>`);
  const noCode = rows.filter(r => !r.code).length;
  importModal("從 Apollo 匯入人員", `讀到 ${rows.length} 人${noCode ? `（${noCode} 人沒有工號，匯入後可以在人員表手動補）` : "，都有工號"}。${left.length ? `<br>另有 ${left.length} 人在 Apollo 標示為離職／留停，沒有匯入：${left.map(esc).join("、")}` : ""}`, rows);
}
