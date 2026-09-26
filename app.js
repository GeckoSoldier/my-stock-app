/* ==========================================================================
   日用品ストック管理 - app.js
   買い物リスト + 購入サイクル + 在庫レベルを管理するシンプルなPWA。
   同期モードが "cloud" の場合は Firebase Firestore を使い、
   "local" の場合はブラウザの localStorage のみを使う。
   ========================================================================== */

const DEFAULT_CATEGORIES = ["キッチン", "バス・トイレ", "洗濯", "衛生用品", "掃除", "その他"];
const SETTINGS_KEY = "dsm_settings_v1";
const LOCAL_ITEMS_KEY = "dsm_items_local_v1";

const state = {
  items: [],
  settings: {
    syncMode: "local",       // "local" | "cloud"
    warnDays: 3,
    categories: [...DEFAULT_CATEGORIES],
    firebaseConfig: null,
    syncCode: ""
  },
  activeTab: "today",
  cloud: {
    app: null,
    db: null,
    unsub: null,
    ready: false
  }
};

/* ---------------------------- Utilities -------------------------------- */

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d;
}

function daysBetween(fromStr, toDate) {
  const from = new Date(fromStr + "T00:00:00");
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((toDate.setHours(0, 0, 0, 0) - from.setHours(0, 0, 0, 0)) / msPerDay);
}

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { t.hidden = true; }, 2400);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// Firestore は undefined を保存できないため、JSON を経由して取り除く
function sanitizeForCloud(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/* ---------------------------- Firebase 設定の読み取り -------------------- */

/**
 * Firebaseコンソールからコピーした設定を読み取る。
 * 次のどの形式で貼り付けても動くようにしている:
 *   - JSON形式            {"apiKey": "...", "projectId": "..."}
 *   - JavaScript形式      const firebaseConfig = { apiKey: "...", projectId: "..." };
 *   - import文などを含むコード全体
 */
function parseFirebaseConfig(raw) {
  const text = (raw || "").trim();
  if (!text) return null;

  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
  } catch (e) { /* JSON ではないので下の方法で読み取る */ }

  const cfg = {};
  const re = /["']?([A-Za-z_$][\w$]*)["']?\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`]*)`)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const value = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
    cfg[m[1]] = value;
  }
  return Object.keys(cfg).length ? cfg : null;
}

const REQUIRED_CONFIG_KEYS = ["apiKey", "projectId", "appId"];

function missingConfigKeys(cfg) {
  return REQUIRED_CONFIG_KEYS.filter((k) => !cfg || !cfg[k]);
}

function describeFirebaseError(err) {
  const code = (err && err.code) || "";
  if (code.includes("operation-not-allowed") || code.includes("admin-restricted-operation")) {
    return "匿名ログインが有効になっていません。Firebaseコンソールの「セキュリティ」→「Authentication」→「ログイン方法」で「匿名」をオンにしてください。";
  }
  if (code.includes("api-key-not-valid") || code.includes("invalid-api-key")) {
    return "apiKey が正しくないようです。Firebaseの設定をもう一度コピーし直して貼り付けてください。";
  }
  if (code.includes("permission-denied")) {
    return "Firestoreへのアクセスが拒否されました。Firestoreの「ルール」タブに、手順書のルールを貼り付けて「公開」したか確認してください。";
  }
  if (code.includes("not-found")) {
    return "Firestoreのデータベースが見つかりません。データベースIDを「(default)」のまま作成したか確認してください。";
  }
  if (code.includes("network-request-failed") || code.includes("unavailable")) {
    return "ネットワークに接続できませんでした。インターネット接続を確認して、もう一度お試しください。";
  }
  if (typeof firebase === "undefined") {
    return "Firebaseの部品を読み込めませんでした。インターネット接続を確認して、ページを再読み込みしてください。";
  }
  return "接続できませんでした。（エラー: " + (code || (err && err.message) || "不明") + "）";
}

/* ---------------------------- Persistence ------------------------------- */

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state.settings = { ...state.settings, ...parsed };
      if (!state.settings.categories || !state.settings.categories.length) {
        state.settings.categories = [...DEFAULT_CATEGORIES];
      }
    }
  } catch (e) { console.warn("settings load failed", e); }
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch (e) { console.warn(e); }
}

function readLocalItems() {
  try {
    const raw = localStorage.getItem(LOCAL_ITEMS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function loadLocalItems() {
  state.items = readLocalItems();
}

function saveLocalItems() {
  try { localStorage.setItem(LOCAL_ITEMS_KEY, JSON.stringify(state.items)); } catch (e) { console.warn(e); }
}

/* ---------------------------- Cloud (Firestore) -------------------------- */

function setSyncStatus(mode, label) {
  const dot = document.getElementById("syncDot");
  const lbl = document.getElementById("syncLabel");
  dot.classList.remove("on", "error");
  if (mode === "on") dot.classList.add("on");
  if (mode === "error") dot.classList.add("error");
  lbl.textContent = label;
}

function stopCloud() {
  if (state.cloud.unsub) { state.cloud.unsub(); state.cloud.unsub = null; }
  state.cloud.ready = false;
}

/**
 * Firestore に接続する。
 * 成功したら { ok: true }、失敗したら { ok: false, message } を返す。
 * options.offerMigration が true のとき、クラウドが空でこの端末に商品があれば
 * クラウドへコピーするか確認する（「保存して接続」を押したときのみ）。
 */
async function connectCloud(options = {}) {
  const cfg = state.settings.firebaseConfig;
  const code = (state.settings.syncCode || "").trim();
  if (!cfg || !code) {
    setSyncStatus("off", "未設定");
    return { ok: false, message: "Firebaseの設定と共有コードの両方を入力してください。" };
  }
  try {
    if (typeof firebase === "undefined") throw new Error("firebase-sdk-not-loaded");

    stopCloud();
    // 設定を直して接続し直す場合に備え、前回の接続は一度破棄する
    if (state.cloud.app) {
      try { await state.cloud.app.delete(); } catch (e) { /* ignore */ }
      state.cloud.app = null;
    }
    state.cloud.app = firebase.initializeApp(cfg);
    await state.cloud.app.auth().signInAnonymously();
    state.cloud.db = state.cloud.app.firestore();
    const colRef = state.cloud.db.collection("households").doc(code).collection("items");

    // 読み取りできるか（ルール・DBが正しいか）を最初に確認する
    const firstSnap = await colRef.get();

    if (options.offerMigration && firstSnap.empty) {
      const localItems = readLocalItems();
      if (localItems.length) {
        const ok = confirm(
          `この端末に登録済みの ${localItems.length} 件の商品を、クラウドにコピーしますか？\n` +
          "（コピーすると、同じ共有コードを入れたスマホなど他の端末でも表示されます）"
        );
        if (ok) {
          const batch = state.cloud.db.batch();
          localItems.forEach((it) => {
            const item = sanitizeForCloud({ ...it, id: it.id || uid() });
            batch.set(colRef.doc(item.id), item);
          });
          await batch.commit();
        }
      }
    }

    state.cloud.unsub = colRef.onSnapshot((snap) => {
      const items = [];
      snap.forEach((doc) => items.push({ ...doc.data(), id: doc.id }));
      items.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      state.items = items;
      render();
    }, (err) => {
      console.error(err);
      setSyncStatus("error", "同期エラー");
      showToast(describeFirebaseError(err));
    });

    state.cloud.ready = true;
    setSyncStatus("on", "同期中：" + code);
    return { ok: true };
  } catch (e) {
    console.error(e);
    stopCloud();
    setSyncStatus("error", "接続失敗");
    return { ok: false, message: describeFirebaseError(e) };
  }
}

function cloudCollection() {
  const code = (state.settings.syncCode || "").trim();
  return state.cloud.db.collection("households").doc(code).collection("items");
}

/* ---------------------------- Data operations ---------------------------- */

async function upsertItem(item) {
  if (state.settings.syncMode === "cloud" && state.cloud.ready) {
    try {
      await cloudCollection().doc(item.id).set(sanitizeForCloud(item), { merge: true });
    } catch (e) {
      console.error(e);
      showToast(describeFirebaseError(e));
    }
    // 画面は onSnapshot 経由で更新される
  } else {
    const idx = state.items.findIndex((i) => i.id === item.id);
    if (idx >= 0) state.items[idx] = item; else state.items.push(item);
    saveLocalItems();
    render();
  }
}

async function deleteItemById(id) {
  if (state.settings.syncMode === "cloud" && state.cloud.ready) {
    try {
      await cloudCollection().doc(id).delete();
    } catch (e) {
      console.error(e);
      showToast(describeFirebaseError(e));
    }
  } else {
    state.items = state.items.filter((i) => i.id !== id);
    saveLocalItems();
    render();
  }
}

/* ---------------------------- Cycle logic --------------------------------- */

function computeStatus(item) {
  const warnDays = Number(state.settings.warnDays) || 3;
  let daysLeft = null;
  if (item.lastPurchased && item.cycleDays) {
    const due = addDays(item.lastPurchased, Number(item.cycleDays));
    daysLeft = daysBetween(todayStr(), new Date(due));
  }

  let status = "ok";
  if (item.stockLevel === "none") status = "due";
  else if (item.stockLevel === "low") status = "soon";

  if (daysLeft !== null) {
    if (daysLeft <= 0) status = "due";
    else if (daysLeft <= warnDays && status === "ok") status = "soon";
  }

  return { daysLeft, status };
}

function statusLabel(status, daysLeft) {
  if (status === "due") {
    if (daysLeft !== null && daysLeft < 0) return `期限切れ（${Math.abs(daysLeft)}日超過）`;
    return "そろそろ買う";
  }
  if (status === "soon") {
    if (daysLeft !== null) return `あと${daysLeft}日`;
    return "残りわずか";
  }
  if (daysLeft !== null) return `あと${daysLeft}日`;
  return "OK";
}

/* ---------------------------- Rendering ----------------------------------- */

function itemThumbHtml(item) {
  const url = item.imageUrl ? escapeHtml(item.imageUrl) : "";
  const fallbackEmoji = "🧺";
  if (!url) {
    return `<span class="item-thumb-wrap item-thumb-empty" title="画像URL未登録"><span class="item-thumb-fallback">${fallbackEmoji}</span></span>`;
  }
  return `
    <a class="item-thumb-wrap" href="${url}" target="_blank" rel="noopener noreferrer" title="クリックでこのURLを開く" onclick="event.stopPropagation()">
      <span class="item-thumb-fallback">${fallbackEmoji}</span>
      <img class="item-thumb-img" src="${url}" alt="" loading="lazy" onerror="this.style.display='none'">
      <span class="item-thumb-link-badge">↗</span>
    </a>`;
}

function itemCardHtml(item) {
  const { daysLeft, status } = computeStatus(item);
  const stockLabel = { full: "十分", low: "少ない", none: "なし" }[item.stockLevel] || "十分";
  const stockClass = item.stockLevel === "none" ? "none" : (item.stockLevel === "low" ? "low" : "");
  const cardClass = status === "due" ? "overdue" : (status === "soon" ? "urgent" : "");

  return `
  <div class="item-card ${cardClass}" data-id="${escapeHtml(item.id)}">
    <div class="item-card-top">
      ${itemThumbHtml(item)}
      <div class="item-title-wrap">
        <div class="item-name">${escapeHtml(item.name)}</div>
        ${item.category ? `<span class="item-category">${escapeHtml(item.category)}</span>` : ""}
      </div>
      <span class="status-badge ${status}">${statusLabel(status, daysLeft)}</span>
    </div>
    <div class="item-meta">
      <span>前回: ${item.lastPurchased ? escapeHtml(item.lastPurchased) : "未記録"} ・ 周期: ${escapeHtml(item.cycleDays || "-")}日</span>
      <span class="stock-pill ${stockClass}">残量: ${stockLabel}</span>
    </div>
    <div class="item-actions">
      <button class="btn btn-primary" data-action="bought" data-id="${escapeHtml(item.id)}">買った（補充）</button>
      <button class="btn btn-secondary" data-action="edit" data-id="${escapeHtml(item.id)}">編集</button>
    </div>
  </div>`;
}

function render() {
  renderCategorySelects();
  renderCategoryChips();

  // TODAY list
  const todayItems = state.items
    .map((i) => ({ item: i, ...computeStatus(i) }))
    .filter((x) => x.status === "due" || x.status === "soon")
    .sort((a, b) => {
      const rank = { due: 0, soon: 1, ok: 2 };
      if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
      return (a.daysLeft ?? 999) - (b.daysLeft ?? 999);
    });

  const todayList = document.getElementById("todayList");
  const todayEmpty = document.getElementById("todayEmpty");
  todayList.innerHTML = todayItems.map((x) => itemCardHtml(x.item)).join("");
  todayEmpty.hidden = todayItems.length > 0;

  // ALL list
  const search = (document.getElementById("searchBox").value || "").trim().toLowerCase();
  const catFilter = document.getElementById("categoryFilter").value;
  let allItems = [...state.items];
  if (search) allItems = allItems.filter((i) => (i.name || "").toLowerCase().includes(search));
  if (catFilter && catFilter !== "__all__") allItems = allItems.filter((i) => i.category === catFilter);
  allItems.sort((a, b) => (a.name || "").localeCompare(b.name || "", "ja"));

  const allList = document.getElementById("allList");
  const allEmpty = document.getElementById("allEmpty");
  allList.innerHTML = allItems.map(itemCardHtml).join("");
  allEmpty.hidden = state.items.length > 0;

  attachCardHandlers();
}

function renderCategorySelects() {
  const cats = state.settings.categories;
  const itemCategory = document.getElementById("itemCategory");
  const currentVal = itemCategory.value;
  itemCategory.innerHTML = cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  if (cats.includes(currentVal)) itemCategory.value = currentVal;

  const catFilter = document.getElementById("categoryFilter");
  const filterVal = catFilter.value || "__all__";
  catFilter.innerHTML = `<option value="__all__">すべてのカテゴリ</option>` +
    cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  catFilter.value = cats.includes(filterVal) ? filterVal : "__all__";
}

function renderCategoryChips() {
  const wrap = document.getElementById("categoryChips");
  wrap.innerHTML = state.settings.categories.map((c) => `
    <span class="chip">${escapeHtml(c)}<button data-cat="${escapeHtml(c)}" title="削除">✕</button></span>
  `).join("");
  wrap.querySelectorAll("button[data-cat]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cat = btn.getAttribute("data-cat");
      state.settings.categories = state.settings.categories.filter((c) => c !== cat);
      saveSettings();
      render();
    });
  });
}

function attachCardHandlers() {
  document.querySelectorAll(".item-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      openEditModal(card.getAttribute("data-id"));
    });
  });
  document.querySelectorAll('[data-action="edit"]').forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openEditModal(btn.getAttribute("data-id"));
    });
  });
  document.querySelectorAll('[data-action="bought"]').forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-id");
      const item = state.items.find((i) => i.id === id);
      if (!item) return;
      const history = Array.isArray(item.history) ? item.history.slice(-9) : [];
      if (item.lastPurchased) history.push(item.lastPurchased);
      const updated = { ...item, lastPurchased: todayStr(), stockLevel: "full", history, updatedAt: Date.now() };
      await upsertItem(updated);
      showToast(`「${item.name}」を買った日を記録しました`);
    });
  });
}

/* ---------------------------- Tabs ----------------------------------------- */

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  document.getElementById("panel-today").hidden = tab !== "today";
  document.getElementById("panel-all").hidden = tab !== "all";
  document.getElementById("panel-settings").hidden = tab !== "settings";
}

/* ---------------------------- Modal ----------------------------------------- */

function updateImagePreview() {
  const url = document.getElementById("itemImageUrl").value.trim();
  const wrap = document.getElementById("imagePreviewWrap");
  const img = document.getElementById("imagePreviewImg");
  const fallback = document.getElementById("imagePreviewFallback");
  if (!url) { wrap.hidden = true; return; }
  wrap.hidden = false;
  fallback.hidden = true;
  img.hidden = false;
  img.onerror = () => { img.hidden = true; fallback.hidden = false; };
  img.src = url;
}

function openAddModal() {
  document.getElementById("modalTitle").textContent = "商品を追加";
  document.getElementById("itemForm").reset();
  document.getElementById("itemId").value = "";
  document.getElementById("itemLastPurchased").value = todayStr();
  document.getElementById("btnDeleteItem").hidden = true;
  document.getElementById("imagePreviewWrap").hidden = true;
  renderCategorySelects();
  document.getElementById("itemModalOverlay").hidden = false;
}

function openEditModal(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  document.getElementById("modalTitle").textContent = "商品を編集";
  document.getElementById("itemId").value = item.id;
  document.getElementById("itemName").value = item.name || "";
  document.getElementById("itemImageUrl").value = item.imageUrl || "";
  renderCategorySelects();
  document.getElementById("itemCategory").value = item.category || state.settings.categories[0];
  document.getElementById("itemCycle").value = item.cycleDays || "";
  document.getElementById("itemLastPurchased").value = item.lastPurchased || "";
  document.getElementById("itemMemo").value = item.memo || "";
  const radios = document.querySelectorAll('input[name="stockLevel"]');
  radios.forEach((r) => { r.checked = r.value === (item.stockLevel || "full"); });
  document.getElementById("btnDeleteItem").hidden = false;
  updateImagePreview();
  document.getElementById("itemModalOverlay").hidden = false;
}

function closeModal() {
  document.getElementById("itemModalOverlay").hidden = true;
}

async function handleItemFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById("itemId").value || uid();
  const existing = state.items.find((i) => i.id === id);
  const stockLevel = document.querySelector('input[name="stockLevel"]:checked').value;

  const item = {
    id,
    name: document.getElementById("itemName").value.trim(),
    imageUrl: document.getElementById("itemImageUrl").value.trim(),
    category: document.getElementById("itemCategory").value,
    cycleDays: Number(document.getElementById("itemCycle").value) || 30,
    lastPurchased: document.getElementById("itemLastPurchased").value || null,
    stockLevel,
    memo: document.getElementById("itemMemo").value.trim(),
    history: existing ? existing.history || [] : [],
    createdAt: existing && existing.createdAt ? existing.createdAt : Date.now(),
    updatedAt: Date.now()
  };

  if (!item.name) return;

  await upsertItem(item);
  closeModal();
  showToast("保存しました");
}

async function handleDeleteItem() {
  const id = document.getElementById("itemId").value;
  if (!id) return;
  if (!confirm("この商品を削除しますか？")) return;
  await deleteItemById(id);
  closeModal();
  showToast("削除しました");
}

/* ---------------------------- Settings UI ----------------------------------- */

function showConnectResult(kind, message) {
  const el = document.getElementById("connectResult");
  el.hidden = !message;
  el.className = "connect-result" + (kind ? " " + kind : "");
  el.textContent = message || "";
}

function initSettingsUI() {
  document.getElementById("modeLocal").checked = state.settings.syncMode === "local";
  document.getElementById("modeCloud").checked = state.settings.syncMode === "cloud";
  document.getElementById("cloudSettings").hidden = state.settings.syncMode !== "cloud";
  document.getElementById("firebaseConfig").value = state.settings.firebaseConfig
    ? JSON.stringify(state.settings.firebaseConfig, null, 2) : "";
  document.getElementById("syncCode").value = state.settings.syncCode || "";
  document.getElementById("warnDays").value = state.settings.warnDays;

  document.querySelectorAll('input[name="syncMode"]').forEach((r) => {
    r.addEventListener("change", () => {
      if (!r.checked) return;
      document.getElementById("cloudSettings").hidden = r.value !== "cloud";
      if (r.value === "local") {
        state.settings.syncMode = "local";
        saveSettings();
        stopCloud();
        loadLocalItems();
        setSyncStatus("off", "この端末のみ");
        showConnectResult(null, "");
        render();
      }
      // 「クラウド同期する」は「保存して接続」が成功した時点で切り替える
    });
  });

  document.getElementById("btnGenCode").addEventListener("click", () => {
    const rand = () => Math.random().toString(36).slice(2, 8);
    document.getElementById("syncCode").value = `home-${rand()}-${rand()}`;
  });

  document.getElementById("btnConnect").addEventListener("click", async () => {
    const btn = document.getElementById("btnConnect");
    const cfg = parseFirebaseConfig(document.getElementById("firebaseConfig").value);
    const code = document.getElementById("syncCode").value.trim();

    if (!cfg) {
      showConnectResult("error", "Firebaseの設定を読み取れませんでした。Firebaseコンソールに表示された「const firebaseConfig = { ... };」の部分をそのまま貼り付けてください。");
      return;
    }
    const missing = missingConfigKeys(cfg);
    if (missing.length) {
      showConnectResult("error", `Firebaseの設定に次の項目が見つかりません：${missing.join("、")}\n「{」から「}」まで全部コピーできているか確認してください。`);
      return;
    }
    if (!code) {
      showConnectResult("error", "共有コードを入力してください（「コード生成」ボタンで作れます）。");
      return;
    }

    btn.disabled = true;
    showConnectResult(null, "接続中です...");

    const prev = { ...state.settings };
    state.settings.firebaseConfig = cfg;
    state.settings.syncCode = code;

    const result = await connectCloud({ offerMigration: true });
    btn.disabled = false;

    if (result.ok) {
      state.settings.syncMode = "cloud";
      saveSettings();
      // 読み取った設定を見やすい形で表示し直す
      document.getElementById("firebaseConfig").value = JSON.stringify(cfg, null, 2);
      showConnectResult("ok", `接続しました。共有コード「${code}」でクラウド同期中です。\nスマホなど他の端末でも、同じFirebase設定と同じ共有コードを入れて「保存して接続」を押してください。`);
    } else {
      // 失敗したら元の設定（この端末のみ等）に戻す
      state.settings = prev;
      saveSettings();
      if (state.settings.syncMode !== "cloud") {
        setSyncStatus("off", "この端末のみ");
        loadLocalItems();
        render();
      }
      showConnectResult("error", result.message);
    }
  });

  document.getElementById("btnAddCategory").addEventListener("click", () => {
    const input = document.getElementById("newCategory");
    const val = input.value.trim();
    if (!val) return;
    if (!state.settings.categories.includes(val)) {
      state.settings.categories.push(val);
      saveSettings();
      render();
    }
    input.value = "";
  });

  document.getElementById("warnDays").addEventListener("change", (e) => {
    state.settings.warnDays = Number(e.target.value) || 3;
    saveSettings();
    render();
  });

  document.getElementById("btnExport").addEventListener("click", () => {
    const data = { items: state.items, categories: state.settings.categories };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `daily-stock-export-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById("btnImport").addEventListener("click", () => {
    document.getElementById("importFile").click();
  });

  document.getElementById("importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (Array.isArray(data.items)) {
        for (const item of data.items) {
          if (!item.id) item.id = uid();
          await upsertItem(item);
        }
        showToast(`${data.items.length}件のデータを取り込みました`);
      }
    } catch (err) {
      console.error(err);
      showToast("インポートに失敗しました");
    }
    e.target.value = "";
  });
}

/* ---------------------------- Init ----------------------------------------- */

function initGeneralUI() {
  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => switchTab(t.dataset.tab));
  });

  document.getElementById("btnAddItem").addEventListener("click", openAddModal);
  document.getElementById("btnCloseModal").addEventListener("click", closeModal);
  document.getElementById("btnCancelItem").addEventListener("click", closeModal);
  document.getElementById("itemModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "itemModalOverlay") closeModal();
  });
  document.getElementById("itemForm").addEventListener("submit", handleItemFormSubmit);
  document.getElementById("btnDeleteItem").addEventListener("click", handleDeleteItem);
  document.getElementById("itemImageUrl").addEventListener("input", updateImagePreview);

  document.getElementById("searchBox").addEventListener("input", render);
  document.getElementById("categoryFilter").addEventListener("change", render);
}

async function init() {
  loadSettings();
  initGeneralUI();
  initSettingsUI();

  if (state.settings.syncMode === "cloud" && state.settings.firebaseConfig && state.settings.syncCode) {
    setSyncStatus("off", "接続中...");
    render();
    const result = await connectCloud();
    if (!result.ok) showToast(result.message);
  } else {
    state.settings.syncMode = "local";
    loadLocalItems();
    setSyncStatus("off", "この端末のみ");
  }

  render();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW登録失敗", e));
  }
}

document.addEventListener("DOMContentLoaded", init);
