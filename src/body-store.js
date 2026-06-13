'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DATA_DIR = process.env.LESSRSS_DATA_DIR || path.join(process.cwd(), '.local-data');
const BODY_ROOT = path.join(DATA_DIR, 'bodies');

async function putBody(key, value) {
  const file = path.join(BODY_ROOT, key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2));
}

async function getBody(key) {
  if (!key) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(BODY_ROOT, key), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

module.exports = { putBody, getBody };
