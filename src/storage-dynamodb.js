'use strict';

const crypto = require('node:crypto');
const { BatchGetCommand, GetCommand, PutCommand, UpdateCommand, QueryCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { documentClient, tableName } = require('./dynamodb-client');
const { mapLimit } = require('./async-util');
const { deleteBody } = require('./body-store');
const { categoryFor, labelName, normalizeCategories } = require('./labels');

const ddb = documentClient();
const TableName = tableName();
const MAX_INDEX_TIMESTAMP = 9999999999999999n;
const ITEM_RETENTION_SECONDS = 365 * 24 * 60 * 60;

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
  const tagged = /\/item\/([0-9a-fA-F]+)$/.exec(id);
  if (tagged) return BigInt('0x' + tagged[1]).toString(10);
  // FreshRSS also accepts the bare hexadecimal suffix used by FeedFlow.
  // Unprefixed digit-only values without a leading zero are decimal IDs.
  if (/^[0-9a-fA-F]+$/.test(id) && (!/^\d+$/.test(id) || id.startsWith('0'))) {
    return BigInt('0x' + id).toString(10);
  }
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
    customTitle: title || old?.customTitle || '',
    customHtmlUrl: old?.customHtmlUrl || '',
    feedTitle: old?.feedTitle || '',
    feedHtmlUrl: old?.feedHtmlUrl || '',
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

async function setSubscriptionCustomTitle(feedId, customTitle) {
  return updateSubscriptionFields(feedId, { customTitle: String(customTitle || '') });
}

async function updateSubscriptionFetchState(feedId, patch) {
  const allowed = ['etag', 'lastModified', 'feedTitle', 'feedHtmlUrl'];
  return updateSubscriptionFields(feedId, Object.fromEntries(
    Object.entries(patch).filter(([key]) => allowed.includes(key))
  ));
}

async function editSubscriptionCategories(feedId, addLabels, removeLabels) {
  const sub = await getSubscription(feedId);
  if (!sub) return null;
  const removed = new Set((removeLabels || []).map(labelName).filter(Boolean));
  const categories = normalizeCategories(sub.categories).filter((category) => !removed.has(category.label));
  for (const value of addLabels || []) {
    const category = categoryFor(value);
    if (category && !categories.some((existing) => existing.label === category.label)) categories.push(category);
  }
  await registerLabels(categories.map((category) => category.label));
  return updateSubscriptionFields(feedId, { categories });
}

async function listLabels() {
  const rows = await queryAll({
    TableName,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': 'USER', ':sk': 'LABEL#' },
    ProjectionExpression: 'label',
  });
  const labels = new Set(rows.map((row) => labelName(row.label)).filter(Boolean));
  for (const sub of await listSubscriptions()) {
    for (const category of normalizeCategories(sub.categories)) labels.add(category.label);
  }
  return [...labels].sort((a, b) => a.localeCompare(b));
}

async function registerLabels(labels) {
  const normalized = [...new Set((labels || []).map(labelName).filter(Boolean))];
  await mapLimit(normalized, 20, (label) => putEntity('USER', 'LABEL#' + label, 'label', { label }));
}

async function renameLabel(sourceValue, destinationValue) {
  const source = labelName(sourceValue);
  const destination = labelName(destinationValue);
  if (!source || !destination || source === destination) return;
  const rows = await queryAll({
    TableName,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': 'STREAM#LABEL#' + source },
    ProjectionExpression: 'itemId',
  });
  await applyItemTags(rows.map((row) => row.itemId), { addLabels: [destination], removeLabels: [source] });
  const affected = (await listSubscriptions()).filter((sub) => (
    normalizeCategories(sub.categories).some((category) => category.label === source)
  ));
  await mapLimit(affected, 20, (sub) => editSubscriptionCategories(sub.feedId, [destination], [source]));
  await registerLabels([destination]);
  await deleteKey('USER', 'LABEL#' + source);
}

async function disableLabel(value) {
  const label = labelName(value);
  if (!label) return;
  const rows = await queryAll({
    TableName,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': 'STREAM#LABEL#' + label },
    ProjectionExpression: 'itemId',
  });
  await applyItemTags(rows.map((row) => row.itemId), { removeLabels: [label] });
  const affected = (await listSubscriptions()).filter((sub) => (
    normalizeCategories(sub.categories).some((category) => category.label === label)
  ));
  await mapLimit(affected, 20, (sub) => editSubscriptionCategories(sub.feedId, [], [label]));
  await deleteKey('USER', 'LABEL#' + label);
}

async function updateSubscriptionFields(feedId, patch) {
  const values = { ':updatedAt': Date.now() };
  const names = { '#updatedAt': 'updatedAt' };
  const assignments = ['#updatedAt = :updatedAt'];
  let index = 0;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    names['#field' + index] = key;
    values[':field' + index] = value;
    assignments.push('#field' + index + ' = :field' + index);
    index += 1;
  }
  try {
    const res = await ddb.send(new UpdateCommand({
      TableName,
      Key: { PK: 'USER', SK: 'SUB#' + feedId },
      UpdateExpression: 'SET ' + assignments.join(', '),
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }));
    return res.Attributes ? stripKeys(res.Attributes) : null;
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') return null;
    throw e;
  }
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
  const safeLimit = streamLimit(opts);
  const input = streamQueryInput(streamId, opts);
  if (!input) return [];
  const startKey = await continuationStartKey(streamId, opts);
  if (startKey === null) return [];

  const items = [];
  let ExclusiveStartKey = startKey;
  do {
    const remaining = safeLimit - items.length;
    const candidateLimit = needsMetadataFilter(streamId, opts)
      ? Math.min(100, Math.max(20, remaining * 5))
      : remaining;
    const res = await ddb.send(new QueryCommand({
      ...input,
      Limit: candidateLimit,
      ExclusiveStartKey,
    }));
    let candidates = await getItems((res.Items || []).map((row) => row.itemId));
    candidates = filterPostQuery(candidates, streamId, opts);
    items.push(...candidates.slice(0, remaining));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (items.length < safeLimit && ExclusiveStartKey);
  return items;
}

async function listStreamItemIds(streamId, opts = {}) {
  if (needsMetadataFilter(streamId, opts)) {
    return (await listStreamItems(streamId, opts)).map((item) => String(item.itemId));
  }
  const startKey = await continuationStartKey(streamId, opts);
  if (startKey === null) return [];
  const rows = await queryStreamRows(streamId, opts, streamLimit(opts), startKey);
  return rows.map((row) => String(row.itemId));
}

async function getUnreadSummary() {
  const rows = await queryAll({
    TableName,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': 'STREAM#UNREAD' },
    ProjectionExpression: 'SK, feedId',
  });
  const summary = { count: rows.length, newestUsec: '0', feeds: [] };
  const byFeed = new Map();
  for (const row of rows) {
    const publishedUsec = publishedUsecFromSortKey(row.SK);
    if (BigInt(publishedUsec) > BigInt(summary.newestUsec)) summary.newestUsec = publishedUsec;
    const feed = byFeed.get(String(row.feedId)) || { feedId: String(row.feedId), count: 0, newestUsec: '0' };
    feed.count += 1;
    if (BigInt(publishedUsec) > BigInt(feed.newestUsec)) feed.newestUsec = publishedUsec;
    byFeed.set(feed.feedId, feed);
  }
  summary.feeds = [...byFeed.values()];
  return summary;
}

async function getItem(id) {
  const res = await ddb.send(new GetCommand({ TableName, Key: { PK: 'ITEM#' + normalizeItemId(id), SK: 'META' } }));
  return res.Item ? stripKeys(res.Item) : null;
}

async function getItems(ids) {
  const normalized = ids.map(normalizeItemId);
  const uniqueIds = [...new Set(normalized)].filter(Boolean);
  const chunks = [];
  for (let i = 0; i < uniqueIds.length; i += 100) chunks.push(uniqueIds.slice(i, i + 100));
  const rowsByChunk = await mapLimit(chunks, 4, batchGetItems);
  const byId = new Map(rowsByChunk.flat().map((row) => [String(row.itemId), stripKeys(row)]));
  return normalized.map((id) => byId.get(id)).filter(Boolean);
}

async function batchGetItems(ids) {
  let pending = ids.map((id) => ({ PK: 'ITEM#' + id, SK: 'META' }));
  const rows = [];
  for (let attempt = 0; pending.length > 0 && attempt < 8; attempt += 1) {
    const res = await ddb.send(new BatchGetCommand({
      RequestItems: { [TableName]: { Keys: pending } },
    }));
    rows.push(...(res.Responses?.[TableName] || []));
    pending = res.UnprocessedKeys?.[TableName]?.Keys || [];
    if (pending.length > 0) await sleep(Math.min(1000, 25 * (2 ** attempt)));
  }
  if (pending.length > 0) {
    const cap = Number(process.env.LESSRSS_DDB_GET_CONCURRENCY) || 20;
    const fallback = await mapLimit(pending, cap, async (Key) => {
      const res = await ddb.send(new GetCommand({ TableName, Key }));
      return res.Item || null;
    });
    rows.push(...fallback.filter(Boolean));
  }
  return rows;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function applyItemTags(ids, patch) {
  await registerLabels(patch.addLabels || []);
  const uniqueIds = [...new Set(ids.map(normalizeItemId))];
  const current = await getItems(uniqueIds);
  const changes = [];
  for (const old of current) {
    const fields = {};
    if (patch.read !== undefined && old.read !== patch.read) fields.read = patch.read;
    if (patch.starred !== undefined && old.starred !== patch.starred) fields.starred = patch.starred;
    const oldLabels = old.labels || [];
    const labels = oldLabels.filter((label) => !(patch.removeLabels || []).includes(label));
    for (const label of patch.addLabels || []) if (!labels.includes(label)) labels.push(label);
    if (labels.length !== oldLabels.length || labels.some((label, i) => label !== oldLabels[i])) fields.labels = labels;
    if (Object.keys(fields).length > 0) changes.push({ itemId: old.itemId, fields });
  }
  const cap = Number(process.env.LESSRSS_DDB_GET_CONCURRENCY) || 20;
  await mapLimit(changes, cap, ({ itemId, fields }) => updateItemStateFields(itemId, fields));
}

async function markStreamRead(streamId, cutoffUsec = Infinity) {
  if (Number.isNaN(Number(cutoffUsec))) return;
  const values = { ':pk': streamPk(streamId, { excludeRead: true }) };
  let condition = 'PK = :pk';
  if (Number.isFinite(Number(cutoffUsec))) {
    let cutoff = BigInt(Math.max(0, Math.trunc(Number(cutoffUsec))));
    if (cutoff > MAX_INDEX_TIMESTAMP) cutoff = MAX_INDEX_TIMESTAMP;
    values[':cutoffSk'] = (MAX_INDEX_TIMESTAMP - cutoff).toString().padStart(16, '0') + '#';
    condition += ' AND SK >= :cutoffSk';
  }
  const rows = await queryAll({
    TableName,
    KeyConditionExpression: condition,
    ExpressionAttributeValues: values,
    ProjectionExpression: 'itemId',
  });
  const items = await getItems(rows.map((row) => row.itemId));
  const matching = items.filter((item) => (
    !item.read && Number(item.publishedUsec || 0) <= Number(cutoffUsec)
  ));
  const cap = Number(process.env.LESSRSS_DDB_GET_CONCURRENCY) || 20;
  await mapLimit(matching, cap, (item) => updateItemStateFields(item.itemId, { read: true }));
}

async function updateItemStateFields(itemId, fields) {
  const names = {};
  const values = {};
  const assignments = [];
  let index = 0;
  for (const [key, value] of Object.entries(fields)) {
    names['#field' + index] = key;
    values[':field' + index] = value;
    assignments.push('#field' + index + ' = :field' + index);
    index += 1;
  }
  if (assignments.length === 0) return null;
  try {
    const res = await ddb.send(new UpdateCommand({
      TableName,
      Key: { PK: 'ITEM#' + itemId, SK: 'META' },
      UpdateExpression: 'SET ' + assignments.join(', '),
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_OLD',
    }));
    if (!res.Attributes) return null;
    const old = stripKeys(res.Attributes);
    const item = { ...old, ...fields };
    await updateItemIndexes(old, item);
    return item;
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') return null;
    throw e;
  }
}

async function upsertItem(feedId, fields) {
  const itemId = fields.itemId || itemIdFor(feedId, fields.guid || fields.url || fields.title);
  const updates = {
    ...Object.fromEntries(Object.entries(fields).filter(([key]) => !['PK', 'SK', 'entity', 'read', 'starred', 'labels'].includes(key))),
    itemId,
    itemHex: BigInt(itemId).toString(16).padStart(16, '0'),
    feedId,
    entity: 'item',
    expiresAt: expiresAtForPublishedUsec(fields.publishedUsec),
    updatedAt: Date.now(),
  };
  const names = { '#read': 'read', '#starred': 'starred', '#labels': 'labels' };
  const values = { ':false': false, ':labels': [] };
  const assignments = [
    '#read = if_not_exists(#read, :false)',
    '#starred = if_not_exists(#starred, :false)',
    '#labels = if_not_exists(#labels, :labels)',
  ];
  let index = 0;
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    names['#field' + index] = key;
    values[':field' + index] = value;
    assignments.push('#field' + index + ' = :field' + index);
    index += 1;
  }
  const res = await ddb.send(new UpdateCommand({
    TableName,
    Key: { PK: 'ITEM#' + itemId, SK: 'META' },
    UpdateExpression: 'SET ' + assignments.join(', '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_OLD',
  }));
  const old = res.Attributes ? stripKeys(res.Attributes) : {};
  const item = {
    ...old,
    ...updates,
    read: old.read === undefined ? false : old.read,
    starred: old.starred === undefined ? false : old.starred,
    labels: old.labels || [],
  };
  await updateItemIndexes(old, item);
  return item;
}

async function updateItemIndexes(oldItem, item) {
  const oldKeys = indexKeys(oldItem || {});
  const newKeys = indexKeys(item);
  const oldSet = new Set(oldKeys.map(keyString));
  const newSet = new Set(newKeys.map(keyString));
  for (const key of oldKeys) if (!newSet.has(keyString(key))) await deleteKey(key.PK, key.SK);
  for (const key of newKeys) {
    if (oldSet.has(keyString(key))) continue;
    await ddb.send(new PutCommand({
      TableName,
      Item: {
        ...key,
        entity: 'streamItem',
        itemId: String(item.itemId),
        feedId: item.feedId,
        expiresAt: item.expiresAt || expiresAtForPublishedUsec(item.publishedUsec),
      },
    }));
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

function expiresAtForPublishedUsec(publishedUsec) {
  const publishedSeconds = Math.floor(Number(publishedUsec || 0) / 1000000);
  return publishedSeconds + ITEM_RETENTION_SECONDS;
}

function indexSortKey(item) {
  let ts;
  try { ts = BigInt(String(item.publishedUsec || 0)); } catch { ts = 0n; }
  const rev = MAX_INDEX_TIMESTAMP - ts;
  return rev.toString().padStart(16, '0') + '#' + item.itemId;
}

function streamLimit(opts) {
  const limit = Number(opts.limit || 20);
  return Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 20;
}

function needsMetadataFilter(streamId, opts = {}) {
  return Boolean(
    streamId === 'user/-/state/com.google/read' ||
    opts.includeRead ||
    (opts.excludeRead && streamId !== 'user/-/state/com.google/reading-list' && !(streamId || '').startsWith('feed/')) ||
    (opts.includeStarred && streamId !== 'user/-/state/com.google/starred')
  );
}

async function continuationStartKey(streamId, opts) {
  if (!opts.continuation) return undefined;
  const item = await getItem(opts.continuation);
  if (!item) return null;
  return { PK: streamPk(streamId, opts), SK: indexSortKey(item) };
}

function streamQueryInput(streamId, opts) {
  const range = streamTimeRange(opts);
  if (range.empty) return null;
  const values = { ':pk': streamPk(streamId, opts) };
  let condition = 'PK = :pk';
  if (range.lower && range.upper) {
    condition += ' AND SK BETWEEN :lower AND :upper';
    values[':lower'] = range.lower;
    values[':upper'] = range.upper;
  } else if (range.lower) {
    condition += ' AND SK >= :lower';
    values[':lower'] = range.lower;
  } else if (range.upper) {
    condition += ' AND SK <= :upper';
    values[':upper'] = range.upper;
  }
  return {
    TableName,
    KeyConditionExpression: condition,
    ExpressionAttributeValues: values,
    ProjectionExpression: 'itemId',
    ScanIndexForward: opts.order === 'o' ? false : true,
  };
}

async function queryStreamRows(streamId, opts, limit, ExclusiveStartKey) {
  const input = streamQueryInput(streamId, opts);
  if (!input) return [];
  return queryAll({ ...input, Limit: limit, ExclusiveStartKey });
}

function streamTimeRange(opts = {}) {
  let lower;
  let upper;
  if (opts.nt) {
    const cutoff = Math.trunc(Number(opts.nt) * 1000000);
    if (!Number.isFinite(cutoff) || cutoff <= 0) return { empty: true };
    const latest = BigInt(Math.min(Number(MAX_INDEX_TIMESTAMP), cutoff - 1));
    lower = (MAX_INDEX_TIMESTAMP - latest).toString().padStart(16, '0') + '#';
  }
  if (opts.ot) {
    const cutoff = Math.trunc(Number(opts.ot) * 1000000);
    if (!Number.isFinite(cutoff) || cutoff >= Number(MAX_INDEX_TIMESTAMP)) return { empty: true };
    const earliest = BigInt(Math.max(0, cutoff + 1));
    upper = (MAX_INDEX_TIMESTAMP - earliest).toString().padStart(16, '0') + '#\uffff';
  }
  if (lower && upper && lower > upper) return { empty: true };
  return { lower, upper, empty: false };
}

function publishedUsecFromSortKey(sk) {
  try {
    const reverse = BigInt(String(sk).split('#', 1)[0]);
    return (MAX_INDEX_TIMESTAMP - reverse).toString();
  } catch {
    return '0';
  }
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
  if (streamId === 'user/-/state/com.google/read' || opts.includeRead) items = items.filter((it) => it.read);
  if (opts.excludeRead && streamId !== 'user/-/state/com.google/reading-list' && !(streamId || '').startsWith('feed/')) {
    items = items.filter((it) => !it.read);
  }
  if (opts.includeStarred && streamId !== 'user/-/state/com.google/starred') items = items.filter((it) => it.starred);
  return items;
}

function stripKeys(row) {
  const { PK, SK, entity, ...rest } = row;
  return rest;
}

async function queryAll(input) {
  const out = [];
  let ExclusiveStartKey = input.ExclusiveStartKey;
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
