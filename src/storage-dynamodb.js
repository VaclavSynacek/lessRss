'use strict';

const crypto = require('node:crypto');
const { GetCommand, PutCommand, QueryCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { documentClient, tableName } = require('./dynamodb-client');
const { mapLimit } = require('./async-util');
const { deleteBody } = require('./body-store');

const ddb = documentClient();
const TableName = tableName();

function hashHex(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function feedIdFor(url) {
  return BigInt('0x' + hashHex(url).slice(0, 15)).toString(10);
}

function itemIdFor(feedId, guid) {
  return BigInt('0x' + hashHex(feedId + '\n' + guid).slice(0, 15)).toString(10);
}

function normalizeItemId(id) {
  id = String(id || '');
  const m = /\/item\/([0-9a-fA-F]+)$/.exec(id);
  if (m) return BigInt('0x' + m[1]).toString(10);
  return id;
}

async function listSubscriptions() {
  const rows = await queryAll({
    TableName,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': 'USER', ':sk': 'SUB#' },
  });
  return rows.filter((x) => x.active !== false).map(stripKeys);
}

async function findSubscriptionByUrl(url) {
  return (await listSubscriptions()).find((s) => s.url === url) || null;
}

async function getSubscription(feedId) {
  const res = await ddb.send(new GetCommand({ TableName, Key: { PK: 'USER', SK: 'SUB#' + feedId } }));
  const sub = res.Item ? stripKeys(res.Item) : null;
  return sub && sub.active !== false ? sub : null;
}

async function subscribe(url, title) {
  const feedId = feedIdFor(url);
  const old = await getAnySubscription(feedId);
  const sub = {
    ...(old || {}),
    feedId,
    id: 'feed/' + feedId,
    url,
    title: title || old?.title || url,
    htmlUrl: old?.htmlUrl || url,
    categories: old?.categories || [],
    active: true,
    createdAt: old?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  await putEntity('USER', 'SUB#' + feedId, 'subscription', sub);
  return sub;
}

async function unsubscribe(streamId) {
  const feedId = String(streamId || '').replace(/^feed\//, '');
  const sub = await getAnySubscription(feedId);
  if (!sub) return;

  // Hard delete: remove every item belonging to this feed from DynamoDB
  // (META row + all stream-index rows: ALL, FEED, UNREAD, FEED#UNREAD,
  // STARRED, LABEL#...) and its S3 body object, then drop the subscription
  // row itself. Soft-deleting (active=false) would leave orphaned items
  // polluting STREAM#ALL, unread-count, starred and label views forever.
  const rows = await queryAll({
    TableName,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': 'STREAM#FEED#' + feedId },
    ProjectionExpression: 'itemId',
  });
  const itemIds = rows.map((r) => r.itemId).filter(Boolean);
  const cap = Number(process.env.LESSRSS_DDB_GET_CONCURRENCY) || 20;
  await mapLimit(itemIds, cap, deleteItemFully);
  await deleteKey('USER', 'SUB#' + feedId);
}

/**
 * Delete a single item's META row, every stream-index row it currently
 * occupies, and its S3 body object. Idempotent: missing rows/objects are
 * treated as already-deleted.
 */
async function deleteItemFully(itemId) {
  const oldRes = await ddb.send(new GetCommand({ TableName, Key: { PK: 'ITEM#' + itemId, SK: 'META' } }));
  const old = oldRes.Item ? stripKeys(oldRes.Item) : null;
  // Compute index keys from the stored state so STARRED / LABEL rows that
  // were added via edit-tag are also removed.
  for (const key of indexKeys(old || { itemId })) {
    await deleteKey(key.PK, key.SK);
  }
  await deleteKey('ITEM#' + itemId, 'META');
  if (old?.bodyKey) {
    // Best-effort: a failed body delete must not fail the unsubscribe, but
    // should be visible. Log to stderr (CloudWatch) and continue.
    try { await deleteBody(old.bodyKey); }
    catch (e) { console.error('unsubscribe: failed to delete body', old.bodyKey, e.message); }
  }
}

async function updateSubscriptionFetchState(feedId, patch) {
  const old = await getAnySubscription(feedId);
  if (!old) return null;
  const next = { ...old, ...patch, updatedAt: Date.now() };
  await putEntity('USER', 'SUB#' + feedId, 'subscription', next);
  return next;
}

async function getAnySubscription(feedId) {
  const res = await ddb.send(new GetCommand({ TableName, Key: { PK: 'USER', SK: 'SUB#' + feedId } }));
  return res.Item ? stripKeys(res.Item) : null;
}

async function listItems() {
  const rows = await queryAll({
    TableName,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': 'STREAM#ALL' },
  });
  return getItems(rows.map((row) => row.itemId));
}

async function listStreamItems(streamId, opts = {}) {
  const pk = streamPk(streamId, opts);
  // Pull enough stream-index rows to satisfy the requested limit plus headroom
  // for client-side filtering (filterPostQuery may drop rows for label/starred/
  // time-range views). Avoids fetching and hydrating the entire stream when the
  // caller only wants the first page.
  const limit = Number(opts.limit || 20);
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 20;
  const oversample = Math.min(1000, Math.max(safeLimit, safeLimit * 5));
  let rows = await queryAll({
    TableName,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': pk },
    ScanIndexForward: opts.order === 'o' ? false : true,
    Limit: oversample,
  });
  let items = await getItems(rows.map((row) => row.itemId));
  items = filterPostQuery(items, streamId, opts);
  return items.slice(0, safeLimit);
}

async function getItem(id) {
  const res = await ddb.send(new GetCommand({ TableName, Key: { PK: 'ITEM#' + normalizeItemId(id), SK: 'META' } }));
  return res.Item ? stripKeys(res.Item) : null;
}

async function getItems(ids) {
  const cap = Number(process.env.LESSRSS_DDB_GET_CONCURRENCY) || 20;
  const items = await mapLimit(ids, cap, async (id) => getItem(id));
  return items.filter((x) => x);
}

async function updateItems(mutator) {
  const current = await listItems();
  const oldById = Object.fromEntries(current.map((it) => [String(it.itemId), structuredClone(it)]));
  const items = Object.fromEntries(current.map((it) => [String(it.itemId), it]));
  const result = await mutator(items, { items });
  for (const it of Object.values(items)) {
    await putItemWithIndexes(oldById[String(it.itemId)], it);
  }
  return result;
}

async function upsertItem(feedId, fields) {
  const itemId = fields.itemId || itemIdFor(feedId, fields.guid || fields.url || fields.title);
  const oldRes = await ddb.send(new GetCommand({ TableName, Key: { PK: 'ITEM#' + itemId, SK: 'META' } }));
  const old = oldRes.Item ? stripKeys(oldRes.Item) : {};
  const item = {
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
  await putItemWithIndexes(old, item);
  return item;
}

async function putItemWithIndexes(oldItem, item) {
  const oldKeys = indexKeys(oldItem || {});
  const newKeys = indexKeys(item);
  const oldSet = new Set(oldKeys.map(keyString));
  const newSet = new Set(newKeys.map(keyString));
  for (const key of oldKeys) if (!newSet.has(keyString(key))) await deleteKey(key.PK, key.SK);
  await putEntity('ITEM#' + item.itemId, 'META', 'item', item);
  for (const key of newKeys) {
    if (oldSet.has(keyString(key))) continue;
    await ddb.send(new PutCommand({ TableName, Item: { ...key, entity: 'streamItem', itemId: String(item.itemId), feedId: item.feedId } }));
  }
}

function keyString(key) {
  return key.PK + '\n' + key.SK;
}

async function putEntity(PK, SK, entity, value) {
  await ddb.send(new PutCommand({ TableName, Item: { ...value, PK, SK, entity } }));
}

async function deleteKey(PK, SK) {
  if (!PK || !SK) return;
  await ddb.send(new DeleteCommand({ TableName, Key: { PK, SK } }));
}

function indexKeys(item) {
  if (!item || !item.itemId) return [];
  const sk = indexSortKey(item);
  const keys = [
    { PK: 'STREAM#ALL', SK: sk },
    { PK: 'STREAM#FEED#' + item.feedId, SK: sk },
  ];
  if (!item.read) {
    keys.push({ PK: 'STREAM#UNREAD', SK: sk });
    keys.push({ PK: 'STREAM#FEED#' + item.feedId + '#UNREAD', SK: sk });
  }
  if (item.starred) keys.push({ PK: 'STREAM#STARRED', SK: sk });
  for (const label of item.labels || []) keys.push({ PK: 'STREAM#LABEL#' + label, SK: sk });
  return keys;
}

function indexSortKey(item) {
  const max = 9999999999999999n;
  let ts;
  try { ts = BigInt(String(item.publishedUsec || 0)); } catch { ts = 0n; }
  const rev = max - ts;
  return rev.toString().padStart(16, '0') + '#' + item.itemId;
}

function streamPk(streamId, opts = {}) {
  if (opts.excludeRead) {
    if (streamId && streamId.startsWith('feed/')) return 'STREAM#FEED#' + streamId.slice(5) + '#UNREAD';
    if (streamId === 'user/-/state/com.google/reading-list') return 'STREAM#UNREAD';
  }
  if (streamId === 'user/-/state/com.google/starred') return 'STREAM#STARRED';
  if (streamId && streamId.startsWith('feed/')) return 'STREAM#FEED#' + streamId.slice(5);
  if (streamId && streamId.startsWith('user/-/label/')) return 'STREAM#LABEL#' + streamId.slice('user/-/label/'.length);
  return 'STREAM#ALL';
}

function filterPostQuery(items, streamId, opts = {}) {
  if (opts.excludeRead && streamId !== 'user/-/state/com.google/reading-list' && !(streamId || '').startsWith('feed/')) {
    items = items.filter((it) => !it.read);
  }
  if (opts.includeStarred && streamId !== 'user/-/state/com.google/starred') items = items.filter((it) => it.starred);
  if (opts.ot) items = items.filter((it) => Number(it.publishedUsec || 0) > Number(opts.ot) * 1000000);
  if (opts.nt) items = items.filter((it) => Number(it.publishedUsec || 0) < Number(opts.nt) * 1000000);
  return items;
}

function stripKeys(row) {
  const { PK, SK, entity, ...rest } = row;
  return rest;
}

async function queryAll(input) {
  const out = [];
  let ExclusiveStartKey;
  const hardCap = Number(input.Limit) || Infinity;
  do {
    const res = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey }));
    out.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
    if (out.length >= hardCap) break;
  } while (ExclusiveStartKey);
  return out;
}


module.exports = {
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
