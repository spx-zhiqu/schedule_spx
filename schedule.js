// 員工查班表頁：免登入，選自己的名字 → 看這個月的班（早／晚／休）和要跑的門市
// 資料來自主管按「發布給員工」寫入的 regions/{區域}/pub/{yyyy-mm}（只含姓名、班別、門市名稱）
import { createStore } from "./store.js?v=5";
const RID = new URLSearchParams(location.search).get("r") || "";

const WD = ["日", "一", "二", "三", "四", "五", "六"];
const LABEL = { am: "早班", pm: "晚班", off: "休假" };
const ICON = { am: "☀️", pm: "🌙", off: "" };
const SHORT = { am: "早", pm: "晚", off: "休" };
// 同一天早晚雙班：第二個班在 e.x
const cls = e => e ? "c-" + e.s + (e.x ? " c-dbl" : "") : "";
const shortOf = e => SHORT[e.s] + (e.x ? SHORT[e.x.s] : "");
const labelOf = e => e.x ? `${ICON[e.s]} ${LABEL[e.s]}＋${ICON[e.x.s]} ${LABEL[e.x.s]}` : `${ICON[e.s]} ${LABEL[e.s]}`;
const $ = s => document.querySelector(s);
const main = $("#main");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
const ymOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const dsOf = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const shiftYm = (ym, n) => { const [y, m] = ym.split("-").map(Number); return ymOf(new Date(y, m - 1 + n, 1)); };
const L = { store: null, ym: ymOf(new Date()), doc: undefined, me: null, unsub: null, err: null };

function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2200); }

init();
async function init() {
  try { L.store = await createStore(); } catch (e) { main.innerHTML = `<div class="card">無法連線：${esc(e.message)}</div>`; return; }
  L.store.setErrorHandler(e => { L.err = e.code || e.message; render(); });
  if (!RID) { main.innerHTML = `<div class="card login"><h2>網址不完整</h2><p class="muted">請跟主管要正確的查班表網址。</p></div>`; return; }
  try { L.me = JSON.parse(localStorage.getItem("zq-sched-me-" + RID) || "null"); } catch {}
  watch();
}
function watch() {
  if (L.unsub) L.unsub();
  L.doc = undefined; L.err = null; render();
  L.unsub = L.store.watch(`regions/${RID}/pub/${L.ym}`, d => { L.doc = d; render(); });
}
function pickMe(id) {
  const r = L.doc?.emps?.[id]; if (!r) return;
  L.me = { id, name: r.n };
  try { localStorage.setItem("zq-sched-me-" + RID, JSON.stringify(L.me)); } catch {}
  render();
}
function notMe() { L.me = null; try { localStorage.removeItem("zq-sched-me-" + RID); } catch {} render(); }

function render() {
  if (L.err) { main.innerHTML = `<div class="card login"><h2>目前無法讀取</h2><p class="muted">${esc(L.err)}</p><p class="muted small">請跟主管確認班表是否已發布。</p></div>`; return; }
  if (L.doc === undefined) { main.innerHTML = `<div class="loading">載入中…</div>`; return; }
  const [y, m] = L.ym.split("-").map(Number);
  const nav = `<div class="card"><div class="sch-nav"><button class="icon-btn" data-nav="-1">‹</button><b>${L.doc?.region ? esc(L.doc.region) + " " : ""}${y}年${m}月</b><button class="icon-btn" data-nav="1">›</button></div>`;
  main.onclick = onClick;
  if (!L.doc) { main.innerHTML = nav + `<p class="muted" style="text-align:center;margin:18px 0">這個月的班表主管還沒發布。</p></div>`; return; }
  const emps = L.doc.emps || {};
  if (L.me && !emps[L.me.id]) L.me = null;
  if (!L.me) {
    const groups = {};
    for (const [id, r] of Object.entries(emps)) (groups[r.g || "其他"] ||= []).push({ id, name: r.n });
    main.innerHTML = nav + `</div><div class="card"><h3>請先選你的名字</h3>${Object.entries(groups).map(([g, list]) =>
      `<div class="pgroup">${esc(g)}</div><div class="namegrid">${list.map(r => `<button class="pbtn" data-me="${esc(r.id)}">${esc(r.name)}</button>`).join("")}</div>`).join("")}
      <p class="muted small" style="margin-top:12px">找不到自己的名字請跟主管說。</p></div>`;
    return;
  }
  const mine = emps[L.me.id], days = new Date(y, m, 0).getDate(), today = dsOf(new Date());
  // 一天一列：日期｜班別｜門市＋應在店時數（不用再點進去看）
  let rows = "";
  for (let d = 1; d <= days; d++) {
    const ds = `${y}${pad(m)}${pad(d)}`, e = mine.d?.[d - 1], wd = new Date(y, m - 1, d).getDay();
    const parts = !e ? [] : e.s === "off" ? [] : e.x ? [e, e.x] : [e];
    rows += `<div class="ag-row ${ds === today ? "today" : ""} ${ds < today ? "past" : ""} ${wd === 0 || wd === 6 ? "we" : ""}" ${ds === today ? 'id="agToday"' : ""}>
      <div class="ag-d"><b>${m}/${d}</b><span>${WD[wd]}${ds === today ? "・今天" : ""}</span></div>
      <div class="ag-b">${!e ? `<span class="muted small">沒有排班</span>` : e.s === "off" ? `<span class="ag-off">休</span>` : parts.map(p => `<div class="ag-sh"><span class="ag-tag c-${p.s}">${ICON[p.s]} ${LABEL[p.s]}${hsum(p) ? ` ${hsum(p)}h` : ""}</span>${storeChips(p)}</div>`).join("")}</div></div>`;
  }
  const has = (mine.d || []).some(Boolean);
  const pub = L.doc.publishedAt ? new Date(L.doc.publishedAt) : null;
  main.innerHTML = nav + `<div class="row" style="margin-top:6px"><b style="font-size:16px">${esc(L.me.name)}</b><a href="#" id="notMe" class="small">不是我，重新選擇</a></div></div>
    <div class="card ag">${has ? "" : `<p class="muted" style="text-align:center;margin:0 0 10px">這個月還沒有你的班表。</p>`}${rows}
      <p class="muted small" style="margin-top:10px">店名旁的數字＝這家店應在店時數（小時）。</p>
      ${pub ? `<p class="sch-dl">班表更新於 ${pub.getMonth() + 1}/${pub.getDate()} ${pad(pub.getHours())}:${pad(pub.getMinutes())}</p>` : ""}</div>`;
  if (!L.scrolled) { L.scrolled = true; setTimeout(() => $("#agToday")?.scrollIntoView({ block: "center" }), 50); }
}
const fmtH = h => (Math.round(h * 100) / 100).toFixed(2);
const hsum = p => { const t = (p.h || []).reduce((a, b) => a + (+b || 0), 0); return t ? (Math.round(t * 10) / 10).toFixed(1) : ""; };
function storeChips(e) {
  if (e.s === "off") return "";
  const tr = e.tr ? `<div class="muted small" style="margin-top:2px">🎓 實習・跟 ${esc(e.tr)}</div>` : "";
  const st = (e.st || []).map((n, i) => `<span class="sch-st">${esc(n)}${e.h && +e.h[i] ? `<small>${fmtH(+e.h[i])}</small>` : ""}</span>`).join("") + (e.sp || []).map(n => `<span class="sch-st sp">支援 ${esc(n)}</span>`).join("");
  return tr + (st ? `<div class="sch-stores">${st}</div>` : `<div class="muted small" style="margin-top:2px">門市請跟主管確認</div>`);
}
function onClick(e) {
  const t = e.target.closest("button,a"); if (!t) return;
  if (t.id === "notMe") { e.preventDefault(); return notMe(); }
  if (t.dataset.nav) { L.ym = shiftYm(L.ym, +t.dataset.nav); L.scrolled = false; return watch(); }
  if (t.dataset.me) return pickMe(t.dataset.me);
}
