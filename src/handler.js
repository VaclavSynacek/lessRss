'use strict';

const { route } = require('./router');
const { text } = require('./http');

async function handler(event) {
  try {
    const req = normalizeEvent(event);
    return await route(req);
  } catch (e) {
    console.error(e);
    return text(500, 'Internal server error: ' + e.message);
  }
}

function normalizeEvent(event) {
  const headers = lowerAndOriginalHeaders(event.headers || {});
  return {
    method: event.requestContext?.http?.method || event.httpMethod || event.method || 'GET',
    rawPath: event.rawPath || event.path || '/',
    rawQueryString: event.rawQueryString || '',
    headers,
    body: event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || ''),
  };
}

function lowerAndOriginalHeaders(input) {
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = v;
    out[k.toLowerCase()] = v;
  }
  return out;
}

module.exports = { handler };
