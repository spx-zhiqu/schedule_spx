// 員工畫休頁：免登入，選自己的名字 → 在月曆上點日期畫休 → 送出
import { createStore } from "./store.js?v=4";
const RID = new URLSearchParams(location.search).get("r") || "";

const WD = ["一", "二", "三", "四", "五", "六", "日"];
const CODES = { off: "休假", am: "只能早班", pm: "只能晚班", any: "早晚都可以" };
const SHORT = { off: "休", am: "早", pm: "晚", any: "皆可" };
const $ = s => document.querySelector(s);
const main = $("#main");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
const L = { store: null, cfg: undefined, me: null, doc: undefined, days: {}, note: "", dirty: false, unsub: null };

function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2200); }
function ymLabel(ym) { const [y, m] = ym.split("-"); return `${y}年${+m}月`; }
function dsLabel(ds) { return `${+ds.slice(4, 6)}/${+ds.slice(6, 8)}`; }

init();
async function init() {
  try { L.store = await createStore(); } catch (e) { main.innerHTML = `<div class="card">無法連線：${esc(e.message)}</div>`; return; }
  L.store.setErrorHandler(e => { main.innerHTML = `<div class="card login"><h2>目前無法讀取</h2><p class="muted">${esc(e.code || e.message)}</p></div>`; });
  if (!RID) { main.innerHTML = `<div class="card login"><h2>網址不完整</h2><p class="muted">請跟主管要正確的畫休網址。</p></div>`; return; }
  try { L.me = JSON.parse(localStorage.getItem("zq-leave-me-" + RID) || "null"); } catch {}
  L.store.watch(`regions/${RID}/cfg/leave`, c => { L.cfg = c; if (L.me && !roster().some(r => r.id === L.me.id)) L.me = null; watchMine(); render(); });
}
const roster = () => L.cfg?.roster || [];
function watchMine() {
  if (L.unsub) { L.unsub(); L.unsub = null; }
  L.doc = undefined;
  if (!L.cfg?.open || !L.me) return;
  L.unsub = L.store.watch(`regions/${RID}/leave/${L.cfg.ym}_${L.me.id}`, d => {
    L.doc = d;
    if (!L.dirty) { L.days = { ...(d?.days || {}) }; L.note = d?.note || ""; }
    render();
  });
}
function pickMe(id) {
  const r = roster().find(x => x.id === id); if (!r) return;
  L.me = { id: r.id, name: r.name };
  try { localStorage.setItem("zq-leave-me-" + RID, JSON.stringify(L.me)); } catch {}
  L.dirty = false; watchMine(); render();
}
function notMe() {
  if (L.dirty && !confirm("還沒送出的變更會不見，確定要換人嗎？")) return;
  L.me = null; L.dirty = false; try { localStorage.removeItem("zq-leave-me-" + RID); } catch {}
  watchMine(); render();
}

function render() {
  if (L.cfg === undefined) { main.innerHTML = `<div class="loading">載入中…</div>`; return; }
  if (!L.cfg || !L.cfg.open) {
    main.innerHTML = `<div class="card login"><img src="icon.svg" width="56" height="56" alt=""><h2>目前沒有開放畫休</h2><p class="muted">主管開放後，再用同一個網址進來就可以畫休。</p></div>`; return;
  }
  const c = L.cfg;
  const head = `<div class="card lvhead"><div class="lvtitle">${c.region ? esc(c.region) + " " : ""}${ymLabel(c.ym)} 畫休</div>
    ${c.deadline ? `<div class="muted">請在 <b>${dsLabel(c.deadline)}</b> 前完成${deadlinePassed() ? `<span class="late">（已過截止日，送出會標記為逾期）</span>` : ""}</div>` : ""}
    ${c.maxOff ? `<div class="muted">每人最多畫休 <b>${c.maxOff}</b> 天</div>` : ""}
    ${c.note ? `<div class="lvnote">${esc(c.note)}</div>` : ""}</div>`;
  if (!L.me) {
    const groups = {};
    for (const r of roster()) (groups[r.group || "其他"] ||= []).push(r);
    main.innerHTML = head + `<div class="card"><h3>請先選你的名字</h3>
      ${Object.entries(groups).map(([g, list]) => `<div class="pgroup">${esc(g)}</div><div class="namegrid">${list.map(r => `<button class="pbtn" data-me="${r.id}">${esc(r.name)}</button>`).join("")}</div>`).join("")}
      <p class="muted small" style="margin-top:12px">找不到自己的名字請跟主管說。</p></div>`;
    main.onclick = e => { const b = e.target.closest("[data-me]"); if (b) pickMe(b.dataset.me); };
    return;
  }
  if (L.doc === undefined) { main.innerHTML = head + `<div class="loading">載入中…</div>`; return; }
  const [y, m] = c.ym.split("-").map(Number);
  const first = new Date(y, m - 1, 1), n = new Date(y, m, 0).getDate();
  const lead = (first.getDay() + 6) % 7;
  let cells = "";
  for (let i = 0; i < lead; i++) cells += `<div class="cal-e"></div>`;
  for (let d = 1; d <= n; d++) {
    const ds = `${y}${pad(m)}${pad(d)}`, code = L.days[ds], wd = new Date(y, m - 1, d).getDay();
    cells += `<button class="cal-d ${code ? "c-" + code : ""} ${wd === 0 || wd === 6 ? "we" : ""}" data-ds="${ds}"><span class="dn">${d}</span>${code ? `<span class="dt">${SHORT[code]}</span>` : ""}</button>`;
  }
  const offN = Object.values(L.days).filter(v => v === "off").length;
  const over = c.maxOff && offN > c.maxOff;
  const sent = L.doc?.submittedAt ? new Date(L.doc.submittedAt) : null;
  main.innerHTML = head + `<div class="card">
    <div class="row" style="margin-bottom:8px"><b style="font-size:16px">${esc(L.me.name)}</b><a href="#" id="notMe" class="small">不是我，重新選擇</a><span class="spacer"></span>
      ${sent ? `<span class="okpill">已送出 ${sent.getMonth() + 1}/${sent.getDate()} ${pad(sent.getHours())}:${pad(sent.getMinutes())}</span>` : `<span class="todo">尚未送出</span>`}</div>
    <p class="muted small" style="margin:0 0 8px">點日期選「休假」或「只能早班／只能晚班」。<b>沒點的日子＝可以照平常的班上班。</b></p>
    <div class="cal">${WD.map(w => `<div class="cal-h">${w}</div>`).join("")}${cells}</div>
    <div class="legend" style="margin-top:10px">${Object.entries(CODES).map(([k, v]) => `<span><i class="c-${k}"></i>${v}</span>`).join("")}</div>
    <div class="lvcount ${over ? "bad" : ""}">已畫休 <b>${offN}</b> 天${c.maxOff ? ` / 最多 ${c.maxOff} 天` : ""}${over ? "（超過上限，請調整）" : ""}</div>
    <label class="small muted">想跟主管說的話（選填）</label>
    <textarea id="lvNote" style="min-height:60px">${esc(L.note)}</textarea>
    <div class="row" style="margin-top:12px"><button class="btn" id="lvClear">全部清除</button><span class="spacer"></span>
      <button class="btn primary big" id="lvSend" ${over ? "disabled" : ""}>${sent ? "更新送出" : "送出畫休"}</button></div>
    ${L.dirty ? `<p class="small" style="color:var(--warn);margin:8px 0 0">有變更還沒送出</p>` : ""}
  </div>`;
  main.onclick = onClick;
  $("#lvNote").oninput = e => { L.note = e.target.value; if (!L.dirty) { L.dirty = true; } };
}
function deadlinePassed() {
  const d = L.cfg?.deadline; if (!d) return false;
  const now = new Date(); const t = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  return t > d;
}
function onClick(e) {
  const t = e.target.closest("button,a"); if (!t) return;
  if (t.id === "notMe") { e.preventDefault(); return notMe(); }
  if (t.dataset.ds) return openPicker(t.dataset.ds);
  if (t.id === "lvClear") { if (confirm("清除這個月全部畫休？")) { L.days = {}; L.dirty = true; render(); } return; }
  if (t.id === "lvSend") return send();
}
function openPicker(ds) {
  const root = $("#modalRoot");
  const cur = L.days[ds];
  root.innerHTML = `<div class="modal-bg"><div class="modal sheet"><h2>${dsLabel(ds)}（${WD[(new Date(+ds.slice(0, 4), +ds.slice(4, 6) - 1, +ds.slice(6, 8)).getDay() + 6) % 7]}）</h2>
    <div class="sheetbtns">${Object.entries(CODES).map(([k, v]) => `<button class="sbtn c-${k} ${cur === k ? "on" : ""}" data-code="${k}">${v}</button>`).join("")}
    <button class="sbtn" data-code="">清除（照平常上班）</button></div></div></div>`;
  const bg = root.querySelector(".modal-bg");
  bg.onclick = ev => {
    if (ev.target === bg) { root.innerHTML = ""; return; }
    const b = ev.target.closest("[data-code]"); if (!b) return;
    if (b.dataset.code) L.days[ds] = b.dataset.code; else delete L.days[ds];
    L.dirty = true; root.innerHTML = ""; render();
  };
}
async function send() {
  const c = L.cfg;
  const offN = Object.values(L.days).filter(v => v === "off").length;
  if (c.maxOff && offN > c.maxOff) return toast(`最多只能畫休 ${c.maxOff} 天`);
  const btn = $("#lvSend"); btn.disabled = true; btn.textContent = "送出中…";
  try {
    await L.store.set(`regions/${RID}/leave/${c.ym}_${L.me.id}`, {
      ym: c.ym, eid: L.me.id, name: L.me.name, days: L.days, note: (L.note || "").slice(0, 300),
      submittedAt: new Date().toISOString(), late: deadlinePassed(),
    });
    L.dirty = false; toast("已送出，謝謝！");
  } catch (e) {
    toast(e.code === "permission-denied" ? "畫休已關閉，無法送出" : "送出失敗：" + e.message);
    btn.disabled = false; btn.textContent = "送出畫休";
  }
}
