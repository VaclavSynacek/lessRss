'use strict';

const Parser = require('rss-parser');
const { mapLimit } = require('./async-util');
const { MAX_FEED_BYTES, MAX_REDIRECTS, httpUrl, truncateUtf8 } = require('./feed-security');

const MAX_CANDIDATES = 10;
const FEED_TYPES = new Set([
  'application/atom+xml',
  'application/rdf+xml',
  'application/rss+xml',
  'application/xml',
  'application/x-rss+xml',
  'text/rdf',
  'text/xml',
]);
const parser = new Parser();

async function discoverFeed(inputUrl) {
  const page = await fetchText(inputUrl);
  const direct = await parsedFeed(page.body, page.url);
  if (direct) return { url: page.url, parsed: direct };

  const links = extractLinks(page.body, page.url);
  const explicit = links.filter((link) => isExplicitFeedLink(link));
  const byExtension = links.filter((link) => !isExplicitFeedLink(link) && /\.(?:atom|rdf|rss|xml)$/i.test(pathname(link.url)));
  const byName = links.filter((link) => (
    !isExplicitFeedLink(link)
    && !/\.(?:atom|rdf|rss|xml)$/i.test(pathname(link.url))
    && /(?:feed|rss|rdf|atom|xml)/i.test(link.url)
  ));

  for (const candidates of [explicit, byExtension, byName]) {
    const checked = await mapLimit(uniqueLinks(candidates).slice(0, MAX_CANDIDATES), 5, async (candidate) => {
      try {
        const response = await fetchText(candidate.url, Math.min(feedTimeoutMs(), 10000));
        const parsed = await parsedFeed(response.body, response.url);
        return parsed ? { ...candidate, url: response.url, parsed } : null;
      } catch {
        // A broken candidate must not prevent trying the remaining links.
        return null;
      }
    });
    const found = checked.filter(Boolean);
    if (found.length > 0) return chooseCandidate(found);
  }

  throw new Error(`no RSS or Atom feed found at ${inputUrl}`);
}

async function fetchText(startUrl, timeoutMs = feedTimeoutMs()) {
  let currentUrl = httpUrl(startUrl);
  if (!currentUrl) throw new Error('feed URL must use HTTP or HTTPS');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    for (let redirects = 0; ; redirects += 1) {
      const res = await fetch(currentUrl, {
        headers: { 'User-Agent': 'lessRss/0.1', Accept: 'application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, text/html;q=0.7, */*;q=0.1' },
        redirect: 'manual',
        signal: ctrl.signal,
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        if (redirects >= MAX_REDIRECTS) {
          await res.body?.cancel().catch(() => {});
          throw new Error(`too many redirects (maximum ${MAX_REDIRECTS})`);
        }
        const nextUrl = httpUrl(res.headers.get('location'), currentUrl);
        await res.body?.cancel().catch(() => {});
        if (!nextUrl) throw new Error('redirect URL must use HTTP or HTTPS');
        currentUrl = nextUrl;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`fetch ${currentUrl} HTTP ${res.status}`);
      }
      return { url: currentUrl, body: await readBoundedText(res) };
    }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`fetch timeout after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedText(res) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`document exceeds ${MAX_FEED_BYTES} bytes`);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body || []) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_FEED_BYTES) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`document exceeds ${MAX_FEED_BYTES} bytes`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function parsedFeed(body, sourceUrl) {
  if (!hasFeedRoot(body)) return null;
  try {
    const parsed = await parser.parseString(body);
    return {
      title: truncateUtf8(parsed.title || ''),
      link: httpUrl(parsed.link || '', sourceUrl),
    };
  } catch {
    return null;
  }
}

function hasFeedRoot(body) {
  const start = String(body || '')
    .replace(/^\uFEFF/, '')
    .replace(/^\s*<\?xml[\s\S]*?\?>/i, '')
    .replace(/^(?:\s*(?:<!--[\s\S]*?-->|<\?[^>]*\?>|<!DOCTYPE[\s\S]*?>))+/i, '');
  return /^\s*<(?:rss\b|(?:[\w.-]+:)?feed\b|(?:[\w.-]+:)?rdf\b)/i.test(start);
}

function extractLinks(html, baseUrl) {
  const out = [];
  const tagPattern = /<(link|a|area)\b([^>]*)>/gi;
  let match;
  while ((match = tagPattern.exec(String(html || ''))) !== null) {
    const attrs = attributes(match[2]);
    const url = httpUrl(decodeHtml(attrs.href || ''), baseUrl);
    if (!url) continue;
    let text = '';
    if (match[1].toLowerCase() === 'a') {
      const close = String(html).slice(tagPattern.lastIndex).match(/^([\s\S]*?)<\/a\s*>/i);
      if (close) text = decodeHtml(close[1].replace(/<[^>]*>/g, ' '));
    }
    out.push({
      url,
      rel: String(attrs.rel || '').toLowerCase().split(/\s+/).filter(Boolean),
      type: String(attrs.type || '').toLowerCase().split(';', 1)[0].trim(),
      name: truncateUtf8([decodeHtml(attrs.title || ''), text].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()),
      order: match.index,
    });
  }
  return out;
}

function attributes(source) {
  const out = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    out[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return out;
}

function isExplicitFeedLink(link) {
  return link.rel.includes('feed') || (
    link.rel.includes('alternate')
    && !link.rel.includes('stylesheet')
    && FEED_TYPES.has(link.type)
  );
}

function chooseCandidate(candidates) {
  let best = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = goodNameScore(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  // With no positively named candidate, retain HTML document order.
  best ||= candidates[0];
  return { url: best.url, parsed: best.parsed };
}

function goodNameScore(candidate) {
  const name = String(candidate.name || '').toLowerCase();
  if (!name) return 0;
  if (/\b(?:comments?|replies|responses|category|categories|tags?|authors?|search)\b/.test(name)) return -10;
  let score = 0;
  if (/\b(?:main|primary|sitewide|all posts?|latest posts?)\b/.test(name)) score += 5;
  if (/\b(?:blog|news|articles?|posts?)\b/.test(name)) score += 4;
  if (/\bfeed\b/.test(name)) score += 3;
  if (/\b(?:rss|atom)\b/.test(name)) score += 2;
  return score;
}

function uniqueLinks(links) {
  const seen = new Set();
  return links.filter((link) => {
    if (seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}

function pathname(url) {
  try { return new URL(url).pathname; } catch { return ''; }
}

function decodeHtml(value) {
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (whole, entity) => {
    const lower = entity.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
  });
}

function feedTimeoutMs() {
  const n = Number(process.env.LESSRSS_FEED_TIMEOUT_MS || 30000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30000;
}

module.exports = { discoverFeed, extractLinks, chooseCandidate };
