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
    syncCode: "",
    mergedCodes: []          // この端末のカテゴリをクラウドと統合済みの共有コード
  },
  activeTab: "today",
  cloud: {
    app: null,
    db: null,
    unsub: null,
    metaUnsub: null,
    sharedOk: false,         // カテゴリなどの共有設定が同期できているか
    ready: false
  }
};

// アプリのバージョン（更新のたびに index.html の ?v= と合わせて変える）
const APP_VERSION = "2026.09.27-1";

const SETUP_PARAM = "setup=";

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

// 「まもなく」の日数（0日も有効な値として扱う）
function getWarnDays() {
  const v = Number(state.settings.warnDays);
  return Number.isFinite(v) && v >= 0 ? v : 3;
}

function base64UrlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s) {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const bin = atob(t);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/* ---------------------------- 接続用リンク -------------------------------- */

// 接続用リンク: 「アプリのURL#setup=（Firebase設定と共有コードを短くまとめたもの）」
// 「#」より後ろはブラウザの外（GitHubのサーバーなど）には送られません。
function buildSetupLink() {
  const cfg = state.settings.firebaseConfig || {};
  const code = (state.settings.syncCode || "").trim();
  const payload = { v: 1, a: cfg.apiKey, p: cfg.projectId, i: cfg.appId, k: code };
  if (cfg.authDomain && cfg.authDomain !== `${cfg.projectId}.firebaseapp.com`) payload.d = cfg.authDomain;
  const base = location.href.split("#")[0];
  return `${base}#${SETUP_PARAM}${base64UrlEncode(JSON.stringify(payload))}`;
}

function parseSetupLink(text) {
  const t = (text || "").trim();
  if (!t) return null;
  const idx = t.indexOf(SETUP_PARAM);
  const token = (idx >= 0 ? t.slice(idx + SETUP_PARAM.length) : t).split(/[&\s]/)[0];
  try {
    const obj = JSON.parse(base64UrlDecode(token));
    if (!obj || !obj.a || !obj.p || !obj.i || !obj.k) return null;
    return {
      config: {
        apiKey: obj.a,
        authDomain: obj.d || `${obj.p}.firebaseapp.com`,
        projectId: obj.p,
        appId: obj.i
      },
      code: String(obj.k)
    };
  } catch (e) {
    return null;
  }
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
  try {
    localStorage.setItem(LOCAL_ITEMS_KEY, JSON.stringify(state.items));
    return true;
  } catch (e) {
    console.warn(e);
    showToast("この端末の保存容量がいっぱいです。写真を外すか、クラウド同期をお使いください");
    return false;
  }
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
  if (state.cloud.metaUnsub) { state.cloud.metaUnsub(); state.cloud.metaUnsub = null; }
  state.cloud.ready = false;
  state.cloud.sharedOk = false;
}

function metaRef(code) {
  return state.cloud.db.collection("households").doc(code).collection("meta").doc("settings");
}

// クラウドから届いた共有設定（カテゴリ・判定日数）をこの端末に反映する
function applySharedSettings(data) {
  if (!data) return;
  if (Array.isArray(data.categories)) state.settings.categories = data.categories.slice();
  if (typeof data.warnDays === "number") {
    state.settings.warnDays = data.warnDays;
    document.getElementById("warnDays").value = data.warnDays;
  }
  saveSettings();
  render();
}

/**
 * カテゴリなどの共有設定の同期を始める。
 * ・クラウドにまだ無ければ、この端末の設定をクラウドに保存する
 * ・この端末がこの共有コードに初めて接続したときは、端末側にしか無いカテゴリを
 *   クラウドに足し合わせる（どちらかの端末のカテゴリが消えてしまわないように）
 * ・以降はクラウドの内容を正として、変更をリアルタイムで受け取る
 * Firestoreのルールが古いままだと読み書きできないので、その場合は false を返す。
 */
async function setupSharedSettings(code) {
  const ref = metaRef(code);
  try {
    const snap = await ref.get();
    const localCats = state.settings.categories || [];
    const localWarn = getWarnDays();
    const alreadyMerged = (state.settings.mergedCodes || []).includes(code);

    if (!snap.exists) {
      await ref.set(sanitizeForCloud({ categories: localCats, warnDays: localWarn, updatedAt: Date.now() }));
    } else if (!alreadyMerged) {
      const cloud = snap.data() || {};
      const cloudCats = Array.isArray(cloud.categories) ? cloud.categories : [];
      const union = cloudCats.concat(localCats.filter((c) => !cloudCats.includes(c)));
      const cloudWarn = typeof cloud.warnDays === "number" ? cloud.warnDays : localWarn;
      if (union.length !== cloudCats.length || typeof cloud.warnDays !== "number") {
        await ref.set(sanitizeForCloud({ categories: union, warnDays: cloudWarn, updatedAt: Date.now() }), { merge: true });
      }
    }

    state.settings.mergedCodes = Array.from(new Set([...(state.settings.mergedCodes || []), code]));
    saveSettings();

    state.cloud.metaUnsub = ref.onSnapshot((doc) => {
      if (doc.exists) applySharedSettings(doc.data());
    }, (err) => {
      console.warn(err);
      state.cloud.sharedOk = false;
    });
    state.cloud.sharedOk = true;
    return true;
  } catch (e) {
    console.warn("共有設定を同期できません", e);
    state.cloud.sharedOk = false;
    return false;
  }
}

// カテゴリ・判定日数を変更したときに呼ぶ（この端末に保存し、同期中ならクラウドにも保存）
function saveSharedSettings() {
  saveSettings();
  if (state.settings.syncMode === "cloud" && state.cloud.ready && state.cloud.sharedOk) {
    const code = (state.settings.syncCode || "").trim();
    metaRef(code).set(sanitizeForCloud({
      categories: state.settings.categories,
      warnDays: getWarnDays(),
      updatedAt: Date.now()
    }), { merge: true }).catch((e) => {
      console.error(e);
      showToast(describeFirebaseError(e));
    });
  }
}

const RULES_UPDATE_NOTE = "※カテゴリと「まもなく」の日数は、まだ同期されていません。Firestoreの「ルール」を新しいもの（手順書の手順C）に貼り替えて「公開」してから、アプリを再読み込みしてください。商品の同期は問題なく動いています。";

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

    // カテゴリなどの共有設定（ルールが古い場合は商品だけ同期を続ける）
    const sharedOk = await setupSharedSettings(code);

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
    return { ok: true, sharedOk };
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
      return true; // 画面は onSnapshot 経由で更新される
    } catch (e) {
      console.error(e);
      showToast(describeFirebaseError(e));
      return false;
    }
  }
  const prev = state.items.slice();
  const idx = state.items.findIndex((i) => i.id === item.id);
  if (idx >= 0) state.items[idx] = item; else state.items.push(item);
  const ok = saveLocalItems();
  if (!ok) state.items = prev; // 保存できなかったら元に戻す
  render();
  return ok;
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

const STOCK_LABELS = { full: "十分", half: "半分程度", low: "少ない", none: "なし" };
// 「半分程度」の範囲（推定残量％、両端を含む）
const HALF_MAX = 65;
const HALF_MIN = 30;

/**
 * 残量の入力方法。"auto"（前回購入日と購入サイクルから自動計算）か、手入力の段階
 * （full / half / low / none）を返す。
 * 以前のバージョンでは残量の初期値が「十分」だったため、旧データの「十分」は自動扱いにする。
 */
function stockMode(item) {
  const lv = item.stockLevel;
  if (!lv || lv === "auto") return "auto";
  if (!item.stockV && lv === "full") return "auto";
  return STOCK_LABELS[lv] ? lv : "auto";
}

// 推定残量（％、整数）。前回購入日からの経過日数を購入サイクルで割って計算する。
function estimateRemainingPct(lastPurchased, cycleDays) {
  const cycle = Number(cycleDays);
  if (!lastPurchased || !(cycle > 0)) return null;
  const daysLeft = daysBetween(todayStr(), addDays(lastPurchased, cycle));
  return Math.round(Math.max(0, Math.min(1, daysLeft / cycle)) * 100);
}

function levelFromPct(pct) {
  if (pct === null) return null;
  if (pct > HALF_MAX) return "full";
  if (pct >= HALF_MIN) return "half";
  if (pct > 0) return "low";
  return "none";
}

// { level, auto, pct } level は full/half/low/none、自動計算できないときは null
function stockInfo(item) {
  const mode = stockMode(item);
  if (mode !== "auto") return { level: mode, auto: false, pct: null };
  const pct = estimateRemainingPct(item.lastPurchased, item.cycleDays);
  return { level: levelFromPct(pct), auto: true, pct };
}

function computeStatus(item) {
  const warnDays = getWarnDays();
  let daysLeft = null;
  if (item.lastPurchased && item.cycleDays) {
    const due = addDays(item.lastPurchased, Number(item.cycleDays));
    daysLeft = daysBetween(todayStr(), new Date(due));
  }

  // 手入力の「少ない」「なし」はこれまでどおり「今買うもの」に入れる。
  // 自動計算の場合は、これまでどおり「残り日数」で判定する。
  const info = stockInfo(item);
  let status = "ok";
  if (!info.auto && info.level === "none") status = "due";
  else if (!info.auto && info.level === "low") status = "soon";

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

// 商品画像の種類："upload"（アップロードした写真） / "url"（画像のURL）。旧データは URL 扱い
function itemImageSource(item) {
  return item.imageSource === "upload" ? "upload" : "url";
}

function itemThumbHtml(item) {
  const fallbackEmoji = "🧺";
  const source = itemImageSource(item);
  if (source === "upload" && item.imageData) {
    return `
    <button type="button" class="item-thumb-wrap item-thumb-photo" data-action="photo" data-id="${escapeHtml(item.id)}" title="写真を大きく表示" aria-label="写真を大きく表示">
      <span class="item-thumb-fallback">${fallbackEmoji}</span>
      <img class="item-thumb-img" src="${escapeHtml(item.imageData)}" alt="" onerror="this.style.display='none'">
    </button>`;
  }
  const url = source === "url" && item.imageUrl ? escapeHtml(item.imageUrl) : "";
  if (!url) {
    return `<span class="item-thumb-wrap item-thumb-empty" title="画像未登録"><span class="item-thumb-fallback">${fallbackEmoji}</span></span>`;
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
  const info = stockInfo(item);
  let stockLabel;
  if (info.level === null) stockLabel = "不明";
  else if (info.auto) stockLabel = `${STOCK_LABELS[info.level]}（約${info.pct}%）`;
  else stockLabel = STOCK_LABELS[info.level];
  const stockClass = info.level || "";
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

  // HALF list（「今買うもの」に入っているものは除く）
  const halfItems = state.items
    .map((i) => ({ item: i, ...computeStatus(i), info: stockInfo(i) }))
    .filter((x) => x.status === "ok" && x.info.level === "half")
    .sort((a, b) => (a.info.pct ?? 999) - (b.info.pct ?? 999));
  document.getElementById("halfList").innerHTML = halfItems.map((x) => itemCardHtml(x.item)).join("");
  document.getElementById("halfEmpty").hidden = halfItems.length > 0;

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
      if (state.settings.categories.length <= 1) {
        showToast("カテゴリは1つ以上必要です");
        return;
      }
      state.settings.categories = state.settings.categories.filter((c) => c !== cat);
      saveSharedSettings();
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
  document.querySelectorAll('[data-action="photo"]').forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const item = state.items.find((i) => i.id === btn.getAttribute("data-id"));
      if (item) openPhotoViewer(item);
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
      const today = todayStr();
      let history = Array.isArray(item.history) ? item.history.slice() : [];
      if (item.lastPurchased && item.lastPurchased !== today && !history.includes(item.lastPurchased)) {
        history.push(item.lastPurchased);
      }
      history = history.sort().slice(-10);
      const updated = { ...item, lastPurchased: today, stockLevel: "auto", stockV: 2, history, updatedAt: Date.now() };
      if (await upsertItem(updated)) showToast(`「${item.name}」を買った日を記録しました`);
    });
  });
}

/* ---------------------------- Tabs ----------------------------------------- */

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  document.getElementById("panel-today").hidden = tab !== "today";
  document.getElementById("panel-half").hidden = tab !== "half";
  document.getElementById("panel-all").hidden = tab !== "all";
  document.getElementById("panel-settings").hidden = tab !== "settings";
}

/* ---------------------------- Modal ----------------------------------------- */

// 登録／編集画面でアップロード中の写真（保存を押すまで商品には反映しない）
let modalImageData = "";

function checkedImageSource() {
  const r = document.querySelector('input[name="imageSource"]:checked');
  return r ? r.value : "url";
}

function setImageSource(source) {
  document.querySelectorAll('input[name="imageSource"]').forEach((r) => { r.checked = r.value === source; });
  applyImageSourceUI();
}

function applyImageSourceUI() {
  const upload = checkedImageSource() === "upload";
  document.getElementById("imageUploadBox").hidden = !upload;
  document.getElementById("imageUrlBox").hidden = upload;
  document.getElementById("btnClearPhoto").hidden = !modalImageData;
  document.getElementById("btnPickPhoto").textContent = modalImageData ? "写真を撮り直す／選び直す" : "写真を撮る／選ぶ";
  updateImagePreview();
}

function updateImagePreview() {
  const wrap = document.getElementById("imagePreviewWrap");
  const img = document.getElementById("imagePreviewImg");
  const fallback = document.getElementById("imagePreviewFallback");
  const upload = checkedImageSource() === "upload";
  const src = upload ? modalImageData : document.getElementById("itemImageUrl").value.trim();
  if (!src) { wrap.hidden = true; return; }
  wrap.hidden = false;
  fallback.hidden = true;
  img.hidden = false;
  img.onerror = () => { img.hidden = true; fallback.hidden = false; };
  img.src = src;
}

/**
 * 写真を端末の中で縮小して JPEG の文字列（data URL）にする。
 * 一覧のアイコンと拡大表示に十分な大きさ（長い辺 480px）にし、保存・同期の負担を小さくする。
 */
function compressImage(file, maxSide = 480) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";           // 透過PNGの背景を白に
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        let quality = 0.8;
        let data = canvas.toDataURL("image/jpeg", quality);
        while (data.length > 120000 && quality > 0.45) {  // 大きすぎるときは画質を少し下げる
          quality -= 0.1;
          data = canvas.toDataURL("image/jpeg", quality);
        }
        resolve(data);
      } catch (e) {
        reject(e);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("decode-failed")); };
    img.src = objectUrl;
  });
}

async function handlePhotoSelected(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const btn = document.getElementById("btnPickPhoto");
  btn.disabled = true;
  btn.textContent = "写真を読み込み中...";
  try {
    modalImageData = await compressImage(file);
  } catch (err) {
    console.error(err);
    showToast("この写真は読み込めませんでした。JPEG や PNG の写真を選んでください");
  }
  btn.disabled = false;
  applyImageSourceUI();
}

function openPhotoViewer(item) {
  document.getElementById("photoViewerImg").src = item.imageData;
  document.getElementById("photoViewerCaption").textContent = item.name || "";
  document.getElementById("photoViewer").hidden = false;
}

function closePhotoViewer() {
  document.getElementById("photoViewer").hidden = true;
  document.getElementById("photoViewerImg").src = "";
}

/* ---------- 残量の推定表示・購入履歴・平均サイクル（登録／編集画面） ---------- */

// 編集中の購入日履歴（保存を押すまで商品には反映しない）
let modalHistory = [];

function checkedStockLevel() {
  const r = document.querySelector('input[name="stockLevel"]:checked');
  return r ? r.value : "auto";
}

function updateStockEstimate() {
  const el = document.getElementById("stockEstimate");
  const pct = estimateRemainingPct(
    document.getElementById("itemLastPurchased").value,
    document.getElementById("itemCycle").value
  );
  if (pct === null) {
    el.textContent = "前回購入日と購入サイクルを入れると、推定残量を計算します。";
  } else {
    const lv = STOCK_LABELS[levelFromPct(pct)];
    el.textContent = `推定残量：約${pct}%（${lv}）` +
      (checkedStockLevel() === "auto" ? "" : " ※手入力の残量を優先しています");
  }
}

// 表示する履歴：前回購入日を除いた、新しい順の最大4件
function visibleHistory(lastPurchased) {
  const uniq = Array.from(new Set(modalHistory.filter(Boolean)));
  return uniq.filter((d) => d !== lastPurchased).sort().reverse().slice(0, 4);
}

/**
 * 平均購入サイクル（日）。表示中の履歴（最大4件）と前回購入日の、
 * 一番古い日から一番新しい日までの日数 ÷ 間隔の数。
 */
function averageCycle(lastPurchased, history) {
  const dates = Array.from(new Set([...history, lastPurchased].filter(Boolean))).sort();
  if (dates.length < 2) return null;
  const span = daysBetween(dates[0], new Date(dates[dates.length - 1] + "T00:00:00"));
  if (span <= 0) return null;
  return { avg: span / (dates.length - 1), count: dates.length };
}

function renderPurchaseHistory() {
  const last = document.getElementById("itemLastPurchased").value;
  const hist = visibleHistory(last);
  const list = document.getElementById("historyList");
  list.innerHTML = hist.map((d) => `
    <li class="history-chip"><span>${escapeHtml(d)}</span><button type="button" data-date="${escapeHtml(d)}" title="この履歴を削除" aria-label="${escapeHtml(d)} の履歴を削除">✕</button></li>
  `).join("");
  document.getElementById("historyEmpty").hidden = hist.length > 0;
  list.querySelectorAll("button[data-date]").forEach((b) => {
    b.addEventListener("click", () => {
      const d = b.getAttribute("data-date");
      modalHistory = modalHistory.filter((x) => x !== d);
      renderPurchaseHistory();
    });
  });

  const avgText = document.getElementById("avgCycleText");
  const btn = document.getElementById("btnApplyAvg");
  const avg = averageCycle(last, hist);
  if (!avg) {
    avgText.textContent = "平均購入サイクル：購入日が2回分以上そろうと計算します";
    btn.hidden = true;
    btn.dataset.days = "";
  } else {
    const shown = Math.round(avg.avg * 10) / 10;
    const applied = Math.max(1, Math.ceil(avg.avg));
    avgText.textContent = `平均購入サイクル：約${shown}日（購入${avg.count}回分から計算）`;
    btn.hidden = false;
    btn.textContent = `購入サイクルに反映（${applied}日）`;
    btn.dataset.days = String(applied);
  }
}

function applyAverageCycle() {
  const days = document.getElementById("btnApplyAvg").dataset.days;
  if (!days) return;
  document.getElementById("itemCycle").value = days;
  updateStockEstimate();
  showToast(`購入サイクルを${days}日にしました（保存で確定）`);
}

function openAddModal() {
  document.getElementById("modalTitle").textContent = "商品を追加";
  document.getElementById("itemForm").reset();
  document.getElementById("itemId").value = "";
  document.getElementById("itemLastPurchased").value = todayStr();
  document.getElementById("btnDeleteItem").hidden = true;
  document.querySelectorAll('input[name="stockLevel"]').forEach((r) => { r.checked = r.value === "auto"; });
  modalHistory = [];
  modalImageData = "";
  setImageSource("upload");
  renderCategorySelects();
  renderPurchaseHistory();
  updateStockEstimate();
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
  const mode = stockMode(item);
  document.querySelectorAll('input[name="stockLevel"]').forEach((r) => { r.checked = r.value === mode; });
  document.getElementById("btnDeleteItem").hidden = false;
  modalHistory = Array.isArray(item.history) ? item.history.slice() : [];
  modalImageData = item.imageData || "";
  setImageSource(itemImageSource(item));
  renderPurchaseHistory();
  updateStockEstimate();
  document.getElementById("itemModalOverlay").hidden = false;
}

function closeModal() {
  document.getElementById("itemModalOverlay").hidden = true;
}

async function handleItemFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById("itemId").value || uid();
  const existing = state.items.find((i) => i.id === id);
  const lastPurchased = document.getElementById("itemLastPurchased").value || null;

  const item = {
    id,
    name: document.getElementById("itemName").value.trim(),
    imageSource: checkedImageSource(),
    imageUrl: document.getElementById("itemImageUrl").value.trim(),
    imageData: modalImageData || "",
    category: document.getElementById("itemCategory").value,
    cycleDays: Number(document.getElementById("itemCycle").value) || 30,
    lastPurchased,
    stockLevel: checkedStockLevel(),
    stockV: 2,
    memo: document.getElementById("itemMemo").value.trim(),
    history: Array.from(new Set(modalHistory.filter((d) => d && d !== lastPurchased))).sort().slice(-10),
    createdAt: existing && existing.createdAt ? existing.createdAt : Date.now(),
    updatedAt: Date.now()
  };

  if (!item.name) return;

  // 保存できなかったときは画面を閉じない（入力した内容を失わないように）
  if (!(await upsertItem(item))) return;
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

/* ---------------------------- リマインド（カレンダー登録） -------------------- */

const REMINDER_TITLE = "日用品の買い物チェック（今買うもの）";
const pad2 = (n) => String(n).padStart(2, "0");

// 次にお知らせする日時（今日のその時刻を過ぎていたら明日）
function nextReminderStart(timeStr) {
  const [h, m] = String(timeStr || "18:00").split(":").map((x) => Number(x) || 0);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
  if (start <= now) start.setDate(start.getDate() + 1);
  return start;
}

function fmtLocalDateTime(d) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}T${pad2(d.getHours())}${pad2(d.getMinutes())}00`;
}

// 予定から開くと「今買うもの」タブが表示されるURL
function appTodayUrl() {
  return location.href.split("#")[0] + "#tab=today";
}

function googleCalendarUrl(timeStr) {
  const start = nextReminderStart(timeStr);
  const end = new Date(start.getTime() + 15 * 60000);
  let tz = "Asia/Tokyo";
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz; } catch (e) { /* 既定のまま */ }
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: REMINDER_TITLE,
    dates: `${fmtLocalDateTime(start)}/${fmtLocalDateTime(end)}`,
    ctz: tz,
    recur: "RRULE:FREQ=DAILY",
    details: `「今買うもの」を確認しましょう。\n${appTodayUrl()}`
  });
  return "https://calendar.google.com/calendar/render?" + params.toString();
}

function icsEscape(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

// .ics は1行75バイトまでなので、それを超える行は折り返す
function icsFold(line) {
  const enc = new TextEncoder();
  let out = "";
  let cur = "";
  let len = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (len + n > 75) {
      out += cur + "\r\n ";
      cur = "";
      len = 1;
    }
    cur += ch;
    len += n;
  }
  return out + cur;
}

function buildReminderIcs(timeStr) {
  const start = nextReminderStart(timeStr);
  const end = new Date(start.getTime() + 15 * 60000);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const url = appTodayUrl();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//DailyStock//Reminder//JA",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid()}@daily-stock`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${fmtLocalDateTime(start)}`,   // 端末の時刻（タイムゾーン指定なし）で毎日その時刻
    `DTEND:${fmtLocalDateTime(end)}`,
    "RRULE:FREQ=DAILY",
    `SUMMARY:${icsEscape(REMINDER_TITLE)}`,
    `DESCRIPTION:${icsEscape("「今買うもの」を確認しましょう。\n" + url)}`,
    `URL:${url}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsEscape(REMINDER_TITLE)}`,
    "TRIGGER:PT0M",                           // 予定の時刻ちょうどに通知
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR"
  ];
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

function initReminderUI() {
  const input = document.getElementById("remindTime");
  input.value = state.settings.remindTime || "18:00";
  input.addEventListener("change", () => {
    state.settings.remindTime = input.value || "18:00";
    saveSettings();
  });
  document.getElementById("btnGoogleCal").addEventListener("click", () => {
    window.open(googleCalendarUrl(input.value), "_blank", "noopener");
  });
  document.getElementById("btnIcs").addEventListener("click", () => {
    const blob = new Blob([buildReminderIcs(input.value)], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "daily-stock-reminder.ics";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showToast("カレンダー用ファイルを作りました。開いてカレンダーに追加してください");
  });
}

// URL の #tab=today などで開かれたとき、そのタブを表示する
function handleTabHash() {
  if (!location.hash.startsWith("#tab=")) return;
  const tab = decodeURIComponent(location.hash.slice(5));
  history.replaceState(null, "", location.href.split("#")[0]);
  if (["today", "half", "all", "settings"].includes(tab)) switchTab(tab);
}

/* ---------------------------- Settings UI ----------------------------------- */

function showConnectResult(kind, message) {
  const el = document.getElementById("connectResult");
  el.hidden = !message;
  el.className = "connect-result" + (kind ? " " + kind : "");
  el.textContent = message || "";
}

function hideSharePanel() {
  document.getElementById("sharePanel").hidden = true;
  document.getElementById("qrBox").innerHTML = "";
  document.getElementById("setupLinkOutput").value = "";
  document.getElementById("btnShowShare").hidden = false;
}

// 同期中のときだけ「他の端末を追加する」を表示する
function updateShareCard() {
  const connected = state.settings.syncMode === "cloud" && state.cloud.ready;
  document.getElementById("shareCard").hidden = !connected;
  if (!connected) hideSharePanel();
}

/**
 * 指定したFirebase設定と共有コードでクラウド同期に接続する。
 * 「保存して接続」「接続用リンク」の両方から使う。
 */
async function connectWith(cfg, code, button) {
  if (button) button.disabled = true;
  showConnectResult(null, "接続中です...");

  const prev = { ...state.settings };
  state.settings.firebaseConfig = cfg;
  state.settings.syncCode = code;

  const result = await connectCloud({ offerMigration: true });
  if (button) button.disabled = false;

  if (result.ok) {
    state.settings.syncMode = "cloud";
    saveSettings();
    document.getElementById("modeCloud").checked = true;
    document.getElementById("cloudSettings").hidden = false;
    document.getElementById("firebaseConfig").value = JSON.stringify(cfg, null, 2);
    document.getElementById("syncCode").value = code;
    let msg = `接続しました。共有コード「${code}」でクラウド同期中です。\n他の端末を追加するときは、下の「他の端末を追加する」から接続用リンクやQRコードを使えます。`;
    if (!result.sharedOk) msg += "\n" + RULES_UPDATE_NOTE;
    showConnectResult("ok", msg);
  } else {
    // 失敗したら元の状態に戻す
    state.settings = prev;
    saveSettings();
    if (prev.syncMode === "cloud" && prev.firebaseConfig && prev.syncCode) {
      await connectCloud(); // 元の共有コードにつなぎ直す
    } else {
      setSyncStatus("off", "この端末のみ");
      loadLocalItems();
      render();
    }
    showConnectResult("error", result.message);
  }
  updateShareCard();
  return result;
}

// 接続用リンクから開かれたとき（URLの # 以降に setup= が付いている）
async function handleSetupLinkOnLoad(hash) {
  const setup = parseSetupLink(hash);
  if (!setup) {
    showToast("接続用リンクを読み取れませんでした");
    return;
  }
  const cur = state.settings;
  if (cur.syncMode === "cloud" && state.cloud.ready && cur.syncCode === setup.code &&
      cur.firebaseConfig && cur.firebaseConfig.projectId === setup.config.projectId) {
    showToast("この端末はすでに同期中です");
    return;
  }
  const ok = confirm(
    "この端末をクラウド同期に接続しますか？\n\n" +
    `Firebaseプロジェクト：${setup.config.projectId}\n共有コード：${setup.code}\n\n` +
    "心当たりのないリンクの場合は「キャンセル」を押してください。"
  );
  if (!ok) return;
  switchTab("settings");
  document.getElementById("modeCloud").checked = true;
  document.getElementById("cloudSettings").hidden = false;
  await connectWith(setup.config, setup.code, null);
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
        updateShareCard();
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
    await connectWith(cfg, code, document.getElementById("btnConnect"));
  });

  // 接続用リンクを貼り付けて接続
  document.getElementById("btnQuickConnect").addEventListener("click", async () => {
    const input = document.getElementById("setupLinkInput");
    const setup = parseSetupLink(input.value);
    if (!setup) {
      showConnectResult("error", "接続用リンクを読み取れませんでした。同期済みの端末で「リンクをコピー」したものを、最後まで全部貼り付けてください。");
      return;
    }
    const result = await connectWith(setup.config, setup.code, document.getElementById("btnQuickConnect"));
    if (result.ok) input.value = "";
  });

  // 他の端末を追加する（接続用リンクとQRコード）
  document.getElementById("btnShowShare").addEventListener("click", () => {
    const link = buildSetupLink();
    document.getElementById("setupLinkOutput").value = link;
    const box = document.getElementById("qrBox");
    try {
      box.innerHTML = window.QRMini.toSvg(link, { ecl: "M", border: 4 });
    } catch (e) {
      console.error(e);
      box.innerHTML = '<p class="qr-error">QRコードを作れませんでした。下のリンクをコピーして使ってください。</p>';
    }
    document.getElementById("sharePanel").hidden = false;
    document.getElementById("btnShowShare").hidden = true;
  });

  document.getElementById("btnHideShare").addEventListener("click", hideSharePanel);

  document.getElementById("btnCopyLink").addEventListener("click", async () => {
    const out = document.getElementById("setupLinkOutput");
    let copied = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(out.value);
        copied = true;
      }
    } catch (e) { /* 下の方法で試す */ }
    if (!copied) {
      out.focus();
      out.select();
      try { copied = document.execCommand("copy"); } catch (e) { copied = false; }
    }
    showToast(copied ? "リンクをコピーしました" : "コピーできませんでした。リンクを長押しして選択・コピーしてください");
  });

  document.getElementById("btnAddCategory").addEventListener("click", () => {
    const input = document.getElementById("newCategory");
    const val = input.value.trim();
    if (!val) return;
    if (!state.settings.categories.includes(val)) {
      state.settings.categories = [...state.settings.categories, val];
      saveSharedSettings();
      render();
    }
    input.value = "";
  });

  document.getElementById("warnDays").addEventListener("change", (e) => {
    const v = Number(e.target.value);
    state.settings.warnDays = Number.isFinite(v) && v >= 0 ? v : 3;
    saveSharedSettings();
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
  document.querySelectorAll('input[name="imageSource"]').forEach((r) => r.addEventListener("change", applyImageSourceUI));
  document.getElementById("btnPickPhoto").addEventListener("click", () => document.getElementById("itemImageFile").click());
  document.getElementById("itemImageFile").addEventListener("change", handlePhotoSelected);
  document.getElementById("btnClearPhoto").addEventListener("click", () => { modalImageData = ""; applyImageSourceUI(); });
  document.getElementById("photoViewer").addEventListener("click", closePhotoViewer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePhotoViewer(); });
  ["input", "change"].forEach((ev) => {
    document.getElementById("itemLastPurchased").addEventListener(ev, () => { renderPurchaseHistory(); updateStockEstimate(); });
    document.getElementById("itemCycle").addEventListener(ev, updateStockEstimate);
  });
  document.querySelectorAll('input[name="stockLevel"]').forEach((r) => r.addEventListener("change", updateStockEstimate));
  document.getElementById("btnApplyAvg").addEventListener("click", applyAverageCycle);

  document.getElementById("searchBox").addEventListener("input", render);
  document.getElementById("categoryFilter").addEventListener("change", render);
}

async function init() {
  // 接続用リンクで開かれた場合は、共有コードがURLに残らないようすぐに消しておく
  let setupHash = null;
  if (location.hash.includes(SETUP_PARAM)) {
    setupHash = location.hash;
    history.replaceState(null, "", location.href.split("#")[0]);
  }

  loadSettings();
  initGeneralUI();
  initSettingsUI();
  document.getElementById("appVersion").textContent = APP_VERSION;
  initReminderUI();

  if (state.settings.syncMode === "cloud" && state.settings.firebaseConfig && state.settings.syncCode) {
    setSyncStatus("off", "接続中...");
    render();
    const result = await connectCloud();
    if (!result.ok) showToast(result.message);
    else if (!result.sharedOk) showToast("カテゴリの同期には、Firestoreのルールの更新が必要です（設定タブ参照）");
    if (result.ok && !result.sharedOk) showConnectResult("error", RULES_UPDATE_NOTE);
  } else {
    state.settings.syncMode = "local";
    loadLocalItems();
    setSyncStatus("off", "この端末のみ");
  }

  render();
  updateShareCard();

  if (setupHash) await handleSetupLinkOnLoad(setupHash);
  handleTabHash();

  // アプリを開いたままのタブで接続用リンクを開いた場合（ページは再読み込みされず # 以降だけが変わる）
  window.addEventListener("hashchange", () => {
    if (location.hash.startsWith("#tab=")) { handleTabHash(); return; }
    if (!location.hash.includes(SETUP_PARAM)) return;
    const hash = location.hash;
    history.replaceState(null, "", location.href.split("#")[0]);
    handleSetupLinkOnLoad(hash);
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW登録失敗", e));
  }
}

document.addEventListener("DOMContentLoaded", init);
