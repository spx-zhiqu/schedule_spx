// 資料層：Firebase（正式）或 localStorage（本機試用）兩種實作，介面相同。
// 所有資料用「路徑」存取，例如 regions/abc/cfg/master、regions/abc/months/2026-10。
import { firebaseConfig, OWNER_EMAIL } from "./firebase-config.js";

const FB = "https://www.gstatic.com/firebasejs/10.12.2/";

export async function createStore() {
  if (firebaseConfig && firebaseConfig.projectId) return firebaseStore();
  return localStore();
}

/* ---------------- Firebase ---------------- */
async function firebaseStore() {
  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(FB + "firebase-app.js"),
    import(FB + "firebase-auth.js"),
    import(FB + "firebase-firestore.js"),
  ]);
  const app = initializeApp(firebaseConfig);
  const au = auth.getAuth(app);
  const db = fs.getFirestore(app);
  let onError = () => {};
  const ref = p => fs.doc(db, p);
  const q = (col, field, op, val) => field ? fs.query(fs.collection(db, col), fs.where(field, op, val)) : fs.collection(db, col);
  const rows = s => s.docs.map(x => ({ id: x.id, ...x.data() }));
  return {
    mode: "firebase",
    owner: OWNER_EMAIL.toLowerCase(),
    setErrorHandler(fn) { onError = fn; },
    onAuth(cb) { auth.onAuthStateChanged(au, u => cb(u ? { email: (u.email || "").toLowerCase(), name: u.displayName || u.email } : null)); },
    async signIn() {
      const p = new auth.GoogleAuthProvider();
      p.setCustomParameters({ prompt: "select_account" });
      try { await auth.signInWithPopup(au, p); }
      catch (e) {
        if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") await auth.signInWithRedirect(au, p);
        else throw e;
      }
    },
    signOut() { return auth.signOut(au); },
    watch(path, cb, quiet) { return fs.onSnapshot(ref(path), s => cb(s.exists() ? s.data() : null), e => quiet ? cb(null) : onError(e)); },
    async get(path) { const s = await fs.getDoc(ref(path)); return s.exists() ? s.data() : null; },
    set(path, data, merge) { return fs.setDoc(ref(path), data, merge ? { merge: true } : {}); },
    // 只改 cells 裡的幾格（值為 null 表示刪掉那格）
    async setCells(path, map) {
      const cells = {};
      for (const [k, v] of Object.entries(map)) cells[k] = v == null ? fs.deleteField() : v;
      await fs.setDoc(ref(path), { cells }, { merge: true });
    },
    del(path) { return fs.deleteDoc(ref(path)); },
    watchList(col, field, op, val, cb) { return fs.onSnapshot(q(col, field, op, val), s => cb(rows(s)), e => onError(e)); },
    async list(col, field, op, val) { return rows(await fs.getDocs(q(col, field, op, val))); },
  };
}

/* ---------------- 本機試用 ---------------- */
function localStore() {
  const KEY = "zhiqu-demo-v2";
  let docs;
  try { docs = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { docs = null; }
  if (!docs) docs = {};
  const subs = new Set();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(docs)); } catch {} subs.forEach(fn => fn()); };
  const sub = fn => { subs.add(fn); setTimeout(fn); return () => subs.delete(fn); };
  const clone = v => v == null ? null : JSON.parse(JSON.stringify(v));
  const match = (col, field, op, val) => Object.entries(docs)
    .filter(([p]) => p.startsWith(col + "/") && !p.slice(col.length + 1).includes("/"))
    .map(([p, d]) => ({ id: p.slice(col.length + 1), ...clone(d) }))
    .filter(d => !field || (op === "array-contains" ? (d[field] || []).includes(val) : d[field] === val));
  return {
    mode: "local",
    owner: OWNER_EMAIL.toLowerCase(),
    setErrorHandler() {},
    onAuth(cb) { setTimeout(() => cb({ email: OWNER_EMAIL.toLowerCase(), name: "本機試用" })); },
    async signIn() {}, async signOut() {},
    watch(path, cb) { return sub(() => cb(clone(docs[path]))); },
    async get(path) { return clone(docs[path]); },
    async set(path, data, merge) { docs[path] = merge ? { ...(docs[path] || {}), ...clone(data) } : clone(data); save(); },
    async setCells(path, map) {
      const d = docs[path] || (docs[path] = {}); const c = d.cells || (d.cells = {});
      for (const [k, v] of Object.entries(map)) { if (v == null) delete c[k]; else c[k] = clone(v); }
      save();
    },
    async del(path) { delete docs[path]; save(); },
    watchList(col, field, op, val, cb) { return sub(() => cb(match(col, field, op, val))); },
    async list(col, field, op, val) { return match(col, field, op, val); },
  };
}
