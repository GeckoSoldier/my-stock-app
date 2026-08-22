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
  return d.toISOString().slice(0, 10);
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
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function loadLocalItems() {
  try {
    const raw = localStorage.getItem(LOCAL_ITEMS_KEY);
    state.items = raw ? JSON.parse(raw) : [];
  } catch (e) {
    state.items = [];
  }
}

function saveLocalItems() {
  localStorage.setItem(LOCAL_ITEMS_KEY, JSON.stringify(state.items));
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

async function connectCloud() {
  const cfg = state.settings.firebaseConfig;
  const code = (state.settings.syncCode || "").trim();
  if (!cfg || !code) {
    setSyncStatus("off", "未設定");
    return;
  }
  try {
    if (state.cloud.unsub) { state.cloud.unsub(); state.cloud.unsub = null; }
    if (!state.cloud.app) {
      state.cloud.app = firebase.initializeApp(cfg);
    }
    const auth = firebase.auth();
    await auth.signInAnonymously();
    state.cloud.db = firebase.firestore();
    const colRef = state.cloud.db.collection("households").doc(code).collection("items");

    setSyncStatus("on", "同期中：" + code);

    state.cloud.unsub = colRef.onSnapshot((snap) => {
      const items = [];
      snap.forEach((doc) => items.push({ id: doc.id, ...doc.data() }));
      items.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      state.items = items;
      render();
    }, (err) => {
      console.error(err);
      setSyncStatus("error", "同期エラー");
    });

    state.cloud.ready = true;
  } catch (e) {
    console.error(e);
    setSyncStatus("error", "接続失敗");
    showToast("Firebaseへの接続に失敗しました。設定を確認してください。");
  }
}

function cloudCollection() {
  const code = (state.settings.syncCode || "").trim();
  return state.cloud.db.collection("households").doc(code).collection("items");
}

/* ---------------------------- Data operations ---------------------------- */

async function upsertItem(item) {
  if (state.settings.syncMode === "cloud" && state.cloud.ready) {
    const ref = cloudCollection().doc(item.id);
    await ref.set(item, { merge: true });
    // local state updates via onSnapshot
  } else {
    const idx = state.items.findIndex((i) => i.id === item.id);
    if (idx >= 0) state.items[idx] = item; else state.items.push(item);
    saveLocalItems();
    render();
  }
}

async function deleteItemById(id) {
  if (state.settings.syncMode === "cloud" && state.cloud.ready) {
    await cloudCollection().doc(id).delete();
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

function itemCardHtml(item) {
  const { daysLeft, status } = computeStatus(item);
  const stockLabel = { full: "十分", low: "少ない", none: "なし" }[item.stockLevel] || "十分";
  const stockClass = item.stockLevel === "none" ? "none" : (item.stockLevel === "low" ? "low" : "");
  const cardClass = status === "due" ? "overdue" : (status === "soon" ? "urgent" : "");

  return `
  <div class="item-card ${cardClass}" data-id="${item.id}">
    <div class="item-card-top">
      <div>
        <div class="item-name">${escapeHtml(item.name)}</div>
        ${item.category ? `<span class="item-category">${escapeHtml(item.category)}</span>` : ""}
      </div>
      <span class="status-badge ${status}">${statusLabel(status, daysLeft)}</span>
    </div>
    <div class="item-meta">
      <span>前回: ${item.lastPurchased ? item.lastPurchased : "未記録"} ・ 周期: ${item.cycleDays || "-"}日</span>
      <span class="stock-pill ${stockClass}">残量: ${stockLabel}</span>
    </div>
    <div class="item-actions">
      <button class="btn btn-primary" data-action="bought" data-id="${item.id}">買った（補充）</button>
      <button class="btn btn-secondary" data-action="edit" data-id="${item.id}">編集</button>
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
  if (search) allItems = allItems.filter((i) => i.name.toLowerCase().includes(search));
  if (catFilter && catFilter !== "__all__") allItems = allItems.filter((i) => i.category === catFilter);
  allItems.sort((a, b) => a.name.localeCompare(b.name, "ja"));

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
  catFilter.value = filterVal;
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

function openAddModal() {
  document.getElementById("modalTitle").textContent = "商品を追加";
  document.getElementById("itemForm").reset();
  document.getElementById("itemId").value = "";
  document.getElementById("itemLastPurchased").value = todayStr();
  document.getElementById("btnDeleteItem").hidden = true;
  renderCategorySelects();
  document.getElementById("itemModalOverlay").hidden = false;
}

function openEditModal(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  document.getElementById("modalTitle").textContent = "商品を編集";
  document.getElementById("itemId").value = item.id;
  document.getElementById("itemName").value = item.name || "";
  renderCategorySelects();
  document.getElementById("itemCategory").value = item.category || state.settings.categories[0];
  document.getElementById("itemCycle").value = item.cycleDays || "";
  document.getElementById("itemLastPurchased").value = item.lastPurchased || "";
  document.getElementById("itemMemo").value = item.memo || "";
  const radios = document.querySelectorAll('input[name="stockLevel"]');
  radios.forEach((r) => { r.checked = r.value === (item.stockLevel || "full"); });
  document.getElementById("btnDeleteItem").hidden = false;
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
    category: document.getElementById("itemCategory").value,
    cycleDays: Number(document.getElementById("itemCycle").value) || 30,
    lastPurchased: document.getElementById("itemLastPurchased").value || null,
    stockLevel,
    memo: document.getElementById("itemMemo").value.trim(),
    history: existing ? existing.history || [] : [],
    createdAt: existing ? existing.createdAt : Date.now(),
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
      document.getElementById("cloudSettings").hidden = r.value !== "cloud" || !r.checked;
      if (r.checked) {
        state.settings.syncMode = r.value;
        saveSettings();
        if (r.value === "local") {
          if (state.cloud.unsub) { state.cloud.unsub(); state.cloud.unsub = null; }
          state.cloud.ready = false;
          loadLocalItems();
          setSyncStatus("off", "この端末のみ");
          render();
        }
      }
    });
  });

  document.getElementById("btnGenCode").addEventListener("click", () => {
    const code = "home-" + Math.random().toString(36).slice(2, 8);
    document.getElementById("syncCode").value = code;
  });

  document.getElementById("btnConnect").addEventListener("click", async () => {
    const resultEl = document.getElementById("connectResult");
    try {
      const raw = document.getElementById("firebaseConfig").value.trim();
      const cfg = raw ? JSON.parse(raw) : null;
      const code = document.getElementById("syncCode").value.trim();
      if (!cfg || !code) {
        resultEl.textContent = "Firebase設定と共有コードの両方を入力してください。";
        return;
      }
      state.settings.syncMode = "cloud";
      state.settings.firebaseConfig = cfg;
      state.settings.syncCode = code;
      saveSettings();
      resultEl.textContent = "接続中...";
      await connectCloud();
      resultEl.textContent = "接続しました。";
    } catch (err) {
      console.error(err);
      resultEl.textContent = "JSONの形式が正しくない可能性があります。";
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
    const data = { settings: state.settings, items: state.items };
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

  document.getElementById("searchBox").addEventListener("input", render);
  document.getElementById("categoryFilter").addEventListener("change", render);
}

async function init() {
  loadSettings();
  initGeneralUI();
  initSettingsUI();

  if (state.settings.syncMode === "cloud" && state.settings.firebaseConfig && state.settings.syncCode) {
    setSyncStatus("off", "接続中...");
    await connectCloud();
  } else {
    loadLocalItems();
    setSyncStatus("off", "この端末のみ");
  }

  render();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW登録失敗", e));
  }
}

document.addEventListener("DOMContentLoaded", init);
