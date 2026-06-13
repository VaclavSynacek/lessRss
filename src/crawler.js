'use strict';

const { listSubscriptions, upsertItem } = require('./storage');
const { putBody } = require('./body-store');

async function refreshAll() {
  const subs = await listSubscriptions();
  const results = [];
  for (const sub of subs) {
    results.push(await refreshSubscription(sub).catch((e) => ({ feedId: sub.feedId, ok: false, error: e.message })));
  }
  return results;
}

async function refreshSubscription(sub) {
  const res = await fetch(sub.url, { headers: { 'User-Agent': 'lessRss/0.1' } });
  if (!res.ok) throw new Error(`fetch ${sub.url} HTTP ${res.status}`);
  const xml = await res.text();
  const parsed = parseFeed(xml);
  let count = 0;
  for (const parsedItem of parsed.items) {
    const guid = parsedItem.guid || parsedItem.link || parsedItem.title;
    if (!guid) continue;
    const publishedMs = parsedItem.pubDate ? Date.parse(parsedItem.pubDate) : Date.now();
    const item = await upsertItem(sub.feedId, {
      guid,
      url: parsedItem.link || '',
      title: parsedItem.title || '',
      author: parsedItem.author || '',
      publishedUsec: String((Number.isFinite(publishedMs) ? publishedMs : Date.now()) * 1000),
      crawlTimeMsec: String(Date.now()),
      feedTitle: sub.title,
      feedUrl: sub.url,
      feedHtmlUrl: sub.htmlUrl,
      bodyKey: '',
    });
    const bodyKey = `items/${sub.feedId}/${item.itemId}.json`;
    await putBody(bodyKey, {
      summaryHtml: parsedItem.description || parsedItem.content || '',
      contentHtml: parsedItem.content || parsedItem.description || '',
      rawTitle: parsedItem.title || '',
      rawDescription: parsedItem.description || '',
      rawContent: parsedItem.content || '',
      url: parsedItem.link || '',
      fetchedAt: new Date().toISOString(),
    });
    await upsertItem(sub.feedId, { ...item, bodyKey });
    count += 1;
  }
  return { feedId: sub.feedId, ok: true, count };
}

function parseFeed(xml) {
  if (/<feed[\s>]/i.test(xml)) return parseAtom(xml);
  return parseRss(xml);
}

function parseRss(xml) {
  const items = [];
  for (const block of matchBlocks(xml, 'item')) {
    items.push({
      title: textTag(block, 'title'),
      description: textTag(block, 'description'),
      content: textTag(block, 'content:encoded') || textTag(block, 'encoded'),
      link: textTag(block, 'link'),
      guid: textTag(block, 'guid'),
      pubDate: textTag(block, 'pubDate') || textTag(block, 'dc:date'),
      author: textTag(block, 'author') || textTag(block, 'dc:creator'),
    });
  }
  return { items };
}

function parseAtom(xml) {
  const items = [];
  for (const block of matchBlocks(xml, 'entry')) {
    items.push({
      title: textTag(block, 'title'),
      description: textTag(block, 'summary'),
      content: textTag(block, 'content'),
      link: attrTag(block, 'link', 'href') || textTag(block, 'link'),
      guid: textTag(block, 'id'),
      pubDate: textTag(block, 'published') || textTag(block, 'updated'),
      author: textTag(matchBlocks(block, 'author')[0] || '', 'name'),
    });
  }
  return { items };
}

function matchBlocks(xml, tag) {
  const re = new RegExp(`<${escapeRe(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRe(tag)}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function textTag(xml, tag) {
  const re = new RegExp(`<${escapeRe(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRe(tag)}>`, 'i');
  const m = re.exec(xml || '');
  return m ? decodeXml(stripCdata(m[1]).trim()) : '';
}

function attrTag(xml, tag, attr) {
  const re = new RegExp(`<${escapeRe(tag)}\\b([^>]*)>`, 'i');
  const m = re.exec(xml || '');
  if (!m) return '';
  const are = new RegExp(`${escapeRe(attr)}=["']([^"']+)["']`, 'i');
  const am = are.exec(m[1]);
  return am ? decodeXml(am[1]) : '';
}

function stripCdata(s) {
  return String(s).replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { refreshAll, refreshSubscription, parseFeed };
