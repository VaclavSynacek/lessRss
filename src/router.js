'use strict';

const { configuredUser, validateLogin, loginResponse, validateAuthHeader, postTokenFor } = require('./auth');
const { STATE } = require('./constants');
const { json, text, xml, unauthorized, notFound, badRequest, formParams, arrayParam } = require('./http');
const storage = require('./storage');
const { mapLimit } = require('./async-util');
const { subscriptionToGreader, itemToGreader, sortItems, streamTitle } = require('./greader-format');
const { refreshAll } = require('./crawler');

// Cap on simultaneous S3 body fetches per stream read. Bounded to avoid
// fanning out hundreds of connections for large n= requests while still
// removing the previous serial-await bottleneck.
const BODY_FETCH_CONCURRENCY = Math.max(1, Number(process.env.LESSRSS_BODY_FETCH_CONCURRENCY) || 20);

async function route(req) {
  const url = new URL(req.rawPath + (req.rawQueryString ? '?' + req.rawQueryString : ''), 'http://local');
  const path = stripBase(url.pathname);

  if (path === '/accounts/ClientLogin' && req.method === 'POST') {
    const form = loginParams(req);
    if (!validateLogin(form.Email, form.Passwd)) return unauthorized();
    return text(200, loginResponse(form.Email));
  }

  const auth = validateAuthHeader(req.headers.authorization || req.headers.Authorization);
  if (!auth) return unauthorized();

  if (path === '/reader/api/0/token' && req.method === 'GET') return text(200, postTokenFor(auth.user) + '\n');
  if (path === '/reader/api/0/user-info' && req.method === 'GET') return userInfo();
  if (path === '/reader/api/0/tag/list' && req.method === 'GET') return requireJson(url) || tagList();
  if (path === '/reader/api/0/subscription/list' && req.method === 'GET') return requireJson(url) || subscriptionList();
  if (path === '/reader/api/0/unread-count' && req.method === 'GET') return requireJson(url) || unreadCount();
  if (path === '/reader/api/0/subscription/edit' && req.method === 'POST') return subscriptionEdit(req);
  if (path === '/reader/api/0/subscription/quickadd' && req.method === 'POST') return quickAdd(req);
  if (path === '/reader/api/0/subscription/export' && req.method === 'GET') return subscriptionExport();
  if (path === '/reader/api/0/subscription/import' && req.method === 'POST') return subscriptionImport(req);
  if (path.startsWith('/reader/api/0/stream/contents/') && req.method === 'GET') {
    const streamId = decodeURIComponent(path.slice('/reader/api/0/stream/contents/'.length));
    return streamContents(streamId, url.searchParams);
  }
  if (path === '/reader/api/0/stream/items/ids' && req.method === 'GET') return streamItemIds(url.searchParams);
  if (path === '/reader/api/0/stream/items/contents' && req.method === 'POST') return streamItemsContents(req);
  if (path === '/reader/api/0/edit-tag' && req.method === 'POST') return editTag(req);
  if (path === '/reader/api/0/mark-all-as-read' && req.method === 'POST') return markAllAsRead(req);
  if (path === '/reader/api/0/rename-tag' && req.method === 'POST') return text(200, 'OK');
  if (path === '/reader/api/0/disable-tag' && req.method === 'POST') return text(200, 'OK');

  return notFound();
}

function stripBase(path) {
  const base = '/api/greader.php';
  if (path === base) return '/';
  if (path.startsWith(base + '/')) return path.slice(base.length);
  return path;
}

function requireJson(url) {
  const output = url.searchParams.get('output');
  return output && output !== 'json' ? text(501, 'Only JSON output is implemented') : null;
}

function loginParams(req) {
  const out = formParams(req.body || '');
  const query = new URLSearchParams(req.rawQueryString || '');
  for (const key of ['Email', 'Passwd', 'service', 'accountType']) {
    if (out[key] === undefined && query.has(key)) out[key] = query.get(key);
  }
  return out;
}

function userInfo() {
  const user = configuredUser();
  return json(200, { userId: user, userName: user, userProfileId: user, userEmail: user });
}

async function tagList() {
  const subs = await storage.listSubscriptions();
  const tags = [
    { id: STATE.READING_LIST, sortid: '00000001' },
    { id: STATE.STARRED, sortid: '00000002' },
  ];
  const labels = new Set();
  for (const sub of subs) for (const c of sub.categories || []) if (c.id) labels.add(c.id);
  for (const label of labels) tags.push({ id: label, sortid: sortId(label), type: 'folder' });
  return json(200, { tags });
}

async function subscriptionList() {
  const subs = await storage.listSubscriptions();
  return json(200, { subscriptions: subs.map(subscriptionToGreader) });
}

async function unreadCount() {
  const items = await storage.listItems();
  const unread = items.filter((it) => !it.read);
  const counts = [{ id: STATE.READING_LIST, count: unread.length, newestItemTimestampUsec: newest(unread) }];
  const byFeed = new Map();
  for (const it of unread) byFeed.set(it.feedId, (byFeed.get(it.feedId) || 0) + 1);
  for (const [feedId, count] of byFeed) counts.push({ id: 'feed/' + feedId, count, newestItemTimestampUsec: newest(unread.filter((it) => it.feedId === feedId)) });
  return json(200, { max: counts.length, unreadcounts: counts });
}

async function subscriptionEdit(req) {
  const form = formParams(req.body || '');
  const ac = form.ac;
  const streams = arrayParam(form.s);
  if (!ac || streams.length === 0) return badRequest('missing ac or s');
  if (ac === 'subscribe') {
    for (const s of streams) {
      const url = String(s).replace(/^feed\//, '');
      await storage.subscribe(url, form.t);
    }
    return text(200, 'OK');
  }
  if (ac === 'unsubscribe') {
    for (const s of streams) await storage.unsubscribe(s);
    return text(200, 'OK');
  }
  if (ac === 'edit') return text(200, 'OK');
  return badRequest('unknown action');
}

async function quickAdd(req) {
  const form = formParams(req.body || '');
  if (!form.quickadd) return badRequest('missing quickadd');
  const sub = await storage.subscribe(form.quickadd);
  return json(200, { numResults: 1, query: form.quickadd, streamId: sub.id, streamName: sub.title });
}

async function subscriptionExport() {
  const subs = await storage.listSubscriptions();
  const outlines = subs.map((s) => `    <outline type="rss" text="${esc(s.title)}" title="${esc(s.title)}" xmlUrl="${esc(s.url)}" htmlUrl="${esc(s.htmlUrl || s.url)}"/>`).join('\n');
  return xml(200, `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>lessRss</title></head>\n  <body>\n${outlines}\n  </body>\n</opml>\n`);
}

async function subscriptionImport(req) {
  const contentType = req.headers['content-type'] || req.headers['Content-Type'] || '';
  let opml = req.body || '';
  if (contentType.includes('application/x-www-form-urlencoded')) opml = formParams(req.body || '').opml || '';
  for (const m of opml.matchAll(/xmlUrl=["']([^"']+)["'][^>]*(?:title|text)=["']([^"']*)["']|(?:title|text)=["']([^"']*)["'][^>]*xmlUrl=["']([^"']+)["']/gi)) {
    const url = unesc(m[1] || m[4]);
    const title = unesc(m[2] || m[3] || url);
    if (url) await storage.subscribe(url, title);
  }
  await refreshAll().catch(() => {});
  return text(200, 'OK');
}

async function streamContents(streamId, params) {
  const items = await selectItems(streamId, params);
  const subs = await storage.listSubscriptions();
  const subMap = new Map(subs.map((s) => [s.feedId, s]));
  // Fan out S3 body fetches in parallel; each itemToGreader awaits getBody(),
  // so serial iteration made latency scale with item count (n defaults to 20).
  const out = await mapLimit(items, BODY_FETCH_CONCURRENCY, (item) => itemToGreader(item, subMap.get(item.feedId)));
  return json(200, {
    id: streamId,
    title: streamTitle(streamId),
    updated: Math.floor(Date.now() / 1000),
    direction: params.get('r') === 'o' ? 'ltr' : 'rtl',
    self: [{ href: streamId }],
    items: out,
  });
}

async function streamItemIds(params) {
  const items = await selectItems(params.get('s') || STATE.READING_LIST, params);
  return json(200, { itemRefs: items.map((it) => ({ id: String(it.itemId) })) });
}

async function streamItemsContents(req) {
  const form = formParams(req.body || '');
  const ids = arrayParam(form.i);
  const items = sortItems(await storage.getItems(ids), form.r);
  const subs = await storage.listSubscriptions();
  const subMap = new Map(subs.map((s) => [s.feedId, s]));
  const out = await mapLimit(items, BODY_FETCH_CONCURRENCY, (item) => itemToGreader(item, subMap.get(item.feedId)));
  return json(200, { items: out });
}

async function selectItems(streamId, params) {
  const opts = {
    limit: Number(params.get('n') || 20),
    order: params.get('r') || 'd',
    excludeRead: params.get('xt') === STATE.READ,
    includeStarred: params.get('it') === STATE.STARRED,
    ot: Number(params.get('ot') || 0),
    nt: Number(params.get('nt') || 0),
  };
  if (storage.listStreamItems) return storage.listStreamItems(streamId, opts);

  let items = await storage.listItems();
  if (streamId === STATE.STARRED) items = items.filter((it) => it.starred);
  else if (streamId.startsWith('feed/')) items = items.filter((it) => it.feedId === streamId.slice(5));
  else if (streamId.startsWith('user/-/label/')) {
    const label = streamId.slice('user/-/label/'.length);
    items = items.filter((it) => (it.labels || []).includes(label));
  }
  if (opts.excludeRead) items = items.filter((it) => !it.read);
  if (opts.includeStarred) items = items.filter((it) => it.starred);
  if (opts.ot) items = items.filter((it) => Number(it.publishedUsec || 0) > opts.ot * 1000000);
  if (opts.nt) items = items.filter((it) => Number(it.publishedUsec || 0) < opts.nt * 1000000);
  items = sortItems(items, opts.order);
  return items.slice(0, Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 20);
}

async function editTag(req) {
  const form = formParams(req.body || '');
  const ids = arrayParam(form.i).map(storage.normalizeItemId);
  const add = arrayParam(form.a);
  const rem = arrayParam(form.r);
  await storage.updateItems((items) => {
    for (const id of ids) {
      const it = items[id];
      if (!it) continue;
      if (add.includes(STATE.READ)) it.read = true;
      if (rem.includes(STATE.READ)) it.read = false;
      if (add.includes(STATE.STARRED)) it.starred = true;
      if (rem.includes(STATE.STARRED)) it.starred = false;
      it.labels = it.labels || [];
      for (const a of add.filter((x) => x.startsWith('user/-/label/'))) {
        const label = a.slice('user/-/label/'.length);
        if (!it.labels.includes(label)) it.labels.push(label);
      }
      for (const r of rem.filter((x) => x.startsWith('user/-/label/'))) {
        const label = r.slice('user/-/label/'.length);
        it.labels = it.labels.filter((x) => x !== label);
      }
    }
  });
  return text(200, 'OK');
}

async function markAllAsRead(req) {
  const form = formParams(req.body || '');
  const streamId = form.s || STATE.READING_LIST;
  const cutoffUsec = form.ts ? Math.floor(Number(form.ts) / 1000) : Infinity;
  await storage.updateItems((items) => {
    for (const it of Object.values(items)) {
      if (streamId.startsWith('feed/') && it.feedId !== streamId.slice(5)) continue;
      if (Number(it.publishedUsec || 0) <= cutoffUsec) it.read = true;
    }
  });
  return text(200, 'OK');
}

function newest(items) {
  return String(Math.max(0, ...items.map((it) => Number(it.publishedUsec || 0))));
}

function sortId(s) {
  let n = 0;
  for (const ch of String(s)) n = ((n * 31) + ch.charCodeAt(0)) >>> 0;
  return n.toString(16).padStart(8, '0');
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unesc(s) {
  return String(s || '').replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

module.exports = { route };
