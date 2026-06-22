'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

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
      title: title || existing.title || url,
      htmlUrl: existing.htmlUrl || url,
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
      if (item.bodyKey) await deleteBody(item.bodyKey).catch(() => {});
      delete state.items[String(item.itemId)];
    }
    delete state.subscriptions[feedId];
    await saveState(state);
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

async function listItems() {
  const state = await loadState();
  return Object.values(state.items);
}

async function listStreamItems(streamId, opts = {}) {
  let items = await listItems();
  items = filterStreamItems(items, streamId, opts);
  items = sortStreamItems(items, opts.order);
  const limit = Number(opts.limit || 20);
  return items.slice(0, Number.isFinite(limit) && limit > 0 ? limit : 20);
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
  const m = /\/item\/([0-9a-fA-F]+)$/.exec(id);
  if (m) return BigInt('0x' + m[1]).toString(10);
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
  getItem,
  getItems,
  updateItems,
  upsertItem,
  updateSubscriptionFetchState,
  normalizeItemId,
  feedIdFor,
  itemIdFor,
};
