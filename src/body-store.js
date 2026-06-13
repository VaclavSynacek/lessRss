'use strict';

const backendName = (process.env.LESSRSS_BODY_STORE || 'fs').toLowerCase();

let backend;
if (backendName === 's3') {
  backend = require('./body-store-s3');
} else if (backendName === 'fs' || backendName === 'filesystem') {
  backend = require('./body-store-fs');
} else {
  throw new Error(`Unknown LESSRSS_BODY_STORE backend: ${backendName}`);
}

module.exports = backend;
