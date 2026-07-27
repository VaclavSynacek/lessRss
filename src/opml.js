'use strict';

const { subscriptionTitle, subscriptionHtmlUrl } = require('./greader-format');

function subscriptionsToOpml(subscriptions) {
  const sorted = [...subscriptions].sort((a, b) => String(a.feedId || a.url).localeCompare(String(b.feedId || b.url)));
  const outlines = sorted.map((sub) => (
    `    <outline type="rss" text="${escapeXml(subscriptionTitle(sub))}" title="${escapeXml(subscriptionTitle(sub))}" xmlUrl="${escapeXml(sub.url)}" htmlUrl="${escapeXml(subscriptionHtmlUrl(sub))}"/>`
  )).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>lessRss</title></head>\n  <body>\n${outlines}\n  </body>\n</opml>\n`;
}

function escapeXml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { subscriptionsToOpml };
