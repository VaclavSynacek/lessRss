'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.LESSRSS_DATA_DIR || path.join(process.cwd(), '.local-data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

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
}

async function unsubscribe(streamId) {
  const feedId = String(streamId || '').replace(/^feed\//, '');
  const state = await loadState();
  if (state.subscriptions[feedId]) {
    state.subscriptions[feedId].active = false;
    state.subscriptions[feedId].updatedAt = Date.now();
    await saveState(state);
  }
}

async function listItems() {
  const state = await loadState();
  return Object.values(state.items);
}

async function getItems(ids) {
  const state = await loadState();
  const idSet = new Set(ids.map(normalizeItemId));
  return Object.values(state.items).filter((it) => idSet.has(String(it.itemId)));
}

function normalizeItemId(id) {
  id = String(id || '');
  const m = /\/item\/([0-9a-fA-F]+)$/.exec(id);
  if (m) return BigInt('0x' + m[1]).toString(10);
  return id;
}

async function updateItems(mutator) {
  const state = await loadState();
  const result = await mutator(state.items, state);
  await saveState(state);
  return result;
}

async function upsertItem(feedId, fields) {
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
  getItems,
  updateItems,
  upsertItem,
  normalizeItemId,
  feedIdFor,
  itemIdFor,
};
