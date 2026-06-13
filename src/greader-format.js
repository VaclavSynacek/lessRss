'use strict';

const { STATE } = require('./constants');
const { getBody } = require('./body-store');

function subscriptionToGreader(sub) {
  return {
    id: sub.id || ('feed/' + sub.feedId),
    title: sub.title || sub.url,
    url: sub.url,
    htmlUrl: sub.htmlUrl || sub.url,
    iconUrl: '',
    categories: sub.categories || [],
    firstitemmsec: '0',
  };
}

async function itemToGreader(item, sub) {
  const body = await getBody(item.bodyKey);
  const html = body?.contentHtml || body?.summaryHtml || item.summaryHtml || '';
  const categories = [STATE.READING_LIST];
  if (item.read) categories.push(STATE.READ);
  if (item.starred) categories.push(STATE.STARRED);
  for (const label of item.labels || []) categories.push('user/-/label/' + label);

  const href = item.url || body?.url || '';
  return {
    id: 'tag:google.com,2005:reader/item/' + item.itemHex,
    crawlTimeMsec: String(item.crawlTimeMsec || Date.now()),
    timestampUsec: String(item.publishedUsec || Date.now() * 1000),
    published: Math.floor(Number(item.publishedUsec || Date.now() * 1000) / 1000000),
    title: item.title || '',
    author: item.author || '',
    summary: { content: html },
    canonical: href ? [{ href }] : [],
    alternate: href ? [{ href, type: 'text/html' }] : [],
    categories,
    origin: {
      streamId: 'feed/' + item.feedId,
      title: sub?.title || item.feedTitle || '',
      htmlUrl: sub?.htmlUrl || item.feedHtmlUrl || '',
      feedUrl: sub?.url || item.feedUrl || '',
    },
    enclosure: [],
  };
}

function sortItems(items, order) {
  const copy = [...items];
  copy.sort((a, b) => Number(b.publishedUsec || 0) - Number(a.publishedUsec || 0));
  if (order === 'o') copy.reverse();
  return copy;
}

function streamTitle(streamId) {
  if (streamId === STATE.READING_LIST) return 'Reading list';
  if (streamId === STATE.STARRED) return 'Starred';
  if (streamId.startsWith('feed/')) return streamId.slice(5);
  if (streamId.startsWith('user/-/label/')) return streamId.slice('user/-/label/'.length);
  return streamId;
}

module.exports = { subscriptionToGreader, itemToGreader, sortItems, streamTitle };
