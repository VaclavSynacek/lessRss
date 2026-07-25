'use strict';

const { ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { documentClient, tableName } = require('../src/dynamodb-client');
const { mapLimit } = require('../src/async-util');

const ddb = documentClient();
const TableName = tableName();
const MAX_INDEX_TIMESTAMP = 9999999999999999n;
const ITEM_RETENTION_SECONDS = 365 * 24 * 60 * 60;
const concurrency = Number(process.env.LESSRSS_DDB_WRITE_CONCURRENCY) || 20;

function publishedUsec(row) {
  if (row.entity === 'item') return row.publishedUsec;
  if (row.entity !== 'streamItem') return null;
  try {
    return (MAX_INDEX_TIMESTAMP - BigInt(String(row.SK).split('#', 1)[0])).toString();
  } catch {
    return null;
  }
}

function expiresAt(row) {
  const usec = Number(publishedUsec(row));
  if (!Number.isFinite(usec) || usec <= 0) return null;
  return Math.floor(usec / 1000000) + ITEM_RETENTION_SECONDS;
}

async function update(row, expiration) {
  await ddb.send(new UpdateCommand({
    TableName,
    Key: { PK: row.PK, SK: row.SK },
    UpdateExpression: 'SET expiresAt = :expiresAt',
    ExpressionAttributeValues: { ':expiresAt': expiration },
  }));
}

async function main() {
  let ExclusiveStartKey;
  let scanned = 0;
  let updated = 0;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName,
      ExclusiveStartKey,
      ProjectionExpression: 'PK, SK, entity, publishedUsec, expiresAt',
    }));
    const changes = (res.Items || [])
      .map((row) => ({ row, expiration: expiresAt(row) }))
      .filter(({ row, expiration }) => expiration !== null && row.expiresAt !== expiration);
    await mapLimit(changes, concurrency, ({ row, expiration }) => update(row, expiration));
    scanned += (res.Items || []).length;
    updated += changes.length;
    console.log(`Scanned ${scanned}; updated ${updated}`);
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
