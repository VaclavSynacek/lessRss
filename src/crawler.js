'use strict';

const crypto = require('node:crypto');
const Parser = require('rss-parser');
const storage = require('./storage');
const { putBody } = require('./body-store');
const { absoluteUrl, sanitizeArticleHtml } = require('./html-sanitize');

const feedParser = new Parser({
  customFields: {
    item: [
      ['content:encoded', 'contentEncoded'],
      ['dc:creator', 'dcCreator'],
    ],
  },
});

async function refreshAll() {
  const subs = await storage.listSubscriptions();
  return mapLimit(subs, crawlerConcurrency(), (sub) => (
    refreshSubscription(sub).catch((e) => ({ feedId: sub.feedId, ok: false, error: e.message }))
  ));
}

async function refreshSubscription(sub) {
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
    throw new Error(message);
  } finally {
    clearTimeout(timer);
  }

  // 304: server confirmed nothing changed, so etag/lastModified are unchanged.
  // Nothing to persist.
  if (res.status === 304) {
    return { feedId: sub.feedId, ok: true, count: 0, skipped: 0, notModified: true };
  }

  if (!res.ok) {
    throw new Error(`fetch ${sub.url} HTTP ${res.status}`);
  }

  const xml = await res.text();
  const parsed = await parseFeed(xml);
  let count = 0;
  let skipped = 0;
  for (const parsedItem of latestItems(parsed.items, maxItemsPerFeed())) {
    const result = await refreshItem(sub, parsedItem, parsed.link);
    if (result === 'written') count += 1;
    else if (result === 'skipped') skipped += 1;
  }

  // Only persist fetch state when the caching headers actually changed.
  // This keeps steady-state refreshes (200 with same etag/last-modified) free
  // of subscription-row writes, matching the no-write-on-no-change rule.
  const nextEtag = res.headers.get('etag') || sub.etag || '';
  const nextLastModified = res.headers.get('last-modified') || sub.lastModified || '';
  if (nextEtag !== (sub.etag || '') || nextLastModified !== (sub.lastModified || '')) {
    await updateFetchState(sub.feedId, { etag: nextEtag, lastModified: nextLastModified });
  }
  return { feedId: sub.feedId, ok: true, count, skipped };
}

async function refreshItem(sub, parsedItem, feedHtmlUrl = '') {
  const itemUrl = absoluteUrl(parsedItem.link, feedHtmlUrl || sub.htmlUrl || sub.url);
  const guid = parsedItem.guid || itemUrl || parsedItem.title;
  if (!guid) return 'ignored';

  const itemId = storage.itemIdFor(sub.feedId, guid);
  const old = storage.getItem ? await storage.getItem(itemId) : (await storage.getItems([itemId]))[0] || null;
  const publishedMs = parsedItem.pubDate ? Date.parse(parsedItem.pubDate) : NaN;
  const stableBody = bodyFor(parsedItem, itemUrl, feedHtmlUrl || sub.htmlUrl || sub.url);
  const body = { ...stableBody, fetchedAt: new Date().toISOString() };
  const bodyHash = hashJson(stableBody);
  const bodyKey = `items/${sub.feedId}/${itemId}.json`;
  const next = {
    itemId,
    guid,
    url: itemUrl,
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

function bodyFor(parsedItem, itemUrl, feedHtmlUrl) {
  const baseUrl = itemUrl || feedHtmlUrl;
  const summaryHtml = parsedItem.description || parsedItem.content || '';
  const contentHtml = parsedItem.content || parsedItem.description || '';
  return {
    summaryHtml: sanitizeArticleHtml(summaryHtml, baseUrl),
    contentHtml: sanitizeArticleHtml(contentHtml, baseUrl),
    url: itemUrl || '',
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

function maxItemsPerFeed() {
  const n = Number(process.env.LESSRSS_MAX_ITEMS_PER_FEED || 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
}

function latestItems(items, limit) {
  if (!Array.isArray(items) || items.length <= limit) return items || [];
  return items
    .map((item, index) => ({ item, index, time: item.pubDate ? Date.parse(item.pubDate) : NaN }))
    .sort((a, b) => {
      const at = Number.isFinite(a.time);
      const bt = Number.isFinite(b.time);
      if (at && bt && a.time !== b.time) return b.time - a.time;
      if (at !== bt) return at ? -1 : 1;
      return a.index - b.index;
    })
    .slice(0, limit)
    .map((x) => x.item);
}

async function parseFeed(xml) {
  const parsed = await feedParser.parseString(xml);
  const isAtom = /<feed[\s>]/i.test(xml);
  return {
    title: parsed.title || '',
    link: parsed.link || parsed.feedUrl || '',
    items: (parsed.items || []).map((item) => normalizeParsedItem(item, isAtom)),
  };
}

function normalizeParsedItem(item, isAtom) {
  return {
    title: item.title || '',
    description: isAtom ? (item.summary || '') : (item.content || ''),
    content: isAtom ? (item.content || '') : (item.contentEncoded || ''),
    link: item.link || '',
    guid: item.guid || item.id || '',
    pubDate: item.isoDate || item.pubDate || '',
    author: item.creator || item.dcCreator || item.author || '',
  };
}

module.exports = { refreshAll, refreshSubscription, parseFeed };
