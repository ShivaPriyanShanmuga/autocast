#!/usr/bin/env node
// A dependency-free HTTP server used by autocast's browser tests.
// Never add npm dependencies: tests must run with no install and no network.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 3000);
const orders = [];

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = await readFile(join(here, 'public', 'index.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (url.pathname === '/api/slow') {
    // Something for wait_for to genuinely wait on.
    setTimeout(() => json(res, 200, { ready: true }), 500);
    return;
  }

  if (url.pathname === '/api/orders' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let qty = 1;
    try {
      qty = Number(JSON.parse(body || '{}').qty ?? 1);
    } catch {
      return json(res, 400, { error: 'bad json' });
    }
    const order = { id: orders.length + 1, qty, status: 'confirmed' };
    orders.push(order);
    process.stdout.write(`POST /api/orders 201 qty=${qty}\n`);
    return json(res, 201, order);
  }

  if (url.pathname === '/api/orders') return json(res, 200, orders);

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

// Fail loudly on a port clash. Without this the process dies with an
// unhandled error and every waiting test times out on "server did not
// start", which says nothing about the real cause.
server.on('error', (err) => {
  process.stderr.write(`web-app fixture could not listen on :${port}: ${err.message}\n`);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`listening on :${port}\n`);
});
