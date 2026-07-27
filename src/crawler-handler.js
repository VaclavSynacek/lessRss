'use strict';

const { refreshAll, refreshSubscription } = require('./crawler');
const storage = require('./storage');
const { backupSubscriptions } = require('./opml-backup');

async function handler(event = {}) {
  const detail = event.detail || event;
  if (detail.feedId) {
    const sub = await storage.getSubscription(detail.feedId);
    if (!sub) return { ok: false, error: 'subscription not found', feedId: detail.feedId };
    return refreshSubscription(sub);
  }
  const backup = await backupSubscriptions().catch((e) => {
    console.error('OPML backup failed', e);
    return { ok: false, error: e.message };
  });
  const results = await refreshAll();
  return {
    ok: backup.ok && results.every((r) => r.ok),
    backup,
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
