import { createStore } from "./store.js?v=5";

/* =====================================================================
   智取店排班系統 v2
   - 各區域資料分開：regions/{rid}/cfg/{master|employees|leave}、months/{ym}、leave/{ym_eid}
   - 主要門市、門市都由使用者自己輸入；頂部選單一次選一間主要門市
   - 班表格子：cells["yyyymmdd_員工id"] = { s: "am"|"pm"|"off", st: [門市id…], n: "備註" }
   ===================================================================== */
const APP_VER = "v59";
const SHIFT = { am: "早班", pm: "晚班" };
const SH1 = { am: "早", pm: "晚", any: "早晚" };
const WD = ["日", "一", "二", "三", "四", "五", "六"];
const DEFAULT_RULES = { capAm: 0, capPm: 0, maxStores: 2, maxKm: 0, maxDays: 5, maxConsec: 6 };
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
// 每人每班最多 2 家店（沒填或填 0 也當 2）
const rules = () => { const r = { ...DEFAULT_RULES, ...(M().rules || {}) }; if (!(+r.maxStores > 0)) r.maxStores = 2; return r; };
// 每週上班天數上限／連續上班天數上限：沒填或填 0＝不限（每週最多 7 天、連續不限）
const weekCap = e => { const v = +e?.maxDays > 0 ? +e.maxDays : +rules().maxDays > 0 ? +rules().maxDays : 7; return Math.min(7, v); };
const consecCap = () => +rules().maxConsec > 0 ? +rules().maxConsec : Infinity;
const hubs = () => M().hubs || [];
// 「全部門市」：主要門市選單選 ALL 時，門市／人員／路線都看全部
const ALL = "*";
const hubBy = id => id === ALL ? { id: ALL, name: "全部門市" } : hubs().find(h => h.id === id);
const stores = () => M().stores || [];
const storeBy = id => stores().find(s => s.id === id);
const storesOf = hub => hub === ALL ? stores() : stores().filter(s => s.hub === hub);
const sName = id => storeBy(id)?.name || "（已刪除）";
const emps = () => S.emps || [];
const empBy = id => emps().find(e => e.id === id);
// 一個人可以有多間主要門市（舊資料是單一 hub 字串）
const eHubs = e => Array.isArray(e?.hubs) ? e.hubs.filter(h => h !== ALL && hubBy(h)) : e?.hub && e.hub !== ALL && hubBy(e.hub) ? [e.hub] : [];
const hubNames = e => eHubs(e).map(h => hubBy(h).name).join("、");
const empsOf = hub => hub === ALL ? emps().filter(e => eHubs(e).length) : emps().filter(e => eHubs(e).includes(hub));
const realHub = () => S.hub === ALL ? hubs()[0]?.id || null : S.hub;
// 可以去的門市：有勾「可支援門市」就照勾的；沒勾＝自己主要門市底下全部
const allowed = e => (e.stores || []).length ? e.stores.filter(id => storeBy(id)) : eHubs(e).flatMap(h => storesOf(h).map(s => s.id));
const canGo = (e, id) => allowed(e).includes(id);
const cell = (ds, eid) => (S.months[ymOf(ds)] || {})[ds + "_" + eid] || null;
// 同一天早晚雙班：第二個班放在 c.x（{ s, st, sp?, n? }）；onSh 取某一班的那一段
const xOf = c => c && c.x && (c.x.s === "am" || c.x.s === "pm") && c.s !== "off" ? c.x : null;
const onSh = (c, sh) => !c ? null : c.s === sh ? c : xOf(c)?.s === sh ? c.x : null;
const allSt = c => [...(c?.st || []), ...(xOf(c)?.st || [])];
// 每家店早晚都要排；只有標成「不排」的店（例：撤店）例外
const isOff = s => s.off === true || (s.needAm === false && s.needPm === false);
const needs = s => !isOff(s);
// 工作量看整天（舊資料可能分早晚）
const loadOf = s => +(s.load ?? s.loadAm ?? s.loadPm) || 1;
// 每班在店時數＝workload（每天）÷ 350 ÷ 2
const WL_RATE = 350;
const shHrs = s => { if (!s) return 0; const w = +(s.load ?? s.loadAm); return w > 0 ? w / WL_RATE / 2 : 0; };
// NDD：有 NDD 打包數就算有 NDD 寄件
const isNdd = s => !!s && (+s.nddCnt > 0 || (s.nddCnt == null && !!s.ndd));
const fmtH = h => (Math.round(h * 100) / 100).toFixed(2);
const FLAGS = [["hd", "HD"], ["pick", "純取件"], ["ndd", "NDD寄件"], ["fbs", "FBS寄件"], ["rearr", "重新分配"], ["sup", "接受支援"]];
// 每人每班最多跑幾間（可在「4. 路線」改；早班預設 3、晚班預設 2）
const maxOf = sh => sh === "pm" ? (+rules().maxPm > 0 ? +rules().maxPm : 2) : (+rules().maxAm > 0 ? +rules().maxAm : 3);
// 接受支援的門市：工作量低的路線可以加一間去支援（沒設定過時，預設這幾家）
const DEFAULT_SUP = ["福壽", "昌盛", "中信", "公園", "福德", "化成", "頭前"];
const isSup = s => !!s && (s.sup === true || (s.sup === undefined && !stores().some(x => x.sup !== undefined) && DEFAULT_SUP.includes(s.name)));
// 路線在店時數低於這個數（小時）就加一間支援門市；0＝不加
const supBelow = () => rules().supBelow === undefined ? 2.5 : +rules().supBelow || 0;
/* ---------- 路線：master.routes["wd_am"|"wd_pm"] = [{ id, code, st:[門市id…（第一間先做）], n:人數 }]（不分平日／假日） ---------- */
const RSET = { wd_am: "早班", wd_pm: "晚班" };
const allRoutes = k => (M().routes || {})[k] || [];
const routeHub = rt => storeBy(rt.st?.[0])?.hub;
const routesOf = (k, hub) => hub === ALL ? allRoutes(k) : allRoutes(k).filter(rt => routeHub(rt) === hub || (!rt.st?.length && rt.hub === hub));
// 某天某班要用的路線（早班一套、晚班一套，不分平日假日）
const routesFor = (ds, sh, hub) => routesOf("wd_" + sh, hub);
const rtHrs = rt => (rt.st || []).reduce((n, id) => n + shHrs(storeBy(id)), 0);
const bans = () => M().ban || [];
// 路線檢查（只提醒，不擋）
function routeWarn(rt, sh) {
  const l = (rt.st || []).map(storeBy).filter(Boolean), w = [];
  if (l.length > maxOf(sh)) w.push(`${SHIFT[sh]}超過 ${maxOf(sh)} 間`);
  const ndd = l.filter(isNdd), hd = l.filter(s => s.hd);
  if (sh === "pm" && ndd.length > Math.max(1, +rt.n || 1)) w.push(`${ndd.length} 間有 NDD 寄件`);
  if (sh === "pm" && ndd.length && !isNdd(l[0]) && !l[0].hd) w.push("NDD 店要排第一間");
  if (hd.length > 1) w.push(`${hd.length} 間 HD 店`);
  if (hd.length && !l[0].hd && !(sh === "pm" && isNdd(l[0]))) w.push("HD 店要排第一間");
  if (sh === "pm" && hd.length && isNdd(l[0]) && !l[0].hd) w.push("HD 店排在第二間");
  for (const [a, b] of bans()) if (rt.st.includes(a) && rt.st.includes(b)) w.push(`${sName(a)}＋${sName(b)} 不排一起`);
  return w;
}
// 某天某班，每家店由誰負責（整個區域的人都算，跨店支援也算）
function coverage(ds, sh, src) {
  const cov = {};
  for (const e of emps()) {
    const c = src ? src(ds, e.id) : cell(ds, e.id);
    const p = onSh(c, sh);
    if (p && !p.tr) for (const st of p.st || []) (cov[st] ||= []).push(e);
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
// 自動更新：GitHub Pages 會快取網頁約 10 分鐘，打開時檢查 version.json，有新版就換網址重新載入（換網址才不會拿到快取）
(async () => {
  try {
    const j = await (await fetch("version.json?t=" + Date.now(), { cache: "no-store" })).json();
    const k = "zq-upd-" + j.v;
    if (j.v && j.v !== APP_VER && !sessionStorage.getItem(k)) {
      sessionStorage.setItem(k, "1");
      location.replace(location.pathname + "?u=" + j.v + location.hash);
    }
  } catch {}
})();
grabApollo();
init();
async function init() {
  const now = new Date();
  S.ym = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  S.ovStart = mondayOf(todayDs());
  S.autoStart = mondayOf(addDays(todayDs(), 7)); S.autoDays = 14;
  S.tab = ls.get("zq2-tab") || "home";
  S.rset = ls.get("zq2-rset") || "wd_am";
  S.dense = true;   // 班表只用精簡顯示
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
const TABS = [["home", "開始", 1], ["people", "1.人員", 1], ["support", "2.可支援門市", 1], ["stores", "3.門市", 1], ["routes", "4.路線", 1], ["leave", "5.畫休", 1], ["auto", "6.自動排班", 1], ["grid", "7.班表"], ["overview", "8.漏排總覽"], ["settings", "設定", 1]];
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
  if (!hubs().length && S.tab !== "settings") return html(admin ? firstHubHtml() : `<div class="card login"><h2>這個區域還沒有設定主要門市</h2><p class="muted">請主管先到「設定」新增主要門市。</p></div>`);
  const keep = keepScroll();
  const v = { home: homeHtml, overview: overviewHtml, grid: gridHtml, auto: autoHtml, people: peopleHtml, support: supportHtml, stores: storesHtml, routes: routesHtml, leave: leaveHtml, settings: settingsHtml }[S.tab] || overviewHtml;
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
  const hubSel = S.rid && hubs().length ? `<label class="hubpick">主要門市 <select id="hubSel">${hubs().length > 1 ? `<option value="${ALL}" ${S.hub === ALL ? "selected" : ""}>全部門市</option>` : ""}${hubs().map(h => `<option value="${h.id}" ${h.id === S.hub ? "selected" : ""}>${esc(h.name)}</option>`).join("")}</select></label>` : "";
  const user = !S.user ? "" : `<span class="role">${S.store.mode === "local" ? "本機試用" : isOwner() ? "最高管理者" : isAdmin() ? "主管" : "檢視"}</span>${S.store.mode === "local" ? "" : `<button class="btn small" id="logout" title="${esc(S.user.email)}">登出</button>`}`;
  box.innerHTML = `${regionSel}${hubSel}<span class="spacer"></span><span class="user-box">${user}<span class="muted small" title="網站版本">${APP_VER}</span></span>`;
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
  if (isOwner()) return `<div class="card login"><h2>建立第一個區域</h2><p class="muted">每個區域的主要門市、門市、人員、班表都分開，各區主管只看得到自己的區域。</p>
    <div class="row" style="justify-content:center"><input type="text" id="newRegion" placeholder="區域名稱，例如 新莊區" style="width:200px"><button class="btn primary" data-act="addRegion">建立</button></div></div>`;
  return `<div class="card login"><h2>帳號尚未開通</h2><p class="muted">你目前登入的是<br><b>${esc(S.user.email)}</b></p>
    <p class="muted small">請把這個 Email 傳給管理者，加到你負責的區域後就可以使用。</p><button class="btn" data-act="switchUser">換一個帳號</button></div>`;
}
function firstHubHtml() {
  return `<div class="card login"><h2>先新增主要門市</h2><p class="muted">主要門市是排班的單位，例如「新莊榮華」。新增後再到「門市」把它底下負責的各家門市加進去。</p>
    <div class="row" style="justify-content:center"><input type="text" id="newHub" placeholder="主要門市名稱" style="width:180px"><button class="btn primary" data-act="addHub">新增主要門市</button></div></div>`;
}

/* ---------- 開始 ---------- */
function homeHtml() {
  const hub = hubBy(S.hub), st = storesOf(S.hub).filter(needs), ppl = empsOf(S.hub).filter(e => e.active !== false);
  const sup = emps().filter(e => e.active !== false && (e.stores || []).some(id => !eHubs(e).includes(storeBy(id)?.hub))).length;
  const noXY = st.filter(s => !hasXY(s)).length;
  const lv = S.leaveCfg, lvOpen = !!lv?.open, lvSubs = lvOpen ? Object.keys(S.leaves[lv.ym] || {}).length : 0;
  const days = range(S.ovStart, 14), ready = monthsReady(new Set(days.map(d => ymOf(d.ds))));
  const miss = ready ? days.reduce((n, d) => n + missing(d.ds, "am", S.hub).length + missing(d.ds, "pm", S.hub).length, 0) : null;
  const am = ppl.filter(e => e.shift === "am").length, pm = ppl.filter(e => e.shift === "pm").length;
  const steps = [
    ["people", "1. 人員", ppl.length ? `${esc(hub?.name)} ${ppl.length} 人（早班 ${am}、晚班 ${pm}、早晚都可 ${ppl.length - am - pm}）` : "還沒有人員，從 Apollo「我的部屬」匯入", ppl.length > 0, "管理人員"],
    ["support", "2. 可支援門市", sup ? `${sup} 人可以跨主要門市支援` : "每個人預設只排自己主要門市底下的門市", true, "設定支援"],
    ["stores", "3. 門市", st.length ? `${st.length} 家門市${noXY ? `（${noXY} 家還沒算出位置）` : ""}` : "還沒有門市，可以用 Excel 匯入", st.length > 0, "設定門市"],
    ["routes", "4. 路線", (() => { const n = ["wd_am", "wd_pm"].map(k => routesOf(k, S.hub).length); return n[0] || n[1] ? `早班 ${n[0]} 條、晚班 ${n[1]} 條` : "還沒有路線，可以匯入「智取店_資料統整.xlsx」"; })(), true, "設定路線"],
    ["leave", "5. 畫休", lvOpen ? `${lv.ym.replace("-", " 年 ")} 月開放中・已送出 ${lvSubs} 人` : "目前沒有開放畫休", true, "畫休"],
    ["auto", "6. 自動排班", "選起始日 → 產生班表 → 預覽 → 確認寫入", ppl.length > 0 && st.length > 0, "去排班"],
    ["grid", "7. 班表", "看整個月的班，每家店旁邊顯示在店時數，點格子可以手動改", true, "看班表"],
    ["overview", "8. 漏排總覽", miss == null ? "載入中…" : miss ? `這 14 天還有 <b class="bad">${miss}</b> 店次沒人` : "這 14 天早晚班都排滿 ✓", miss === 0, "看漏排"],
  ];
  const next = !ppl.length ? "1. 人員" : !st.length ? "3. 門市" : miss ? "6. 自動排班" : "7. 班表";
  return `<div class="card hero"><h2>每一期只要做 5 → 6 → 8</h2>
      <div class="muted">人員、門市或路線有異動時，再回 1～4 調整。設定會自動儲存。<b class="nexts">建議下一步：${next}</b></div></div>
    ${steps.map(([tab, t, d, ok, btn]) => `<div class="card step"><div class="stat ${ok ? "ok" : "todo2"}">${ok ? "✓" : "!"}</div>
      <div class="stxt"><h3>${t}</h3><div class="muted">${d}</div></div><button class="btn sec" data-act="go" data-tab="${tab}">${btn}</button></div>`).join("")}`;
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
const SHICON = { am: "☀️ 早班", pm: "🌙 晚班" };
// 精簡顯示：一行「早3間・路線代碼・時數」，下面店名小字；雙班上下兩段
const routeCode = p => { const ids = (p.st || []).filter(id => !(p.sp || []).includes(id)); return ids.length ? allRoutes("wd_" + p.s).find(r => r.st.length === ids.length && r.st.every(id => ids.includes(id)))?.code || "" : ""; };
const fmt1 = h => (Math.round(h * 10) / 10).toFixed(1);
function cellDense(c, av, hs, ds, src, eid, hs2) {
  if (!c) return avTag(av);
  if (c.s === "off") return avTag(av) + `<span class="offt">休</span>`;
  const part = (p, h) => {
    if (p.tr) {
      const tc = src && ds ? onSh(src(ds, p.tr), p.s) : null, ids = tc ? tc.st || [] : p.st || [];
      return `<div class="dl"><b class="pill p-${p.s}">${SH1[p.s]}</b><span class="dh trn">🎓跟${esc(empBy(p.tr)?.name || "")}</span></div><div class="dn">${ids.map(id => esc(sName(id))).join(" ")}</div>`;
    }
    const ids = p.st || [], sp = p.sp || [], tot = (h || []).reduce((a, x) => a + x, 0), code = routeCode(p);
    const kids = ds && src ? emps().filter(x => x.id !== eid && onSh(src(ds, x.id), p.s)?.tr === eid) : [];
    return `<div class="dn">${ids.map((id, i) => sp.includes(id) ? `<div class="spn">+${esc(sName(id))}<small>支援</small></div>` : `<div>${esc(sName(id))}${h && h[i] ? `<small>${fmtH(h[i])}</small>` : ""}</div>`).join("")}</div>`
      + (p.n ? `<div class="nt" title="${esc(p.n)}">✎ ${esc(p.n.length > 8 ? p.n.slice(0, 8) + "…" : p.n)}</div>` : "")
      + (kids.length ? `<div class="dh trn">🎓帶${kids.map(k => esc(k.name)).join("、")}</div>` : "");
  };
  const x = xOf(c);
  // 雙班：上下兩段，第二段用晚班（或早班）顏色、標一個小字
  return avTag(av) + part(c, hs) + (x ? `<div class="dsep"></div><div class="d2 d2-${x.s}"><span class="d2t">${SH1[x.s]}</span>${part(x, hs2)}</div>` : "");
}
function cellInner(c, av, hs, ds, src, eid, hs2) {
  if (S.dense) return cellDense(c, av, hs, ds, src, eid, hs2);
  if (!c) return avTag(av);
  const x = xOf(c);
  if (x) { const { x: _, ...a } = c; return cellInner(a, av, hs, ds, src, eid) + `<div class="dbl">${cellInner(x, null, hs2, ds, src, eid)}</div>`; }
  if (c.s === "off") return avTag(av) + `<span class="offt">休</span>`;
  // 實習：跟帶班人員同一班，門市照帶班人員當天的班（不算人力、不分時數）
  if (c.tr) {
    const t = empBy(c.tr), tc = src && ds ? onSh(src(ds, c.tr), c.s) : null, ok = !!tc;
    return avTag(av) + `<div class="shl">${SHICON[c.s]}</div><div class="trn">🎓 實習・跟 ${esc(t?.name || "（已刪除）")}</div><div class="sts">${(ok ? tc.st : c.st || []).map(id => `<span class="st">${esc(sName(id))}</span>`).join("")}</div>${ok ? "" : `<div class="note" style="color:#b45309">帶班人員這班沒排班</div>`}` + (c.n ? `<div class="note">${esc(c.n)}</div>` : "");
  }
  const kids = ds && src ? emps().filter(x => x.id !== eid && onSh(src(ds, x.id), c.s)?.tr === eid) : [];
  return avTag(av) + `<div class="shl">${SHICON[c.s]}</div><div class="sts">${(c.st || []).map((id, i) => `<span class="st ${(c.sp || []).includes(id) ? "spt" : ""}">${(c.sp || []).includes(id) ? "支援 " : ""}${esc(sName(id))}${hs && hs[i] ? `<small class="hrs">${fmtH(hs[i])}</small>` : ""}</span>`).join("")}</div>` + (kids.length ? `<div class="trn">🎓 帶 ${kids.map(x => esc(x.name)).join("、")}</div>` : "") + (c.n ? `<div class="note">${esc(c.n)}</div>` : "");
}
// 這格每家店的在店時數（一間一個）：每班在店時數；同一班同一家店排了幾個人就平分
// 支援的店不顯示時數；同一家店有幾個「正式負責」的人（不含去支援的）就平分
function cellHrs(c, ds, cov, src) {
  if (!c || !c.s || c.s === "off" || c.tr) return [];
  return (c.st || []).map(id => (c.sp || []).includes(id) ? 0 : shHrs(storeBy(id)) / Math.max(1, (cov(ds, c.s)[id] || []).filter(p => !(onSh(src(ds, p.id), c.s)?.sp || []).includes(id)).length));
}
const SHIFT_GROUP = [["am", "☀️ 早班人員"], ["pm", "🌙 晚班人員"], ["any", "早晚都可"], ["tr", "🎓 實習人員"]];
function personRows(list, days, src, changed) {
  const grp = e => e.trainee ? "tr" : e.shift === "am" || e.shift === "pm" ? e.shift : "any";
  const groups = SHIFT_GROUP.map(([k, label]) => [k, label, list.filter(e => grp(e) === k)]).filter(g => g[2].length);
  return groups.map(([k, label, l]) => (groups.length > 1 ? `<tr class="grp grp-${k}"><td class="sticky">${label}（${l.length}）</td><td colspan="${days.length + 1}"></td></tr>` : "") + personRows1(l, days, src, changed)).join("");
}
function personRows1(list, days, src, changed) {
  const memo = {}, cov = (ds, sh) => memo[ds + sh] ||= coverage(ds, sh, src);
  return list.map(e => {
    let work = 0, cnt = 0, run = 0, maxRun = 0, tightN = 0, prevS = null, hrs = 0;
    const wk = {};
    const tds = days.map(d => {
      const c = src(d.ds, e.id), av = avOf(d.ds, e.id);
      const on = c && c.s && c.s !== "off";
      run = on ? run + 1 : 0; maxRun = Math.max(maxRun, run);
      if (on) { const w = mondayOf(d.ds); wk[w] = (wk[w] || 0) + 1; }
      const x2 = xOf(c);
      if (on && (c.s === "am" || x2?.s === "am") && prevS === "pm") tightN++;
      prevS = on ? (x2?.s === "pm" ? "pm" : c.s) : null;
      if (c && c.s !== "off") { work++; cnt += allSt(c).length; }
      const bad = av && c && c.s !== "off" && (avBad(av, c.s) || (x2 && avBad(av, x2.s)));
      const ch = changed && changed(d.ds, e.id), h = cellHrs(c, d.ds, cov, src), h2 = cellHrs(x2, d.ds, cov, src);
      hrs += [...h, ...h2].reduce((a, x) => a + x, 0);
      return `<td class="c ${c?.s ? "s-" + c.s : ""} ${x2 ? "s-dbl" : ""} ${bad ? "avbad" : ""} ${ch ? "chg" : ""} ${d.we ? "we" : ""}" ${src === cell && isAdmin() ? `data-act="editCell" data-e="${e.id}" data-ds="${d.ds}"` : ""} title="${esc(e.name + " " + dLabel(d.ds) + (av ? "\n" + AVL[av] : ""))}">${cellInner(c, av, h, d.ds, src, e.id, h2)}</td>`;
    }).join("");
    // 提醒：超過每週天數上限、連續上班太久、晚班隔天接早班（只是標示，不會擋）
    const warn = [], wkOver = Object.values(wk).filter(n => n > weekCap(e)).length;
    if (wkOver) warn.push(`${wkOver} 週超過每週 ${weekCap(e)} 天`);
    if (maxRun > consecCap()) warn.push(`連續上班 ${maxRun} 天（上限 ${consecCap()}）`);
    if (tightN) warn.push(`${tightN} 次晚班隔天接早班`);
    return `<tr><td class="sticky">${esc(e.name)}${S.hub === ALL || !eHubs(e).includes(S.hub) ? `${S.dense ? "<br>" : " "}<span class="muted small">(${esc(hubNames(e) || "未設定主要門市")})</span>` : ""}${e.active === false ? ' <span class="muted small">(停用)</span>' : ""}</td>${tds}<td class="tot ${warn.length ? "over" : ""}" ${warn.length ? `title="${esc(e.name + "：" + warn.join("；"))}"` : ""}>${work}天${warn.length ? " ⚠" : ""}<br><span class="small">${cnt}店次</span>${hrs ? `<br><span class="small">在店 ${fmtH(hrs)} 小時</span>` : ""}</td></tr>`;
  }).join("");
}
function missRow(days, src) {
  return ["am", "pm"].map(sh => `<tr class="missrow"><th class="sticky">${SHIFT[sh]}漏排</th>${days.map(d => {
    const m = missing(d.ds, sh, S.hub, src);
    return `<th><span class="missbtn ${m.length ? "bad" : "good"}" title="${m.length ? "漏排：" + m.map(s => s.name).join("、") : "全部排滿"}">${m.length ? "漏" + m.length : "✓"}</span></th>`;
  }).join("")}<th></th></tr>`).join("");
}
// 這個主要門市的人＋這段期間有來支援的人
function rowsFor(days, src) {
  const own = empsOf(S.hub).filter(e => e.active !== false || days.some(d => src(d.ds, e.id)));
  const ids = new Set(storesOf(S.hub).map(s => s.id));
  const help = emps().filter(e => !eHubs(e).includes(S.hub) && days.some(d => allSt(src(d.ds, e.id)).some(x => ids.has(x))));
  return [...own, ...help];
}
function gridHtml() {
  const days = monthDays(S.ym);
  const [y, m] = S.ym.split("-");
  if (!S.months[S.ym]) return monthNav(y, m) + `<div class="loading">載入班表中…</div>`;
  const list = rowsFor(days, cell);
  return monthNav(y, m) + `
  <div class="scroll"><table class="sg ${S.dense ? "dense" : ""}">
    <thead><tr><th class="sticky">${esc(hubBy(S.hub)?.name)}（${list.length}人）</th>${days.map(d => `<th class="${d.today ? "today" : ""} ${d.we ? "we" : ""}">${d.d}<br>${d.wd}</th>`).join("")}<th>合計</th></tr>
    ${missRow(days, cell)}</thead>
    <tbody>${personRows(list, days, cell) || `<tr><td class="sticky" style="padding:20px" colspan="${days.length + 2}">這間主要門市還沒有人員，請到「人員」新增或從 Apollo 匯入。</td></tr>`}</tbody>
  </table></div>
  <div class="legend" style="margin-top:8px"><span><i style="background:#e0f2fe;border-left:4px solid #0284c7"></i>☀️ 早班</span><span><i style="background:#ede9fe;border-left:4px solid #7c3aed"></i>🌙 晚班</span><span><i style="background:#f4f5f7"></i>休</span><span>右上角小標＝員工畫休</span><span>店名旁的數字＝這家店這班的在店時數（營運指標「僅在店」÷ 2；同一家店排 2 人就平分）</span><span style="color:#b45309">⚠ 合計欄＝超過每週／連續上限，或晚班隔天接早班</span>${isAdmin() ? "<span>點格子可以修改</span>" : ""}</div>`;
}
function monthNav(y, m) {
  return `<div class="row toolbar" style="margin-bottom:10px">
    <button class="icon-btn" data-act="month" data-n="-1">‹</button><b style="font-size:16px">${y}年${+m}月</b><button class="icon-btn" data-act="month" data-n="1">›</button>
    <span class="spacer"></span>${isAdmin() ? '<label class="btn" title="把排班 Excel（每間主要門市一段「XX店-早班／晚班」）匯入這個月">匯入班表 Excel<input type="file" data-ch="schedImp" accept=".xlsx,.xls" hidden></label>' : ""}${isAdmin() ? '<button class="btn" data-act="pubSched" title="把這個月的班表發布到員工查班表網頁">發布給員工</button><button class="btn" data-act="pubLink">複製查班網址</button>' : ""}<button class="btn" data-act="exportX">匯出 Excel</button><button class="btn" data-act="exportApollo" title="產生 Apollo 班表匯入檔（每人每天一列，時數＝當天路線所需時數）">匯出 Apollo 匯入檔</button><button class="btn" onclick="window.print()">列印</button></div>`;
}

/* ---------- 自動排班 ---------- */
function autoHtml() {
  const r = rules(), hub = hubBy(S.hub), st = storesOf(S.hub), people = empsOf(S.hub).filter(e => e.active !== false);
  S.autoStart ||= mondayOf(addDays(todayDs(), 7)); S.autoDays ||= 14;
  const noXY = st.filter(s => !hasXY(s)).length;
  if (noXY) setTimeout(() => autoLocate(st), 0);
  const p = S.plan && S.plan.hub === S.hub ? S.plan : null;
  const setup = `<div class="card"><h3>自動排班・${esc(hub?.name)}</h3>
    <div class="row">
      <label>從哪天開始<br><input type="date" data-ch="autoStart" value="${isoOf(S.autoStart)}"></label>
      <label>排幾天<br><select data-ch="autoDays">${[7, 14, 21, 28].map(n => `<option value="${n}" ${n === S.autoDays ? "selected" : ""}>${n} 天</option>`).join("")}</select></label>
      <label>已經排的格子<br><select data-ch="autoMode">${[["keepOff", "保留休假，門市全部重排"], ["fill", "全部保留，只補空的"], ["all", "全部清掉重排（休假也清）"]].map(([k, v]) => `<option value="${k}" ${autoMode() === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      <span class="spacer"></span>
      <button class="btn primary big" data-act="autoRun">產生班表</button>
    </div>
    <div class="small muted" style="margin-top:10px;line-height:1.8">
      這間主要門市：門市 <b>${st.filter(needs).length}</b> 家（早晚都要排）・可排人員 <b>${people.length}</b> 人
      （只上早班 ${people.filter(e => e.shift === "am").length}、只上晚班 ${people.filter(e => e.shift === "pm").length}、早晚都可 ${people.filter(e => !e.shift || e.shift === "any").length}）<br>
      條件：每人每週最多 <b>${weekCap()}</b> 天、最多連上 <b>${consecCap() === Infinity ? "不限" : consecCap()}</b> 天
      <a href="#" data-act="goSettings">修改條件</a><br>
      ${["am", "pm"].map(sh => `${SHIFT[sh]}路線 <b>${routesOf("wd_" + sh, S.hub).length}</b> 條`).join("・")}
      ${routesOf("wd_am", S.hub).length || routesOf("wd_pm", S.hub).length ? "（有路線就照路線排，重的路線先排人）" : "（還沒有路線，會照門市的 workload、NDD 打包數自動產生路線再排人）"} <a href="#" data-act="goRoutes">修改路線</a><br>
      ${routesOf("wd_am", S.hub).length || routesOf("wd_pm", S.hub).length ? "" : noXY ? `<span class="muted">有 ${noXY} 家門市還沒算出位置，這幾家會照門市列表的順序和相鄰的店排在一起。</span>` : "所有門市都已定位，會把距離近的店分給同一個人。"}
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
    <p class="muted small">左上角有<b style="color:#2563eb">藍點</b>的是這次會改的格子。確認寫入後還是可以到「班表」點格子手動調整。</p>
    <div class="scroll"><table class="sg ${S.dense ? "dense" : ""}">
      <thead><tr><th class="sticky">${esc(hub?.name)}</th>${days.map(d => `<th class="${d.today ? "today" : ""} ${d.we ? "we" : ""}">${d.m}/${d.d}<br>${d.wd}</th>`).join("")}<th>合計</th></tr>${missRow(days, src)}</thead>
      <tbody>${personRows(list, days, src, changed)}</tbody></table></div></div>`;
}
// 把要排的店依距離與工作量分成一組一組（一組給一個人）
// target：希望當天用幾個人（平均分攤一週的上班天數）；條件不允許時組數可以超過 target
function buildRoutes(list, sh, people) {
  // 只用在沒排進任何路線的店；跟自動產生路線一樣：晚班最多 2 間、早班最多 3 間，不設工作量上限和距離
  const cap = 0, maxSt = maxOf(sh), maxKm = 0;
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
// 已排格子的處理：keepOff＝保留休假、門市重排；fill＝全部保留只補空；all＝全部清掉
const autoMode = () => S.autoMode || ls.get("zq2-automode") || "keepOff";
// 全部門市：一間一間排，共用同一份 plan（前一間排走的人，後面就不會重複排）
function autoPlan() {
  if (S.hub !== ALL) return autoPlanHub(S.hub, {});
  const plan = {}, notes = [];
  for (const h of hubs()) { const r = autoPlanHub(h.id, plan); r.notes.forEach(x => notes.push(`${h.name}：${x}`)); }
  return { hub: ALL, start: S.autoStart, days: S.autoDays, cells: plan, notes };
}
function autoPlanHub(HUB, plan) {
  const r = rules(), start = S.autoStart, n = S.autoDays, mode = autoMode(), keep = mode === "fill";
  const days = range(start, n).map(d => d.ds);
  const hubStores = storesOf(HUB);
  const members = empsOf(HUB).filter(e => e.active !== false && !e.trainee);
  // 別間主要門市、但在「可支援門市」勾了這裡門市的人，也可以來支援
  const helpers = emps().filter(e => e.active !== false && !e.trainee && !members.includes(e) && (e.stores || []).some(id => hubStores.some(s => s.id === id)));
  const people = [...members, ...helpers];
  const isHelper = new Set(helpers.map(e => e.id));
  const notes = [];
  const get = (ds, eid) => plan[ds + "_" + eid] !== undefined ? plan[ds + "_" + eid] : cell(ds, eid);
  const working = c => c && c.s && c.s !== "off";
  const daysInWeek = (eid, ds) => { const w = mondayOf(ds); let k = 0; for (let i = 0; i < 7; i++) { const d = addDays(w, i); if (d !== ds && working(get(d, eid))) k++; } return k; };
  const streak = (eid, ds) => { let k = 0, d = addDays(ds, -1); while (k < 14 && working(get(d, eid))) { k++; d = addDays(d, -1); } return k; };
  const lastStores = (eid, ds, sh) => onSh(get(addDays(ds, -1), eid), sh)?.st || [];
  const own = new Set(hubStores.map(s => s.id));
  // 這格是不是排在「別間主要門市」的店（多間主要門市的人）→ 不能動、當天也不能再排
  const elsewhere = c => c && c.s && c.s !== "off" && allSt(c).some(id => !own.has(id));
  // 不保留：先把這段期間的格子清空（排在別間主要門市的班不動）
  if (!keep) for (const ds of days) for (const e of people) {
    if (plan[ds + "_" + e.id] !== undefined) continue;   // 全部門市模式：前面那間已經排過這格
    const c = cell(ds, e.id);
    // 單一主要門市重排時，排在別間主要門市的班（去支援）不動；全部門市一起排時全部重排
    if ((S.hub !== ALL && elsewhere(c)) || c?.tr || (mode === "keepOff" && c?.s === "off")) continue;
    plan[ds + "_" + e.id] = null;
  }
  for (const ds of days) {
    const used = new Set(people.filter(e => { const c = get(ds, e.id); return !!(c && c.s) || elsewhere(c); }).map(e => e.id));
    for (const sh of ["am", "pm"]) {
      const cov = coverage(ds, sh, get);
      const need = hubStores.filter(s => needs(s, sh) && !cov[s.id]);
      if (!need.length) continue;
      const cand = people.filter(e => {
        if (used.has(e.id)) return false;
        if (e.shift && e.shift !== "any" && e.shift !== sh) return false;
        const av = avOf(ds, e.id); if (av && avBad(av, sh)) return false;
        if (daysInWeek(e.id, ds) >= weekCap(e)) return false;
        if (streak(e.id, ds) >= consecCap()) return false;
        return true;
      });
      // 一天要用幾個人：讓大家的上班天數平均攤在一週 7 天（早晚都可的人兩班各算一半）
      const pool = people.filter(e => !e.shift || e.shift === "any" || e.shift === sh);
      const wt = e => (e.shift === sh ? 1 : 0.5) * (isHelper.has(e.id) ? 0.5 : 1);
      const slots = pool.reduce((n, e) => n + weekCap(e) / 7 * wt(e), 0);
      const target = Math.max(1, Math.min(cand.length, Math.round(slots)));
      // 有設定路線就照路線（重的先排）；不在任何路線裡的店，照距離另外分組
      // 沒有設定路線時，照門市資料當場自動分組（不會存起來）
      const rts0 = routesFor(ds, sh, HUB), rts = rts0.length ? rts0 : genRoutes(HUB, sh), toR = l => ({ ids: l.map(s => s.id), n: 1, h: l.reduce((a, s) => a + shHrs(s), 0) });
      let routes;
      if (rts.length) {
        // 路線可以帶到別間主要門市的店（例：文衡＋民樂）；別間主要門市路線已經包含的店，這裡不另外排
        const setK = "wd_" + sh;
        const inRt = new Set([...allRoutes(setK), ...rts].flatMap(r => r.st));
        routes = rts.map(rt => {
          const ids = rt.st.filter(id => storeBy(id) && needs(storeBy(id)) && !cov[id]);
          const had = Math.max(0, ...rt.st.map(id => (cov[id] || []).length));
          return { ids, sp: (rt.sup || []).filter(id => storeBy(id) && needs(storeBy(id)) && !rt.st.includes(id)), n: Math.max(1, (+rt.n || 1) - had), h: rtHrs(rt), hub: routeHub(rt) };
        }).filter(r => r.ids.length);
        const rest = need.filter(s => !inRt.has(s.id));
        if (rest.length) routes.push(...buildRoutes(rest, sh, Math.max(1, target - routes.length)).map(r => toR(r.stores)));
        routes.sort((a, b) => b.h - a.h);
      } else routes = buildRoutes(need, sh, target).map(r => toR(r.stores));
      // 人手不夠時，把這週剩下的上班天數平均攤到剩下的每一天（避免平日排滿、週末全空）
      const wd = (fromDs(ds).getDay() + 6) % 7, daysLeft = 7 - wd;
      const left = pool.reduce((n, e) => n + Math.max(0, weekCap(e) - daysInWeek(e.id, ds)) * wt(e), 0);
      const quota = Math.max(1, Math.ceil(left / daysLeft - 1e-9));
      let slotsLeft = quota;
      for (const rt of routes) for (let k = 0; k < rt.n; k++) {
        if (slotsLeft <= 0) break;
        const ids = rt.ids;
        let best = null, bs = -Infinity;
        for (const e of cand) {
          if (used.has(e.id)) continue;
          // 照路線排時：本區的人（沒另外勾可支援門市）可以跑這條路線的所有店
          if (!ids.every(id => canGo(e, id)) && !(rt.hub && !(e.stores || []).length && eHubs(e).includes(rt.hub))) continue;
          const last = lastStores(e.id, ds, sh);
          // 軟性避開「晚班隔天接早班」（休息間隔太短）：前一天晚班→今天早班、或明天已排早班→今天晚班，各扣分（不是硬限制，人手不夠時還是會排）
          const prev = get(addDays(ds, -1), e.id), next = get(addDays(ds, 1), e.id);
          const tight = (sh === "am" && prev?.s === "pm") || (sh === "pm" && next?.s === "am");
          const score = -10 * daysInWeek(e.id, ds) + 4 * ids.filter(id => last.includes(id)).length + (e.shift === sh ? 3 : 0) - (isHelper.has(e.id) ? 6 : 0) - 0.5 * streak(e.id, ds) - (tight ? 12 : 0) + Math.random() * 0.1;
          if (score > bs) { bs = score; best = e; }
        }
        if (!best) continue;
        used.add(best.id); slotsLeft--;
        plan[ds + "_" + best.id] = rt.sp?.length ? { s: sh, st: [...ids, ...rt.sp], sp: rt.sp } : { s: sh, st: ids };
      }
    }
    // 沒排到班的人標「休」（保留模式下不動原本的格子；有多間主要門市的人留空，讓別間還能排）
    for (const e of members) if (!get(ds, e.id) && eHubs(e).length <= 1) plan[ds + "_" + e.id] = { s: "off", st: [] };
  }
  if (!members.length) notes.push("這間主要門市沒有啟用中的人員");
  if (!hubStores.length) notes.push("這間主要門市沒有門市");
  return { hub: HUB, start, days: n, cells: plan, notes };
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
  const hubOpts = sel => `<option value="">（未設定）</option>` + hubs().map(h => `<option value="${h.id}" ${h.id === sel ? "selected" : ""}>${esc(h.name)}</option>`).join("");
  const list = S.showAllEmps ? emps() : emps().filter(e => eHubs(e).includes(S.hub) || !eHubs(e).length);
  const rows = list.map(e => `<tr>
    <td><input type="text" value="${esc(e.name)}" data-ch="eName" data-id="${e.id}" style="width:90px"></td>
    <td><input type="text" value="${esc(e.code || "")}" data-ch="eCode" data-id="${e.id}" placeholder="工號" style="width:100px"></td>
    <td><button class="btn small hubsbtn ${eHubs(e).length ? "" : "warnbox"}" data-act="eHubs" data-id="${e.id}">${esc(hubNames(e) || "未設定")}</button></td>
    <td><select data-ch="eShift" data-id="${e.id}">${[["any", "早晚都可"], ["am", "只上早班"], ["pm", "只上晚班"]].map(([k, v]) => `<option value="${k}" ${(e.shift || "any") === k ? "selected" : ""}>${v}</option>`).join("")}</select></td>
    <td><input type="number" min="1" max="7" value="${e.maxDays || ""}" placeholder="${weekCap()}" data-ch="eMax" data-id="${e.id}" style="width:56px"></td>
    <td><button class="btn small" data-act="eStores" data-id="${e.id}">${(e.stores || []).length ? `${e.stores.length} 家` : "不限"}</button></td>
    <td><input type="checkbox" data-ch="eTr" data-id="${e.id}" ${e.trainee ? "checked" : ""} title="實習人員：自動排班不排，主管在班表點格子安排跟誰實習"></td>
    <td><input type="checkbox" data-ch="eAct" data-id="${e.id}" ${e.active !== false ? "checked" : ""}></td>
    <td><button class="btn small danger" data-act="eDel" data-id="${e.id}">刪</button></td></tr>`).join("");
  const act = emps().filter(e => e.active !== false);
  // 檢查：沒工號的人、疑似同一人（小名 vs 全名）
  const noCode = act.filter(e => !e.code);
  const dup = act.filter(e => e.name.length <= 2).map(e => [e, act.find(x => x.id !== e.id && x.name.length > e.name.length && x.name.endsWith(e.name))]).filter(([, x]) => x);
  const chk = (noCode.length || dup.length) ? `<div class="warnbox small" style="margin-bottom:10px;line-height:1.8">${dup.length ? `疑似同一人（小名和全名各一筆，請把小名那筆的班改到全名後刪掉）：${dup.map(([a, x]) => `${esc(a.name)} ↔ ${esc(x.name)}`).join("、")}<br>` : ""}${noCode.length ? `還沒有工號 ${noCode.length} 人（匯出 Apollo 匯入檔時會跳過）：${noCode.map(e => esc(e.name)).join("、")}` : ""}</div>` : "";
  return `<div class="card"><h3>人員・${esc(hubBy(S.hub)?.name)}（${empsOf(S.hub).filter(e => e.active !== false).length} 人）</h3>${chk}
    <div class="row" style="margin-bottom:10px">
      <button class="btn primary" data-act="apolloHelp">從 Apollo「我的部屬」匯入…</button>
      <span class="spacer"></span>
      <button class="btn small danger" data-act="empClear">清空全部人員…</button>
      <label class="small"><input type="checkbox" data-ch="showAll" ${S.showAllEmps ? "checked" : ""}> 顯示全區域人員（${act.length} 人）</label>
    </div>
    <div class="scrollx"><table class="list emp"><tr><th>姓名</th><th>工號</th><th>主要門市</th><th>班別</th><th>每週最多天</th><th>可去門市</th><th>實習</th><th>啟用</th><th></th></tr>${rows || `<tr><td colspan="9" class="muted" style="padding:16px">還沒有人員</td></tr>`}</table></div>
    <p class="muted small">「主要門市」可以選不只一間，這個人會出現在每一間的排班裡。離職的人取消「啟用」就好，歷史班表會保留。「可去門市」不限＝主要門市底下每一家都可以排。<b>實習</b>打勾的人自動排班不會排，主管在「7. 班表」點他的格子選「實習」，指定跟誰（帶班人員）；班表上新人會看到「實習・跟 某某」，帶班人員會看到「帶 某某」。新人、帶班人員要看班表的話，把 Email 加到「設定 → 權限」的檢視者。</p></div>`;
}

/* ---------- 可支援門市（人員 × 門市） ---------- */
function supportHtml() {
  const ph = S.supPeople ?? (S.hub === ALL ? "" : S.hub), sh = S.supStores ?? "";
  const people = emps().filter(e => e.active !== false && (ph === "" ? true : ph === "none" ? !eHubs(e).length : eHubs(e).includes(ph)));
  const shownHubs = hubs().filter(h => !sh || h.id === sh).map(h => [h, storesOf(h.id).filter(needs)]).filter(([, l]) => l.length);
  const cols = shownHubs.flatMap(([, l]) => l);
  const hubOpt = (sel, all) => `<option value="">${all}</option>` + hubs().map(h => `<option value="${h.id}" ${h.id === sel ? "selected" : ""}>${esc(h.name)}</option>`).join("");
  const shiftTxt = { am: "早班", pm: "晚班" };
  const rows = people.map(e => {
    const al = new Set(allowed(e)), custom = (e.stores || []).length > 0;
    return `<tr><td class="sticky nm">${esc(e.name)}</td><td class="sticky2"><span class="muted small">${esc(hubNames(e) || "未設定")}／${shiftTxt[e.shift] || "早晚"}</span>
      ${custom ? `<button class="btn small" data-act="supReset" data-id="${e.id}" title="恢復成只去自己主要門市底下的門市">本區</button>` : `<span class="okpill small" title="沒有另外設定＝自己主要門市底下全部">本區</span>`}</td>
      ${cols.map(s => `<td class="ck2 ${eHubs(e).includes(s.hub) ? "own" : ""}"><input type="checkbox" data-ch="sup" data-e="${e.id}" data-s="${s.id}" ${al.has(s.id) ? "checked" : ""}></td>`).join("")}</tr>`;
  }).join("");
  return `<div class="card"><div class="row">
      <label>人員主要門市 <select data-ch="supPeople"><option value="" ${ph === "" ? "selected" : ""}>全部</option>${hubs().map(h => `<option value="${h.id}" ${h.id === ph ? "selected" : ""}>${esc(h.name)}</option>`).join("")}<option value="none" ${ph === "none" ? "selected" : ""}>未設定</option></select></label>
      <label>顯示門市 <select data-ch="supStores">${hubOpt(sh, "全部主要門市")}</select></label>
      <button class="btn" data-act="supAllOwn">篩選中的人員全部恢復「本區」</button>
      <button class="btn" data-act="supAllSel" title="篩選中的人員，把目前顯示的門市全部勾起來">全選</button>
      <span class="muted small">勾選＝這個人可以排到這家店。沒另外勾過的人＝自己主要門市底下全部（標「本區」）。勾到別間主要門市的店，自動排班時就能去支援。</span>
    </div></div>
    ${!people.length ? `<div class="card muted">沒有符合的人員</div>` : `<div class="scroll"><table class="sup">
      <thead><tr><th class="sticky nm" rowspan="2">姓名</th><th class="sticky2" rowspan="2">主要門市／班別</th>${shownHubs.map(([h, l]) => `<th colspan="${l.length}" class="hubh">${esc(h.name)}</th>`).join("")}</tr>
        <tr>${cols.map(s => `<th class="vt"><span>${esc(s.name)}</span></th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody></table></div>`}`;
}

/* ---------- 門市 ---------- */
function storesHtml() {
  const hub = hubBy(S.hub), list = storesOf(S.hub);
  setTimeout(() => autoLocate(stores()), 0);
  const hubOpts = sel => hubs().map(h => `<option value="${h.id}" ${h.id === sel ? "selected" : ""}>${esc(h.name)}</option>`).join("");
  const rows = list.map((s, i) => `<tr>
    <td class="muted">${i + 1}</td>
    <td class="nowrap"><input type="text" value="${esc(s.name)}" data-ch="sName" data-id="${s.id}" style="width:90px">${isOff(s) ? ` <span class="todo" title="這家店目前不排班">不排</span> <a href="#" data-act="sOn" data-id="${s.id}" class="small">恢復排班</a>` : ""}</td>
    <td><input type="text" value="${esc(s.addr || "")}" data-ch="sAddr" data-id="${s.id}" placeholder="地址" style="width:220px"></td>
    <td><input type="number" min="0" step="any" value="${s.load ?? s.loadAm ?? ""}" placeholder="1" data-ch="sLoad" data-id="${s.id}" style="width:80px"></td>
    <td><input type="number" min="0" value="${s.nddCnt ?? ""}" placeholder="—" data-ch="sNdd" data-id="${s.id}" style="width:64px"></td>
    <td class="num"><b>${shHrs(s) ? fmtH(shHrs(s)) : "—"}</b></td>
    ${FLAGS.map(([k]) => k === "ndd" ? `<td class="ctr">${isNdd(s) ? "有" : "—"}</td>` : `<td class="ctr"><input type="checkbox" data-ch="sFlag" data-k="${k}" data-id="${s.id}" ${(k === "sup" ? isSup(s) : s[k]) ? "checked" : ""}></td>`).join("")}
    <td><select data-ch="sHub" data-id="${s.id}">${hubOpts(s.hub)}</select></td>
    <td class="nowrap"><button class="btn small" data-act="sMove" data-id="${s.id}" data-n="-1">↑</button> <button class="btn small" data-act="sMove" data-id="${s.id}" data-n="1">↓</button> <button class="btn small danger" data-act="sDel" data-id="${s.id}">刪</button></td></tr>`).join("");
  const noXY = list.filter(s => !hasXY(s) && s.addr).length;
  return `<div class="card"><h3>門市・${esc(hub?.name)}（${list.length} 家）</h3>
    <div class="row" style="margin-bottom:10px">
      <input type="text" id="newStore" placeholder="門市名稱" style="width:110px"><input type="text" id="newStoreAddr" placeholder="地址（選填）" style="width:220px">
      <button class="btn primary" data-act="addStore">新增門市</button>
      <label class="btn" for="kpiFile" title="直接選營運指標週報（分頁像「智取2026_1019」），不用先改">匯入營運指標週報…</label><input type="file" id="kpiFile" data-ch="storeFile" accept=".xlsx,.xls" hidden>
      <label class="btn" for="infoFile" title="Excel／CSV：門市名稱＋地址，和（或）HD、純取件、重新分配">匯入門市地址／類型…</label><input type="file" id="infoFile" data-ch="infoFile" accept=".xlsx,.xls,.csv" hidden>
      <button class="btn" data-act="nddImg" title="上傳 NDD 打包數截圖，自動辨識門市和數字">匯入 NDD 打包數（截圖）…</button>
      <span class="spacer"></span>
    </div>
    <div class="scrollx"><table class="list emp"><tr><th>#</th><th>門市</th><th>地址</th><th>workload<br>（整天）</th><th>NDD<br>打包數</th><th>每班<br>在店時數</th>${FLAGS.map(([, v]) => `<th>${v}</th>`).join("")}<th>主要門市</th><th></th></tr>${rows || `<tr><td colspan="15" class="muted" style="padding:16px">還沒有門市</td></tr>`}</table></div>
    <p class="muted small" style="line-height:1.8">
      <b>每班在店時數</b>＝workload ÷ 350 ÷ 2（表格可以直接改，會自動儲存）；有 NDD 打包數就算有 NDD 寄件。<br>
      <b>匯入營運指標週報</b>：直接選每週的門市週報檔，會讀最新一週的 workload（Avg 4W）。<br>
      <b>匯入門市地址／類型</b>：Excel 或 CSV，第一列標題要有「門市」，再加「地址」和（或）「HD」「純取件」「重新分配」欄（填 V、Y、是、1 都算勾）；只更新有填的欄位。<br>
      <b>匯入 NDD 打包數（截圖）</b>：上傳截圖，系統辨識門市名稱和數字，確認後才寫入；辨識錯的可以在預覽直接改。<br>
      系統會自動用地址算出各店位置，排班時把距離近的店分給同一個人；位置算不出來的店，會照列表順序和相鄰的店排在一起。</p></div>`;
}

/* ---------- 路線 ---------- */
function routesHtml() {
  const k = RSET[S.rset] ? S.rset : "wd_am", sh = k.slice(3), hub = hubBy(S.hub), list = routesOf(k, S.hub);
  const hubSt = storesOf(S.hub).filter(needs);
  const inN = id => allRoutes(k).filter(r => r.st.includes(id)).length;
  const unrouted = hubSt.filter(s => !inN(s.id));
  const others = stores().filter(s => needs(s) && s.hub !== S.hub);
  let nWarn = 0;
  const rows = list.map(rt => {
    const w = routeWarn(rt, sh), h = rtHrs(rt), n = +rt.n || 1;
    const dup = rt.st.filter(id => inN(id) > 1);
    if (dup.length) w.push(dup.map(sName).join("、") + " 也排在別條路線");
    if (w.length) nWarn++;
    const chips = rt.st.map((id, j) => { const x = storeBy(id); return `<span class="rchip">${j + 1}. ${esc(sName(id))}${x?.hd ? '<i class="hd">HD</i>' : ""}${x?.ndd ? '<i class="nd">NDD</i>' : ""}${x?.pick ? '<i class="pk">純取</i>' : ""}<small>${fmtH(shHrs(x))}</small>${j ? `<a data-act="rtMv" data-k="${k}" data-id="${rt.id}" data-j="${j}" title="往前移（先做）">◀</a>` : ""}<a data-act="rtRm" data-k="${k}" data-id="${rt.id}" data-j="${j}" title="移出這條路線">✕</a></span>`; }).join("");
    const supChips = (rt.sup || []).map(id => `<span class="rchip spt">支援 ${esc(sName(id))}<a data-act="rtSupRm" data-k="${k}" data-id="${rt.id}" data-s="${id}" title="不支援">✕</a></span>`).join("");
    const supAdd = `<select data-ch="rtSup" data-k="${k}" data-id="${rt.id}"><option value="">＋ 支援</option>${stores().filter(x => needs(x) && isSup(x) && !rt.st.includes(x.id) && !(rt.sup || []).includes(x.id)).map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select>`;
    const opt = s => `<option value="${s.id}">${esc(s.name)}${inN(s.id) ? "" : "（未排）"}</option>`;
    const add = `<select data-ch="rtAdd" data-k="${k}" data-id="${rt.id}"><option value="">＋ 加門市</option><optgroup label="${esc(hub?.name)}">${hubSt.filter(s => !rt.st.includes(s.id)).map(opt).join("")}</optgroup>${others.length ? `<optgroup label="其他主要門市">${others.filter(s => !rt.st.includes(s.id)).map(opt).join("")}</optgroup>` : ""}</select>`;
    return `<tr><td><input type="text" value="${esc(rt.code || "")}" data-ch="rtCode" data-k="${k}" data-id="${rt.id}" style="width:52px"></td>
      <td><input type="number" min="1" max="5" value="${n}" data-ch="rtN" data-k="${k}" data-id="${rt.id}" style="width:44px"></td>
      <td class="rstores">${chips}${supChips}${add}${supAdd}</td><td class="num">${rt.st.length}${(rt.sup || []).length ? `＋${rt.sup.length}` : ""}</td><td class="num"><b>${fmtH(h)}</b></td><td class="num"><b>${fmtH(h / n)}</b></td><td class="num">${sh === "pm" && +storeBy(rt.st[0])?.nddCnt ? storeBy(rt.st[0]).nddCnt : "—"}</td>
      <td class="rwarn">${w.map(esc).join("<br>")}</td><td><button class="btn small danger" data-act="rtDel" data-k="${k}" data-id="${rt.id}">刪</button></td></tr>`;
  }).join("");
  const ppl = list.reduce((a, r) => a + (+r.n || 1), 0), tot = list.reduce((a, r) => a + rtHrs(r), 0);
  const banList = bans().filter(([a, b]) => storeBy(a)?.hub === S.hub || storeBy(b)?.hub === S.hub);
  const sopt = hubSt.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
  return `<div class="ovbar">${Object.entries(RSET).map(([kk, v]) => `<button class="ovtab ${k === kk ? "on" : ""}" data-act="rset" data-k="${kk}">${v}</button>`).join("")}</div>
  <div class="card"><h3>${RSET[k]}路線・${esc(hub?.name)}</h3>
    <div class="row" style="margin-bottom:10px">
      <button class="btn primary" data-act="rtGen" data-k="${k}">⚙️ 自動產生路線</button>
      <button class="btn" data-act="rtGenAll">全部主要門市早晚班一起產生</button>
      <label class="small">每人最多跑 早班 <select data-ch="maxSh" data-k="maxAm">${[2, 3].map(v => `<option ${maxOf("am") === v ? "selected" : ""}>${v}</option>`).join("")}</select> 間・晚班 <select data-ch="maxSh" data-k="maxPm">${[1, 2, 3].map(v => `<option ${maxOf("pm") === v ? "selected" : ""}>${v}</option>`).join("")}</select> 間</label>
      <label class="small">在店時數低於 <input type="number" min="0" max="8" step="0.1" value="${supBelow()}" data-ch="supBelow" style="width:54px"> 小時的路線加一間支援門市（0＝不加）</label>
      <button class="btn" data-act="rtNew" data-k="${k}">＋ 手動新增路線</button>
      <label class="btn" for="rtFile">匯入路線 Excel…</label><input type="file" id="rtFile" data-ch="storeFile" accept=".xlsx,.xls" hidden>
      <span class="spacer"></span>
      <span>${list.length} 條・<b>${ppl}</b> 人・每班合計 <b>${fmtH(tot)}</b> 小時・每人平均 <b>${ppl ? fmtH(tot / ppl) : "—"}</b> 小時${nWarn ? `・<b class="bad">${nWarn}</b> 條要注意` : ""}</span>
    </div>
    <div class="scrollx"><table class="list rt"><tr><th>代號</th><th>人數</th><th>門市（1 先做；◀ 往前、✕ 移出）</th><th>間數</th><th>在店時數</th><th>每人在店時數</th><th>第1間<br>NDD打包數</th><th>提醒</th><th></th></tr>
      ${rows || `<tr><td colspan="9" class="muted" style="padding:16px">還沒有路線。按「⚙️ 自動產生路線」，系統會照門市資料排好。</td></tr>`}</table></div>
    ${unrouted.length ? `<p><b class="bad">還沒排進路線的門市（${unrouted.length}）：</b>${unrouted.map(s => esc(s.name)).join("、")}<br><span class="muted small">自動排班時，這些店會照距離另外分組。</span></p>` : list.length ? `<p class="good small">這間主要門市的門市都排進路線了 ✓</p>` : ""}
    <p class="muted small" style="line-height:1.8"><b>自動產生路線</b>：照「3. 門市」的 workload（換算在店時數）、NDD 打包數、HD，把同一間主要門市底下的店分組——晚班每人最多 2 間、早班最多 3 間；HD 店、晚班有 NDD 寄件的店排第一間，每條最多 1 間；每人最多跑幾間照上面的設定（早班 2 或 3 間、晚班 2 間），路線數用最少的，再依 workload 平均分配，讓每條路線的在店時數盡量接近；在店時數低於設定的路線，會再加一間「接受支援」的門市（支援不算在每人最多間數裡；只支援每班在店時數也達門檻的店，每家每班最多 1 人支援）（3. 門市勾選；預設福壽、昌盛、中信、公園、福德、化成、頭前），只找同一間主要門市的；「不排一起」的店不會排在一起。產生後可以再手動調整（例如加人）。<br>在店時數＝每家店「每班在店時數」加總（營運指標僅在店 ÷ 2，店名旁的小數字）；每人在店時數＝在店時數 ÷ 人數。<br>
      提醒規則：超過每人最多間數（支援不算）；晚班有 NDD 寄件的店、HD 店排第一間，每條最多各 1 間；下面設定的組合不排一起。只提醒，不會擋。<br>
      自動排班會照這裡的路線，把人排進每一條路線（重的路線先排），平日、假日都用同一套。</p></div>
  <div class="card"><h3>不排一起的門市</h3>
    <div class="row" style="margin-bottom:8px"><select id="banA">${sopt}</select>＋<select id="banB">${sopt}</select><button class="btn" data-act="banAdd">新增</button></div>
    ${banList.length ? `<div class="row">${banList.map(([a, b], i) => `<span class="rchip">${esc(sName(a))}＋${esc(sName(b))}<a data-act="banDel" data-a="${a}" data-b="${b}">✕</a></span>`).join("")}</div>` : `<p class="muted small">還沒有設定</p>`}</div>`;
}
/* ---------- 自動產生路線 ----------
   照門市資料（workload 換算的在店時數、HD、NDD 寄件）和規則把同一間主要門市底下的店分組，不設時數上限：
   - 每人最多幾間照設定（早班 2 或 3、晚班 2）；HD 店、晚班有 NDD 寄件的店要排第一間，每條路線最多 1 間這種店
   - 路線數用最少的：max（HD／NDD 店數，總間數 ÷ 每條最多間數）
   - 依 workload 平均分配：由重到輕，每家店放進目前時數最少、還有空位的路線（有座標時同樣條件下選近的）
   - 「不排一起」的組合不會排在同一條 */
function genRoutes(hub, sh, all = stores(), bl = bans(), supCnt = {}) {
  const maxSt = maxOf(sh);
  const L = all.filter(s => s.hub === hub && needs(s)).map(s => ({ s, h: shHrs(s) || 0.1 }));
  const head = x => x.s.hd || (sh === "pm" && isNdd(x.s));
  const ban = (r, s) => r.st.some(t => bl.some(([a, b]) => (a === t.id && b === s.id) || (a === s.id && b === t.id)));
  const heads = L.filter(head).sort((a, b) => b.h - a.h), tails = L.filter(x => !head(x)).sort((a, b) => b.h - a.h);
  const R = Math.max(heads.length, Math.ceil(L.length / maxSt));
  const routes = heads.map(x => ({ st: [x.s], h: x.h }));
  while (routes.length < R && tails.length) { const x = tails.shift(); routes.push({ st: [x.s], h: x.h }); }
  for (const x of tails) {
    let best = null, bv = Infinity;
    for (const r of routes) {
      if (r.st.length >= maxSt || ban(r, x.s)) continue;
      const d = km(r.st[0], x.s), v = r.h + (d == null ? 0 : d * 0.05);
      if (v < bv) { bv = v; best = r; }
    }
    if (best) { best.st.push(x.s); best.h += x.h; } else routes.push({ st: [x.s], h: x.h });
  }
  // 工作量低的路線：加一間同一間主要門市的「接受支援」門市（不算在每人最多間數裡）（同一間主要門市優先，支援人數少、時數大的先）
  // 只支援本身工作量夠大的店（每班在店時數 ≥ 門檻），避免輕的店互相支援；每家店每班最多 1 人支援
  const lim = supBelow(), supL = all.filter(s => s.hub === hub && needs(s) && isSup(s) && shHrs(s) >= lim);
  if (lim > 0 && supL.length) for (const r of [...routes].sort((a, b) => a.h - b.h)) {
    if (r.h >= lim) continue;
    const c = supL.filter(x => !r.st.includes(x) && !ban(r, x) && !(supCnt[x.id] >= 1)).sort((a, b) => ((b.hub === hub) - (a.hub === hub)) || shHrs(b) / (1 + (supCnt[b.id] || 0)) - shHrs(a) / (1 + (supCnt[a.id] || 0)))[0];
    if (c) { r.sup = [c.id]; supCnt[c.id] = (supCnt[c.id] || 0) + 1; }
  }
  const pre = sh === "pm" ? "N" : "R";
  return routes.sort((a, b) => b.h - a.h).map((r, i) => ({ id: uid("t"), code: pre + pad(i + 1), hub, st: r.st.map(s => s.id), sup: r.sup || [], n: 1 }));
}
function genAll(list, all = stores(), hs = hubs(), bl = bans(), base = M().routes || {}) {
  // list: [[k, hub]]；取代這幾間主要門市在這些班別的路線，代號同一班別全區連號
  const routes = { ...base }, hubOf = r => all.find(s => s.id === r.st?.[0])?.hub || r.hub;
  const cnt = { am: {}, pm: {} };
  for (const [k, hub] of list) routes[k] = [...(routes[k] || []).filter(r => hubOf(r) !== hub), ...genRoutes(hub, k.slice(3), all, bl, cnt[k.slice(3)])];
  for (const k of new Set(list.map(([k]) => k))) { const pre = k.endsWith("pm") ? "N" : "R"; routes[k] = hs.flatMap(h => routes[k].filter(r => hubOf(r) === h.id)).map((r, i) => ({ ...r, code: pre + pad(i + 1) })); }
  delete routes.we_am; delete routes.we_pm;
  return routes;
}
const applyGen = list => saveMaster({ routes: genAll(list) });
const setRoutes = (k, fn) => saveMaster({ routes: { ...(M().routes || {}), [k]: fn(allRoutes(k).map(r => ({ ...r, st: [...(r.st || [])] }))) } });
const editRoute = (k, id, fn) => setRoutes(k, l => l.map(r => r.id === id ? (fn(r), r) : r));

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
  const roster = emps().filter(e => e.active !== false).map(e => ({ id: e.id, name: e.name, group: hubBy(eHubs(e)[0])?.name || "其他" }));
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
    <div class="card"><h3>主要門市</h3>
      <div class="row" style="margin-bottom:8px"><input type="text" id="newHub" placeholder="主要門市名稱" style="width:160px"><button class="btn primary" data-act="addHub">新增主要門市</button></div>
      <table class="list">${hubRows || `<tr><td class="muted">還沒有主要門市</td></tr>`}</table>
      <p class="muted small">主要門市底下負責的門市，請到「門市」分頁新增。</p></div>
    <div class="card"><h3>自動排班條件</h3>
      <div class="rules">
        ${num("maxDays", "每人每週最多上幾天", "人員那邊可以個別設定")}
        ${num("maxConsec", "最多連續上幾天", "")}
      </div>
      <p class="muted small">沒填＝不限。每人每班跑哪幾家店由「4. 路線」決定（晚班最多 2 間、早班最多 3 間，依 workload 自動分配）。</p></div>
  </div><div>
    <div class="card"><h3>權限・${esc(S.reg?.name)}</h3>
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
  nddImg: () => openNddImport(),
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
  exportApollo: () => exportApollo(),
  pubSched: () => publishSchedule(),
  pubLink: () => { const u = schedLink(); navigator.clipboard?.writeText(u).then(() => toast("已複製員工查班網址"), () => prompt("請手動複製：", u)); },
  go: el => setTab(el.dataset.tab),
  goSettings: (el, e) => { e.preventDefault(); setTab("settings"); },
  goRoutes: (el, e) => { e.preventDefault(); setTab("routes"); },
  autoRun: async () => {
    watchMonths();
    for (let i = 0; i < 50 && !monthsReady(neededMonths()); i++) await new Promise(r => setTimeout(r, 100));
    if (!monthsReady(neededMonths())) { toast("班表載入中，請稍等一下再按"); return; }
    S.plan = autoPlan(); render();
  },
  autoCancel: () => { S.plan = null; render(); },
  autoSave: () => autoSave(),
  addHub: () => {
    const name = ($("#newHub")?.value || "").trim(); if (!name) return toast("請輸入主要門市名稱");
    if (hubs().some(h => h.name === name)) return toast("已經有同名的主要門市");
    const id = uid("h"); S.hub = id; ls.set("zq2-hub-" + S.rid, id);
    saveMaster({ hubs: [...hubs(), { id, name }] }); toast("已新增主要門市「" + name + "」");
  },
  hDel: el => {
    const h = hubBy(el.dataset.id), n = storesOf(h.id).length, m = empsOf(h.id).length;
    if (!confirm(`刪除主要門市「${h.name}」？${n ? `\n底下 ${n} 家門市也會一起刪除。` : ""}${m ? `\n${m} 位人員會移除這間主要門市。` : ""}`)) return;
    saveMaster({ hubs: hubs().filter(x => x.id !== h.id), stores: stores().filter(s => s.hub !== h.id) });
    if (m) saveEmps(emps().map(e => eHubs(e).includes(h.id) ? setHubs(e, eHubs(e).filter(x => x !== h.id)) : e));
  },
  addStore: () => {
    const name = ($("#newStore")?.value || "").trim(), addr = ($("#newStoreAddr")?.value || "").trim();
    if (!name) return toast("請輸入門市名稱");
    if (stores().some(s => s.name === name)) return toast("已經有同名的門市");
    if (S.hub === ALL) return toast("請先在上方選一間主要門市，再新增門市");
    saveMaster({ stores: [...stores(), { id: uid("s"), name, addr, hub: S.hub }] });
  },
  sOn: (el, e) => { e.preventDefault(); patchStore(el.dataset.id, { off: false, needAm: true, needPm: true }); },
  sDel: el => { const s = storeBy(el.dataset.id); if (confirm(`刪除門市「${s.name}」？`)) saveMaster({ stores: stores().filter(x => x.id !== s.id) }); },
  sMove: el => {
    const l = [...stores()], i = l.findIndex(s => s.id === el.dataset.id), dir = +el.dataset.n;
    let j = i + dir; while (j >= 0 && j < l.length && l[j].hub !== l[i].hub) j += dir;
    if (j < 0 || j >= l.length) return; [l[i], l[j]] = [l[j], l[i]]; saveMaster({ stores: l });
  },
  storePaste: () => openStorePaste(),
  storeTpl: () => storeTemplate(),
  addEmp: () => {
    const name = ($("#newEmp")?.value || "").trim(), code = ($("#newEmpCode")?.value || "").trim().toUpperCase();
    if (!name) return toast("請輸入姓名");
    saveEmps([...emps(), { id: uid("e"), name, code, hubs: [S.hub], shift: "any", active: true }]); toast("已新增 " + name);
  },
  eDel: el => { const e = empBy(el.dataset.id); if (confirm(`刪除「${e.name}」？只是離職的話，建議取消「啟用」就好。`)) saveEmps(emps().filter(x => x.id !== e.id)); },
  empClear: () => {
    const n = emps().length; if (!n) return toast("目前沒有人員");
    const t = prompt(`會刪除這個區域全部 ${n} 位人員（班表格子不會刪，但人員刪掉後不會再顯示）。\n確定的話請輸入「清空」：`);
    if (t === "清空") { saveEmps([]); toast(`已清空 ${n} 位人員`); }
  },
  eStores: el => openEmpStores(el.dataset.id),
  supReset: el => patchEmp(el.dataset.id, { stores: [] }),
  supAllSel: () => {
    const ph = S.supPeople ?? (S.hub === ALL ? "" : S.hub), sh = S.supStores ?? "";
    const cols = hubs().filter(h => !sh || h.id === sh).flatMap(h => storesOf(h.id).filter(needs)).map(x => x.id);
    const ids = new Set(emps().filter(e => e.active !== false && (ph === "" ? true : ph === "none" ? !eHubs(e).length : eHubs(e).includes(ph))).map(e => e.id));
    if (!confirm(`把篩選中的 ${ids.size} 人，畫面上的 ${cols.length} 家門市全部勾選？`)) return;
    saveEmps(emps().map(e => ids.has(e.id) ? { ...e, stores: [...new Set([...allowed(e), ...cols])] } : e));
  },
  supAllOwn: () => {
    const ph = S.supPeople ?? (S.hub === ALL ? "" : S.hub);
    const ids = new Set(emps().filter(e => ph === "" ? true : ph === "none" ? !eHubs(e).length : eHubs(e).includes(ph)).map(e => e.id));
    if (!confirm(`把篩選中的 ${ids.size} 人都恢復成「本區」（只去自己主要門市底下的門市）？`)) return;
    saveEmps(emps().map(e => ids.has(e.id) ? { ...e, stores: [] } : e));
  },
  eHubs: el => openEmpHubs(el.dataset.id),
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
  rset: el => { S.rset = el.dataset.k; ls.set("zq2-rset", S.rset); render(); },
  rtGen: el => {
    const k = el.dataset.k;
    if (routesOf(k, S.hub).length && !confirm(`會依門市資料重新產生「${hubBy(S.hub)?.name}」的${RSET[k]}路線，取代目前的路線（產生後還可以手動調整），確定？`)) return;
    applyGen(S.hub === ALL ? hubs().map(h => [k, h.id]) : [[k, S.hub]]).then(() => toast("已自動產生路線，可以再手動調整"));
  },
  rtGenAll: () => {
    if (!confirm("會依門市資料重新產生全部主要門市的早班、晚班路線，取代目前的路線，確定？")) return;
    applyGen(hubs().flatMap(h => [["wd_am", h.id], ["wd_pm", h.id]])).then(() => toast("已產生全部路線"));
  },
  rtNew: el => { if (S.hub === ALL) return toast("請先在上方選一間主要門市"); const k = el.dataset.k, pre = k.endsWith("pm") ? "N" : "R"; setRoutes(k, l => [...l, { id: uid("t"), code: pre + pad(l.length + 1), hub: S.hub, st: [], n: 1 }]); },
  rtDel: el => { if (confirm("刪除這條路線？")) setRoutes(el.dataset.k, l => l.filter(r => r.id !== el.dataset.id)); },
  rtMv: el => editRoute(el.dataset.k, el.dataset.id, r => { const j = +el.dataset.j; [r.st[j - 1], r.st[j]] = [r.st[j], r.st[j - 1]]; }),
  rtSupRm: el => editRoute(el.dataset.k, el.dataset.id, r => { r.sup = (r.sup || []).filter(x => x !== el.dataset.s); }),
  rtRm: el => editRoute(el.dataset.k, el.dataset.id, r => { r.st.splice(+el.dataset.j, 1); }),

  banAdd: () => {
    const a = $("#banA").value, b = $("#banB").value;
    if (!a || !b || a === b) return toast("請選兩家不同的門市");
    if (bans().some(([x, y]) => (x === a && y === b) || (x === b && y === a))) return toast("已經有這個組合");
    saveMaster({ ban: [...bans(), [a, b]] });
  },
  banDel: el => saveMaster({ ban: bans().filter(([x, y]) => !(x === el.dataset.a && y === el.dataset.b)) }),
};
const CH = {
  onlyMiss: t => { S.onlyMiss = t.checked; render(); },
  showAll: t => { S.showAllEmps = t.checked; render(); },
  autoStart: t => { if (t.value) { S.autoStart = t.value.replace(/-/g, ""); S.plan = null; watchMonths(); render(); } },
  autoDays: t => { S.autoDays = +t.value; S.plan = null; watchMonths(); render(); },
  autoMode: t => { S.autoMode = t.value; ls.set("zq2-automode", t.value); S.plan = null; render(); },
  hName: t => { const nm = t.value.trim(); if (!nm) return render(); saveMaster({ hubs: hubs().map(h => h.id === t.dataset.id ? { ...h, name: nm } : h) }); },
  rule: t => saveMaster({ rules: { ...rules(), [t.dataset.k]: t.value === "" ? 0 : +t.value } }),
  rName: t => { const nm = t.value.trim(); if (nm) S.store.set(`regions/${t.dataset.id}`, { name: nm }, true); },
  sName: t => { const nm = t.value.trim(); if (!nm || stores().some(s => s.name === nm && s.id !== t.dataset.id)) { toast("名稱空白或重複"); return render(); } patchStore(t.dataset.id, { name: nm }); },
  sAddr: t => { const id = t.dataset.id; patchStore(id, { addr: t.value.trim(), lat: null, lng: null }).then(() => setTimeout(() => autoLocate([storeBy(id)]), 500)); },
  sLoad: t => patchStore(t.dataset.id, { load: t.value === "" ? null : +t.value, loadAm: null, loadPm: null }),
  sHub: t => patchStore(t.dataset.id, { hub: t.value }),
  sNdd: t => patchStore(t.dataset.id, { nddCnt: t.value === "" ? null : +t.value }),
  sFlag: t => {
    // 「接受支援」第一次改：先把預設名單寫進每家店，避免其他店的預設消失
    if (t.dataset.k === "sup" && !stores().some(x => x.sup !== undefined)) return saveMaster({ stores: stores().map(x => ({ ...x, sup: x.id === t.dataset.id ? t.checked : isSup(x) })) });
    patchStore(t.dataset.id, { [t.dataset.k]: t.checked });
  },
  eName: t => { const nm = t.value.trim(); if (!nm) return render(); patchEmp(t.dataset.id, { name: nm }); },
  eCode: t => patchEmp(t.dataset.id, { code: t.value.trim().toUpperCase() }),
  eShift: t => patchEmp(t.dataset.id, { shift: t.value }),
  eMax: t => patchEmp(t.dataset.id, { maxDays: t.value === "" ? null : +t.value }),
  eAct: t => patchEmp(t.dataset.id, { active: t.checked }),
  eTr: t => patchEmp(t.dataset.id, { trainee: t.checked }),
  lvYm: t => { if (t.value) { S.leaveYm = t.value; render(); } },
  storeFile: t => { const f = t.files[0]; t.value = ""; if (f) importStoreFile(f); },
  infoFile: t => { const f = t.files[0]; t.value = ""; if (f) importStoreInfo(f); },
  supPeople: t => { S.supPeople = t.value; render(); },
  supStores: t => { S.supStores = t.value; render(); },
  sup: t => {
    const e = empBy(t.dataset.e), set = new Set(allowed(e));
    t.checked ? set.add(t.dataset.s) : set.delete(t.dataset.s);
    const own = new Set(eHubs(e).flatMap(h => storesOf(h).map(s => s.id)));
    const same = set.size === own.size && [...set].every(id => own.has(id));
    patchEmp(e.id, { stores: same ? [] : stores().map(s => s.id).filter(id => set.has(id)) });
  },
  restore: t => { const f = t.files[0]; t.value = ""; if (f) restore(f); },
  schedImp: t => { const f = t.files[0]; t.value = ""; if (f) importSchedFile(f); },
  maxSh: t => saveMaster({ rules: { ...rules(), [t.dataset.k]: +t.value } }),
  supBelow: t => saveMaster({ rules: { ...rules(), supBelow: t.value === "" ? 0 : +t.value } }),
  rtSup: t => { const v = t.value; if (v) editRoute(t.dataset.k, t.dataset.id, r => { r.sup = [...(r.sup || []), v]; }); },
  rtAdd: t => { const v = t.value; if (v) editRoute(t.dataset.k, t.dataset.id, r => { r.st.push(v); }); },
  rtCode: t => editRoute(t.dataset.k, t.dataset.id, r => { r.code = t.value.trim(); }),
  rtN: t => editRoute(t.dataset.k, t.dataset.id, r => { r.n = Math.max(1, +t.value || 1); }),
};
function onClick(e) {
  const el = e.target.closest("[data-act]");
  if (el && ACT[el.dataset.act]) ACT[el.dataset.act](el, e);
}
function onChange(e) { const t = e.target; if (t.dataset.ch && CH[t.dataset.ch]) CH[t.dataset.ch](t); }
function openRegionLater(id) { S.pendingRid = id; const t = setInterval(() => { if (S.regions?.some(r => r.id === id)) { clearInterval(t); openRegion(id); render(); } }, 200); setTimeout(() => clearInterval(t), 8000); }

/* ================= 存檔 ================= */
async function saveMaster(patch) {
  const m = { hubs: hubs(), stores: stores(), rules: rules(), importOnly: M().importOnly ?? "智取店", routes: M().routes || {}, ban: bans(), ...patch };
  try { await S.store.set(P("cfg", "master"), m); } catch (e) { toast("儲存失敗：" + e.message); }
}
const patchStore = (id, patch) => saveMaster({ stores: stores().map(s => s.id === id ? { ...s, ...patch } : s) });
async function saveEmps(list) { try { await S.store.set(P("cfg", "employees"), { list }); } catch (e) { toast("儲存失敗：" + e.message); } }
const setHubs = (e, hubs) => { const { hub, ...rest } = e; return { ...rest, hubs }; };
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
  let s = c.tr ? "tr" : c.s || "", sel = new Set(c.st || []), tr = c.tr || "";
  // 雙班：同一天另外再排一個班（早＋晚）
  let x2on = !!xOf(c), sel2 = new Set(xOf(c)?.st || []), note1 = c.n || "", note2 = xOf(c)?.n || "";
  const keepNotes = () => { const a = m.querySelector("#ceNote"), b = m.querySelector("#ceNote2"); if (a) note1 = a.value; if (b) note2 = b.value; };
  const draw = () => {
    const own = (eHubs(e).length ? eHubs(e) : [S.hub]).flatMap(storesOf), other = stores().filter(x => !own.includes(x));
    const o = s === "am" ? "pm" : "am";
    const cov = s === "am" || s === "pm" ? coverage(ds, s) : {}, cov2 = coverage(ds, o);
    const mk = (cv, sh, set, key) => x => { const by = (cv[x.id] || []).filter(p => p.id !== eid); return `<button class="pbtn ${set.has(x.id) ? "on" : ""} ${needs(x, sh) && !by.length && !set.has(x.id) ? "need" : ""}" data-${key}="${x.id}">${esc(x.name)}${by.length ? `<small>${esc(by.map(p => p.name).join("、"))}</small>` : needs(x, sh) ? "<small>沒人</small>" : ""}</button>`; };
    const btn = mk(cov, s, sel, "st"), btn2 = mk(cov2, o, sel2, "st2");
    const dbl = `<div class="dblbox"><label class="small"><input type="checkbox" id="ceX" ${x2on ? "checked" : ""}> 同一天另外排${SHIFT[o]}（雙班）</label>
      ${x2on ? `<div class="picker" style="margin-top:6px">${own.map(btn2).join("")}</div>
        ${other.length ? `<details style="margin-top:8px"><summary class="small muted" style="cursor:pointer">其他主要門市的門市（支援）</summary><div class="picker" style="margin-top:6px">${other.map(btn2).join("")}</div></details>` : ""}
        <input type="text" id="ceNote2" placeholder="${SHIFT[o]}備註（選填）" value="${esc(note2)}" style="width:100%;margin-top:8px">` : ""}</div>`;
    m.innerHTML = `<h2>${esc(e.name)}・${dLabel(ds)}</h2>
      ${av ? `<div class="avline">${AVL[av]}</div>` : ""}
      <div class="seg" style="margin:8px 0">${[["", "清空"], ["off", "休"], ["am", "早班"], ["pm", "晚班"], ["tr", "🎓 實習"]].map(([k, v]) => `<button class="${s === k ? "on" : ""}" data-s="${k}">${v}</button>`).join("")}</div>
      ${s === "tr" ? (() => { const ws = emps().filter(x => x.id !== eid && !x.trainee && (() => { const y = cell(ds, x.id); return y && (y.s === "am" || y.s === "pm") && !y.tr; })());
        return `<div class="sub">選帶班人員（這天有上班的人）：新人會跟他同一班、跑一樣的門市</div><div class="picker">${ws.map(x => { const y = cell(ds, x.id); return `<button class="pbtn ${tr === x.id ? "on" : ""}" data-tr="${x.id}">${esc(x.name)}<small>${SH1[y.s]}班 ${esc((y.st || []).map(sName).join("、"))}</small></button>`; }).join("") || `<span class="muted small">這天還沒有人排班，先排好帶班人員的班再來安排實習</span>`}</div>
        <input type="text" id="ceNote" placeholder="備註（選填，例：第 3 天實習）" value="${esc(note1)}" style="width:100%;margin-top:10px">`; })() : ""}
      ${s === "am" || s === "pm" ? `<div class="sub">選負責的門市（紅框＝這班還沒人負責）</div><div class="picker">${own.map(btn).join("")}</div>
        ${other.length ? `<details style="margin-top:8px"><summary class="small muted" style="cursor:pointer">其他主要門市的門市（支援）</summary><div class="picker" style="margin-top:6px">${other.map(btn).join("")}</div></details>` : ""}
        <input type="text" id="ceNote" placeholder="備註（選填）" value="${esc(note1)}" style="width:100%;margin-top:10px">${dbl}` : ""}
      <div class="actions"><span class="spacer"></span><button class="btn" data-x="cancel">取消</button><button class="btn primary" data-x="save">儲存</button></div>`;
  };
  const m = openModal("", "");
  draw();
  m.onclick = async ev => {
    if (ev.target.id === "ceX") { keepNotes(); x2on = ev.target.checked; draw(); return; }
    const b = ev.target.closest("button"); if (!b) return;
    if (b.dataset.s !== undefined) { keepNotes(); if ((s === "am" || s === "pm") && (b.dataset.s === "am" || b.dataset.s === "pm") && b.dataset.s !== s) sel2 = new Set(); s = b.dataset.s; draw(); return; }
    if (b.dataset.st) { keepNotes(); sel.has(b.dataset.st) ? sel.delete(b.dataset.st) : sel.add(b.dataset.st); draw(); return; }
    if (b.dataset.st2) { keepNotes(); sel2.has(b.dataset.st2) ? sel2.delete(b.dataset.st2) : sel2.add(b.dataset.st2); draw(); return; }
    if (b.dataset.tr) { keepNotes(); tr = b.dataset.tr; draw(); return; }
    if (b.dataset.x === "cancel") return closeModal();
    if (b.dataset.x === "save") {
      const note = (m.querySelector("#ceNote")?.value || "").trim();
      if (s === "tr" && !tr) return toast("請選帶班人員");
      const tc = s === "tr" ? cell(ds, tr) : null;
      const v = !s ? null : s === "off" ? { s: "off", st: [] } : s === "tr" ? { s: tc.s, st: [...(tc.st || [])], tr, ...(note ? { n: note } : {}) } : { s, st: [...sel], ...(note ? { n: note } : {}) };
      if ((s === "am" || s === "pm") && x2on) {
        if (!sel2.size) return toast(`雙班請選${SHIFT[s === "am" ? "pm" : "am"]}要跑的門市，或取消勾選`);
        const n2 = (m.querySelector("#ceNote2")?.value || "").trim();
        v.x = { s: s === "am" ? "pm" : "am", st: [...sel2], ...(n2 ? { n: n2 } : {}) };
      }
      if (await writeCell(ds, eid, v)) closeModal();
    }
  };
}
// 指派某家店（從漏排總覽點 ✕）
function openAssign(storeId, ds, sh) {
  const st = storeBy(storeId), cov = coverage(ds, sh)[storeId] || [];
  const pool = emps().filter(e => e.active !== false);
  const rowsOf = list => list.map(e => {
    const c = cell(ds, e.id), av = avOf(ds, e.id), p = onSh(c, sh), has = !!p && (p.st || []).includes(storeId);
    const busy = c && c.s && c.s !== "off" && !p;
    const info = has ? "已負責" : p ? `已排：${(p.st || []).map(sName).join("、")}` : c?.s === "off" ? "排休" : busy ? `已排${SHIFT[c.s]}（點了會加排雙班）` : "還沒排";
    return `<button class="pbtn ${has ? "on" : ""}" data-e="${e.id}" ${has ? "disabled" : ""}>${esc(e.name)}${avTag(av)}<small>${esc(info)}</small></button>`;
  }).join("");
  const own = pool.filter(e => eHubs(e).includes(st.hub) && (!e.shift || e.shift === "any" || e.shift === sh)), other = pool.filter(e => !own.includes(e));
  const m = openModal(`<h2>${esc(st.name)}・${dLabel(ds)} ${SHIFT[sh]}</h2>
    <div class="sub">${cov.length ? "目前負責：" + cov.map(e => esc(e.name)).join("、") : "目前沒有人負責，點一個人指派給他"}</div>
    <div class="picker">${rowsOf(own) || '<span class="muted small">這間主要門市沒有可以上這個班的人</span>'}</div>
    ${other.length ? `<details style="margin-top:8px"><summary class="small muted" style="cursor:pointer">其他人（支援）</summary><div class="picker" style="margin-top:6px">${rowsOf(other)}</div></details>` : ""}
    <div class="actions"><span class="spacer"></span><button class="btn" data-x="close">關閉</button></div>`);
  m.onclick = async ev => {
    const b = ev.target.closest("button"); if (!b || b.disabled) return;
    if (b.dataset.x) return closeModal();
    const eid = b.dataset.e; if (!eid) return;
    const c = cell(ds, eid);
    const add = p => ({ ...p, st: [...new Set([...(p.st || []), storeId])] });
    const v = c?.s === sh ? add(c) : xOf(c)?.s === sh ? { ...c, x: add(c.x) } : c && c.s && c.s !== "off" && !c.tr ? { ...c, x: { s: sh, st: [storeId] } } : { s: sh, st: [storeId] };
    if (await writeCell(ds, eid, v)) { closeModal(); toast(`已指派 ${empBy(eid).name}`); }
  };
}
// 某人的主要門市（可以多選）
function openEmpHubs(eid) {
  const e = empBy(eid), sel = new Set(eHubs(e));
  const draw = () => { m.innerHTML = `<h2>${esc(e.name)} 的主要門市</h2><div class="sub">可以選不只一間。自動排班時，這個人會出現在每一間主要門市的可排人員裡（同一天只會排一個班）。</div>
    <div class="picker">${hubs().map(h => `<button class="pbtn ${sel.has(h.id) ? "on" : ""}" data-h="${h.id}">${esc(h.name)}</button>`).join("")}</div>
    <div class="actions"><span class="spacer"></span><button class="btn" data-x="cancel">取消</button><button class="btn primary" data-x="save">儲存</button></div>`; };
  const m = openModal(""); draw();
  m.onclick = ev => {
    const b = ev.target.closest("button"); if (!b) return;
    if (b.dataset.h) { sel.has(b.dataset.h) ? sel.delete(b.dataset.h) : sel.add(b.dataset.h); draw(); return; }
    if (b.dataset.x === "cancel") return closeModal();
    if (b.dataset.x === "save") { saveEmps(emps().map(x => x.id === eid ? setHubs(x, hubs().map(h => h.id).filter(id => sel.has(id))) : x)); closeModal(); }
  };
}
// 某人可以去哪些門市
function openEmpStores(eid) {
  const e = empBy(eid); const sel = new Set(e.stores || []);
  const draw = () => { m.innerHTML = `<h2>${esc(e.name)} 可以去的門市</h2><div class="sub">都不選＝主要門市底下的每一家門市都可以。</div>
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
    <div class="sub">從 Excel 複製貼上，一行一家。欄位：<b>門市名稱</b>、<b>地址</b>、<b>工作量（整天）</b>（後面幾欄可以不填）。第一行是標題也沒關係。<br>同名的門市會更新地址和工作量。</div>
    <textarea id="spText" style="min-height:180px" placeholder="福壽\t新北市新莊區福壽街1號\t3649"></textarea>
    <div id="spPrev" class="small muted" style="margin-top:6px"></div>
    <div class="actions"><button class="btn" data-x="check">試算看看</button><span class="spacer"></span><button class="btn" data-x="cancel">取消</button><button class="btn primary" data-x="go">套用</button></div>`);
  const parse = () => {
    const lines = m.querySelector("#spText").value.split("\n").map(l => l.split(/\t|,|，/).map(x => x.trim())).filter(c => c[0]);
    let col = { name: 0, addr: 1, am: 2, pm: -1 };
    if (lines[0] && lines[0].some(c => /門市|店名|名稱/.test(c))) {
      const h = lines.shift(), f = re => h.findIndex(c => re.test(c));
      col = { name: f(/門市|店名|名稱/), addr: f(/地址/), am: f(/量/), pm: -1 };
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
      const list = stores().map(s => { const r = p.upd.find(x => x.name === s.name); return r ? { ...s, ...clean({ addr: r.addr, load: r.loadAm }) } : s; });
      for (const r of p.add) list.push({ id: uid("s"), hub: S.hub, ...clean({ name: r.name, addr: r.addr, load: r.loadAm }) });
      await saveMaster({ stores: list }); closeModal(); toast(`已新增 ${p.add.length} 家、更新 ${p.upd.length} 家`);
    }
  };
}
/* ---------- 門市 Excel 匯入 ----------
   欄位（順序不拘，看標題）：主要門市、門市名稱、地址、座標（或 緯度／經度）、早班工作量、晚班工作量、早班要排、晚班要排
   沒有「主要門市」欄 → 全部放到目前選的主要門市；有寫但系統沒有 → 自動新增那間主要門市 */
const STORE_COLS = { hub: /主要門市|母店/, name: /^(門市名稱|店名|門市|名稱)$/, addr: /地址/, xy: /座標/, lat: /緯度|lat/i, lng: /經度|lng|lon/i,
  load: /^(每日|整天|全天|日)?(平均)?工作量|^W\d*平均|^平均|^四週平均workload|^workload/i, loadAm: /早.*(工作量|量)/, loadPm: /晚.*(工作量|量)/, needAm: /早.*(要排|需排|排班)/, needPm: /晚.*(要排|需排|排班)/,
  ins: /^僅在店|在店時數/, nddCnt: /NDD寄件數|NDD打包數/i, hd: /^HD/i, pick: /純取件/, ndd: /^NDD寄件$/i, fbs: /^FBS寄件/i, rearr: /^重新分配$/, sup: /接受支援|支援門市/ };
function storeRowsFromAoa(aoa) {
  const hi = aoa.findIndex(r => (r || []).some(c => STORE_COLS.name.test(String(c ?? "").trim())));
  if (hi < 0) return null;
  const H = aoa[hi].map(c => String(c ?? "").trim()), col = {};
  for (const [k, re] of Object.entries(STORE_COLS)) { const i = H.findIndex((h, j) => re.test(h) && !Object.values(col).includes(j)); if (i >= 0) col[k] = i; }
  const yes = v => !/^(否|不|n|no|x|0|false)$/i.test(String(v ?? "").trim());
  const num = v => { const t = String(v ?? "").trim().replace(/,/g, ""); return t === "" || isNaN(+t) ? null : +t; };
  const flag = k => col[k] >= 0 ? (r => { const t = String(r[col[k]] ?? "").trim(); return !!t && !/^(—|-|否|無|n|no|x|0|false)$/i.test(t); }) : () => null;
  return aoa.slice(hi + 1).map(r => {
    const g = k => col[k] >= 0 ? r[col[k]] : undefined;
    const name = String(g("name") ?? "").trim(); if (!name) return null;
    const xy = parseXY(g("xy")) || (num(g("lat")) != null && num(g("lng")) != null ? { lat: num(g("lat")), lng: num(g("lng")) } : null);
    return { hubName: String(g("hub") ?? "").trim(), name, addr: String(g("addr") ?? "").trim(), ...(xy || {}),
      load: num(g("load")) ?? num(g("loadAm")) ?? num(g("loadPm")),
      needAm: col.needAm >= 0 && String(g("needAm") ?? "").trim() !== "" ? yes(g("needAm")) : null,
      needPm: col.needPm >= 0 && String(g("needPm") ?? "").trim() !== "" ? yes(g("needPm")) : null,
      ins: num(g("ins")), nddCnt: num(g("nddCnt")), ...Object.fromEntries(FLAGS.map(([k]) => [k, flag(k)(r)])) };
  }).filter(Boolean);
}
async function importStoreFile(file) {
  try {
    const X = await loadXLSX(), buf = await file.arrayBuffer();
    // 營運指標週報（分頁名稱像「智取2026_1019」）：直接讀最新一週的「僅在店」應排時數和 workload，不用先改 Excel
    const names = X.read(buf, { type: "array", bookSheets: true }).SheetNames;
    const kpiSheets = names.filter(n => /^智取\d{4}_\d{4}$/.test(n)).sort();
    if (kpiSheets.length) return importKpi(X, buf, kpiSheets[kpiSheets.length - 1], file.name);
    const wb = X.read(buf, { type: "array" });
    let rows = [];
    const rts = []; let banRows = null;
    for (const n of wb.SheetNames) {
      const aoa = X.utils.sheet_to_json(wb.Sheets[n], { header: 1, blankrows: false, raw: false });
      if (/說明/.test(n)) continue;
      if (/路線/.test(n)) { rts.push(...routeRowsFromAoa(aoa, /晚/.test(n) ? "pm" : "am")); continue; }
      if (/不排一起/.test(n)) { banRows = aoa.slice(1).map(r => [String(r?.[0] ?? "").trim(), String(r?.[1] ?? "").trim()]).filter(([a, b]) => a && b && a !== b); continue; }
      const r = storeRowsFromAoa(aoa); if (r) rows.push(...r);
    }
    if (!rows.length && !rts.length) return toast("找不到門市資料：第一行要有「門市名稱」這個標題，可以先下載公版 Excel 照著填");
    const rtCnt = Object.keys(RSET).map(k => [k, rts.filter(r => r.k === k).length]).filter(([, n]) => n);
    const curHub = hubBy(S.hub)?.name || "";
    const newHubs = [...new Set(rows.map(r => r.hubName).filter(h => h && !hubs().some(x => x.name === h)))];
    const exist = r => stores().find(s => s.name === r.name);
    const m = openModal(`<h2>匯入門市</h2><div class="sub">檔案：${esc(file.name)}・讀到 <b>${rows.length}</b> 家（新增 ${rows.filter(r => !exist(r)).length}、更新 ${rows.filter(exist).length}）
      ${newHubs.length ? `<br>會新增主要門市：<b>${newHubs.map(esc).join("、")}</b>` : ""}${rows.some(r => !r.hubName) ? `<br>沒寫主要門市的放到「${esc(curHub)}」` : ""}</div>
      ${rtCnt.length ? `<div class="hint"><label><input type="checkbox" id="impRt" checked> 也匯入路線：${rtCnt.map(([k, n]) => `${RSET[k]} ${n} 條`).join("、")}（會取代這幾間主要門市原本的路線）</label></div>` : ""}
      ${banRows ? `<div class="hint"><label><input type="checkbox" id="impBan" checked> 也匯入「不排一起」：${banRows.length ? banRows.map(([a, b]) => `${esc(a)}＋${esc(b)}`).join("、") : "（空白，會清空）"}（會取代原本的設定）</label></div>` : ""}
      ${rows.length && !rtCnt.length ? `<div class="hint"><label><input type="checkbox" id="impGen" checked> 匯入後依新數據<b>自動重新產生全部路線</b>（早班、晚班；會取代目前的路線）</label></div>` : ""}
      ${rows.length ? `<div class="scrollx" style="max-height:320px;overflow:auto"><table class="list"><tr><th>主要門市</th><th>門市</th><th>地址</th><th>workload</th><th>NDD打包數</th><th>服務</th><th></th></tr>
      ${rows.map(r => `<tr><td>${esc(r.hubName || curHub)}</td><td>${esc(r.name)}</td><td class="small">${esc(r.addr)}</td><td>${r.load ?? ""}</td><td>${r.nddCnt ?? ""}</td><td class="small">${FLAGS.filter(([k]) => r[k]).map(([, v]) => v).join("、")}</td><td>${exist(r) ? '<span class="muted">更新</span>' : '<span style="color:var(--ok)">新增</span>'}</td></tr>`).join("")}</table></div>` : ""}
      <div class="actions"><span class="spacer"></span><button class="btn" data-x="cancel">取消</button><button class="btn primary" data-x="go">匯入</button></div>`);
    m.onclick = async ev => {
      const b = ev.target.closest("button"); if (!b) return;
      if (b.dataset.x === "cancel") return closeModal();
      if (b.dataset.x !== "go") return;
      const hs = [...hubs()];
      for (const n of newHubs) hs.push({ id: uid("h"), name: n });
      const hubId = n => n ? hs.find(h => h.name === n).id : S.hub;
      const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ""));
      const list = [...stores()];
      for (const r of rows) {
        // 有 NDD 打包數欄、沒有 NDD 寄件欄 → 由打包數決定（FBS 寄件跟著 NDD 寄件）
        if (r.nddCnt != null && r.ndd == null) { r.ndd = r.nddCnt > 0; if (r.fbs == null) r.fbs = r.ndd; }
        const patch = clean({ hub: hubId(r.hubName), addr: r.addr, lat: r.lat, lng: r.lng, load: r.load, needAm: r.needAm, needPm: r.needPm, ins: r.ins, nddCnt: r.nddCnt, ...Object.fromEntries(FLAGS.map(([k]) => [k, r[k]])) });
        const i = list.findIndex(s => s.name === r.name);
        if (i >= 0) list[i] = { ...list[i], ...patch }; else list.push({ id: uid("s"), name: r.name, ...patch });
      }
      const patch = { hubs: hs, stores: list };
      let rtMsg = "", miss = new Set();
      if (rtCnt.length && $("#impRt")?.checked) {
        const idOf = nm => list.find(s => s.name === nm)?.id;
        const routes = { ...(M().routes || {}) };
        for (const [k] of rtCnt) {
          const add = rts.filter(r => r.k === k).map(r => { const st = r.names.map(nm => idOf(nm) || (miss.add(nm), null)).filter(Boolean); return { id: uid("t"), code: r.code, n: r.n, st, hub: list.find(s => s.id === st[0])?.hub }; }).filter(r => r.st.length);
          const hset = new Set(add.map(r => r.hub));
          routes[k] = [...(routes[k] || []).filter(r => !hset.has(list.find(s => s.id === r.st?.[0])?.hub || r.hub)), ...add];
        }
        delete routes.we_am; delete routes.we_pm;
        patch.routes = routes; rtMsg = `、${rts.length} 條路線`;
      }
      const doGen = !!$("#impGen")?.checked;
      if (banRows && $("#impBan")?.checked) {
        const idOf = nm => list.find(s => s.name === nm)?.id;
        patch.ban = banRows.map(([a, b]) => [idOf(a), idOf(b)]).filter(([a, b]) => a && b);
        rtMsg += `、${patch.ban.length} 組不排一起`;
      }
      if (doGen) { patch.routes = genAll(hs.flatMap(h => [["wd_am", h.id], ["wd_pm", h.id]]), list, hs, patch.ban || bans()); rtMsg += "，已自動產生全部路線"; }
      await saveMaster(patch); closeModal();
      toast(`已匯入 ${rows.length} 家門市${rtMsg}${newHubs.length ? `，新增 ${newHubs.length} 間主要門市` : ""}${miss.size ? `；找不到門市：${[...miss].join("、")}` : ""}`);
    };
  } catch (e) { toast("讀取失敗：" + e.message); }
}
/* ---------- 營運指標週報匯入 ---------- */
function kpiFromAoa(aoa) {
  const top = aoa.slice(0, 15), find = re => { for (let r = 0; r < top.length; r++) for (let c = 0; c < (top[r] || []).length; c++) if (re.test(String(top[r][c] ?? ""))) return [r, c]; return null; };
  const avgCol = hit => { if (!hit) return -1; for (let r = hit[0]; r < top.length; r++) for (let c = hit[1]; c < hit[1] + 8; c++) if (/^Avg\s*4W/i.test(String(top[r]?.[c] ?? "").trim())) return c; return -1; };
  const insC = avgCol(find(/僅在店/)), wlC = avgCol(find(/^Workload|^工作量$/i));
  if (insC < 0) return null;
  // 門市名稱欄：「- 智取店」最多的那一欄
  const cnt = {};
  for (const r of aoa) (r || []).forEach((v, c) => { if (/-\s*智取店\s*$/.test(String(v ?? ""))) cnt[c] = (cnt[c] || 0) + 1; });
  const nc = +Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!(nc >= 0)) return null;
  const out = [];
  for (const r of aoa) {
    const raw = String(r?.[nc] ?? "").trim(); if (!/-\s*智取店$/.test(raw)) continue;
    let nm = raw.replace(/\s*-\s*智取店$/, "").trim(), dist = "";
    for (let c = Math.max(0, nc - 6); c < nc + 6; c++) { const v = String(r[c] ?? "").trim(); if (/^.{1,3}區$/.test(v) && nm.startsWith(v.slice(0, -1))) { dist = v; nm = nm.slice(v.length - 1); break; } }
    const num = v => { const t = String(v ?? "").replace(/,/g, "").trim(); return t === "" || isNaN(+t) ? null : +t; };
    out.push({ raw, nm, dist, ins: num(r[insC]), wl: wlC >= 0 ? num(r[wlC]) : null });
  }
  return out;
}
async function importKpi(X, buf, sheet, fname) {
  const wb = X.read(buf, { type: "array", sheets: [sheet] });
  const rows = kpiFromAoa(X.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, blankrows: false, raw: true }));
  if (!rows || !rows.length) return toast(`「${sheet}」裡找不到「僅在店」應排時數`);
  // 同名的店可能在別的區（例：三重中興）→ 優先用大部分店所在的行政區
  const cands = s => rows.filter(r => r.nm === s.name);
  const dc = {}; for (const s of stores()) { const c = cands(s); if (c.length === 1) dc[c[0].dist] = (dc[c[0].dist] || 0) + 1; }
  const mainD = Object.entries(dc).sort((a, b) => b[1] - a[1])[0]?.[0];
  const hit = stores().filter(needs).map(s => { const c = cands(s); return [s, c.find(r => r.dist === mainD) || c[0]]; });
  const ok = hit.filter(([, r]) => r && r.ins != null), miss = hit.filter(([, r]) => !r || r.ins == null).map(([s]) => s.name);
  const f = v => v == null || v === "" ? "—" : v;
  const m = openModal(`<h2>匯入營運指標</h2><div class="sub">檔案：${esc(fname)}・分頁：<b>${esc(sheet)}</b>（最新一週）<br>
      對到 <b>${ok.length}</b> 家門市，會更新 workload（Avg 4W），每班在店時數會自動重算。
      ${miss.length ? `<br><span style="color:var(--warn)">找不到資料：${miss.map(esc).join("、")}（新店還沒有資料是正常的，會保留原本的數字）</span>` : ""}</div>
    <div class="scrollx" style="max-height:340px;overflow:auto"><table class="list"><tr><th>門市</th><th>workload</th><th>每班在店時數</th></tr>
      ${ok.map(([s, r]) => `<tr><td>${esc(s.name)}</td><td>${r.wl != null ? `${f(s.load)} → <b>${Math.round(r.wl)}</b>` : f(s.load)}</td><td>${r.wl != null ? fmtH(r.wl / WL_RATE / 2) : "—"}</td></tr>`).join("")}</table></div>
    <div class="actions"><span class="spacer"></span><button class="btn" data-x="cancel">取消</button><button class="btn primary" data-x="go">更新</button></div>`);
  m.onclick = async ev => {
    const b = ev.target.closest("button"); if (!b) return;
    if (b.dataset.x === "cancel") return closeModal();
    if (b.dataset.x !== "go") return;
    const map = new Map(ok.map(([s, r]) => [s.id, r]));
    await saveMaster({ stores: stores().map(s => { const r = map.get(s.id); return r ? { ...s, ins: r.ins, ...(r.wl != null ? { load: Math.round(r.wl), loadAm: null, loadPm: null } : {}), kpiAt: sheet } : s; }) });
    closeModal(); toast(`已更新 ${ok.length} 家門市的 workload（${sheet}）`);
  };
}
// 路線表：A 欄代號（R01／N01…）、B 欄人數、D～G 欄門市（第一間先做）；早晚班各一套，不分平日假日（舊檔的「假日」區塊、H 開頭的路線略過）
function routeRowsFromAoa(aoa, sh) {
  let we = false; const out = [];
  for (const r of aoa) {
    const a = String(r?.[0] ?? "").trim();
    if (/假日/.test(a)) { we = true; continue; } else if (/平日|^早班$|^晚班$/.test(a)) we = false;
    if (!/^[A-Z]{1,2}\d{1,3}$/i.test(a)) continue;
    const names = (r.slice(3, 7) || []).map(x => String(x ?? "").trim()).filter(Boolean);
    if (!names.length) continue;
    if (we || /^H/i.test(a)) continue;
    out.push({ k: `wd_${sh}`, code: a, n: Math.max(1, +r[1] || 1), names });
  }
  return out;
}
async function storeTemplate() {
  // 公版：只要填 workload、NDD 打包數（HD、純取件、重新分配設定一次就好）；在店時數和路線由系統自動算
  const X = await loadXLSX(), wb = X.utils.book_new();
  const has = v => v ? "有" : "";
  const info = [["智取店排班系統・公版 Excel"], [""], ["每次只要更新「門市」頁的 workload（每天、四週平均）和 NDD打包數，再到網站「3. 門市」→「匯入 Excel…」選這個檔案。"],
    ["系統會自動換算每班在店時數（workload ÷ 350 ÷ 2），有 NDD 打包數就算有 NDD 寄件；匯入時勾「自動重新產生路線」就會依 workload 排好早晚班路線，再到「6. 自動排班」產生班表。"],
    ["HD門市、純取件店、重新分配、接受支援：有就填「有」，沒有留空（設定一次就好）。接受支援＝工作量低的路線可以加這家店去支援。新增門市就往下加一列。"], ["不排一起：兩家店不能排在同一條路線。"]];
  const w0 = X.utils.aoa_to_sheet(info); w0["!cols"] = [{ wch: 110 }]; X.utils.book_append_sheet(wb, w0, "說明");
  const head = ["主要門市", "門市名稱", "地址", "workload", "NDD打包數", "HD門市", "純取件店", "重新分配", "接受支援"];
  const list = stores().length ? hubs().flatMap(h => storesOf(h.id).filter(needs).map(s => [h.name, s.name, s.addr || "", s.load ?? s.loadAm ?? "", s.nddCnt ?? "", has(s.hd), has(s.pick), has(s.rearr), has(isSup(s))]))
    : [[hubBy(S.hub)?.name || "新莊榮華店", "範例門市", "新北市新莊區○○路1號", 1500, 120, "", "", "", ""]];
  const ws = X.utils.aoa_to_sheet([head, ...list]);
  ws["!cols"] = [14, 10, 36, 10, 11, 8, 8, 8, 8].map(w => ({ wch: w }));
  X.utils.book_append_sheet(wb, ws, "門市");
  const wbn = X.utils.aoa_to_sheet([["門市A", "門市B"], ...bans().filter(([a, b]) => storeBy(a) && storeBy(b)).map(([a, b]) => [sName(a), sName(b)])]);
  wbn["!cols"] = [{ wch: 12 }, { wch: 12 }]; X.utils.book_append_sheet(wb, wbn, "不排一起");
  X.writeFile(wb, `智取店排班_公版_${S.reg?.name || ""}.xlsx`);
}

// 依地址找座標（OpenStreetMap，免金鑰；台灣地址不一定找得到）
// 背景自動定位：用地址算座標（不用按按鈕）。每家店每次開網頁只試一次，找不到就照列表順序分組。
const triedXY = new Set();
async function autoLocate(list) {
  list = list.filter(s => s && s.addr && !hasXY(s) && !triedXY.has(s.id + s.addr));
  if (!list.length || S.locating) return;
  S.locating = true;
  try {
    for (const s of list) {
      triedXY.add(s.id + s.addr);
      const tries = [s.addr.replace(/\d+[、,]?\d*樓.*$/, ""), s.addr.replace(/[\d\-之]+號.*$/, "")];
      for (const q of [...new Set(tries)]) {
        try {
          const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=tw&accept-language=zh-TW&q=${encodeURIComponent(q)}`);
          const j = await r.json();
          if (j[0]) { const cur = storeBy(s.id); if (cur && cur.addr === s.addr) await patchStore(s.id, { lat: +j[0].lat, lng: +j[0].lon }); break; }
        } catch {}
        await new Promise(r => setTimeout(r, 1100));
      }
      await new Promise(r => setTimeout(r, 1100));
    }
  } finally { S.locating = false; }
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
  const txt1 = c => !c ? "" : c.s === "off" ? "休" : `${c.tr ? `實習（跟${empBy(c.tr)?.name || ""}）` : ""}${SH1[c.s]} ${(c.st || []).map(sName).join("、")}${c.n ? `（${c.n}）` : ""}`;
  const txt = c => xOf(c) ? txt1(c) + "\n" + txt1(c.x) : txt1(c);
  const rows = [[hubN, ...days.map(d => `${d.d}(${d.wd})`)]];
  for (const e of rowsFor(days, cell)) rows.push([e.name, ...days.map(d => txt(cell(d.ds, e.id)))]);
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(rows), "班表");
  const miss = [["", ...days.map(d => `${d.d}(${d.wd})`)]];
  for (const sh of ["am", "pm"]) miss.push([`${SHIFT[sh]}漏排`, ...days.map(d => missing(d.ds, sh, S.hub).map(s => s.name).join(" ") || "✓")]);
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(miss), "漏排");
  X.writeFile(wb, `排班_${hubN}_${S.ym}.xlsx`);
}
// ───────── 匯出 Apollo 班表匯入檔（格式＝Apollo「班表匯入範本」的「匯入檔」分頁） ─────────
// 規則：
//  - 每人每天一列；不填任何「支援單位代碼」（填了 Apollo 腳本就無法再調整當天上下班時間）
//  - 早班固定 08:30 起算、晚班固定 17:30 起算；下班時間＝上班時間＋當天路線所需時數（往上取整到 15 分）
//  - 班次代碼只決定薪資的時數級別，一律依所需時數往上選：≤4 小時→4hr、≤6 小時→6hr、其餘→8hr
//    （班次給太低，薪資就只算那麼多小時）；匯入後上下班時間可在 Apollo 自由調整
//  - 路線所需時數＝cellHrs（在店時數，支援的店不算、同店多人平分）；移動時間先不計
const APOLLO = {
  amStart: "08:30", pmStart: "17:30",
  am: { 4: "A40830", 6: "A60830", 8: "A80830" },   // 早4／早6／早8 (08:30)
  pm: { 4: "C41730", 6: "C61730", 8: "B81600" },   // 晚4／晚6 (17:30)；晚班超過 6 小時用午8（範本午8 最晚 16:00，開始時間匯入後可調）
  work: "W0001", off: "H0001",                    // 上班／休假日（要改成休息日就用 H0002）
  noHours: 4,                                      // 算不出時數（門市沒有 workload）時先給的小時數
};
function apolloRow(code, name, ds, c, hrs) {
  const date = `${ds.slice(0, 4)}/${ds.slice(4, 6)}/${ds.slice(6, 8)}`;
  if (c.s === "off") return [code, name, date, APOLLO.off];
  const start = c.s === "am" ? APOLLO.amStart : APOLLO.pmStart, sm = +start.slice(0, 2) * 60 + +start.slice(3);
  const mins = Math.max(15, Math.ceil(hrs * 4 - 1e-6) * 15);         // 往上取整到 15 分
  const tier = mins <= 240 ? 4 : mins <= 360 ? 6 : 8, em = (sm + mins) % 1440;
  const hm = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return [code, name, date, APOLLO.work, APOLLO[c.s][tier], start, hm(em)];
}
async function exportApollo() {
  const days = monthDays(S.ym), hubN = hubBy(S.hub)?.name || "";
  const memo = {}, cov = (ds, sh) => memo[ds + sh] ||= coverage(ds, sh, cell);
  const noCode = new Set(), noHrs = [], rows = [];
  for (const e of rowsFor(days, cell)) {
    for (const d of days) {
      let c = cell(d.ds, e.id);
      if (!c || !c.s) continue;
      if (!e.code) { noCode.add(e.name); continue; }
      if (c.s === "off") { rows.push(apolloRow(e.code, e.name, d.ds, c, 0)); continue; }
      // 雙班：早、晚各一列
      for (const part of [c, xOf(c)].filter(Boolean)) {
        // 實習：沿用帶班人員當天同一班的時數
        const m = part.tr ? onSh(cell(d.ds, part.tr), part.s) : part;
        let hrs = m ? cellHrs(m, d.ds, cov, cell).reduce((a, b) => a + b, 0) : 0;
        if (!(hrs > 0)) { hrs = APOLLO.noHours; noHrs.push(`${e.name} ${d.ds.slice(4, 6)}/${d.ds.slice(6, 8)}`); }
        rows.push(apolloRow(e.code, e.name, d.ds, part, hrs));
      }
    }
  }
  if (!rows.length) return toast("這個月沒有可匯出的班表（或人員都沒有工號）");
  const warn = [];
  if (noCode.size) warn.push(`${noCode.size} 位沒有工號，不會匯出：${[...noCode].join("、")}`);
  if (noHrs.length) warn.push(`${noHrs.length} 筆算不出所需時數（門市沒有 workload），先給 ${APOLLO.noHours} 小時：${noHrs.slice(0, 8).join("、")}${noHrs.length > 8 ? "…" : ""}`);
  if (warn.length && !confirm(warn.join("\n") + "\n\n仍要匯出？")) return;
  const head = ["*工號", "姓名", "*日期(YYYY/MM/DD)", "*狀態代碼", "班次代碼", "上班時間(HH:mm)", "下班時間(HH:mm)", "休息時間(hh:mm~hh:mm；如有多組以\",\"分隔)", "全天支援單位代碼"];
  for (let i = 1; i <= 15; i++) head.push(`(${i})支援單位代碼`, `(${i})支援起時-hh:mm`, `(${i})支援迄時-hh:mm`);
  const X = await loadXLSX(), wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([head, ...rows]), "匯入檔");
  X.writeFile(wb, `Apollo匯入_${hubN}_${S.ym}.xlsx`);
  toast(`已匯出 ${rows.length} 列${warn.length ? "（有提醒，請確認）" : ""}`);
}
// ───────── 匯入排班 Excel（新莊排班表格式）─────────
// 讀「新莊排班表」格式（每間主要門市一段「XX店-早班／晚班」，B 欄姓名、C 欄起每天一格）
function parseSchedBook(X, buf, ym, ctx) {
  const { hubs, stores, emps } = ctx;
  const wb = X.read(buf, { type: "array" });
  const norm = s => String(s || "").replace(/\s+/g, "").replace(/^新莊/, "").replace(/店$/, "");
  const hubOf = t => { const k = norm(t); return hubs.find(h => norm(h.name) === k) || hubs.find(h => norm(h.name).includes(k) || k.includes(norm(h.name))); };
  const byLen = [...stores].sort((a, b) => b.name.length - a.name.length);
  const [Y, Mo] = ym.split("-").map(Number), nDays = new Date(Y, Mo, 0).getDate();
  const toDs = d => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const serial = v => v instanceof Date ? Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()) : typeof v === "number" ? Date.UTC(1899, 11, 30) + Math.round(v) * 864e5 : null;
  const out = { rows: [], unknownHub: [], unknownSt: {}, sheet: "" };
  for (const sn of wb.SheetNames) {
    const a = X.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null });
    if (!a.some(r => r && r[1] === "門市人員")) continue;
    out.sheet = sn;
    let hub = null, sh = null, base = null, inBlock = false;
    for (const r of a) {
      if (!r) { inBlock = false; continue; }
      const c0 = String(r[0] ?? "").trim(), c1 = String(r[1] ?? "").trim();
      const tm = c0.match(/^(.+?)[-－—]\s*(早班|晚班)/);
      if (tm) { const h = hubOf(tm[1]); hub = h?.id || null; sh = tm[2] === "早班" ? "am" : "pm"; if (!h) out.unknownHub.push(tm[1]); inBlock = false; continue; }
      if (c1 === "門市人員") { base = serial(r[2]); inBlock = base != null; continue; }
      if (!inBlock) continue;
      if (!c1) { if (r.slice(2).every(v => v == null || v === "")) inBlock = false; continue; }
      if (/^[一二三四五六日]$/.test(String(r[2] ?? ""))) continue;
      const days = {};
      for (let i = 2; i < r.length; i++) {
        const v = r[i]; if (v == null || String(v).trim() === "") continue;
        const d = new Date(base + (i - 2) * 864e5);
        if (d.getUTCFullYear() !== Y || d.getUTCMonth() + 1 !== Mo) continue;
        days[toDs(d)] = String(v).trim();
      }
      out.rows.push({ name: c1, wage: c0, hub, sh, days });
    }
    break;
  }
  if (!out.sheet) return { error: "找不到排班表（要有「門市人員」那一列）" };
  // 姓名對應：全名直接對；兩個字的小名對到全名結尾相同的人（系統名單優先，再找檔案裡的全名）
  const fileFull = [...new Set(out.rows.map(r => r.name).filter(n => n.length >= 3))];
  const resolve = n => {
    const e = emps.find(x => x.name === n); if (e) return { emp: e, name: n };
    if (n.length <= 2) {
      const es = emps.filter(x => x.name.length > n.length && x.name.endsWith(n)); if (es.length === 1) return { emp: es[0], name: es[0].name };
      const fs = fileFull.filter(x => x.endsWith(n)); if (fs.length === 1) { const e2 = emps.find(x => x.name === fs[0]); return e2 ? { emp: e2, name: fs[0] } : { name: fs[0] }; }
    }
    return { name: n };
  };
  const parseCell = (t, sh0, hub) => {
    if (/^[xX×✕]$/.test(t) || /^(休|例休|休假|特休|請假|病假|事假|喪假|婚假|公休)/.test(t)) return { s: "off", st: [] };
    let s = sh0;
    if (/[（(]\s*早\s*[)）]/.test(t)) s = "am"; else if (/[（(]\s*晚\s*[)）]/.test(t)) s = "pm";
    const sup = /支援/.test(t);
    const body = t.replace(/[（(][^)）]*[)）]/g, " ").replace(/\+?\s*支援/g, " ");
    const ids = [], bad = [];
    for (let tok of body.split(/[\s、,，+＋\/／]+/).filter(Boolean)) {
      while (tok) { const m = byLen.find(x => tok.startsWith(x.name)); if (!m) { bad.push(tok); break; } if (!ids.includes(m.id)) ids.push(m.id); tok = tok.slice(m.name.length); }
    }
    if (!ids.length && bad.length && bad.every(b => /^(早|晚)班?$/.test(b))) return null;
    bad.forEach(b => out.unknownSt[b] = (out.unknownSt[b] || 0) + 1);
    if (!ids.length && !bad.length) return null;
    const c = { s, st: ids };
    if (sup) { const sp = ids.filter(id => stores.find(x => x.id === id)?.hub !== hub); if (sp.length && sp.length < ids.length) c.sp = sp; }
    if (bad.length || (sup && !c.sp)) c.n = t;
    return c;
  };
  const people = new Map();
  let dbl = 0;
  for (const r of out.rows) {
    const res = resolve(r.name), key = res.emp ? res.emp.id : "new:" + res.name;
    let p = people.get(key);
    if (!p) people.set(key, p = { key, emp: res.emp || null, name: res.name, hub: r.hub, wage: r.wage, sh: r.sh, cells: {}, alias: new Set() });
    if (r.name !== res.name) p.alias.add(r.name);
    if (!p.wage && r.wage) { p.wage = r.wage; p.hub = r.hub; p.sh = r.sh; }
    for (const [ds, t] of Object.entries(r.days)) {
      const c = parseCell(t, r.sh, r.hub); if (!c) continue;
      const old = p.cells[ds];
      if (!old || old.s === "off") { if (!(old && c.s === "off")) p.cells[ds] = c; continue; }
      if (c.s === "off") continue;
      if (c.s === old.s) { c.st.forEach(id => old.st.includes(id) || old.st.push(id)); continue; }
      // 同一天早晚都有排：存成雙班（第二個班放 x）
      if (old.x) { if (old.x.s === c.s) c.st.forEach(id => old.x.st.includes(id) || old.x.st.push(id)); continue; }
      old.x = c; dbl++;
    }
  }
  // 雙班一律早班在前、晚班放 x
  for (const p of people.values()) for (const [ds, c] of Object.entries(p.cells)) if (c.x && c.s === "pm") { const { x, ...a } = c; p.cells[ds] = { ...x, x: a }; }
  return { sheet: out.sheet, unknownHub: [...new Set(out.unknownHub)], unknownSt: out.unknownSt, people: [...people.values()], dbl, nDays };
}

async function importSchedFile(file) {
  const ym = S.ym;
  let r;
  try { const X = await loadXLSX(); r = parseSchedBook(X, await file.arrayBuffer(), ym, { hubs: hubs(), stores: stores(), emps: emps() }); }
  catch (e) { return toast("讀取失敗：" + e.message); }
  if (r.error) return toast(r.error);
  const ppl = r.people.filter(p => Object.keys(p.cells).length);
  const known = ppl.filter(p => p.emp), fresh = ppl.filter(p => !p.emp);
  const nCells = ppl.reduce((n, p) => n + Object.keys(p.cells).length, 0);
  const unk = Object.entries(r.unknownSt).sort((a, b) => b[1] - a[1]);
  const [y, mo] = ym.split("-");
  const m = openModal(`<h2>匯入 ${y}年${+mo}月 班表</h2>
    <div class="sub">讀「${esc(r.sheet)}」分頁，只匯入 ${+mo} 月的日子（檔案裡其他月份不會動）。</div>
    <ul class="small" style="line-height:1.9;padding-left:18px">
      <li><b>${ppl.length}</b> 人、<b>${nCells}</b> 格（含休假）；其中 <b>${r.dbl}</b> 格是同一天早＋晚雙班</li>
      <li>已在人員名單：${known.length} 人</li>
      ${fresh.length ? `<li style="color:#b45309">名單上沒有的 ${fresh.length} 人：${fresh.map(p => esc(p.name) + (p.alias.size ? `（${esc([...p.alias].join("、"))}）` : "")).join("、")}</li>` : ""}
      ${r.unknownHub.length ? `<li style="color:#b91c1c">對不到主要門市：${r.unknownHub.map(esc).join("、")}</li>` : ""}
      ${unk.length ? `<li style="color:#b91c1c">對不到的門市名稱（會寫在格子備註）：${unk.map(([k, n]) => `${esc(k)}×${n}`).join("、")}</li>` : ""}
    </ul>
    ${fresh.length ? `<label class="small"><input type="checkbox" id="siNew" checked> 自動新增名單上沒有的人（主要門市照 Excel 區塊）</label><br>` : ""}
    <label class="small"><input type="checkbox" id="siClr"> 先清掉這些人 ${+mo} 月原本的班（Excel 空白的日子會變空白）</label>
    <p class="small muted">小名（例如「佳緯」）會對到同一個人的全名；「X」＝休；「(早)」「(晚)」會改成那一班；寫「支援」的格子，別間主要門市的店標成支援。</p>
    <div class="actions"><span class="spacer"></span><button class="btn" data-x="cancel">取消</button><button class="btn primary" data-x="go">匯入</button></div>`);
  m.onclick = async ev => {
    const b = ev.target.closest("button"); if (!b) return;
    if (b.dataset.x === "cancel") return closeModal();
    if (b.dataset.x !== "go") return;
    const addNew = !!m.querySelector("#siNew")?.checked, clr = !!m.querySelector("#siClr")?.checked;
    b.disabled = true;
    try {
      const idOf = new Map(known.map(p => [p.key, p.emp.id]));
      if (addNew && fresh.length) {
        const add = fresh.map(p => ({ id: uid("e"), name: p.name, code: "", hubs: [p.hub || realHub()], shift: /早班/.test(p.wage) ? "am" : /晚班/.test(p.wage) ? "pm" : "any", active: true }));
        fresh.forEach((p, i) => idOf.set(p.key, add[i].id));
        await S.store.set(P("cfg", "employees"), { list: [...emps(), ...add] });
      }
      const map = {}, days = monthDays(ym).map(d => d.ds);
      for (const p of ppl) {
        const eid = idOf.get(p.key); if (!eid) continue;
        if (clr) for (const ds of days) if (cell(ds, eid)) map[ds + "_" + eid] = null;
        for (const [ds, c] of Object.entries(p.cells)) map[ds + "_" + eid] = c;
      }
      await S.store.setCells(P("months", ym), map);
      closeModal(); toast(`已匯入 ${Object.values(map).filter(Boolean).length} 格`);
    } catch (e) { b.disabled = false; toast("匯入失敗：" + e.message); }
  };
}
// ───────── 匯入門市地址／類型（Excel／CSV）─────────
async function importStoreInfo(file) {
  let rows;
  try { const X = await loadXLSX(), wb = X.read(await file.arrayBuffer(), { type: "array" }); rows = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: "" }); }
  catch (e) { return toast("讀取失敗：" + e.message); }
  const hi = rows.findIndex(r => r.some(v => /門市|店名/.test(String(v))));
  if (hi < 0) return toast("找不到標題列（要有「門市」欄）");
  const H = rows[hi].map(v => String(v).replace(/\s/g, ""));
  const col = re => H.findIndex(h => re.test(h));
  const cName = H.findIndex(h => /^(門市|門市名稱|店名|智取店)$/.test(h)) >= 0 ? H.findIndex(h => /^(門市|門市名稱|店名|智取店)$/.test(h)) : col(/門市(?!.*(類型|地址))|店名/);
  const cAddr = col(/地址/), cHd = col(/^HD/i), cPick = col(/純取件/), cRe = col(/重新分配/), cType = col(/類型/);
  const yes = v => /^(v|y|yes|是|有|1|✓|✔|○|o|true)$/i.test(String(v).trim());
  const norm = n => String(n || "").replace(/\s/g, "").replace(/^(智取店?[-－_]?)/, "").replace(/店$/, "");
  const upd = new Map(), miss = [];
  for (const r of rows.slice(hi + 1)) {
    const nm = norm(r[cName]); if (!nm) continue;
    const st = stores().find(x => x.name === nm) || stores().find(x => norm(x.name) === nm);
    if (!st) { miss.push(nm); continue; }
    const p = {};
    if (cAddr >= 0 && String(r[cAddr]).trim()) p.addr = String(r[cAddr]).trim();
    const t = cType >= 0 ? String(r[cType]) : "";
    const flag = (k, c, re) => { if (c >= 0 && String(r[c]).trim() !== "") p[k] = yes(r[c]); else if (cType >= 0) p[k] = re.test(t); };
    flag("hd", cHd, /HD/i); flag("pick", cPick, /純取件/); flag("rearr", cRe, /重新分配/);
    if (Object.keys(p).length) upd.set(st.id, p);
  }
  if (!upd.size) return toast("沒有可以更新的門市" + (miss.length ? `（對不到：${miss.slice(0, 8).join("、")}）` : ""));
  const lines = [...upd].map(([id, p]) => { const st = storeBy(id); return `<tr><td>${esc(st.name)}</td><td class="small">${p.addr ? esc(p.addr) : "—"}</td>${["hd", "pick", "rearr"].map(k => `<td class="ctr">${k in p ? (p[k] ? "✓" : "✗") : "—"}</td>`).join("")}</tr>`; }).join("");
  const m = openModal(`<h2>匯入門市地址／類型</h2><div class="sub">會更新 <b>${upd.size}</b> 家門市（只改檔案裡有填的欄位）${miss.length ? `；<span style="color:#b91c1c">對不到 ${miss.length} 家：${miss.map(esc).join("、")}</span>` : ""}</div>
    <div class="scrollx" style="max-height:50vh;overflow:auto"><table class="list"><tr><th>門市</th><th>地址</th><th>HD</th><th>純取件</th><th>重新分配</th></tr>${lines}</table></div>
    <div class="actions"><span class="spacer"></span><button class="btn" data-x="cancel">取消</button><button class="btn primary" data-x="go">更新</button></div>`);
  m.onclick = async ev => {
    const b = ev.target.closest("button"); if (!b) return;
    if (b.dataset.x === "cancel") return closeModal();
    if (b.dataset.x !== "go") return;
    b.disabled = true;
    await saveMaster({ stores: stores().map(x => upd.has(x.id) ? { ...x, ...upd.get(x.id), ...(upd.get(x.id).addr && upd.get(x.id).addr !== x.addr ? { lat: null, lng: null } : {}) } : x) });
    closeModal(); toast(`已更新 ${upd.size} 家門市`);
  };
}

// ───────── 匯入 NDD 打包數（截圖辨識，或貼上文字）─────────
// 在瀏覽器用 Tesseract.js 辨識繁中＋數字；找每一行裡的門市名稱，取名稱後面第一個數字。辨識結果一律先進預覽，可以手動改。
function parseNddText(text, list) {
  const out = {}, byLen = [...list].sort((a, b) => b.name.length - a.name.length);
  const t = String(text).replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 65248)).replace(/[ \t]+/g, " ");
  for (const line of t.split(/\n/)) {
    const L = line.replace(/\s/g, "");
    let used = "";
    for (const s of byLen) {
      const i = L.indexOf(s.name); if (i < 0 || used.includes(s.name)) continue;
      used += s.name;
      const m = L.slice(i + s.name.length).match(/\d[\d,]*/);
      if (m) out[s.id] = +m[0].replace(/,/g, "");
    }
  }
  return out;
}
let tessP = null;
const loadTess = () => tessP ||= new Promise((ok, ng) => { if (window.Tesseract) return ok(window.Tesseract); const sc = document.createElement("script"); sc.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js"; sc.onload = () => ok(window.Tesseract); sc.onerror = () => { tessP = null; ng(new Error("辨識元件載入失敗，請檢查網路")); }; document.head.appendChild(sc); });
function openNddImport() {
  const list = storesOf(S.hub).filter(needs);
  const val = {};
  const m = openModal(`<h2>匯入 NDD 打包數・${esc(hubBy(S.hub)?.name || "")}</h2>
    <div class="sub">上傳截圖（可以一次選多張），系統會辨識門市名稱和後面的數字；也可以把文字貼在下面。<b>確認數字沒錯再按「寫入」</b>，辨識錯的直接改。</div>
    <div class="row" style="margin:8px 0"><label class="btn primary">選截圖…<input type="file" id="nddPic" accept="image/*" multiple hidden></label><span id="nddMsg" class="small muted"></span></div>
    <textarea id="nddTxt" rows="3" placeholder="或貼上文字（例如：福壽 120）" style="width:100%"></textarea>
    <div class="row" style="margin:6px 0"><button class="btn small" data-x="parse">讀取貼上的文字</button><span class="spacer"></span><label class="small"><input type="checkbox" id="nddZero"> 沒辨識到的門市設為 0</label></div>
    <div style="max-height:46vh;overflow:auto"><table class="list"><tr><th>門市</th><th>目前</th><th>新的 NDD 打包數</th></tr>
      ${list.map(st => `<tr><td>${esc(st.name)}</td><td class="muted">${st.nddCnt ?? "—"}</td><td><input type="number" min="0" data-ndd="${st.id}" style="width:90px" placeholder="不變"></td></tr>`).join("")}</table></div>
    <div class="actions"><span class="spacer"></span><button class="btn" data-x="cancel">取消</button><button class="btn primary" data-x="go">寫入</button></div>`);
  const fill = found => { let k = 0; for (const [id, v] of Object.entries(found)) { const i = m.querySelector(`[data-ndd="${id}"]`); if (i) { i.value = v; i.style.background = "#fef9c3"; k++; } } return k; };
  m.querySelector("#nddPic").onchange = async ev => {
    const files = [...ev.target.files]; ev.target.value = ""; if (!files.length) return;
    const msg = m.querySelector("#nddMsg");
    try {
      msg.textContent = "載入辨識元件…（第一次比較久）";
      const T = await loadTess(); let txt = "";
      for (const [i, f] of files.entries()) {
        msg.textContent = `辨識第 ${i + 1}/${files.length} 張…`;
        const r = await T.recognize(f, "chi_tra+eng");
        txt += "\n" + r.data.text;
      }
      m.querySelector("#nddTxt").value = txt.trim();
      const k = fill(parseNddText(txt, list));
      msg.textContent = `辨識到 ${k} 家（黃底），請核對`;
    } catch (e) { msg.textContent = "辨識失敗：" + e.message; }
  };
  m.onclick = async ev => {
    const b = ev.target.closest("button"); if (!b) return;
    if (b.dataset.x === "cancel") return closeModal();
    if (b.dataset.x === "parse") { const k = fill(parseNddText(m.querySelector("#nddTxt").value, list)); return toast(`讀到 ${k} 家`); }
    if (b.dataset.x !== "go") return;
    const zero = m.querySelector("#nddZero").checked, ch = {};
    m.querySelectorAll("[data-ndd]").forEach(i => { if (i.value !== "") ch[i.dataset.ndd] = +i.value; else if (zero) ch[i.dataset.ndd] = 0; });
    const n = Object.keys(ch).length; if (!n) return toast("沒有要更新的數字");
    b.disabled = true;
    await saveMaster({ stores: stores().map(x => x.id in ch ? { ...x, nddCnt: ch[x.id] } : x) });
    closeModal(); toast(`已更新 ${n} 家的 NDD 打包數`);
  };
}
// ───────── 發布班表給員工（員工用 schedule.html?r=區域代碼 免登入查班） ─────────
// 寫到 regions/{區域}/pub/{yyyy-mm}（firestore.rules 要允許任何人讀、主管寫）。
// 只放姓名、班別、門市名稱；各人的天數用陣列（第 i 格＝當月第 i+1 天），每人整段覆蓋、不同主要門市分開發布也不會互相蓋掉。
function schedLink() { return location.href.split("#")[0].split("?")[0].replace(/[^/]*$/, "") + "schedule.html?r=" + S.rid; }
function pubEntry(e, ds, cov) {
  const c = cell(ds, e.id);
  if (!c || !c.s) return null;
  if (c.s === "off") return { s: "off" };
  const one = c => {
    // 實習：門市照帶班人員當天同一班；h＝各店應在店時數（和 st 一一對應）
    const m = (c.tr && onSh(cell(ds, c.tr), c.s)) || c;
    const sp = m.sp || [], own = (m.st || []).filter(id => !sp.includes(id));
    const hs = cov ? cellHrs(m, ds, cov, cell) : [], hOf = id => +(hs[(m.st || []).indexOf(id)] || 0).toFixed(2);
    const out = { s: c.s, st: own.map(sName), h: own.map(hOf), sp: (m.st || []).filter(id => sp.includes(id)).map(sName) };
    if (c.tr) out.tr = empBy(c.tr)?.name || "";
    return out;
  };
  const out = one(c), x = xOf(c);
  if (x) out.x = one(x);
  return out;
}
async function publishSchedule() {
  if (!isAdmin()) return toast("只有主管可以發布班表");
  if (!S.months[S.ym]) return toast("班表還在載入，請稍等");
  const days = monthDays(S.ym), emps = {};
  const memo = {}, cov = (ds, sh) => memo[ds + sh] ||= coverage(ds, sh, cell);
  let n = 0;
  for (const e of rowsFor(days, cell)) {
    const d = days.map(x => pubEntry(e, x.ds, cov)), any = d.some(Boolean);
    if (e.active === false && !any) continue;
    if (any) n++;
    emps[e.id] = { n: e.name, g: hubBy(eHubs(e)[0])?.name || "", d };
  }
  if (!n) return toast("這個月還沒有任何班表可以發布");
  if (!confirm(`要把「${hubBy(S.hub)?.name || ""}」${S.ym} 的班表發布給員工嗎？\n\n共 ${n} 人有班。知道網址的人都能看到姓名、班別和門市名稱。`)) return;
  try {
    await S.store.set(P("pub", S.ym), { ym: S.ym, region: S.reg?.name || "", publishedAt: new Date().toISOString(), emps }, true);
    toast(`已發布 ${n} 人的班表；用「複製查班網址」傳給員工`);
  } catch (e) { toast(e.code === "permission-denied" ? "沒有權限，請先更新 Firestore 規則（見說明）" : "發布失敗：" + e.message); }
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
const CODE_RE = /(?<![A-Za-z0-9@._-])(SPX?\d{3,})(?![A-Za-z0-9@._-])/i;
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
// 部門名稱含主要門市名（例：新莊公園 - 智取店 → 公園店）就放到那間主要門市
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
    if (!hit) { if (syncActive && eHubs(e).includes(hub) && e.active !== false) { off++; return { ...e, active: false }; } return e; }
    const r = hit[1];
    return { ...e, ...(syncActive ? { active: true } : {}), code: r.code || e.code || "", wage: r.wage || e.wage || "", unit: r.unit || e.unit || "", ...(eHubs(e).length ? {} : setHubs({}, [hub])) };
  });
  for (const r of add) list.push({ id: uid("e"), name: r.name, code: r.code || "", wage: r.wage || "", unit: r.unit || "", hubs: [hubFromDept(r.unit) || hub], shift: shiftOfWage(r.wage), active: true });
  await saveEmps(list);
  closeModal(); toast(`已更新 ${upd.length} 人、新增 ${add.length} 人${off ? `、停用 ${off} 人` : ""}`);
}
// 只匯入部門含關鍵字的人（預設「智取店」，排除有人店）；關鍵字存在這個區域的設定
function importModal(title, sub, allRows) {
  let kw = M().importOnly ?? "智取店";
  const m = openModal("");
  const draw = () => {
    const hubSel = m.querySelector("#imHub")?.value || S.hub;
    const keepIt = r => !kw || !r.unit || r.unit.includes(kw);
    const rows = allRows.filter(keepIt), out = allRows.filter(r => !keepIt(r));
    const outBy = {}; for (const r of out) (outBy[r.unit || "（無部門）"] ||= []).push(r.name);
    const hubOpts = hubs().map(h => `<option value="${h.id}" ${h.id === hubSel ? "selected" : ""}>${esc(h.name)}</option>`).join("");
    const { add, upd, skip } = planRows(rows);
    const tag = r => { const u = upd.find(([, x]) => x === r); if (u) return `<span class="muted">已有（${esc(hubNames(u[0]) || "未設定主要門市")}）</span>`; const h = hubFromDept(r.unit); return `<span style="color:var(--ok)">新增${h ? "→" + esc(hubBy(h).name) : ""}</span>`; };
    m.innerHTML = `<h2>${title}</h2><div class="sub">${sub}</div>
      <div class="row" style="margin-bottom:8px"><label class="small">只匯入部門含 <input type="text" id="imKw" value="${esc(kw)}" placeholder="（全部匯入）" style="width:100px"> 的人</label>
        <span class="small muted">匯入 <b>${rows.length}</b> 人${out.length ? `・排除 <b>${out.length}</b> 人` : ""}</span></div>
      ${out.length ? `<details class="small" style="margin-bottom:8px"><summary class="muted" style="cursor:pointer">排除的人（${Object.entries(outBy).map(([d, l]) => `${esc(d)} ${l.length}`).join("、")}）</summary>
        <div class="muted" style="margin-top:4px">${Object.entries(outBy).map(([d, l]) => `<b>${esc(d)}</b>：${l.map(esc).join("、")}`).join("<br>")}</div></details>` : ""}
      <div class="scrollx" style="max-height:300px;overflow:auto"><table class="list"><tr><th>#</th><th>姓名</th><th>工號</th><th>部門</th><th>時薪類別</th><th></th></tr>
        ${rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${esc(r.code) || '<span class="muted">—</span>'}</td><td>${esc(r.unit)}</td><td>${esc(r.wage)}</td><td>${tag(r)}</td></tr>`).join("")}</table></div>
      <div class="row" style="margin-top:10px"><label>部門認不出主要門市的新人放到 <select id="imHub">${hubOpts}</select></label></div>
      <label class="small" style="display:block;margin-top:6px"><input type="checkbox" id="imSync"> 同步在職狀態：這間主要門市裡、名單上<b>沒有</b>的人設為停用</label>
      <div class="small muted" style="margin-top:8px">更新 ${upd.length} 人、新增 ${add.length} 人${skip.length ? `、<span style="color:var(--warn)">${skip.length} 筆同名要手動處理：${skip.map(esc).join("、")}</span>` : ""}。已經在系統裡的人只補工號和時薪類別，主要門市不會變。</div>
      <div class="actions"><span class="spacer"></span><button class="btn" data-x="cancel">取消</button><button class="btn primary" data-x="go" ${rows.length ? "" : "disabled"}>直接匯入</button></div>`;
    m.querySelector("#imKw").onchange = e => { kw = e.target.value.trim(); draw(); };
    m.onclick = ev => {
      const b = ev.target.closest("button"); if (!b) return;
      if (b.dataset.x === "cancel") return closeModal();
      if (b.dataset.x === "go") {
        const hub = m.querySelector("#imHub").value, sync = m.querySelector("#imSync").checked;
        if (sync) { const keep = new Set(upd.map(([e]) => e.id)); const n = emps().filter(e => eHubs(e).includes(hub) && e.active !== false && !keep.has(e.id)).length; if (n && !confirm(`會把 ${n} 位不在名單上的人設為停用，確定嗎？`)) return; }
        if (kw !== (M().importOnly ?? "智取店")) saveMaster({ importOnly: kw });
        applyRows(rows, hub, sync);
      }
    };
  };
  draw();
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
b.innerHTML='<b style="font-size:15px">📥 匯入排班網站</b><div id="zqm" style="margin:6px 0 10px">正在重新載入名單…<br>幾秒後沒有出現人數的話，請按頁面上方藍色的<b>放大鏡 🔍</b>。</div><button id="zqg" disabled style="background:#2563eb;color:#fff;border:0;border-radius:8px;padding:6px 12px;opacity:.5">送到排班網站</button> <button id="zqt" style="border:1px solid #ccc;background:#fff;border-radius:8px;padding:6px 10px">只用畫面文字</button> <a href="#" id="zqx" style="float:right;color:#888">關閉</a>';
document.body.appendChild(b);
function again(){var ins=[].slice.call(document.querySelectorAll('input'));var inp=ins.filter(function(i){var t=(i.placeholder||'')+' '+(i.getAttribute('aria-label')||'')+' '+((i.closest&&i.closest('div')&&i.closest('div').innerText)||'');return /工號|姓名/.test(t)})[0];var bs=[].slice.call(document.querySelectorAll('button,[role=button]')).filter(function(x){return !Z.box.contains(x)});var sb=bs.filter(function(x){return /search|搜尋|查詢/i.test((x.innerText||'')+' '+(x.className||'')+' '+(x.getAttribute('aria-label')||'')+' '+(x.title||''))})[0];if(!sb&&inp){var r=inp.getBoundingClientRect(),cx=(r.left+r.right)/2,cy=(r.top+r.bottom)/2,d=function(x){var q=x.getBoundingClientRect();return Math.hypot((q.left+q.right)/2-cx,(q.top+q.bottom)/2-cy)};sb=bs.filter(function(x){var q=x.getBoundingClientRect();return q.width>0&&q.width<140&&d(x)<r.width+200}).sort(function(x,y){return d(x)-d(y)})[0]}if(sb){sb.click()}else if(inp){['keydown','keypress','keyup'].forEach(function(k){inp.dispatchEvent(new KeyboardEvent(k,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}))})}}
function scan(){var seen=new Set(),n0=Object.keys(got).length;function add(x){if(!x||seen.has(x))return;seen.add(x);if(typeof x.EmployeeName==='string'&&('EmployeeNumber' in x)){got[x.EmployeeNumber||x.EmployeeName]={name:x.EmployeeName||'',code:x.EmployeeNumber||'',dept:x.DeptName||'',title:x.JobTitle||'',leave:!!x.IsLeave}}}function walk(o,d){if(!o||typeof o!=='object'||d>4||seen.has(o))return;if(o.nodeType||o.$$typeof)return;add(o);if(Array.isArray(o)){for(var i=0;i<o.length&&i<600;i++)walk(o[i],d+1);return}seen.add(o);for(var k in o){if(k==='children'||k==='_owner'||k==='return'||k==='child'||k==='sibling'||k==='stateNode')continue;try{walk(o[k],d+1)}catch(e){}}}var els=document.querySelectorAll('div,li,a,section,article');for(var i=0;i<els.length&&i<20000;i++){var el=els[i];for(var k in el){if(k.indexOf('__reactFiber')===0||k.indexOf('__reactInternalInstance')===0||k.indexOf('__reactProps')===0){var f=el[k];if(k.indexOf('__reactProps')===0){walk(f,0)}else{for(var j=0;f&&j<8;j++){walk(f.memoizedProps,0);var st=f.memoizedState;for(var m=0;st&&m<10;m++){walk(st.memoizedState,0);st=st.next}f=f.return}}}}}if(Object.keys(got).length>n0)upd()}
try{scan()}catch(e){}
setTimeout(function(){if(!Object.keys(got).length)again()},300);
setTimeout(function(){try{scan()}catch(e){}},1500);
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
      <li>小書籤會自動重新載入名單（等於幫你按一下藍色放大鏡 🔍）。小框顯示「已讀到 N 人」後按「送到排班網站」→ 預覽 → 「直接匯入」。<br>幾秒後還沒有人數，就自己按一下 Apollo 上方的<b>藍色放大鏡 🔍</b>。</li></ol>
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
  const L = String(text || "").split("\n").map(x => x.trim()).filter(x => x && !/@|…$/.test(x));
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
  if (!Array.isArray(p.people) && p.v !== 3) return openModal(`<h2>請換新版的小書籤</h2><div class="sub">你點的是<b>舊版</b>小書籤，讀不到工號，也沒有排除有人店。</div>
    <ol class="small" style="padding-left:20px;line-height:1.8"><li>在書籤列對「📥 Apollo→排班」按右鍵 → <b>刪除</b>。</li><li>到「人員」→「從 Apollo「我的部屬」匯入…」，把新的按鈕拖到書籤列。</li><li>回 Apollo「我的部屬」點新書籤，右上角會出現藍框，照框裡的說明操作。</li></ol>
    <div class="actions"><span class="spacer"></span><button class="btn primary" onclick="document.getElementById('modalRoot').innerHTML=''">知道了</button></div>`);
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
