'use strict';

const { refreshAll, refreshSubscription } = require('./crawler');
const storage = require('./storage');

async function handler(event = {}) {
  const detail = event.detail || event;
  if (detail.feedId) {
    const sub = await storage.getSubscription(detail.feedId);
    if (!sub) return { ok: false, error: 'subscription not found', feedId: detail.feedId };
    return refreshSubscription(sub);
  }
  const results = await refreshAll();
  return {
    ok: results.every((r) => r.ok),
    count: results.length,
    results,
  };
}

if (require.main === module) {
  handler().then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { handler };
