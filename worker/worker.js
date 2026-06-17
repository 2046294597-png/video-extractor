// video-extractor-worker.js
// Cloudflare Worker - Telegram video URL extractor
// Deploy: npx wrangler deploy

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // POST /extract - extract video from Telegram URL
    if (request.method === "POST" && url.pathname === "/extract") {
      try {
        const { tgUrl } = await request.json();
        if (!tgUrl || !tgUrl.includes("t.me")) {
          return json({ error: "Invalid Telegram URL" }, 400, corsHeaders);
        }

        const result = await extractTelegramVideo(tgUrl);
        if (!result) {
          return json({ error: "No video found" }, 404, corsHeaders);
        }

        return json({ videoUrl: result.videoUrl, source: result.source }, 200, corsHeaders);
      } catch (e) {
        return json({ error: e.message || "Extraction failed" }, 500, corsHeaders);
      }
    }

    return json({ error: "Not found" }, 404, corsHeaders);
  }
};

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function extractTelegramVideo(url) {
  let cleanUrl = url.replace(/\?.*$/, "").replace(/\/$/, "");

  // Parse username/channel and message ID
  const match = cleanUrl.match(/t\.me\/([^/]+)\/(\d+)/);
  if (!match) {
    // Try private channel format: t.me/c/123/456
    const privMatch = cleanUrl.match(/t\.me\/c\/(\d+)\/(\d+)/);
    if (privMatch) {
      throw new Error("Private channels require login. Open in browser instead.");
    }
    throw new Error("Invalid Telegram URL format");
  }

  const channel = match[1];
  const messageId = match[2];

  // Strategy 1: Fetch t.me/s/ server-rendered HTML
  const sUrl = `https://t.me/s/${channel}/${messageId}`;
  let html = await fetchWithRetry(sUrl);
  if (html) {
    const videoUrl = parseHTMLForVideo(html);
    if (videoUrl) return { videoUrl, source: "t.me/s/" };
  }

  // Strategy 2: Fetch embed version
  const embedUrl = `${cleanUrl}?embed=1&mode=tme`;
  html = await fetchWithRetry(embedUrl);
  if (html) {
    const videoUrl = parseHTMLForVideo(html);
    if (videoUrl) return { videoUrl, source: "embed" };
  }

  // Strategy 3: Try without mode=tme
  const embedUrl2 = `${cleanUrl}?embed=1`;
  html = await fetchWithRetry(embedUrl2);
  if (html) {
    const videoUrl = parseHTMLForVideo(html);
    if (videoUrl) return { videoUrl, source: "embed2" };
  }

  // Strategy 4: Fetch channel feed and search for the message
  const feedUrl = `https://t.me/s/${channel}`;
  html = await fetchWithRetry(feedUrl);
  if (html) {
    const videoUrl = parseFeedHTMLForVideo(html, messageId);
    if (videoUrl) return { videoUrl, source: "feed" };
  }

  return null;
}

async function fetchWithRetry(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; VideoExtractor/1.0)",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      if (resp.ok) {
        const text = await resp.text();
        if (text.length > 500) return text;
      }
    } catch {}
  }
  return null;
}

function parseHTMLForVideo(html) {
  // 1. video tag src
  let m = html.match(/<video[^>]+src=["']([^"']+)["'][^>]*>/i);
  if (m) return normalizeUrl(m[1]);

  // 2. source tag src
  m = html.match(/<source[^>]+src=["']([^"']+)["'][^>]*>/i);
  if (m) return normalizeUrl(m[1]);

  // 3. data-video-src or data-video-url
  m = html.match(/data-video-src=["']([^"']+)["']/i) || html.match(/data-video-url=["']([^"']+)["']/i);
  if (m) return normalizeUrl(m[1]);

  // 4. og:video meta tags
  m = html.match(/<meta\s+property=["']og:video["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta\s+property=["']og:video:url["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta\s+property=["']og:video:secure_url["'][^>]+content=["']([^"']+)["']/i);
  if (m) return normalizeUrl(m[1]);

  // 5. tgme_player_params JSON
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch;
  while ((scriptMatch = scriptRegex.exec(html)) !== null) {
    const jsonMatch = scriptMatch[1].match(
      /(?:var|let|const|window\.)?\s*(?:tgme_player_params|videoData|playerData|tgmePlayerParams|playerParams)\s*=\s*(\{[\s\S]*?\})\s*;?/i
    );
    if (jsonMatch) {
      try {
        const data = JSON.parse(jsonMatch[1]);
        const url = data?.video?.src || data?.video?.url || data?.src || data?.url || data?.file || data?.video_url;
        if (url) return normalizeUrl(url);
      } catch {}
    }
  }

  // 6. Inline JSON video patterns
  m = html.match(/"video"\s*:\s*\{[^}]*"src"\s*:\s*"([^"]+)"/)
    || html.match(/"src"\s*:\s*"(https?:\/\/[^"]*\.(?:mp4|webm)[^"]*)"/)
    || html.match(/"url"\s*:\s*"(https?:\/\/[^"]*\.(?:mp4|webm)[^"]*)"/)
    || html.match(/"video_url"\s*:\s*"(https?:\/\/[^"]+)"/)
    || html.match(/"file"\s*:\s*"(https?:\/\/[^"]*\.mp4[^"]*)"/);
  if (m) return normalizeUrl(m[1].replace(/\\\//g, "/"));

  // 7. Raw MP4/WebM URL
  m = html.match(/(https?:\/\/[^\s"'<>]+\.(?:mp4|webm|mov))/i);
  if (m) return normalizeUrl(m[1]);

  return null;
}

function parseFeedHTMLForVideo(html, targetMessageId) {
  // In the /s/ feed, find the message with data-post matching
  const postRegex = new RegExp(
    `<div[^>]*data-post=["'][^"']*${targetMessageId}["'][^>]*>[\\s\\S]*?</div>`,
    "i"
  );
  const postMatch = html.match(postRegex);
  if (!postMatch) return null;

  return parseHTMLForVideo(postMatch[0]);
}

function normalizeUrl(url) {
  if (!url) return null;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return url;
  return url.replace(/^http:\/\//i, "https://");
}
