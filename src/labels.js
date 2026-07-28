'use strict';

const { truncateUtf8 } = require('./feed-security');

const LABEL_PREFIX = 'user/-/label/';
const MAX_LABEL_BYTES = 512;

function labelName(value) {
  let label = String(value || '');
  if (label.startsWith(LABEL_PREFIX)) label = label.slice(LABEL_PREFIX.length);
  label = truncateUtf8(label.trim(), MAX_LABEL_BYTES);
  return label || '';
}

function labelId(value) {
  const label = labelName(value);
  return label ? LABEL_PREFIX + label : '';
}

function categoryFor(value) {
  const label = labelName(value);
  return label ? { id: LABEL_PREFIX + label, label } : null;
}

function normalizeCategories(categories) {
  const out = [];
  const seen = new Set();
  for (const category of categories || []) {
    const value = typeof category === 'string' ? category : (category.id || category.label || '');
    const normalized = categoryFor(value);
    if (!normalized || seen.has(normalized.label)) continue;
    seen.add(normalized.label);
    out.push(normalized);
  }
  return out;
}

module.exports = { LABEL_PREFIX, labelName, labelId, categoryFor, normalizeCategories };
