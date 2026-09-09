import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] ?? 5180);

const STAGES = ['build', 'test', 'bundle', 'upload', 'live'];
/** @type {{id:string, stage:number, startedAt:number, done:boolean}|null} */
let deploy = null;

const log = (msg) => console.log(`${new Date().toISOString().slice(11, 19)}  ${msg}`);

function advance() {
  if (!deploy || deploy.done) return;
  deploy.stage++;
  if (deploy.stage >= STAGES.length) {
    deploy.done = true;
    log(`DEPLOY ${deploy.id} live in ${((Date.now() - deploy.startedAt) / 1000).toFixed(1)}s`);
    return;
  }
  log(`  ${STAGES[deploy.stage]} ok`);
  setTimeout(advance, 380);
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/deploy' && req.method === 'POST') {
    deploy = { id: `d-${Math.random().toString(36).slice(2, 7)}`, stage: -1, startedAt: Date.now(), done: false };
    log(`POST /api/deploy 202  ${deploy.id}`);
    setTimeout(advance, 250);
    return send(res, 202, { id: deploy.id });
  }

  if (url.pathname === '/api/status') {
    return send(res, 200, {
      stages: STAGES,
      current: deploy ? deploy.stage : -1,
      done: deploy?.done ?? false,
      id: deploy?.id ?? null,
    });
  }

  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  try {
    const body = await readFile(join(HERE, 'public', file));
    const type = file.endsWith('.html') ? 'text/html' : 'text/plain';
    return send(res, 200, body.toString(), type);
  } catch {
    return send(res, 404, { error: 'not found' });
  }
}).listen(PORT, '127.0.0.1', () => log(`shipboard listening on :${PORT}`));
