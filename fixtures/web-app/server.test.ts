import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';

const PORT = 34567;
let proc: ChildProcess;

beforeAll(async () => {
  proc = spawn(process.execPath, ['fixtures/web-app/server.mjs', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    proc.stdout!.on('data', (d: Buffer) => {
      if (d.toString().includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
});

afterAll(() => {
  proc.kill();
});

describe('web-app fixture', () => {
  it('serves the page', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-test="new-order"');
  });

  it('accepts an order and echoes the quantity', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ qty: 3 }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ qty: 3, status: 'confirmed' });
  });

  it('has a deliberately slow endpoint for wait_for to wait on', async () => {
    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${PORT}/api/slow`);
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
  });

  it('404s an unknown path', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/nope`);
    expect(res.status).toBe(404);
  });
});
