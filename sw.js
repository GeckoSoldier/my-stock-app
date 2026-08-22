/* シンプルなオフラインキャッシュ用 Service Worker
   ※ CORE_ASSETSは「ネットワーク優先」で取得します。
      オンラインなら常に最新のファイルを表示し、オフライン時のみキャッシュを使います。
      これにより、index.html/app.js/styles.cssなどを更新してデプロイし直せば、
      次にページを開いたときに自動的に新しい内容が反映されます。 */
const CACHE_NAME = "daily-stock-cache-v2";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
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
  const url = new URL(event.request.url);

  // Firebase / 外部APIへのリクエストはキャッシュせずそのまま通す
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== "GET") return;

  // ネットワーク優先：オンラインなら常に最新を取りに行き、キャッシュも更新する。
  // オフラインでネットワークが失敗したときだけ、保存しておいたキャッシュを返す。
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
