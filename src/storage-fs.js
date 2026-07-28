'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { categoryFor, labelName, normalizeCategories } = require('./labels');

const DATA_DIR = process.env.LESSRSS_DATA_DIR || path.join(process.cwd(), '.local-data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
let writeChain = Promise.resolve();

function emptyState() {
  return {
    subscriptions: {},
    items: {},
    labels: {},
  };
}

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return emptyState();
    throw e;
  }
}

async function saveState(state) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + '.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(16).slice(2) + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, STATE_FILE);
}

function hashHex(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function feedIdFor(url) {
  return BigInt('0x' + hashHex(url).slice(0, 15)).toString(10);
}

function itemIdFor(feedId, guid) {
  return BigInt('0x' + hashHex(feedId + '\n' + guid).slice(0, 15)).toString(10);
}

async function listSubscriptions() {
  const state = await loadState();
  return Object.values(state.subscriptions).filter((s) => s.active !== false);
}

async function findSubscriptionByUrl(url) {
  return (await listSubscriptions()).find((s) => s.url === url) || null;
}

async function getSubscription(feedId) {
  const state = await loadState();
  const sub = state.subscriptions[feedId];
  return sub && sub.active !== false ? sub : null;
}

async function subscribe(url, title) {
  return withWriteLock(async () => {
    const state = await loadState();
    const feedId = feedIdFor(url);
    const existing = state.subscriptions[feedId] || {};
    state.subscriptions[feedId] = {
      feedId,
      id: 'feed/' + feedId,
      url,
      customTitle: title || existing.customTitle || '',
      customHtmlUrl: existing.customHtmlUrl || '',
      feedTitle: existing.feedTitle || '',
      feedHtmlUrl: existing.feedHtmlUrl || '',
      categories: existing.categories || [],
      active: true,
      createdAt: existing.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    await saveState(state);
    return state.subscriptions[feedId];
  });
}

async function unsubscribe(streamId) {
  return withWriteLock(async () => {
    const feedId = String(streamId || '').replace(/^feed\//, '');
    const state = await loadState();
    if (!state.subscriptions[feedId]) return;
    // Hard delete: drop every item belonging to this feed and its body, then
    // remove the subscription row. Mirrors storage-dynamodb.unsubscribe.
    const { deleteBody } = require('./body-store');
    for (const item of Object.values(state.items)) {
      if (String(item.feedId) !== String(feedId)) continue;
      if (item.bodyKey) {
        try { await deleteBody(item.bodyKey); }
        catch (e) { console.error('unsubscribe: failed to delete body', item.bodyKey, e.message); }
      }
      delete state.items[String(item.itemId)];
    }
    delete state.subscriptions[feedId];
    await saveState(state);
  });
}

async function setSubscriptionCustomTitle(feedId, customTitle) {
  return withWriteLock(async () => {
    const state = await loadState();
    const old = state.subscriptions[String(feedId)];
    if (!old) return null;
    state.subscriptions[String(feedId)] = { ...old, customTitle: String(customTitle || ''), updatedAt: Date.now() };
    await saveState(state);
    return state.subscriptions[String(feedId)];
  });
}

async function updateSubscriptionFetchState(feedId, patch) {
  return withWriteLock(async () => {
    const state = await loadState();
    const old = state.subscriptions[String(feedId)];
    if (!old) return null;
    state.subscriptions[String(feedId)] = { ...old, ...patch, updatedAt: Date.now() };
    await saveState(state);
    return state.subscriptions[String(feedId)];
  });
}

async function editSubscriptionCategories(feedId, addLabels, removeLabels) {
  return withWriteLock(async () => {
    const state = await loadState();
    state.labels ||= {};
    const sub = state.subscriptions[String(feedId)];
    if (!sub) return null;
    const removed = new Set((removeLabels || []).map(labelName).filter(Boolean));
    const categories = normalizeCategories(sub.categories).filter((category) => !removed.has(category.label));
    for (const value of addLabels || []) {
      const category = categoryFor(value);
      if (category && !categories.some((existing) => existing.label === category.label)) categories.push(category);
      if (category) state.labels[category.label] = true;
    }
    sub.categories = categories;
    sub.updatedAt = Date.now();
    await saveState(state);
    return sub;
  });
}

async function listLabels() {
  const state = await loadState();
  const labels = new Set(Object.keys(state.labels || {}));
  for (const sub of Object.values(state.subscriptions)) {
    for (const category of normalizeCategories(sub.categories)) labels.add(category.label);
  }
  for (const item of Object.values(state.items)) for (const label of item.labels || []) labels.add(label);
  return [...labels].sort((a, b) => a.localeCompare(b));
}

async function renameLabel(sourceValue, destinationValue) {
  const source = labelName(sourceValue);
  const destination = labelName(destinationValue);
  if (!source || !destination || source === destination) return;
  return withWriteLock(async () => {
    const state = await loadState();
    state.labels ||= {};
    for (const sub of Object.values(state.subscriptions)) {
      const labels = normalizeCategories(sub.categories).map((category) => category.label);
      if (!labels.includes(source)) continue;
      sub.categories = normalizeCategories(labels.map((label) => label === source ? destination : label));
      sub.updatedAt = Date.now();
    }
    for (const item of Object.values(state.items)) {
      if (!(item.labels || []).includes(source)) continue;
      item.labels = [...new Set(item.labels.map((label) => label === source ? destination : label))];
    }
    delete state.labels[source];
    state.labels[destination] = true;
    await saveState(state);
  });
}

async function disableLabel(value) {
  const label = labelName(value);
  if (!label) return;
  return withWriteLock(async () => {
    const state = await loadState();
    state.labels ||= {};
    for (const sub of Object.values(state.subscriptions)) {
      const categories = normalizeCategories(sub.categories);
      if (!categories.some((category) => category.label === label)) continue;
      sub.categories = categories.filter((category) => category.label !== label);
      sub.updatedAt = Date.now();
    }
    for (const item of Object.values(state.items)) item.labels = (item.labels || []).filter((existing) => existing !== label);
    delete state.labels[label];
    await saveState(state);
  });
}

async function listItems() {
  const state = await loadState();
  return Object.values(state.items);
}

async function listStreamItems(streamId, opts = {}) {
  let items = await listItems();
  items = filterStreamItems(items, streamId, opts);
  items = sortStreamItems(items, opts.order);
  if (opts.continuation) {
    const cursor = normalizeItemId(opts.continuation);
    const index = items.findIndex((item) => String(item.itemId) === cursor);
    items = index < 0 ? [] : items.slice(index + 1);
  }
  const limit = Number(opts.limit || 20);
  return items.slice(0, Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 20);
}

async function listStreamItemIds(streamId, opts = {}) {
  return (await listStreamItems(streamId, opts)).map((item) => String(item.itemId));
}

async function getUnreadSummary() {
  const unread = (await listItems()).filter((item) => !item.read);
  const summary = { count: unread.length, newestUsec: '0', feeds: [] };
  const byFeed = new Map();
  for (const item of unread) {
    const publishedUsec = String(item.publishedUsec || 0);
    if (BigInt(publishedUsec) > BigInt(summary.newestUsec)) summary.newestUsec = publishedUsec;
    const feed = byFeed.get(String(item.feedId)) || { feedId: String(item.feedId), count: 0, newestUsec: '0' };
    feed.count += 1;
    if (BigInt(publishedUsec) > BigInt(feed.newestUsec)) feed.newestUsec = publishedUsec;
    byFeed.set(feed.feedId, feed);
  }
  summary.feeds = [...byFeed.values()];
  return summary;
}

async function getItem(id) {
  const state = await loadState();
  return state.items[normalizeItemId(id)] || null;
}

async function getItems(ids) {
  const state = await loadState();
  const idSet = new Set(ids.map(normalizeItemId));
  return Object.values(state.items).filter((it) => idSet.has(String(it.itemId)));
}

function filterStreamItems(items, streamId, opts = {}) {
  if (streamId === 'user/-/state/com.google/starred') items = items.filter((it) => it.starred);
  else if (streamId && streamId.startsWith('feed/')) items = items.filter((it) => it.feedId === streamId.slice(5));
  else if (streamId && streamId.startsWith('user/-/label/')) {
    const label = streamId.slice('user/-/label/'.length);
    items = items.filter((it) => (it.labels || []).includes(label));
  }
  if (opts.excludeRead) items = items.filter((it) => !it.read);
  if (opts.includeStarred) items = items.filter((it) => it.starred);
  if (opts.ot) items = items.filter((it) => Number(it.publishedUsec || 0) > Number(opts.ot) * 1000000);
  if (opts.nt) items = items.filter((it) => Number(it.publishedUsec || 0) < Number(opts.nt) * 1000000);
  return items;
}

function sortStreamItems(items, order) {
  const copy = [...items];
  copy.sort((a, b) => Number(b.publishedUsec || 0) - Number(a.publishedUsec || 0));
  if (order === 'o') copy.reverse();
  return copy;
}

function normalizeItemId(id) {
  id = String(id || '');
  const tagged = /\/item\/([0-9a-fA-F]+)$/.exec(id);
  if (tagged) return BigInt('0x' + tagged[1]).toString(10);
  // FreshRSS also accepts the bare hexadecimal suffix used by FeedFlow.
  // Unprefixed digit-only values without a leading zero are decimal IDs.
  if (/^[0-9a-fA-F]+$/.test(id) && (!/^\d+$/.test(id) || id.startsWith('0'))) {
    return BigInt('0x' + id).toString(10);
  }
  return id;
}

async function updateItems(mutator) {
  return withWriteLock(async () => {
    const state = await loadState();
    const result = await mutator(state.items, state);
    await saveState(state);
    return result;
  });
}

async function applyItemTags(ids, patch) {
  const idSet = new Set(ids.map(normalizeItemId));
  return updateItems((items, state) => {
    state.labels ||= {};
    for (const item of Object.values(items)) {
      if (!idSet.has(String(item.itemId))) continue;
      if (patch.read !== undefined) item.read = patch.read;
      if (patch.starred !== undefined) item.starred = patch.starred;
      item.labels = (item.labels || []).filter((label) => !(patch.removeLabels || []).includes(label));
      for (const value of patch.addLabels || []) {
        const label = labelName(value);
        if (label && !item.labels.includes(label)) item.labels.push(label);
        if (label) state.labels[label] = true;
      }
    }
  });
}

async function markStreamRead(streamId, cutoffUsec = Infinity) {
  return updateItems((items) => {
    const matching = filterStreamItems(Object.values(items), streamId);
    for (const item of matching) {
      if (!item.read && Number(item.publishedUsec || 0) <= Number(cutoffUsec)) item.read = true;
    }
  });
}

async function upsertItem(feedId, fields) {
  return withWriteLock(async () => {
    const state = await loadState();
    const itemId = itemIdFor(feedId, fields.guid || fields.url || fields.title);
    const old = state.items[itemId] || {};
    state.items[itemId] = {
      ...old,
      ...fields,
      itemId,
      itemHex: BigInt(itemId).toString(16).padStart(16, '0'),
      feedId,
      read: old.read === undefined ? false : old.read,
      starred: old.starred || false,
      labels: old.labels || [],
      updatedAt: Date.now(),
    };
    await saveState(state);
    return state.items[itemId];
  });
}

function withWriteLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

module.exports = {
  loadState,
  saveState,
  listSubscriptions,
  findSubscriptionByUrl,
  getSubscription,
  subscribe,
  unsubscribe,
  listItems,
  listStreamItems,
  listStreamItemIds,
  getUnreadSummary,
  getItem,
  getItems,
  applyItemTags,
  markStreamRead,
  upsertItem,
  updateSubscriptionFetchState,
  setSubscriptionCustomTitle,
  editSubscriptionCategories,
  listLabels,
  renameLabel,
  disableLabel,
  normalizeItemId,
  feedIdFor,
  itemIdFor,
};
