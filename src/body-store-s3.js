'use strict';

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const bucket = process.env.LESSRSS_BODY_BUCKET || process.env.LESSRSS_S3_BUCKET;
if (!bucket) throw new Error('LESSRSS_BODY_BUCKET or LESSRSS_S3_BUCKET is required for LESSRSS_BODY_STORE=s3');

const endpoint = process.env.S3_ENDPOINT || process.env.AWS_ENDPOINT_URL_S3 || '';
const cfg = { region: process.env.AWS_REGION || 'us-east-1' };
if (endpoint) {
  cfg.endpoint = endpoint;
  cfg.forcePathStyle = true;
  cfg.credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'dummy',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'dummy',
  };
}
const s3 = new S3Client(cfg);

async function putBody(key, value) {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(value),
    ContentType: 'application/json; charset=utf-8',
  }));
}

async function getBody(key) {
  if (!key) return null;
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await res.Body.transformToString());
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

module.exports = { putBody, getBody };
