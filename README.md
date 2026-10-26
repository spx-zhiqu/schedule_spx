# 智取店排班系統 v2（GitHub Pages + Firebase）

網站：https://spx-zhiqu.github.io/schedule_spx/
員工畫休：在網站「畫休」分頁複製網址（`leave.html?r=區域代碼`）

## 架構
- **區域**：每個區域的主要門市、門市、人員、班表完全分開。最高管理者（firebase-config.js 的 OWNER_EMAIL）建立區域，並在「設定 → 權限」加入該區主管／檢視者的 Email。
- **主要門市**：使用者自己新增；頂部選單一次選一間主要門市。
- **門市**：掛在主要門市底下，含地址、座標、早／晚班要不要排、工作量。
- **人員**：主要門市（可多間）、工號、班別（早／晚／都可）、每週最多天數、可去門市。可從 Apollo「我的部屬」用小書籤匯入。
- **自動排班**：依門市座標（距離近的分給同一人）、工作量、條件、員工畫休產生預覽，按「確認寫入」才存。
- **漏排總覽**：早班／晚班分開，14 天一頁，✓／✕。

## Firestore 資料
```
regions/{rid}                 name, admins[], viewers[]
regions/{rid}/cfg/master      hubs[], stores[], rules{}
regions/{rid}/cfg/employees   list[]
regions/{rid}/cfg/leave       畫休設定＋員工名單（公開讀）
regions/{rid}/months/{yyyy-mm}  cells{"yyyymmdd_員工id": {s:"am"|"pm"|"off", st:[門市id], n}}
regions/{rid}/leave/{ym_員工id}  員工送出的畫休
```
舊版資料（config/、months/）保留不刪，只有最高管理者讀得到。

## 部署
1. `firestore.rules` 整段貼到 Firebase 主控台 → Firestore Database → 規則 → 發布。
2. 推到 GitHub main，Pages 1～2 分鐘後更新。

`firebase-config.js` 的 firebaseConfig 改成 `null` 就是本機試用模式（資料存在瀏覽器）。

## 發新版要改的地方

執行 `node tools/bump.mjs`（改了樣式就加 `--css`）。它會一次把 `app.js` 的 `APP_VER`、`index.html` 的 `app.js?v=`、`version.json` 改成同一個版本號，並檢查三處一致。網站打開時會比對 version.json，版本不同就自動重新載入，使用者不用手動強制重新整理。

## 自動排班條件（設定頁）

- 每週最多天數、最多連續天數：留空或填 0＝不限（每週最多 7 天）。人員表可以個別設定每週天數。
- 晚班隔天接早班：不是硬限制，只是排班時扣分盡量避開；班表合計欄的 ⚠ 會標出超過每週／連續上限、或晚接早的人。
