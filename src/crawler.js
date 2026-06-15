'use strict';

const crypto = require('node:crypto');
const storage = require('./storage');
const { putBody } = require('./body-store');

async function refreshAll() {
  const subs = await storage.listSubscriptions();
  return mapLimit(subs, crawlerConcurrency(), (sub) => (
    refreshSubscription(sub).catch((e) => ({ feedId: sub.feedId, ok: false, error: e.message }))
  ));
}

async function refreshSubscription(sub) {
  const now = Date.now();
  const headers = { 'User-Agent': 'lessRss/0.1' };
  if (sub.etag) headers['If-None-Match'] = sub.etag;
  if (sub.lastModified) headers['If-Modified-Since'] = sub.lastModified;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), feedTimeoutMs());
  let res;
  try {
    res = await fetch(sub.url, { headers, signal: ctrl.signal });
  } catch (e) {
    const message = e.name === 'AbortError' ? `fetch timeout after ${feedTimeoutMs()}ms` : e.message;
    await updateFetchState(sub.feedId, { lastFetchAt: now, lastError: message });
    throw new Error(message);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 304) {
    await updateFetchState(sub.feedId, { lastFetchAt: now, lastStatus: 304, lastError: '' });
    return { feedId: sub.feedId, ok: true, count: 0, skipped: 0, notModified: true };
  }

  if (!res.ok) {
    const message = `fetch ${sub.url} HTTP ${res.status}`;
    await updateFetchState(sub.feedId, { lastFetchAt: now, lastStatus: res.status, lastError: message });
    throw new Error(message);
  }

  const xml = await res.text();
  const parsed = parseFeed(xml);
  let count = 0;
  let skipped = 0;
  for (const parsedItem of parsed.items) {
    const result = await refreshItem(sub, parsedItem);
    if (result === 'written') count += 1;
    else if (result === 'skipped') skipped += 1;
  }

  await updateFetchState(sub.feedId, {
    etag: res.headers.get('etag') || sub.etag || '',
    lastModified: res.headers.get('last-modified') || sub.lastModified || '',
    lastFetchAt: now,
    lastSuccessAt: Date.now(),
    lastStatus: 200,
    lastError: '',
  });
  return { feedId: sub.feedId, ok: true, count, skipped };
}

async function refreshItem(sub, parsedItem) {
  const guid = parsedItem.guid || parsedItem.link || parsedItem.title;
  if (!guid) return 'ignored';

  const itemId = storage.itemIdFor(sub.feedId, guid);
  const old = storage.getItem ? await storage.getItem(itemId) : (await storage.getItems([itemId]))[0] || null;
  const publishedMs = parsedItem.pubDate ? Date.parse(parsedItem.pubDate) : NaN;
  const stableBody = bodyFor(parsedItem);
  const body = { ...stableBody, fetchedAt: new Date().toISOString() };
  const bodyHash = hashJson(stableBody);
  const bodyKey = `items/${sub.feedId}/${itemId}.json`;
  const next = {
    itemId,
    guid,
    url: parsedItem.link || '',
    title: parsedItem.title || '',
    author: parsedItem.author || '',
    publishedUsec: String((Number.isFinite(publishedMs) ? publishedMs : old?.publishedUsec ? Math.floor(Number(old.publishedUsec) / 1000) : Date.now()) * 1000),
    crawlTimeMsec: old?.crawlTimeMsec || String(Date.now()),
    feedTitle: sub.title,
    feedUrl: sub.url,
    feedHtmlUrl: sub.htmlUrl,
    bodyKey,
    bodyHash,
  };

  if (old && unchanged(old, next)) return 'skipped';
  if (!old || old.bodyHash !== bodyHash || old.bodyKey !== bodyKey) await putBody(bodyKey, body);
  await storage.upsertItem(sub.feedId, next);
  return 'written';
}

function bodyFor(parsedItem) {
  return {
    summaryHtml: parsedItem.description || parsedItem.content || '',
    contentHtml: parsedItem.content || parsedItem.description || '',
    rawTitle: parsedItem.title || '',
    rawDescription: parsedItem.description || '',
    rawContent: parsedItem.content || '',
    url: parsedItem.link || '',
  };
}

function unchanged(old, next) {
  for (const key of ['guid', 'url', 'title', 'author', 'publishedUsec', 'feedTitle', 'feedUrl', 'feedHtmlUrl', 'bodyKey', 'bodyHash']) {
    if (String(old[key] || '') !== String(next[key] || '')) return false;
  }
  return true;
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function updateFetchState(feedId, patch) {
  if (storage.updateSubscriptionFetchState) await storage.updateSubscriptionFetchState(feedId, patch);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

function crawlerConcurrency() {
  const n = Number(process.env.LESSRSS_CRAWLER_CONCURRENCY || 5);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

function feedTimeoutMs() {
  const n = Number(process.env.LESSRSS_FEED_TIMEOUT_MS || 30000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30000;
}

function parseFeed(xml) {
  if (/<feed[\s>]/i.test(xml)) return parseAtom(xml);
  return parseRss(xml);
}

function parseRss(xml) {
  const items = [];
  for (const block of matchBlocks(xml, 'item')) {
    items.push({
      title: textTag(block, 'title'),
      description: textTag(block, 'description'),
      content: textTag(block, 'content:encoded') || textTag(block, 'encoded'),
      link: textTag(block, 'link'),
      guid: textTag(block, 'guid'),
      pubDate: textTag(block, 'pubDate') || textTag(block, 'dc:date'),
      author: textTag(block, 'author') || textTag(block, 'dc:creator'),
    });
  }
  return { items };
}

function parseAtom(xml) {
  const items = [];
  for (const block of matchBlocks(xml, 'entry')) {
    items.push({
      title: textTag(block, 'title'),
      description: textTag(block, 'summary'),
      content: textTag(block, 'content'),
      link: attrTag(block, 'link', 'href') || textTag(block, 'link'),
      guid: textTag(block, 'id'),
      pubDate: textTag(block, 'published') || textTag(block, 'updated'),
      author: textTag(matchBlocks(block, 'author')[0] || '', 'name'),
    });
  }
  return { items };
}

function matchBlocks(xml, tag) {
  const re = new RegExp(`<${escapeRe(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRe(tag)}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function textTag(xml, tag) {
  const re = new RegExp(`<${escapeRe(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRe(tag)}>`, 'i');
  const m = re.exec(xml || '');
  return m ? decodeXml(stripCdata(m[1]).trim()) : '';
}

function attrTag(xml, tag, attr) {
  const re = new RegExp(`<${escapeRe(tag)}\\b([^>]*)>`, 'i');
  const m = re.exec(xml || '');
  if (!m) return '';
  const are = new RegExp(`${escapeRe(attr)}=["']([^"']+)["']`, 'i');
  const am = are.exec(m[1]);
  return am ? decodeXml(am[1]) : '';
}

function stripCdata(s) {
  return String(s).replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { refreshAll, refreshSubscription, parseFeed };
