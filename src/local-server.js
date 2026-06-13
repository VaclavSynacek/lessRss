'use strict';

const http = require('node:http');
const { handler } = require('./handler');

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);

const server = http.createServer(async (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
    const result = await handler({
      requestContext: { http: { method: req.method } },
      rawPath: url.pathname,
      rawQueryString: url.search.length > 1 ? url.search.slice(1) : '',
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
      isBase64Encoded: false,
    });
    res.writeHead(result.statusCode || 200, result.headers || {});
    res.end(result.body || '');
  });
});

server.listen(port, host, () => {
  console.log(`lessRss local server listening on http://${host}:${port}/api/greader.php`);
});
