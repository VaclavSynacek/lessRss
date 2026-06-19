'use strict';

/**
 * Run an async mapper over items with a bounded number of in-flight calls.
 * Preserves input order in the output. No-op when limit <= 0 (runs all in
 * parallel) and when items is empty.
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  if (items.length === 0) return out;
  const cap = Number.isFinite(limit) && limit > 0 ? Math.min(limit, items.length) : items.length;
  let next = 0;
  const workers = Array.from({ length: cap }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

module.exports = { mapLimit };
