'use strict';

const backendName = (process.env.LESSRSS_STORAGE || 'fs').toLowerCase();

let backend;
if (backendName === 'dynamodb' || backendName === 'ddb') {
  backend = require('./storage-dynamodb');
} else if (backendName === 'fs' || backendName === 'filesystem') {
  backend = require('./storage-fs');
} else {
  throw new Error(`Unknown LESSRSS_STORAGE backend: ${backendName}`);
}

module.exports = backend;
