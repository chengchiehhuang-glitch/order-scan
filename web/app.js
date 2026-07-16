'use strict';

/* =========================================================
 * 訂單辨識 PWA — 前端邏輯（純原生 JS，無框架、無 build step）
 * ========================================================= */

const APP_VERSION = 'v1.4.0';

/* ---- 固定連結（試算表 ID 固定，不放進設定） ---- */
const SHEET_ID = '1xB-hiIh6r-EizWqz80bbYT7p_OpNT36aZzz0KE9tVrA';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
const XLSX_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`;

/* ---- localStorage key 前綴 ---- */
const LS_PREFIX = 'orderscan_';
const LS_KEYS = {
  operator: LS_PREFIX + 'operator',
  apiKey: LS_PREFIX + 'apiKey',
  model: LS_PREFIX + 'model',
  gasUrl: LS_PREFIX + 'gasUrl',
  secret: LS_PREFIX + 'secret',
};
// 用 lite 版：辨識固定表格不需推理，比 flash-latest 快約 8 倍（實測 22s → 3s）、準確度相同。
// 都用 -latest 別名指向當前穩定版，避免某版本被下架後辨識掛掉。
const DEFAULT_MODEL = 'gemini-flash-lite-latest';
const FALLBACK_MODEL = 'gemini-flash-latest';
// 通行碼不內嵌在公開網站裡：由「設定一鍵匯入連結」(#cfg=) 私下配發，
// 或在設定頁手動輸入。實際值必須與 GAS 部署版的 SECRET 一致。
const DEFAULT_SECRET = '';

/* ---- 圖片壓縮參數 ---- */
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.85;

/* ---- 辨識用 JSON Schema（Gemini responseSchema，OpenAPI 子集，type 需大寫）---- */
const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    supplier: { type: 'STRING' },
    salesOrderNo: { type: 'STRING' },
    date: { type: 'STRING' },
    invoiceNo: { type: 'STRING' },
    customer: { type: 'STRING' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          seq: { type: 'STRING' },
          productNo: { type: 'STRING' },
          name: { type: 'STRING' },
          spec: { type: 'STRING' },
          qty: { type: 'NUMBER' },
          unit: { type: 'STRING' },
          unitPrice: { type: 'NUMBER' },
          amount: { type: 'NUMBER' },
          orderNo: { type: 'STRING' },
          customerProductNo: { type: 'STRING' },
        },
        required: ['seq', 'productNo', 'name', 'spec', 'qty', 'unit', 'unitPrice', 'amount', 'orderNo', 'customerProductNo'],
      },
    },
    subtotal: { type: 'NUMBER' },
    tax: { type: 'NUMBER' },
    total: { type: 'NUMBER' },
  },
  required: ['supplier', 'salesOrderNo', 'date', 'invoiceNo', 'customer', 'items', 'subtotal', 'tax', 'total'],
};

const GEMINI_PROMPT = `你正在辨識台灣供應商「東野精機」的固定版式出貨單照片，請仔細閱讀版面配置後輸出結構化資料。

版面配置說明：
- 銷貨單號通常印在單據右上角。
- 明細表格每一列包含兩行：上一行是品號與品名，下一行是規格；請正確拆解到 productNo / name / spec。
- 明細表格右側欄位另外印有「訂單號碼」與「客戶品號」，對應到 orderNo / customerProductNo。
- 單據下方會有未稅合計、稅額、含稅合計三個數字。

已知背景詞彙（辨識提示，仍以照片實際內容為準，不可照抄）：
- 供應商固定為「東野精機股份有限公司」。
- 客戶名稱通常為「M310 銘機實業股份有限公司」（M310 是客戶代號）。
- 銷貨單號在右上角、由兩段組成（例如「B230 2606160010」），請以「B230-2606160010」格式完整輸出兩段。
- 品號多為「AC-」開頭的英數編號（例如 AC-DCB401、AC-ENC502），字母後面接的是數字不是字母。
- 常見品名詞彙：「三角連結塊」（DCB 系列）、「端蓋」（ENC 系列）；品名結尾常見「烤漆」二字（表面處理，不是「烤透」）。
- 發票號碼通常是手寫的 2 碼英文字母＋8 碼數字。

輸出規則（務必遵守）：
1. 日期一律輸出 YYYY/MM/DD 格式（例如 2026/07/15）。
2. 序號、單號（銷貨單號/訂單號碼）、品號、客戶品號、發票號碼一律輸出為字串，且必須保留原本的前導零（例如 "0012" 不可變成 12）。
3. 數量、單價、金額、未稅合計、稅額、含稅合計一律輸出為數字（number），不要加千分位逗號或貨幣符號。
4. 任何欄位若照片模糊、被遮擋或無法辨識，字串欄位輸出空字串 ""，數字欄位輸出 0，絕對不要憑空編造內容。
5. items 陣列必須包含單據上出現的每一列明細，順序與單據一致。

請直接依照給定的 JSON schema 輸出結果。`;

/* =========================================================
 * 佇列狀態機
 * ========================================================= */

const STATUS = {
  QUEUED: 'queued',
  RECOGNIZING: 'recognizing',
  REVIEW: 'review',
  DONE: 'done',
  FAILED: 'failed',
};

const STATUS_LABEL = {
  [STATUS.QUEUED]: '等待中',
  [STATUS.RECOGNIZING]: '辨識中',
  [STATUS.REVIEW]: '待核對',
  [STATUS.DONE]: '已送出',
  [STATUS.FAILED]: '失敗',
};

/* =========================================================
 * 小工具
 * ========================================================= */

const $ = (id) => document.getElementById(id);

function showView(id) {
  document.querySelectorAll('.view').forEach((el) => el.classList.remove('is-active'));
  $(id).classList.add('is-active');
  $(id).scrollTop = 0;
  const scrollArea = $(id).querySelector('.review-scroll');
  if (scrollArea) scrollArea.scrollTop = 0;
}

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

function fmtDateTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function makeId() {
  return 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* =========================================================
 * 全域 toast（輕量回饋，例如設定匯入成功）
 * ========================================================= */

let toastTimer = null;
function showToast(message, duration) {
  const el = $('global-toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  // 強制 reflow，確保連續呼叫時 transition 會重新播放
  void el.offsetWidth;
  el.classList.add('is-visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('is-visible');
    setTimeout(() => { el.hidden = true; }, 200);
  }, duration || 2000);
}

/* =========================================================
 * 設定（localStorage）
 * =========================================================
 */

function loadConfig() {
  return {
    operator: localStorage.getItem(LS_KEYS.operator) || '',
    apiKey: localStorage.getItem(LS_KEYS.apiKey) || '',
    model: localStorage.getItem(LS_KEYS.model) || DEFAULT_MODEL,
    gasUrl: localStorage.getItem(LS_KEYS.gasUrl) || '',
    secret: localStorage.getItem(LS_KEYS.secret) || DEFAULT_SECRET,
  };
}

function saveConfigFromForm() {
  localStorage.setItem(LS_KEYS.operator, $('cfg-operator').value.trim());
  localStorage.setItem(LS_KEYS.apiKey, $('cfg-apikey').value.trim());
  localStorage.setItem(LS_KEYS.model, $('cfg-model').value.trim() || DEFAULT_MODEL);
  localStorage.setItem(LS_KEYS.gasUrl, $('cfg-gasurl').value.trim());
  localStorage.setItem(LS_KEYS.secret, $('cfg-secret').value.trim());
}

function populateSettingsForm() {
  const cfg = loadConfig();
  $('cfg-operator').value = cfg.operator;
  $('cfg-apikey').value = cfg.apiKey;
  $('cfg-model').value = cfg.model;
  $('cfg-gasurl').value = cfg.gasUrl;
  $('cfg-secret').value = cfg.secret;
}

function refreshHomeHint() {
  const cfg = loadConfig();
  const missing = !cfg.apiKey || !cfg.gasUrl;
  $('setup-hint').hidden = !missing;
}

/* =========================================================
 * 設定一鍵匯入（URL hash provisioning）
 * 網址帶 #cfg=<base64url(JSON)>，欄位可含 operator/apiKey/model/gasUrl/secret（皆選填）。
 * 匯入後立刻把 hash 從網址列清掉，避免機密留在瀏覽紀錄或截圖裡。
 * ========================================================= */

function base64UrlDecodeUtf8(input) {
  let base64 = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  if (pad === 2) base64 += '==';
  else if (pad === 3) base64 += '=';
  else if (pad !== 0) throw new Error('base64url 長度不合法');

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

// 把設定物件寫進 localStorage（只寫有值的欄位，沒帶到的維持原設定）。
function applyImportedConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('匯入內容不是合法物件');
  if (cfg.operator) localStorage.setItem(LS_KEYS.operator, String(cfg.operator));
  if (cfg.apiKey) localStorage.setItem(LS_KEYS.apiKey, String(cfg.apiKey));
  if (cfg.model) localStorage.setItem(LS_KEYS.model, String(cfg.model));
  if (cfg.gasUrl) localStorage.setItem(LS_KEYS.gasUrl, String(cfg.gasUrl));
  if (cfg.secret) localStorage.setItem(LS_KEYS.secret, String(cfg.secret));
}

// 從「整條連結」或「純代碼」解析出設定物件。
function parseCfgPayload(raw) {
  let s = String(raw).trim();
  const idx = s.lastIndexOf('cfg=');
  if (idx >= 0) s = s.slice(idx + 4);
  s = s.split('&')[0].split('#')[0].trim();
  if (!s) throw new Error('沒有找到設定代碼');
  return JSON.parse(base64UrlDecodeUtf8(s));
}

function importConfigFromHash() {
  const hash = window.location.hash || '';
  const match = hash.match(/^#cfg=([^&]+)$/);
  if (!match) return;

  try {
    applyImportedConfig(JSON.parse(base64UrlDecodeUtf8(match[1])));
    history.replaceState(null, '', window.location.pathname + window.location.search);
    showToast('設定已匯入');
  } catch (err) {
    console.warn('設定匯入失敗（hash 解析錯誤）：', err);
  }
}

/* =========================================================
 * 圖片壓縮（canvas，長邊壓到 1600px，JPEG 0.85）
 * ========================================================= */

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const longSide = Math.max(width, height);
      if (longSide > MAX_DIMENSION) {
        const scale = MAX_DIMENSION / longSide;
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
      URL.revokeObjectURL(url);
      const base64 = dataUrl.split(',')[1];
      resolve({ base64, mime: 'image/jpeg', dataUrl });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('圖片讀取失敗，請重新拍攝'));
    };
    img.src = url;
  });
}

/* =========================================================
 * 呼叫 Gemini API
 * ========================================================= */

async function callGemini(base64, mime, apiKey, model) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [
      {
        parts: [
          { inline_data: { mime_type: mime, data: base64 } },
          { text: GEMINI_PROMPT },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: GEMINI_SCHEMA,
    },
  };

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error('網路連線失敗，請檢查網路後重試');
  }

  if (!res.ok) {
    if (res.status === 429) {
      const e = new Error('額度用盡或呼叫過快，請稍後再試');
      e.status = 429;
      throw e;
    }
    // 模型被下架 / 打錯模型名（404）→ 自動改用當前 flash 穩定版重試一次，避免整個辨識卡死。
    if (res.status === 404 && model !== FALLBACK_MODEL) {
      return callGemini(base64, mime, apiKey, FALLBACK_MODEL);
    }
    let detail = '';
    try {
      const errJson = await res.json();
      detail = errJson && errJson.error && errJson.error.message ? errJson.error.message : '';
    } catch (_) { /* ignore */ }
    const e = new Error(`Gemini API 錯誤（HTTP ${res.status}）${detail ? '：' + detail : ''}`);
    e.status = res.status;
    throw e;
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error('Gemini 回應解析失敗（非合法 JSON）');
  }

  const candidate = json.candidates && json.candidates[0];
  const part = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0];
  const text = part && part.text;
  if (!text) {
    throw new Error('Gemini 未回傳辨識結果（可能被安全過濾或照片無法辨識）');
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error('辨識結果 JSON 解析失敗，請重試');
  }
}

/* =========================================================
 * 送出到 GAS（單純 POST + 解析，payload 格式與 GAS 端契約不可變動）
 * ========================================================= */

async function postToGas(gasUrl, payload) {
  const res = await fetch(gasUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    redirect: 'follow',
    body: JSON.stringify(payload),
  });

  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error('GAS 回應解析失敗（非合法 JSON）');
  }

  if (!json.ok) {
    throw new Error(json.error === 'unauthorized' ? '通行碼不正確，請至設定確認' : (json.error || 'GAS 回傳失敗'));
  }

  return json;
}

/* =========================================================
 * App 狀態
 *   queue：批次佇列（單張拍照流程也會建立一個長度為 1 的佇列，行為不變）
 *   batchMode：true＝從相簿多選進入，佇列畫面/總結畫面生效
 *   activeId：目前顯示在核對畫面的佇列項目 id
 * ========================================================= */

const appState = {
  queue: [],
  batchMode: false,
  activeId: null,
  queueRunning: false,
};

function findItem(id) {
  return appState.queue.find((q) => q.id === id);
}

function activeItem() {
  return appState.activeId ? findItem(appState.activeId) : null;
}

function isBatchTerminal() {
  return appState.queue.length > 0 && appState.queue.every((q) => q.status === STATUS.DONE || q.status === STATUS.FAILED);
}

/* =========================================================
 * 核對畫面：明細卡片
 * ========================================================= */

function createItemCard(item) {
  const tpl = $('item-card-template');
  const frag = tpl.content.cloneNode(true);
  const card = frag.querySelector('.item-card');

  card.querySelector('.item-seq').value = item.seq ?? '';
  card.querySelector('.item-productNo').value = item.productNo ?? '';
  card.querySelector('.item-name').value = item.name ?? '';
  card.querySelector('.item-spec').value = item.spec ?? '';
  card.querySelector('.item-qty').value = item.qty ?? '';
  card.querySelector('.item-unit').value = item.unit ?? '';
  card.querySelector('.item-unitPrice').value = item.unitPrice ?? '';
  card.querySelector('.item-amount').value = item.amount ?? '';
  card.querySelector('.item-orderNo').value = item.orderNo ?? '';
  card.querySelector('.item-customerProductNo').value = item.customerProductNo ?? '';

  card.querySelector('.btn-item-delete').addEventListener('click', () => {
    card.remove();
    recalcMismatch();
  });

  return card;
}

function renderItems(items) {
  const list = $('items-list');
  list.innerHTML = '';
  (items || []).forEach((item) => list.appendChild(createItemCard(item)));
}

function addEmptyItem() {
  const list = $('items-list');
  const nextSeq = String(list.children.length + 1);
  const card = createItemCard({ seq: nextSeq, productNo: '', name: '', spec: '', qty: '', unit: '', unitPrice: '', amount: '', orderNo: '', customerProductNo: '' });
  list.appendChild(card);
  const firstInput = card.querySelector('.item-productNo');
  if (firstInput) firstInput.focus();
}

function recalcMismatch() {
  const amounts = document.querySelectorAll('#items-list .item-amount');
  let sum = 0;
  amounts.forEach((inp) => { sum += num(inp.value); });
  const subtotal = num($('tot-subtotal').value);
  const diff = Math.abs(sum - subtotal);
  const warnEl = $('mismatch-warning');
  if (diff > 0.5) {
    $('mismatch-warning-text').textContent = `明細加總 ${sum} 與單上未稅 ${subtotal} 不符`;
    warnEl.hidden = false;
  } else {
    warnEl.hidden = true;
  }
}

/* =========================================================
 * 核對畫面：填入辨識結果 + 批次進度
 * ========================================================= */

function updateReviewProgress() {
  const el = $('review-progress');
  if (!appState.batchMode) {
    el.hidden = true;
    return;
  }
  const idx = appState.queue.findIndex((q) => q.id === appState.activeId);
  el.hidden = false;
  el.textContent = `${idx + 1} / ${appState.queue.length}`;
}

function setReviewSubmitting(isSubmitting) {
  $('btn-submit').disabled = isSubmitting;
  $('btn-submit-label').textContent = isSubmitting ? '送出中…' : '確認送出';
}

function showReviewSubmitError(message) {
  $('review-submit-error-msg').textContent = message;
  $('review-submit-error').hidden = false;
}

function hideReviewSubmitError() {
  $('review-submit-error').hidden = true;
}

function populateReview(item) {
  const cfg = loadConfig();
  const result = item.result || {};

  $('hdr-supplier').value = result.supplier || '';
  $('hdr-salesOrderNo').value = result.salesOrderNo || '';
  $('hdr-date').value = result.date || '';
  $('hdr-invoiceNo').value = result.invoiceNo || '';
  $('hdr-customer').value = result.customer || '';

  $('hdr-capturedAt').textContent = item.capturedAt ? fmtDateTime(item.capturedAt) : '—';
  $('hdr-operator').textContent = cfg.operator || '—';

  renderItems(result.items || []);

  $('tot-subtotal').value = result.subtotal ?? 0;
  $('tot-tax').value = result.tax ?? 0;
  $('tot-total').value = result.total ?? 0;

  recalcMismatch();
  hideReviewSubmitError();
  setReviewSubmitting(false);
  $('btn-retake').textContent = appState.batchMode ? '返回佇列' : '重拍';
  updateReviewProgress();
}

/* =========================================================
 * 辨識中（單張拍照流程）錯誤處理
 * ========================================================= */

function showProcessingError(message) {
  $('processing-error-msg').textContent = message;
  $('processing-error').hidden = false;
}

function resetProcessingError() {
  $('processing-error').hidden = true;
}

/* =========================================================
 * 辨識引擎：對單一佇列項目呼叫 Gemini
 * ========================================================= */

async function recognizeItem(item) {
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    item.status = STATUS.FAILED;
    item.error = '尚未設定 Gemini API Key，請先到設定完成初始化';
    return false;
  }
  item.status = STATUS.RECOGNIZING;
  if (appState.batchMode) renderQueueList(); // 讓佇列卡片在等待 Gemini 期間即時顯示「辨識中」而非停在「等待中」
  try {
    const result = await callGemini(item.base64, item.mime, cfg.apiKey, cfg.model || DEFAULT_MODEL);
    item.result = result;
    item.capturedAt = new Date();
    item.status = STATUS.REVIEW;
    item.error = null;
    return true;
  } catch (err) {
    item.status = STATUS.FAILED;
    item.error = err.message || '辨識發生未知錯誤';
    return false;
  }
}

async function runSingleRecognition() {
  const item = activeItem();
  if (!item) return;
  const ok = await recognizeItem(item);
  if (ok) {
    populateReview(item);
    showView('view-review');
  } else {
    showProcessingError(item.error);
  }
}

/* =========================================================
 * 批次佇列引擎：一次一張依序辨識，避免打爆 API
 * ========================================================= */

async function processQueue() {
  if (appState.queueRunning) return;
  appState.queueRunning = true;
  try {
    for (;;) {
      const next = appState.queue.find((q) => q.status === STATUS.QUEUED);
      if (!next) break;
      renderQueueList();
      await recognizeItem(next);
      renderQueueList();
    }
  } finally {
    appState.queueRunning = false;
  }

  if (isBatchTerminal() && document.querySelector('.view.is-active')?.id === 'view-queue') {
    showBatchSummary();
  }
}

function retryItem(id) {
  const item = findItem(id);
  if (!item) return;
  item.status = STATUS.QUEUED;
  item.error = null;
  renderQueueList();
  processQueue();
}

function openReviewFor(id) {
  const item = findItem(id);
  if (!item || item.status !== STATUS.REVIEW) return;
  appState.activeId = id;
  populateReview(item);
  showView('view-review');
}

async function advanceAfterSubmit() {
  const nextReview = appState.queue.find((q) => q.status === STATUS.REVIEW);
  if (nextReview) {
    appState.activeId = nextReview.id;
    populateReview(nextReview);
    showView('view-review');
    return;
  }
  if (isBatchTerminal()) {
    showBatchSummary();
  } else {
    appState.activeId = null;
    renderQueueList();
    showView('view-queue');
  }
}

/* =========================================================
 * 佇列畫面：卡片渲染
 * ========================================================= */

function createQueueCard(item) {
  const tpl = $('queue-card-template');
  const frag = tpl.content.cloneNode(true);
  const card = frag.querySelector('.queue-card');
  card.dataset.id = item.id;

  const thumb = card.querySelector('.queue-card-thumb');
  if (item.dataUrl) {
    thumb.src = item.dataUrl;
  } else {
    thumb.remove();
  }

  card.querySelector('.queue-card-no').textContent = (item.result && item.result.salesOrderNo) || '－';

  const chip = card.querySelector('.queue-card-status');
  chip.textContent = STATUS_LABEL[item.status] || '';
  chip.className = `queue-card-status status-chip status-${item.status}`;

  const retryBtn = card.querySelector('.btn-queue-retry');
  if (item.status === STATUS.FAILED) {
    retryBtn.hidden = false;
    retryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      retryItem(item.id);
    });
  } else {
    retryBtn.hidden = true;
  }

  if (item.status === STATUS.REVIEW) {
    card.classList.add('is-tappable');
    card.addEventListener('click', () => openReviewFor(item.id));
  }

  return card;
}

function renderQueueList() {
  const list = $('queue-list');
  list.innerHTML = '';
  appState.queue.forEach((item) => list.appendChild(createQueueCard(item)));
  const doneCount = appState.queue.filter((q) => q.status === STATUS.DONE).length;
  $('queue-progress').textContent = `${doneCount} / ${appState.queue.length}`;
}

/* =========================================================
 * 拍照 / 相簿選擇 → 壓縮 → 建立佇列
 * ========================================================= */

async function handleCameraFile(file) {
  if (!file) return;
  try {
    const { base64, mime, dataUrl } = await compressImage(file);
    appState.batchMode = false;
    const item = { id: makeId(), base64, mime, dataUrl, capturedAt: null, status: STATUS.QUEUED, result: null, error: null };
    appState.queue = [item];
    appState.activeId = item.id;
    $('processing-thumb').src = dataUrl;
    resetProcessingError();
    showView('view-processing');
    await runSingleRecognition();
  } catch (err) {
    alert(err.message || '照片處理失敗，請重新拍攝');
  }
}

async function handleAlbumFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  // 只選 1 張時走單張流程（有清楚的「辨識中…」全螢幕畫面），不繞佇列。
  if (files.length === 1) {
    await handleCameraFile(files[0]);
    return;
  }

  appState.batchMode = true;
  appState.queue = [];
  appState.activeId = null;

  for (const file of files) {
    try {
      const { base64, mime, dataUrl } = await compressImage(file);
      appState.queue.push({ id: makeId(), base64, mime, dataUrl, capturedAt: null, status: STATUS.QUEUED, result: null, error: null });
    } catch (err) {
      appState.queue.push({ id: makeId(), base64: null, mime: null, dataUrl: '', capturedAt: null, status: STATUS.FAILED, result: null, error: err.message || '照片讀取失敗' });
    }
  }

  renderQueueList();
  showView('view-queue');
  processQueue();
}

/* =========================================================
 * 送出到 GAS（單張流程／批次流程共用資料組裝，分流呈現方式）
 * ========================================================= */

function gatherHeader() {
  return {
    supplier: $('hdr-supplier').value.trim(),
    salesOrderNo: $('hdr-salesOrderNo').value.trim(),
    date: $('hdr-date').value.trim(),
    invoiceNo: $('hdr-invoiceNo').value.trim(),
    customer: $('hdr-customer').value.trim(),
  };
}

function gatherItems() {
  const cards = document.querySelectorAll('#items-list .item-card');
  const items = [];
  cards.forEach((card) => {
    items.push({
      seq: card.querySelector('.item-seq').value.trim(),
      productNo: card.querySelector('.item-productNo').value.trim(),
      name: card.querySelector('.item-name').value.trim(),
      spec: card.querySelector('.item-spec').value.trim(),
      qty: num(card.querySelector('.item-qty').value),
      unit: card.querySelector('.item-unit').value.trim(),
      unitPrice: num(card.querySelector('.item-unitPrice').value),
      amount: num(card.querySelector('.item-amount').value),
      orderNo: card.querySelector('.item-orderNo').value.trim(),
      customerProductNo: card.querySelector('.item-customerProductNo').value.trim(),
    });
  });
  return items;
}

function gatherTotals() {
  return {
    subtotal: num($('tot-subtotal').value),
    tax: num($('tot-tax').value),
    total: num($('tot-total').value),
  };
}

function showDoneSubmitting() {
  showView('view-done');
  $('done-spinner').hidden = false;
  $('done-check').hidden = true;
  $('done-actions').hidden = true;
  $('done-error').hidden = true;
  $('done-text').hidden = false;
  $('done-text').textContent = '送出中…';
}

function triggerCheckAnimation() {
  const path = $('done-check-path');
  if (!path) return;
  path.classList.remove('draw-anim');
  void path.getBoundingClientRect();
  path.classList.add('draw-anim');
}

function revealDoneCheck() {
  $('done-check').hidden = false;
  triggerCheckAnimation();
}

function showDoneSuccess(rows) {
  $('done-spinner').hidden = true;
  revealDoneCheck();
  $('done-text').hidden = false;
  $('done-text').textContent = `已寫入 ${rows} 筆明細，照片已存 Drive`;
  $('btn-done-again').textContent = '再拍一張';
  $('link-done-sheet').href = SHEET_URL;
  $('done-actions').hidden = false;
}

function showDoneError(message) {
  $('done-spinner').hidden = true;
  $('done-check').hidden = true;
  $('done-text').hidden = true;
  $('done-error-msg').textContent = message;
  $('done-error').hidden = false;
}

function showBatchSummary() {
  const doneCount = appState.queue.filter((q) => q.status === STATUS.DONE).length;
  const failCount = appState.queue.filter((q) => q.status === STATUS.FAILED).length;

  showView('view-done');
  $('done-spinner').hidden = true;
  $('done-error').hidden = true;
  revealDoneCheck();
  $('done-text').hidden = false;
  $('done-text').textContent = failCount > 0
    ? `已送出 ${doneCount} 張，失敗 ${failCount} 張`
    : `已送出 ${doneCount} 張，全部完成`;
  $('btn-done-again').textContent = '回主畫面';
  $('link-done-sheet').href = SHEET_URL;
  $('done-actions').hidden = false;
}

async function submitOrder() {
  const cfg = loadConfig();
  if (!cfg.gasUrl) {
    alert('尚未設定 GAS 網址，請先到設定完成初始化');
    return;
  }
  const item = activeItem();
  if (!item || !item.base64) {
    alert('找不到照片資料，請重新拍攝');
    return;
  }

  const payload = {
    secret: cfg.secret,
    operator: cfg.operator,
    capturedAt: item.capturedAt ? item.capturedAt.toISOString() : new Date().toISOString(),
    header: gatherHeader(),
    items: gatherItems(),
    totals: gatherTotals(),
    photoBase64: item.base64,
    photoMime: item.mime,
  };

  if (!appState.batchMode) {
    showDoneSubmitting();
    try {
      const json = await postToGas(cfg.gasUrl, payload);
      item.status = STATUS.DONE;
      showDoneSuccess(json.rows);
    } catch (err) {
      showDoneError(err.message || '送出失敗，請重試');
    }
    return;
  }

  setReviewSubmitting(true);
  hideReviewSubmitError();
  try {
    await postToGas(cfg.gasUrl, payload);
    item.status = STATUS.DONE;
    setReviewSubmitting(false);
    await advanceAfterSubmit();
  } catch (err) {
    setReviewSubmitting(false);
    showReviewSubmitError(err.message || '送出失敗，請重試');
  }
}

/* =========================================================
 * 事件綁定
 * ========================================================= */

function resetToHome() {
  appState.queue = [];
  appState.activeId = null;
  appState.batchMode = false;
  $('file-input').value = '';
  $('file-input-multi').value = '';
  $('btn-done-again').textContent = '再拍一張';
  refreshHomeHint();
  showView('view-home');
}

function leaveReviewWithoutSubmitting() {
  if (appState.batchMode) {
    appState.activeId = null;
    renderQueueList();
    showView('view-queue');
  } else {
    resetToHome();
  }
}

function hasUnsentQueueItems() {
  return appState.queue.some((q) => q.status === STATUS.QUEUED || q.status === STATUS.RECOGNIZING || q.status === STATUS.REVIEW);
}

function bindEvents() {
  // 主畫面
  $('btn-shutter').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    handleCameraFile(file);
  });

  $('btn-pick-album').addEventListener('click', () => $('file-input-multi').click());
  $('file-input-multi').addEventListener('change', (e) => {
    handleAlbumFiles(e.target.files);
  });

  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const target = el.getAttribute('data-nav');
      if (target === 'view-settings') populateSettingsForm();
      showView(target);
    });
  });

  // 辨識中（單張拍照流程）
  $('btn-retry-scan').addEventListener('click', () => {
    resetProcessingError();
    showView('view-processing');
    runSingleRecognition();
  });
  $('btn-retry-retake').addEventListener('click', resetToHome);

  // 佇列畫面
  $('btn-queue-back').addEventListener('click', () => {
    const pendingCount = appState.queue.filter((q) => q.status !== STATUS.DONE).length;
    if (pendingCount > 0 && !confirm(`目前還有 ${pendingCount} 張尚未送出，確定要返回主畫面嗎？`)) return;
    resetToHome();
  });

  // 核對畫面
  $('btn-review-back').addEventListener('click', leaveReviewWithoutSubmitting);
  $('btn-retake').addEventListener('click', leaveReviewWithoutSubmitting);
  $('btn-add-item').addEventListener('click', addEmptyItem);
  $('btn-submit').addEventListener('click', submitOrder);

  $('items-list').addEventListener('input', (e) => {
    if (e.target.classList.contains('item-amount')) recalcMismatch();
  });
  $('tot-subtotal').addEventListener('input', recalcMismatch);

  // 完成畫面（單張／批次總結共用）
  $('btn-done-again').addEventListener('click', resetToHome);
  $('btn-submit-retry').addEventListener('click', submitOrder);
  $('btn-submit-back').addEventListener('click', () => showView('view-review'));

  // 設定畫面
  $('btn-settings-back').addEventListener('click', () => {
    refreshHomeHint();
    showView('view-home');
  });
  $('btn-import-config').addEventListener('click', () => {
    const raw = $('cfg-import').value.trim();
    if (!raw) { showToast('請先貼上設定連結'); return; }
    try {
      applyImportedConfig(parseCfgPayload(raw));
      populateSettingsForm();
      $('cfg-import').value = '';
      refreshHomeHint();
      showToast('設定已匯入');
    } catch (err) {
      console.warn('貼上匯入失敗：', err);
      showToast('連結格式不正確，請重新複製整條連結');
    }
  });
  $('btn-save-settings').addEventListener('click', () => {
    saveConfigFromForm();
    refreshHomeHint();
    const btn = $('btn-save-settings');
    const original = '儲存';
    btn.textContent = '已儲存 ✓';
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 1600);
  });
  $('btn-toggle-key').addEventListener('click', () => {
    const input = $('cfg-apikey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });
  $('btn-toggle-secret').addEventListener('click', () => {
    const input = $('cfg-secret');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  // 離開頁面前若佇列有未送出項目，提示使用者
  window.addEventListener('beforeunload', (e) => {
    if (hasUnsentQueueItems()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

/* =========================================================
 * 初始化
 * ========================================================= */

function init() {
  importConfigFromHash();
  // 分頁已開著時收到 #cfg= 連結（同頁 hash 變化不會重載）也要能匯入
  window.addEventListener('hashchange', () => {
    importConfigFromHash();
    refreshHomeHint();
  });

  $('link-sheet').href = SHEET_URL;
  $('link-xlsx').href = XLSX_URL;
  $('app-version').textContent = APP_VERSION;

  bindEvents();
  refreshHomeHint();
  showView('view-home');

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* 離線快取非必要，失敗不影響主流程 */ });
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
