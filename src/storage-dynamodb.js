'use strict';

const crypto = require('node:crypto');
const { GetCommand, PutCommand, QueryCommand, ScanCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { documentClient, tableName } = require('./dynamodb-client');

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
  const old = await getAnySubscription(feedId);
  if (!old) return;
  await putEntity('USER', 'SUB#' + feedId, 'subscription', { ...old, active: false, updatedAt: Date.now() });
}

async function getAnySubscription(feedId) {
  const res = await ddb.send(new GetCommand({ TableName, Key: { PK: 'USER', SK: 'SUB#' + feedId } }));
  return res.Item ? stripKeys(res.Item) : null;
}

async function listItems() {
  const rows = await scanAll({
    TableName,
    FilterExpression: '#entity = :entity',
    ExpressionAttributeNames: { '#entity': 'entity' },
    ExpressionAttributeValues: { ':entity': 'item' },
  });
  return rows.map(stripKeys);
}

async function getItems(ids) {
  const normalized = ids.map(normalizeItemId);
  const out = [];
  for (const id of normalized) {
    const res = await ddb.send(new GetCommand({ TableName, Key: { PK: 'ITEM#' + id, SK: 'META' } }));
    if (res.Item) out.push(stripKeys(res.Item));
  }
  return out;
}

async function updateItems(mutator) {
  const current = await listItems();
  const items = Object.fromEntries(current.map((it) => [String(it.itemId), it]));
  const result = await mutator(items, { items });
  for (const it of Object.values(items)) {
    await putEntity('ITEM#' + it.itemId, 'META', 'item', it);
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
  await putEntity('ITEM#' + itemId, 'META', 'item', item);
  return item;
}

async function putEntity(PK, SK, entity, value) {
  await ddb.send(new PutCommand({ TableName, Item: { ...value, PK, SK, entity } }));
}

function stripKeys(row) {
  const { PK, SK, entity, ...rest } = row;
  return rest;
}

async function queryAll(input) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey }));
    out.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

async function scanAll(input) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const res = await dynamodbScan({ ...input, ExclusiveStartKey });
    out.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

async function dynamodbScan(input) {
  return ddb.send(new ScanCommand(input));
}

module.exports = {
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
