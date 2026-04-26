import { describe, expect, it } from 'vitest';
import { createBasicAdminAuthResolver } from './basicAuthResolver.js';

function basic(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
}

describe('createBasicAdminAuthResolver', () => {
  it('returns the actor on a valid Basic auth header', async () => {
    const r = createBasicAdminAuthResolver({ user: 'mike', pass: 'hunter2' });
    expect(
      await r.resolve({ headers: { authorization: basic('mike', 'hunter2') }, ip: '127.0.0.1' }),
    ).toEqual({ actor: 'mike' });
  });

  it('returns null on a wrong password', async () => {
    const r = createBasicAdminAuthResolver({ user: 'mike', pass: 'hunter2' });
    expect(
      await r.resolve({ headers: { authorization: basic('mike', 'wrong') }, ip: '127.0.0.1' }),
    ).toBeNull();
  });

  it('returns null on a missing header', async () => {
    const r = createBasicAdminAuthResolver({ user: 'mike', pass: 'hunter2' });
    expect(await r.resolve({ headers: {}, ip: '127.0.0.1' })).toBeNull();
  });

  it('returns null on a non-basic scheme', async () => {
    const r = createBasicAdminAuthResolver({ user: 'mike', pass: 'hunter2' });
    expect(
      await r.resolve({ headers: { authorization: 'Bearer xyz' }, ip: '127.0.0.1' }),
    ).toBeNull();
  });

  it('returns null on a malformed payload (no colon)', async () => {
    const r = createBasicAdminAuthResolver({ user: 'mike', pass: 'hunter2' });
    const payload = Buffer.from('miketoken', 'utf8').toString('base64');
    expect(
      await r.resolve({ headers: { authorization: `Basic ${payload}` }, ip: '127.0.0.1' }),
    ).toBeNull();
  });
});
