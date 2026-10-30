// video-extractor-worker.js
// Cloudflare Worker —— 服务端直连解析，绕开浏览器 CORS
// Deploy: cd worker && npx wrangler deploy
//
// 路由：
//   GET  /              健康检查
//   GET  /proxy?url=    通用 GET 代理（转发 Range，供 <video> 拖动进度条）
//   POST /extract       { tgUrl } → { videoUrl, source }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// 白名单：否则这个 Worker 会变成任何人都能白嫖的开放代理
const ALLOWED_HOSTS = [
  't.me',
  'telegram.org',
  'telesco.pe',
  'video.twimg.com',
  'pbs.twimg.com',
  'cdn.syndication.twimg.com',
  'api.fxtwitter.com',
  'platform.twitter.com',
  'abs.twimg.com',
];

const UPSTREAM_TIMEOUT_MS = 25000;
// 视频本体可能是几十上百 MB，用 25 秒会把下载从中间掐断，代理单独放宽
const PROXY_TIMEOUT_MS = 180000;

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json(
        { ok: true, service: 'video-extractor-worker', routes: ['/proxy?url=', '/extract'] },
        200
      );
    }

    if (request.method === 'GET' && url.pathname === '/proxy') {
      return handleProxy(request, url);
    }

    if (request.method === 'POST' && url.pathname === '/extract') {
      try {
        const { tgUrl } = await request.json();
        if (!tgUrl || typeof tgUrl !== 'string' || !tgUrl.includes('t.me')) {
          return json({ error: 'Invalid Telegram URL' }, 400);
        }

        const result = await extractTelegramVideo(tgUrl);
        if (!result) {
          return json({ error: 'No video found' }, 404);
        }
        return json({ videoUrl: result.videoUrl, source: result.source }, 200);
      } catch (e) {
        return json({ error: e && e.message ? e.message : 'Extraction failed' }, 500);
      }
    }

    return json({ error: 'Not found' }, 404);
  },
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

// ---------------------------------------------------------------------------
// 通用代理
// ---------------------------------------------------------------------------

async function handleProxy(request, url) {
  const raw = url.searchParams.get('url');
  if (!raw) return json({ error: 'Missing ?url=' }, 400);

  let target;
  try {
    target = new URL(raw);
  } catch {
    return json({ error: 'Invalid url' }, 400);
  }

  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return json({ error: 'Bad protocol' }, 400);
  }

  const allowed = ALLOWED_HOSTS.some(
    (h) => target.hostname === h || target.hostname.endsWith('.' + h)
  );
  if (!allowed) {
    return json({ error: 'Host not allowed: ' + target.hostname }, 403);
  }

  const headers = {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  const range = request.headers.get('Range');
  if (range) headers['Range'] = range;

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
  } catch (e) {
    return json({ error: 'Upstream failed: ' + (e && e.message ? e.message : 'unknown') }, 502);
  }

  const out = new Headers(CORS);
  for (const h of [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'last-modified',
    'etag',
  ]) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  if (!out.has('accept-ranges') && (out.get('content-type') || '').startsWith('video/')) {
    out.set('accept-ranges', 'bytes');
  }
  out.set('cache-control', upstream.headers.get('cache-control') || 'public, max-age=300');

  return new Response(upstream.body, { status: upstream.status, headers: out });
}

// ---------------------------------------------------------------------------
// Telegram 解析
// ---------------------------------------------------------------------------

async function extractTelegramVideo(url) {
  const cleanUrl = url.replace(/\?.*$/, '').replace(/\/$/, '');

  // t.me/c/<internalId>/<msgId> 是私有频道，必须登录，直接给明确错误
  if (/t\.me\/c\/\d+\/\d+/.test(cleanUrl)) {
    throw new Error('Private channels require login. Open in browser instead.');
  }

  const match = cleanUrl.match(/t\.me\/([^/]+)\/(\d+)/);
  if (!match) throw new Error('Invalid Telegram URL format');

  const channel = match[1];
  const messageId = match[2];

  const strategies = [
    { url: `https://t.me/s/${channel}/${messageId}`, source: 't.me/s/' },
    { url: `${cleanUrl}?embed=1&mode=tme`, source: 'embed' },
    { url: `${cleanUrl}?embed=1`, source: 'embed2' },
  ];

  for (const s of strategies) {
    const html = await fetchHtml(s.url);
    if (!html) continue;
    const videoUrl = parseHTMLForVideo(html, s.url);
    if (videoUrl) return { videoUrl, source: s.source };
  }

  // 最后兜底：抓频道整页，定位到目标消息那一段再解析
  const feed = await fetchHtml(`https://t.me/s/${channel}`);
  if (feed) {
    const videoUrl = parseFeedHTMLForVideo(feed, messageId);
    if (videoUrl) return { videoUrl, source: 'feed' };
  }

  return null;
}

async function fetchHtml(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!resp.ok) continue;
      const text = await resp.text();
      if (text.length > 500) return text;
    } catch {
      // 重试一次
    }
  }
  return null;
}

function parseHTMLForVideo(html, baseUrl) {
  // 1. <video src>
  let m = html.match(/<video[^>]+src=["']([^"']+)["'][^>]*>/i);
  if (m) return absolutize(m[1], baseUrl);

  // 2. <source src>
  m = html.match(/<source[^>]+src=["']([^"']+)["'][^>]*>/i);
  if (m) return absolutize(m[1], baseUrl);

  // 3. data-video-src / data-video-url
  m =
    html.match(/data-video-src=["']([^"']+)["']/i) ||
    html.match(/data-video-url=["']([^"']+)["']/i);
  if (m) return absolutize(m[1], baseUrl);

  // 4. og:video meta
  m =
    html.match(/<meta\s+property=["']og:video(?::url|:secure_url)?["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta\s+property=["']twitter:player:stream["'][^>]+content=["']([^"']+)["']/i);
  if (m) return absolutize(m[1], baseUrl);

  // 5. tgme_player_params 等内联 JSON
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch;
  while ((scriptMatch = scriptRegex.exec(html)) !== null) {
    const jsonMatch = scriptMatch[1].match(
      /(?:var|let|const|window\.)?\s*(?:tgme_player_params|videoData|playerData|tgmePlayerParams|playerParams)\s*=\s*(\{[\s\S]*?\})\s*;?/i
    );
    if (!jsonMatch) continue;
    try {
      const data = JSON.parse(jsonMatch[1]);
      const url =
        (data.video && (data.video.src || data.video.url)) ||
        data.src ||
        data.url ||
        data.file ||
        data.video_url;
      if (url) return absolutize(url, baseUrl);
    } catch {
      // 这段不是合法 JSON，继续
    }
  }

  // 6. 内联 JSON 里的视频地址
  m =
    html.match(/"video"\s*:\s*\{[^}]*"src"\s*:\s*"([^"]+)"/) ||
    html.match(/"src"\s*:\s*"(https?:\/\/[^"]*\.(?:mp4|webm)[^"]*)"/) ||
    html.match(/"url"\s*:\s*"(https?:\/\/[^"]*\.(?:mp4|webm)[^"]*)"/) ||
    html.match(/"video_url"\s*:\s*"(https?:\/\/[^"]+)"/) ||
    html.match(/"file"\s*:\s*"(https?:\/\/[^"]*\.mp4[^"]*)"/);
  if (m) return absolutize(m[1].replace(/\\\//g, '/'), baseUrl);

  // 7. 裸的 mp4/webm/mov 链接
  m = html.match(/(https?:\/\/[^\s"'<>]+\.(?:mp4|webm|mov))/i);
  if (m) return absolutize(m[1], baseUrl);

  // 8. Telegram CDN
  m =
    html.match(/https?:\/\/cdn\d?\.(?:telesco\.pe|telegram\.org)\/[^\s"'<>]+\.(?:mp4|webm)/i) ||
    html.match(/https?:\/\/video\.(?:telesco\.pe|telegram\.org)\/[^\s"'<>]+\.(?:mp4|webm)/i);
  if (m) return absolutize(m[0], baseUrl);

  return null;
}

// 原来用 /<div[^>]*data-post=...[\s\S]*?<\/div>/ 非贪婪匹配，
// 遇到第一个 </div> 就断，嵌套结构必然截错。改成按 data-post 切段。
function parseFeedHTMLForVideo(html, messageId) {
  const safeId = String(messageId).replace(/[^0-9]/g, '');
  if (!safeId) return null;

  const marker = new RegExp(`data-post=["'][^"']*${safeId}(?![0-9])["']`, 'i');
  const hit = marker.exec(html);
  if (!hit) return null;

  const rest = html.slice(hit.index);
  const nextIdx = rest.slice(1).search(/data-post=["']/i);
  const block = nextIdx > 0 ? rest.slice(0, nextIdx + 1) : rest.slice(0, 20000);

  return parseHTMLForVideo(block, 'https://t.me');
}

// 相对地址必须补成绝对地址，否则前端拿到 "/file/xxx.mp4" 没法直接播
function absolutize(raw, baseUrl) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  try {
    return new URL(s, baseUrl || 'https://t.me').toString().replace(/^http:\/\//i, 'https://');
  } catch {
    return null;
  }
}
