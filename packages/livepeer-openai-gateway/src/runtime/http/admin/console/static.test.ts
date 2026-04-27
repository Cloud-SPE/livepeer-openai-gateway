import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFastifyServer } from '@cloudspe/livepeer-openai-gateway-core/providers/http/fastify.js';
import { registerAdminConsoleStatic } from './static.js';

const closables: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closables.splice(0)) await close();
});

describe('registerAdminConsoleStatic', () => {
  it('skips registration cleanly when dist/ does not exist', async () => {
    const server = await createFastifyServer({ logger: false });
    closables.push(() => server.close());
    await registerAdminConsoleStatic(server.app, { rootDir: '/tmp/admin-no-dist-12345' });
    await server.app.ready();
    const res = await server.app.inject({ method: 'GET', url: '/admin/console/index.html' });
    expect(res.statusCode).toBe(404);
  });

  it('serves files at /admin/console/* when dist/ exists', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'admin-static-'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><h1>admin-test</h1>');

    const server = await createFastifyServer({ logger: false });
    closables.push(() => server.close());
    await registerAdminConsoleStatic(server.app, { rootDir: dir, prefix: '/admin/console/' });
    await server.app.ready();

    const res = await server.app.inject({ method: 'GET', url: '/admin/console/index.html' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('admin-test');
  });
});
