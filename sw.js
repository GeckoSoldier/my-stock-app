/* シンプルなオフラインキャッシュ用 Service Worker
   ・オンラインのときは、毎回サーバーに「新しい版があるか」を確認してから表示します
     （GitHub Pages はファイルをブラウザに10分間保存させるため、それを使わずに確認する）。
   ・オフラインのときだけ、保存しておいたファイルで表示します。
   ・index.html は app.js などを「app.js?v=バージョン」の形で読むので、
     古い app.js と新しい index.html が混ざることもありません。 */
const CACHE_NAME = "daily-stock-cache-v3";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS.map((u) => new Request(u, { cache: "no-cache" }))))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Firebase / 外部APIへのリクエストはそのまま通す
  if (url.origin !== self.location.origin) return;
  if (req.method !== "GET") return;

  // ネットワーク優先（ブラウザの一時保存を使わずにサーバーへ確認）。
  // ※ページ本体（navigate）の Request はオプション付きで複製できないため、URL から取り直す
  event.respondWith(
    fetch(req.url, { cache: "no-cache", credentials: "same-origin" })
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return response;
      })
      .catch(() => caches.match(req).then((hit) =>
        hit || (req.mode === "navigate" ? caches.match("./index.html") : undefined)))
  );
});
