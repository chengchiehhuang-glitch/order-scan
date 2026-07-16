'use strict';

/* =========================================================
 * 訂單辨識 PWA — 前端邏輯（純原生 JS，無框架、無 build step）
 * ========================================================= */

const APP_VERSION = 'v1.5.0';

/* ---- 固定連結（試算表 ID 固定，不放進設定） ---- */
const SHEET_ID = '1xB-hiIh6r-EizWqz80bbYT7p_OpNT36aZzz0KE9tVrA';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
const XLSX_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`;

/* ---- localStorage：前端零設定，只留「輸入人員」名字 ---- */
const LS_PREFIX = 'orderscan_';
const LS_KEYS = {
  operator: LS_PREFIX + 'operator',
};

// 前端零設定：GAS 網址與通行碼寫死在此；辨識與金鑰都在後端 GAS，不會下到前端。
// 這是沒對外宣傳的內部工具，URL 半公開可接受；真正機密（Gemini key）只在後端。
const GAS_URL = 'https://script.google.com/macros/s/AKfycbxwNU4Qh-qsURC0T8u2IJjOD7bwbLEfX-GwKatvkrm1uNHpa4Mab_dVxzK3zE8iwOdZ/exec';
const SECRET = 'fd01921724322e47fff0121a';

/* ---- 圖片壓縮參數 ---- */
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.85;

// 辨識用的 Gemini schema／prompt 已搬到後端 GAS（gas/Code.gs），前端不再需要。

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

// 前端零設定：唯一需要記住的是「輸入人員」名字（哪台手機是誰在用）。
function loadConfig() {
  return {
    operator: localStorage.getItem(LS_KEYS.operator) || '',
  };
}

function saveConfigFromForm() {
  localStorage.setItem(LS_KEYS.operator, $('cfg-operator').value.trim());
}

function populateSettingsForm() {
  $('cfg-operator').value = loadConfig().operator;
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
  item.status = STATUS.RECOGNIZING;
  if (appState.batchMode) renderQueueList(); // 讓佇列卡片在等待期間即時顯示「辨識中」而非停在「等待中」
  try {
    // 辨識在後端 GAS 進行：前端只把照片送過去，換回結構化結果（金鑰不在前端）。
    const json = await postToGas(GAS_URL, {
      action: 'recognize',
      secret: SECRET,
      photoBase64: item.base64,
      photoMime: item.mime,
    });
    item.result = json.result;
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
  const item = activeItem();
  if (!item || !item.base64) {
    alert('找不到照片資料，請重新拍攝');
    return;
  }

  const payload = {
    secret: SECRET,
    operator: loadConfig().operator,
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
      const json = await postToGas(GAS_URL, payload);
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
    await postToGas(GAS_URL, payload);
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

  // 設定畫面（只剩「輸入人員」名字）
  $('btn-settings-back').addEventListener('click', () => showView('view-home'));
  $('btn-save-settings').addEventListener('click', () => {
    saveConfigFromForm();
    const btn = $('btn-save-settings');
    btn.textContent = '已儲存 ✓';
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = '儲存';
      btn.disabled = false;
    }, 1600);
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
  $('link-sheet').href = SHEET_URL;
  $('link-xlsx').href = XLSX_URL;
  $('app-version').textContent = APP_VERSION;

  bindEvents();
  showView('view-home');

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* 離線快取非必要，失敗不影響主流程 */ });
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
