import test from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createAccountsStore } from '../src/web/accounts-store.js';
import { startAccountsServer } from '../src/web/accounts-server.js';
import { currentRelease } from '../src/web/release.js';

test('release identity follows deployed commits and stays stable on restarts', () => {
  assert.deepEqual(currentRelease({}), currentRelease({}));
  assert.equal(currentRelease({ RENDER_GIT_COMMIT: 'first' }).id, currentRelease({ RENDER_GIT_COMMIT: 'first' }).id);
  assert.notEqual(currentRelease({ RENDER_GIT_COMMIT: 'first' }).id, currentRelease({ RENDER_GIT_COMMIT: 'second' }).id);
  assert.equal(currentRelease({ SOLUNA_RELEASE_ID: 'manual', RENDER_GIT_COMMIT: 'first' }).id, currentRelease({ SOLUNA_RELEASE_ID: 'manual' }).id);
});

test('announcements are claimed once per account across tabs, logins, restarts and releases', async (t) => {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  const store = await createAccountsStore({ pool, encryptionKey: 'test-announcements-encryption-key' });
  const alice = await store.register('alice', 'alice-test-password');
  const bob = await store.register('bob', 'bob-test-password');
  const cookie = async (user) => `soluna_session=${await store.createLogin(user.id)}`;
  const aliceCookie = await cookie(alice);
  const bobCookie = await cookie(bob);
  let gateway;
  t.after(async () => { if (gateway) await gateway.close(); await pool.end(); });
  async function start(commit) {
    gateway = await startAccountsServer({ port: 0, host: '127.0.0.1', store, migrate: false, adminPassword: 'admin-test-password', runtimes: { async close() {} }, release: currentRelease({ RENDER_GIT_COMMIT: commit }) });
  }
  async function claim(token, origin) {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/api/account/announcement`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { cookie: token } : {}), ...(origin ? { origin } : {}) }, body: '{}',
    });
    return { status: res.status, ...(await res.json()) };
  }
  await start('first');
  assert.equal((await claim()).status, 401);
  assert.equal((await claim(aliceCookie, 'https://other.example')).status, 403);
  const simultaneous = await Promise.all([claim(aliceCookie), claim(aliceCookie)]);
  assert.equal(simultaneous.filter((r) => r.announcement).length, 1);
  assert.equal((await claim(bobCookie)).announcement.title, currentRelease({}).title);
  assert.equal((await claim(await cookie(alice))).announcement, null);
  await gateway.close(); gateway = null;
  await start('first');
  assert.equal((await claim(aliceCookie)).announcement, null);
  await gateway.close(); gateway = null;
  await start('second');
  assert.ok((await claim(aliceCookie)).announcement);
  assert.equal((await claim(aliceCookie)).announcement, null);
  assert.ok((await claim(bobCookie)).announcement);
});
