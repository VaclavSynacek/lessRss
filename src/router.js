'use strict';

const { configuredUser, validateLogin, loginResponse, validateAuthHeader, postTokenFor } = require('./auth');
const { STATE } = require('./constants');
const { json, text, xml, unauthorized, notFound, badRequest, formParams, arrayParam } = require('./http');
const storage = require('./storage');
const { mapLimit } = require('./async-util');
const { subscriptionTitle, subscriptionHtmlUrl, subscriptionToGreader, itemToGreader, sortItems, streamTitle } = require('./greader-format');
const { refreshAll } = require('./crawler');
const { discoverFeed } = require('./feed-discovery');
const { httpUrl, truncateUtf8 } = require('./feed-security');
const { LABEL_PREFIX, labelName } = require('./labels');
const { subscriptionsToOpml, parseOpmlSubscriptions } = require('./opml');

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
  if (path === '/reader/api/0/rename-tag' && req.method === 'POST') return renameTag(req);
  if (path === '/reader/api/0/disable-tag' && req.method === 'POST') return disableTag(req);

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
  const tags = [
    { id: STATE.READING_LIST, sortid: '00000001' },
    { id: STATE.STARRED, sortid: '00000002' },
  ];
  const labels = await storage.listLabels();
  for (const label of labels) {
    const id = LABEL_PREFIX + label;
    tags.push({ id, sortid: sortId(id), type: 'folder' });
  }
  return json(200, { tags });
}

async function subscriptionList() {
  const subs = await storage.listSubscriptions();
  return json(200, { subscriptions: subs.map(subscriptionToGreader) });
}

async function unreadCount() {
  const summary = await storage.getUnreadSummary();
  const counts = [{
    id: STATE.READING_LIST,
    count: summary.count,
    newestItemTimestampUsec: summary.newestUsec,
  }];
  for (const feed of summary.feeds) {
    counts.push({
      id: 'feed/' + feed.feedId,
      count: feed.count,
      newestItemTimestampUsec: feed.newestUsec,
    });
  }
  return json(200, { max: counts.length, unreadcounts: counts });
}

async function subscriptionEdit(req) {
  const form = formParams(req.body || '');
  const ac = form.ac;
  const streams = arrayParam(form.s);
  if (!ac || streams.length === 0) return badRequest('missing ac or s');
  if (ac === 'subscribe') {
    const urls = streams.map((s) => httpUrl(String(s).replace(/^feed\//, '')));
    if (urls.some((url) => !url)) return badRequest('feed URL must use HTTP or HTTPS');
    const addLabels = arrayParam(form.a).map(labelName).filter(Boolean);
    for (const url of urls) {
      const sub = await storage.subscribe(url, truncateUtf8(form.t));
      if (addLabels.length > 0) await storage.editSubscriptionCategories(sub.feedId, addLabels, []);
    }
    return text(200, 'OK');
  }
  if (ac === 'unsubscribe') {
    for (const s of streams) await storage.unsubscribe(s);
    return text(200, 'OK');
  }
  if (ac === 'edit') {
    const titles = arrayParam(form.t);
    const removeLabels = arrayParam(form.r).map(labelName).filter(Boolean);
    const addLabels = arrayParam(form.a).map(labelName).filter((label) => label && !removeLabels.includes(label));
    for (let i = 0; i < streams.length; i += 1) {
      const feedId = String(streams[i]).replace(/^feed\//, '');
      if (titles.length > 0) {
        const title = truncateUtf8(titles[Math.min(i, titles.length - 1)]);
        await storage.setSubscriptionCustomTitle(feedId, title);
      }
      if (addLabels.length > 0 || removeLabels.length > 0) {
        await storage.editSubscriptionCategories(feedId, addLabels, removeLabels);
      }
    }
    return text(200, 'OK');
  }
  return badRequest('unknown action');
}

async function quickAdd(req) {
  const form = formParams(req.body || '');
  if (!form.quickadd) return badRequest('missing quickadd');
  const url = httpUrl(String(form.quickadd).replace(/^feed\//, ''));
  if (!url) return badRequest('feed URL must use HTTP or HTTPS');

  let discovered;
  try {
    discovered = await discoverFeed(url);
  } catch (e) {
    return json(200, { numResults: 0, query: form.quickadd, error: e.message });
  }

  let sub = await storage.subscribe(discovered.url);
  const metadata = {};
  if (discovered.parsed.title) metadata.feedTitle = discovered.parsed.title;
  if (discovered.parsed.link) metadata.feedHtmlUrl = discovered.parsed.link;
  if (Object.keys(metadata).length > 0 && storage.updateSubscriptionFetchState) {
    await storage.updateSubscriptionFetchState(sub.feedId, metadata);
    sub = { ...sub, ...metadata };
  }
  return json(200, { numResults: 1, query: form.quickadd, streamId: sub.id, streamName: subscriptionTitle(sub) });
}

async function subscriptionExport() {
  return xml(200, subscriptionsToOpml(await storage.listSubscriptions()));
}

async function subscriptionImport(req) {
  const contentType = req.headers['content-type'] || req.headers['Content-Type'] || '';
  let opml = req.body || '';
  if (contentType.includes('application/x-www-form-urlencoded')) opml = formParams(req.body || '').opml || '';
  for (const entry of parseOpmlSubscriptions(opml)) {
    const url = httpUrl(entry.url);
    if (!url) continue;
    const sub = await storage.subscribe(url, truncateUtf8(entry.title || url));
    if (entry.labels.length > 0) await storage.editSubscriptionCategories(sub.feedId, entry.labels, []);
  }
  await refreshAll().catch((e) => console.error('subscription/import: refresh failed', e.message));
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
  const streamId = params.get('s') || STATE.READING_LIST;
  const ids = await storage.listStreamItemIds(streamId, streamOptions(params));
  return json(200, { itemRefs: ids.map((id) => ({ id: String(id) })) });
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

function streamOptions(params) {
  return {
    limit: Number(params.get('n') || 20),
    order: params.get('r') || 'd',
    excludeRead: params.get('xt') === STATE.READ,
    includeStarred: params.get('it') === STATE.STARRED,
    ot: Number(params.get('ot') || 0),
    nt: Number(params.get('nt') || 0),
  };
}

async function selectItems(streamId, params) {
  const opts = streamOptions(params);
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
  const removedLabels = rem
    .filter((value) => value.startsWith('user/-/label/'))
    .map((value) => value.slice('user/-/label/'.length));
  const patch = {
    read: rem.includes(STATE.READ) ? false : add.includes(STATE.READ) ? true : undefined,
    starred: rem.includes(STATE.STARRED) ? false : add.includes(STATE.STARRED) ? true : undefined,
    addLabels: add
      .filter((value) => value.startsWith('user/-/label/'))
      .map((value) => value.slice('user/-/label/'.length))
      .filter((label) => !removedLabels.includes(label)),
    removeLabels: removedLabels,
  };
  await storage.applyItemTags(ids, patch);
  return text(200, 'OK');
}

async function markAllAsRead(req) {
  const form = formParams(req.body || '');
  const streamId = form.s || STATE.READING_LIST;
  const cutoffUsec = form.ts ? Math.floor(Number(form.ts) / 1000) : Infinity;
  await storage.markStreamRead(streamId, cutoffUsec);
  return text(200, 'OK');
}

async function renameTag(req) {
  const form = formParams(req.body || '');
  const source = labelName(form.s);
  const destination = labelName(form.dest);
  if (!source || !destination) return badRequest('missing label source or destination');
  if (source !== destination) await storage.renameLabel(source, destination);
  return text(200, 'OK');
}

async function disableTag(req) {
  const form = formParams(req.body || '');
  const labels = arrayParam(form.s).map(labelName).filter(Boolean);
  if (labels.length === 0) return badRequest('missing label');
  for (const label of labels) await storage.disableLabel(label);
  return text(200, 'OK');
}

function sortId(s) {
  let n = 0;
  for (const ch of String(s)) n = ((n * 31) + ch.charCodeAt(0)) >>> 0;
  return n.toString(16).padStart(8, '0');
}

module.exports = { route };
