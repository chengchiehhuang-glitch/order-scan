# 訂單辨識（order-scan）

手機拍照辨識供應商「東野精機」固定版式出貨單 → 核對修正 → 寫入 Google Sheet + 照片存 Google Drive。
純靜態前端 PWA（無 build step、無 Node），前端直呼 Gemini API，後端是一支 Google Apps Script。

## 架構圖（文字版）

```
手機瀏覽器（PWA, web/）
  │
  │ 1. 拍照（<input type=file capture=environment>，不用 getUserMedia）
  │ 2. canvas 壓縮（長邊 1600px, JPEG 0.85）
  ▼
Gemini API（前端直呼，不經過任何後端中轉）
  generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
  │ 3. responseSchema 限定 JSON 結構，回傳結構化辨識結果
  ▼
核對畫面（單頭 / 明細 / 合計，全部可編輯，本地做金額檢核）
  │ 4. 使用者按「確認送出」
  ▼
GAS Web App（gas/Code.gs，doPost）
  │ 5. 驗證 secret
  │ 6. 照片 → Google Drive「訂單辨識照片」資料夾
  │ 7. 明細逐列 → Google Sheet
  ▼
回傳 {ok, rows, photoUrl} → 前端顯示完成畫面
```

## 目錄結構

```
order-scan/
├── web/                    純靜態前端（PWA）
│   ├── index.html          六個畫面（主畫面/辨識中/佇列/核對/完成/設定，v1.1.0 新增批次佇列畫面）
│   ├── style.css           Design tokens + 版面樣式
│   ├── app.js               原生 JS：拍照/壓縮/呼叫 Gemini/表單/送出/設定
│   ├── manifest.webmanifest
│   ├── sw.js                stale-while-revalidate 快取（僅同源 GET）
│   └── icons/
├── gas/
│   └── Code.gs              Google Apps Script 後端（doGet/doPost）
├── README.md
└── .claude/launch.json      本地預覽用（python3 http.server, port 4713）
```

## 本地預覽

```bash
cd /Users/aqualux/Code/order-scan
python3 -m http.server 4713 --directory web
# 開 http://localhost:4713
```

手機上 `<input capture="environment">` 需要 HTTPS 或 localhost 才會叫出相機；純區網 http:// IP 在部分手機瀏覽器會退化成選檔案。正式使用建議部署到 HTTPS 靜態網站（GitHub Pages / Netlify 等，待你選定）。

## 首次使用設定

打開 App → 底部「設定」，填入：

| 欄位 | 說明 |
|---|---|
| 輸入人員 | 會寫進 Sheet 的「輸入人員」欄，並顯示在核對畫面唯讀區 |
| Gemini API Key | 從 [Google AI Studio](https://aistudio.google.com/apikey) 取得 |
| Gemini 模型 | 預設 `gemini-flash-latest`（自動指向當前 flash 穩定版；模型 404 時 app 會自動 fallback 到它） |
| GAS 網址 | 見下方「GAS 部署步驟」，部署完成後的 `/exec` 網址 |
| 通行碼 | 需與 `gas/Code.gs` 裡的 `SECRET` 常數一致（見下方安全性提醒） |

全部存在瀏覽器 `localStorage`（key 前綴 `orderscan_`），不會上傳到任何地方。

## 設定一鍵匯入（URL hash provisioning）

幫同事/員工初次設定裝置時，不用口頭念 API Key／GAS 網址／通行碼，可以做一條「匯入連結」讓對方點開就自動填好設定。

原理：網址帶 `#cfg=<base64url 編碼的 JSON>`，App 啟動時會檢查這個 hash，把裡面有值的欄位寫進 `localStorage`，然後立刻用 `history.replaceState` 把 hash 從網址列清掉（避免機密留在瀏覽紀錄或截圖裡），並跳一個「設定已匯入」的輕量提示。

JSON 欄位（全部選填，沒帶到的欄位維持原本設定不變）：

```json
{
  "operator": "王小明",
  "apiKey": "AIza...",
  "model": "gemini-flash-latest",
  "gasUrl": "https://script.google.com/macros/s/xxx/exec",
  "secret": "<與 GAS 部署版一致的通行碼>"
}
```

產生連結範例（`python3`，處理中文用 UTF-8 是關鍵）：

```python3
import base64, json

cfg = {
    "operator": "王小明",
    "apiKey": "AIza...",
    "gasUrl": "https://script.google.com/macros/s/xxx/exec",
}

payload = base64.urlsafe_b64encode(json.dumps(cfg, ensure_ascii=False).encode("utf-8")).decode("ascii").rstrip("=")
print(f"https://<你的部署網域>/#cfg={payload}")
```

⚠️ **這條連結等同於把 API Key／通行碼交出去，一定要當機密處理**：只能用 AirDrop、私訊等一對一管道傳給對方，**絕對不可以貼到群組、公開頁面、或存進共用雲端文件**。對方點開連結完成匯入後，建議請他確認網址列的 `#cfg=...` 已經消失（App 會自動清除，若因瀏覽器快取顯示異常請手動重新整理一次）。

## GAS 部署步驟

1. 開 [script.google.com](https://script.google.com) → 新增專案。
2. 刪掉預設的 `Code.gs` 內容，貼上本專案 `gas/Code.gs` 全部內容。
3. 確認檔案內的三個常數：
   - `SHEET_ID`：目標 Google Sheet 的 ID（已預填 `1xB-hiIh6r-EizWqz80bbYT7p_OpNT36aZzz0KE9tVrA`，如需換表請自行更改）。
   - `SHEET_NAME`：分頁名稱，預設 `工作表1`，找不到會自動退回第一個分頁。
   - `SECRET`：通行碼，**正式對外使用前務必更換**（見下方安全性提醒）。
4. 右上角「部署」→「新增部署作業」→ 類型選「網頁應用程式」。
   - 執行身分：**我**（你自己的帳號，這樣才有權限寫 Sheet / 存 Drive）
   - 存取權限：**任何人**（否則手機呼叫會被要求登入 Google 帳號，PWA 無法處理登入流程）
5. 授權時會跳出 Google 帳號授權畫面，允許存取 Sheets / Drive。
6. 部署完成後複製 `.../exec` 結尾的網址，貼進 PWA 的「設定 → GAS 網址」。
7. 可先用瀏覽器直接開 `.../exec`（GET），應該會看到 `{"ok":true,"ping":"orderscan-gas v1"}`，確認部署成功。
8. 之後若修改 `Code.gs`，記得「部署」→「管理部署作業」→ 编辑既有部署 → 新版本，否則 `/exec` 網址不會套用新程式碼。

### Google Sheet 欄位（A→V，共 22 欄）

拍攝時間、輸入人員、供應商、銷貨單號、銷貨日期、發票號碼、客戶名稱、序號、品號、品名、規格、數量、單位、單價、金額、訂單號碼、客戶品號、未稅合計、稅額、含稅合計、照片連結、ERP狀態（固定寫入「待回填」）。

## 安全性提醒

- 通行碼（`SECRET`）**不出現在公開 repo**：`web/app.js` 的 `DEFAULT_SECRET` 為空字串；真實值只存在於 GAS 部署版（`gas/Code.gs`，本機保留、不進公開 repo）與各裝置的 localStorage（經一鍵匯入連結配發）。
- `gas/` 與 `test/` 目錄已列入 `.gitignore`（含通行碼與真實單據樣張），只保留在本機（有 pCloud 每晚備份）。
- GAS 部署選「任何人可存取」代表任何知道 `/exec` 網址的人都能呼叫 `doPost`；`secret` 通行碼是主要防線，請把 `/exec` 網址與通行碼都當機密保管（兩者都只透過一鍵匯入連結私下配發）。

## 部署（已定案：GitHub Pages）

- 正式站：GitHub repo `chengchiehhuang-glitch/order-scan` 的 `gh-pages` 分支（內容 = `web/` 目錄），Pages 服務。
- 更新流程：改 `web/` → bump `sw.js` 的 `CACHE_VERSION` → `git commit` → `git subtree push --prefix web origin gh-pages`。
- [ ] `SHEET_NAME` 目前假設分頁名稱是「工作表1」，請依實際 Sheet 分頁名稱確認或調整。
- [ ] 尚未實際用東野精機真實出貨單照片測試 Gemini 辨識準確度，`GEMINI_PROMPT` 的版面描述是依照任務需求文字推測撰寫，正式使用建議先用幾張真實照片跑過、視情況微調 prompt。
- [ ] icons 為程式產生的極簡相機線稿圖示（PIL 畫的圓角方形 + 白色相機線稿），未經設計師確認觀感是否符合品牌調性。
