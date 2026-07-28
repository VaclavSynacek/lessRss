'use strict';

const sax = require('sax');
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
  const categoryStack = [];
  let sawOpml = false;
  let sawBody = false;
  let inBody = false;

  const parser = sax.parser(true, {
    normalize: false,
    strictEntities: true,
    trim: false,
  });
  parser.onopentag = (node) => {
    const name = node.name.toLowerCase();
    if (name === 'opml') sawOpml = true;
    if (name === 'body' && sawOpml) {
      sawBody = true;
      inBody = true;
    }
    if (name !== 'outline' || !inBody) return;

    const attrs = Object.fromEntries(Object.entries(node.attributes).map(([key, value]) => (
      [key.toLowerCase(), String(value)]
    )));
    const url = attrs.xmlurl || '';
    if (url) {
      const title = attrs.title || attrs.text || url;
      const labels = categoryStack.map(labelName).filter(Boolean);
      const existing = entries.get(url) || { url, title, labels: [] };
      for (const label of labels) if (!existing.labels.includes(label)) existing.labels.push(label);
      entries.set(url, existing);
    }
    categoryStack.push(url ? '' : (attrs.title || attrs.text || ''));
  };
  parser.onclosetag = (name) => {
    name = name.toLowerCase();
    if (name === 'outline' && inBody) categoryStack.pop();
    if (name === 'body') inBody = false;
  };
  parser.write(String(xml || '')).close();
  if (!sawOpml || !sawBody) throw new Error('document is not OPML');
  return [...entries.values()];
}

function escapeXml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

module.exports = { subscriptionsToOpml, parseOpmlSubscriptions };
