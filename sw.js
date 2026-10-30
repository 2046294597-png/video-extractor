const CACHE_NAME = 'video-extractor-v13';
const PRECACHE = ['./', './index.html', './manifest.json'];

// ===================== 大文件流式下载 =====================
// 页面要下 1GB 的视频时，走 <a download> + Blob 会把整段数据读进 JS 内存，
// 手机必被系统杀掉。这里让页面跳到 /__download?url=...&name=...，
// SW 向 CDN 发一次请求，把响应体直接管道给浏览器的下载管理器：
// 全程不经过 JS 内存，多大都行，还支持断点续传（Range 原样转发）。
const DOWNLOAD_PATH = '__download';

// 只允许下载这些域的视频，避免这个端点被当成任意文件的下载器
const DOWNLOAD_HOSTS = ['telesco.pe', 'twimg.com', 'xgvideo.com', 'vxtwitter.com'];

function hostAllowed(hostname) {
  return DOWNLOAD_HOSTS.some((h) => hostname === h || hostname.endsWith('.' + h));
}

function sanitizeFilename(name) {
  return (name || 'video.mp4').replace(/[\\"\r\n\t]/g, '_').slice(0, 120);
}

async function handleDownload(url, req) {
  const raw = url.searchParams.get('url');
  if (!raw) return new Response('missing url', { status: 400 });

  let target;
  try {
    target = new URL(raw);
  } catch {
    return new Response('bad url', { status: 400 });
  }

  // 只放行 https，且域名必须在白名单里
  if (target.protocol !== 'https:') {
    return new Response('protocol not allowed', { status: 400 });
  }
  if (!hostAllowed(target.hostname)) {
    return new Response('host not allowed: ' + target.hostname, { status: 403 });
  }

  const filename = sanitizeFilename(url.searchParams.get('name'));

  // 浏览器的下载管理器续传时会带 Range，原样转发，让它能接着下
  const init = { cache: 'no-store', redirect: 'follow' };
  const range = req.headers.get('range');
  if (range) init.headers = { Range: range };

  const upstream = await fetch(target.href, init);
  if (!upstream.ok && upstream.status !== 206) {
    return new Response('upstream ' + upstream.status, { status: 502 });
  }
  if (!upstream.body) {
    return new Response('upstream returned no body', { status: 502 });
  }

  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  headers.set('Content-Disposition', 'attachment; filename="' + filename + '"');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'no-store');

  const contentLength = upstream.headers.get('content-length');
  if (contentLength) headers.set('Content-Length', contentLength);

  const contentRange = upstream.headers.get('content-range');
  if (contentRange) headers.set('Content-Range', contentRange);

  // upstream.body 直接透传，不 buffer —— 这是「1GB 也不炸内存」的关键
  return new Response(upstream.body, { status: upstream.status, headers });
}

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

  // 大文件下载端点：必须在下面「跨域直接放行」之前拦下来
  if (url.origin === self.location.origin && url.pathname.endsWith(DOWNLOAD_PATH)) {
    event.respondWith(
      handleDownload(url, req).catch(
        (err) => new Response('download failed: ' + ((err && err.message) || err), { status: 502 })
      )
    );
    return;
  }

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
