const CACHE_NAME = 'video-extractor-v12';
const PRECACHE = ['./', './index.html', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 跨域请求（后端代理、视频 CDN）不进缓存，完全交给网络
  if (url.origin !== self.location.origin) return;

  const isDocument =
    req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');

  // 文档走「网络优先」：
  // 以前是 stale-while-revalidate，用户刷新一次拿到的还是旧缓存，
  // 部署修复后要等第二次访问才生效。改成网络优先，离线才回缓存。
  if (isDocument) {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() =>
          caches.match(req).then((hit) => hit || caches.match('./') || caches.match('./index.html'))
        )
    );
    return;
  }

  // 其余同源静态资源：缓存优先 + 后台更新
  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => hit || new Response('', { status: 408 }));
      return hit || network;
    })
  );
});
