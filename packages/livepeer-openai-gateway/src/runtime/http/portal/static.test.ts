import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFastifyServer } from '@cloudspe/livepeer-openai-gateway-core/providers/http/fastify.js';
import { registerPortalStatic } from './static.js';

const closables: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closables.splice(0)) await close();
});

describe('registerPortalStatic', () => {
  it('skips registration cleanly when dist/ does not exist', async () => {
    const server = await createFastifyServer({ logger: false });
    closables.push(() => server.close());
    await registerPortalStatic(server.app, { rootDir: '/tmp/portal-no-dist-12345' });
    await server.app.ready();
    // /portal/* should 404 (no static handler attached)
    const res = await server.app.inject({ method: 'GET', url: '/portal/index.html' });
    expect(res.statusCode).toBe(404);
  });

  it('serves files from the configured rootDir at the configured prefix', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'portal-static-'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><h1>portal-test</h1>');

    const server = await createFastifyServer({ logger: false });
    closables.push(() => server.close());
    await registerPortalStatic(server.app, { rootDir: dir, prefix: '/portal/' });
    await server.app.ready();

    const res = await server.app.inject({ method: 'GET', url: '/portal/index.html' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('portal-test');
  });
});
