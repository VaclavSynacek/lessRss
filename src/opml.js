'use strict';

const { subscriptionTitle, subscriptionHtmlUrl } = require('./greader-format');
const { labelName, normalizeCategories } = require('./labels');

function subscriptionsToOpml(subscriptions) {
  const sorted = [...subscriptions].sort((a, b) => String(a.feedId || a.url).localeCompare(String(b.feedId || b.url)));
  const groups = new Map();
  const uncategorized = [];
  for (const sub of sorted) {
    const labels = normalizeCategories(sub.categories).map((category) => category.label);
    if (labels.length === 0) uncategorized.push(sub);
    for (const label of labels) {
      const entries = groups.get(label) || [];
      entries.push(sub);
      groups.set(label, entries);
    }
  }

  const outlines = [];
  for (const sub of uncategorized) outlines.push('    ' + subscriptionOutline(sub));
  for (const label of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    outlines.push(`    <outline text="${escapeXml(label)}" title="${escapeXml(label)}">`);
    for (const sub of groups.get(label)) outlines.push('      ' + subscriptionOutline(sub));
    outlines.push('    </outline>');
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>lessRss</title></head>\n  <body>\n${outlines.join('\n')}\n  </body>\n</opml>\n`;
}

function subscriptionOutline(sub) {
  const title = escapeXml(subscriptionTitle(sub));
  return `<outline type="rss" text="${title}" title="${title}" xmlUrl="${escapeXml(sub.url)}" htmlUrl="${escapeXml(subscriptionHtmlUrl(sub))}"/>`;
}

function parseOpmlSubscriptions(xml) {
  const entries = new Map();
  const stack = [];
  const tags = String(xml || '').match(/<\/?outline\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (/^<\/outline/i.test(tag)) {
      stack.pop();
      continue;
    }
    const attrs = parseAttributes(tag);
    const selfClosing = /\/\s*>$/.test(tag);
    const url = decodeXml(attrs.xmlurl || '');
    if (url) {
      const title = decodeXml(attrs.title || attrs.text || url);
      const labels = stack.map(labelName).filter(Boolean);
      const key = url;
      const existing = entries.get(key) || { url, title, labels: [] };
      if (!existing.title && title) existing.title = title;
      for (const label of labels) if (!existing.labels.includes(label)) existing.labels.push(label);
      entries.set(key, existing);
    }
    if (!selfClosing) stack.push(url ? '' : decodeXml(attrs.title || attrs.text || ''));
  }
  return [...entries.values()];
}

function parseAttributes(tag) {
  const out = {};
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(tag)) !== null) out[match[1].toLowerCase()] = match[2] ?? match[3] ?? '';
  return out;
}

function escapeXml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function decodeXml(value) {
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (whole, entity) => {
    const lower = entity.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
  });
}

module.exports = { subscriptionsToOpml, parseOpmlSubscriptions };
