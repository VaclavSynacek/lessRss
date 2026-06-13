'use strict';

function response(statusCode, body = '', headers = {}) {
  return {
    statusCode,
    headers: {
      'Cache-Control': 'no-store',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function json(statusCode, value) {
  return response(statusCode, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8' });
}

function text(statusCode, value) {
  return response(statusCode, value, { 'Content-Type': 'text/plain; charset=utf-8' });
}

function xml(statusCode, value) {
  return response(statusCode, value, { 'Content-Type': 'application/xml; charset=utf-8' });
}

function unauthorized() {
  return text(401, 'Unauthorized');
}

function notFound() {
  return text(404, 'Not found');
}

function badRequest(msg) {
  return text(400, msg || 'Bad request');
}

function formParams(body) {
  const params = new URLSearchParams(body || '');
  const out = {};
  for (const [k, v] of params.entries()) {
    if (out[k] === undefined) out[k] = v;
    else if (Array.isArray(out[k])) out[k].push(v);
    else out[k] = [out[k], v];
  }
  return out;
}

function arrayParam(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

module.exports = { response, json, text, xml, unauthorized, notFound, badRequest, formParams, arrayParam };
