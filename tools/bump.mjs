// 發新版：一次把 app.js 的 APP_VER、index.html 的 app.js?v=、version.json 改成同一個版本號。
// 用法：node tools/bump.mjs            → 自動 +1（v40 → v41）
//       node tools/bump.mjs v50        → 指定版本號
//       node tools/bump.mjs --css      → 同時把 style.css?v= 加 1（改了樣式時用，index.html／leave.html 都會改）
import fs from "node:fs";
const args = process.argv.slice(2), css = args.includes("--css"), want = args.find(a => /^v\d+$/.test(a));
const read = f => fs.readFileSync(f, "utf8"), write = (f, t) => fs.writeFileSync(f, t);
const cur = +read("app.js").match(/const APP_VER = "v(\d+)"/)[1];
const next = want ? +want.slice(1) : cur + 1;
const sub = (f, re, to) => { const t = read(f); if (!re.test(t)) throw new Error(`${f} 找不到 ${re}`); write(f, t.replace(re, to)); };
sub("app.js", /const APP_VER = "v\d+"/, `const APP_VER = "v${next}"`);
sub("index.html", /app\.js\?v=\d+/, `app.js?v=${next}`);
write("version.json", JSON.stringify({ v: "v" + next }) + "\n");
if (css) for (const f of ["index.html", "leave.html"]) sub(f, /style\.css\?v=(\d+)/, (_, n) => `style.css?v=${+n + 1}`);
// 三處對照檢查
const a = read("app.js").match(/APP_VER = "(v\d+)"/)[1], b = read("index.html").match(/app\.js\?v=(\d+)/)[1], c = JSON.parse(read("version.json")).v;
if (a !== c || a !== "v" + b) throw new Error(`版本號不一致：${a} / v${b} / ${c}`);
console.log(`已更新為 v${next}${css ? "（含 style.css）" : ""}：app.js、index.html、version.json 一致 ✓`);
