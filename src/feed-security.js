'use strict';

const MAX_FEED_BYTES = 20 * 1024 * 1024;
const MAX_ATTRIBUTE_BYTES = 8 * 1024;
const MAX_REDIRECTS = 10;

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function isOversizedAttribute(value) {
  return byteLength(value) > MAX_ATTRIBUTE_BYTES;
}

function truncateUtf8(value, maxBytes = MAX_ATTRIBUTE_BYTES) {
  const text = String(value || '');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  return bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, '');
}

function httpUrl(value, baseUrl = '', { allowFragment = false } = {}) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (allowFragment && text.startsWith('#')) return truncateUtf8(text);
  if (isOversizedAttribute(text)) return '';

  try {
    const url = baseUrl ? new URL(text, baseUrl) : new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (url.username || url.password) return '';
    const normalized = url.href;
    return isOversizedAttribute(normalized) ? '' : normalized;
  } catch {
    return '';
  }
}

module.exports = {
  MAX_FEED_BYTES,
  MAX_ATTRIBUTE_BYTES,
  MAX_REDIRECTS,
  isOversizedAttribute,
  truncateUtf8,
  httpUrl,
};
