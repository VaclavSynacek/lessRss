'use strict';

const crypto = require('node:crypto');
const { S3Client, HeadObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const storage = require('./storage');
const { subscriptionsToOpml } = require('./opml');

const bucket = process.env.LESSRSS_OPML_BACKUP_BUCKET || '';
const key = 'subscriptions.opml';
const s3 = bucket ? new S3Client({ region: process.env.AWS_REGION || 'us-east-1' }) : null;

async function backupSubscriptions() {
  if (!bucket) return { ok: true, skipped: true, reason: 'backup bucket not configured' };

  const subscriptions = await storage.listSubscriptions();
  const opml = subscriptionsToOpml(subscriptions);
  const sha256 = crypto.createHash('sha256').update(opml).digest('hex');
  const previousHash = await currentHash();
  if (previousHash === sha256) {
    return { ok: true, skipped: true, count: subscriptions.length, sha256 };
  }

  const result = await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: opml,
    ContentType: 'text/x-opml; charset=utf-8',
    Metadata: { sha256 },
  }));
  return { ok: true, skipped: false, count: subscriptions.length, sha256, versionId: result.VersionId || '' };
}

async function currentHash() {
  try {
    const result = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return result.Metadata?.sha256 || '';
  } catch (e) {
    if (e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return '';
    throw e;
  }
}

module.exports = { backupSubscriptions };
