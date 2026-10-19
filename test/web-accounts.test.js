import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newDb } from 'pg-mem';
import { createAccountsStore, checkPassword, hashPassword, secretBox, publicUser } from '../src/web/accounts-store.js';
import { startAccountsServer } from '../src/web/accounts-server.js';

async function database() {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  return { pool, store: await createAccountsStore({ pool, encryptionKey: 'test-encryption-secret-32-characters' }) };
}

test('password hashes and encrypted keys reject changes and wrong contexts', async () => {
  const hash = await hashPassword('a-secret-password');
  assert.ok(!hash.includes('a-secret-password'));
  assert.equal(await checkPassword('a-secret-password', hash), true);
  assert.equal(await checkPassword('wrong-password', hash), false);
  const box = secretBox('x'.repeat(32));
  const cipher = box.seal(['api-secret'], 'alice:openrouter');
  assert.ok(!cipher.includes('api-secret'));
  assert.deepEqual(box.open(cipher, 'alice:openrouter'), ['api-secret']);
  assert.throws(() => box.open(cipher, 'bob:openrouter'));
  assert.throws(() => secretBox('y'.repeat(32)).open(cipher, 'alice:openrouter'));
  assert.equal(publicUser({ id: '1', username: 'alice', is_admin: true }).isAdmin, false);
});

test('database persists private keys, roles, login revocation and admin audit', async (t) => {
  const { pool, store } = await database();
  t.after(() => pool.end());
  const admin = await store.ensureAdmin('admin-test-password');
  assert.equal(admin.isAdmin, true);
  await assert.rejects(store.register('picolas', 'some-password'), /reservado/);
  const alice = await store.register('ALICE', 'alice-test-password');
  const bob = await store.register('bob', 'bob-test-password');
  assert.equal(alice.username, 'alice');
  assert.equal(alice.isAdmin, false);
  await assert.rejects(store.login('alice', 'wrong-password'), /incorrectos/);
  await assert.rejects(store.login('missing', 'wrong-password'), /incorrectos/);
  const token = await store.createLogin(alice.id);
  assert.equal((await store.authenticate(token)).id, alice.id);
  const rows = (await pool.query('SELECT * FROM soluna_logins')).rows;
  assert.ok(!JSON.stringify(rows).includes(token));
  await store.saveKeys(alice.id, 'openrouter', ['alice-private-1234', 'alice-private-5678']);
  await store.saveKeys(bob.id, 'openrouter', ['bob-private-9000']);
  assert.deepEqual((await store.keySets(bob.id)).openrouter, ['bob-private-9000']);
  const encrypted = (await pool.query('SELECT * FROM soluna_provider_keys')).rows;
  assert.ok(!JSON.stringify(encrypted).includes('alice-private'));
  const keys = await store.allKeys();
  assert.equal(keys.length, 3);
  assert.ok(!JSON.stringify(keys).includes('alice-private'));
  const first = keys.find((key) => key.userId === alice.id);
  assert.equal(await store.revealKey(alice.id, first.provider, first.id), 'alice-private-1234');
  await assert.rejects(store.revealKey(bob.id, first.provider, first.id), /no existe/);
  await store.audit(admin.id, alice.id, 'reveal-key', 'openrouter');
  assert.equal((await pool.query('SELECT * FROM soluna_audit')).rows.length, 1);
  await assert.rejects(store.disable(admin.id, true), /No se puede/);
  await store.disable(alice.id, true);
  assert.equal(await store.authenticate(token), null);
  await assert.rejects(store.login('alice', 'alice-test-password'), /incorrectos/);
  await store.disable(alice.id, false);
  const next = await store.createLogin(alice.id);
  await store.logout(next);
  assert.equal(await store.authenticate(next), null);
});

test('gateway protects admin routes and isolates real account workers and API keys', { timeout: 60000 }, async (t) => {
  const { pool, store } = await database();
  const home = await mkdtemp(join(tmpdir(), 'soluna-accounts-'));
  const gateway = await startAccountsServer({ store, home, port: 0, host: '127.0.0.1', adminPassword: 'admin-test-password', migrate: false });
  t.after(async () => { await gateway.close(); await pool.end(); await rm(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${gateway.port}`;
  async function request(path, { body, cookie, origin, method } = {}) {
    return fetch(base + path, { method: method || (body ? 'POST' : 'GET'), headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(origin ? { origin } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  }
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/app')).status, 303);
  assert.equal((await request('/api/config')).status, 401);
  assert.equal((await request('/api/account/register', { body: { username: 'picolas', password: 'test-password-123' } })).status, 409);
  const aliceResponse = await request('/api/account/register', { body: { username: 'alice', password: 'test-password-123', isAdmin: true } });
  assert.equal(aliceResponse.status, 200);
  const aliceCookie = aliceResponse.headers.get('set-cookie').split(';')[0];
  assert.match(aliceResponse.headers.get('set-cookie'), /HttpOnly/);
  const alice = (await aliceResponse.json()).user;
  assert.equal(alice.isAdmin, false);
  assert.equal((await request('/admin', { cookie: aliceCookie })).status, 403);
  for (const path of ['/api/admin/overview', '/api/admin/keys/reveal', '/api/admin/user']) {
    assert.equal((await request(path, { cookie: aliceCookie, ...(path.endsWith('overview') ? {} : { body: { userId: alice.id } }) })).status, 403);
  }
  assert.equal((await request('/api/account/login', { origin: 'https://evil.example', body: { username: 'picolas', password: 'admin-test-password' } })).status, 403);
  const adminResponse = await request('/api/account/login', { body: { username: 'picolas', password: 'admin-test-password' } });
  const adminCookie = adminResponse.headers.get('set-cookie').split(';')[0];
  const bobResponse = await request('/api/account/register', { body: { username: 'bob', password: 'test-password-123' } });
  const bobCookie = bobResponse.headers.get('set-cookie').split(';')[0];
  const [aliceState, bobState] = await Promise.all([
    request('/api/state', { cookie: aliceCookie }).then((r) => r.json()),
    request('/api/state', { cookie: bobCookie }).then((r) => r.json()),
  ]);
  assert.notEqual(aliceState.cwd, bobState.cwd);
  assert.ok(aliceState.cwd.startsWith(join(home, 'accounts', alice.id)));
  const added = await request('/api/keys', { cookie: aliceCookie, body: { provider: 'openrouter', keys: ['test-alice-api-key-1234'] } });
  assert.equal(added.status, 200);
  assert.ok(!JSON.stringify(await added.json()).includes('test-alice-api-key'));
  const bobKeys = await request('/api/keys?provider=openrouter', { cookie: bobCookie }).then((r) => r.json());
  assert.equal(bobKeys.keys.length, 0);
  assert.equal((await request('/api/settings/auto-approve', { cookie: aliceCookie, body: { enabled: true } })).status, 403);
  const overview = await request('/api/admin/overview', { cookie: adminCookie }).then((r) => r.json());
  assert.equal(overview.users.length, 3);
  assert.equal(overview.keys.length, 1);
  assert.ok(!JSON.stringify(overview).includes('test-alice-api-key'));
  const key = overview.keys[0];
  const revealed = await request('/api/admin/keys/reveal', { cookie: adminCookie, body: { userId: key.userId, provider: key.provider, id: key.id } });
  assert.equal((await revealed.json()).key, 'test-alice-api-key-1234');
  const removed = await request('/api/admin/keys', { cookie: adminCookie, body: { userId: key.userId, provider: key.provider, id: key.id, action: 'remove' } });
  assert.equal(removed.status, 200);
  const remaining = await request('/api/keys?provider=openrouter', { cookie: aliceCookie }).then((r) => r.json());
  assert.equal(remaining.keys.length, 0);
  assert.equal((await store.keySets(alice.id)).openrouter.length, 0);
  assert.equal((await request('/api/admin/user', { cookie: adminCookie, body: { userId: alice.id, disabled: true } })).status, 200);
  assert.equal((await request('/api/state', { cookie: aliceCookie })).status, 401);
  assert.equal((await request('/api/account/logout', { cookie: bobCookie, body: {} })).status, 200);
  assert.equal((await request('/api/state', { cookie: bobCookie })).status, 401);
});

test('worker recycling preserves the last task and keys and respects occupied slots', { timeout: 60000 }, async (t) => {
  const { accountRuntimes } = await import('../src/web/account-runtimes.js');
  const { pool, store } = await database();
  const home = await mkdtemp(join(tmpdir(), 'soluna-worker-recycle-'));
  const runtimes = accountRuntimes({ home, store, maxWorkers: 1 });
  t.after(async () => { await runtimes.close(); await pool.end(); await rm(home, { recursive: true, force: true }); });
  const alice = await store.register('alice', 'test-password-123');
  const bob = await store.register('bob', 'test-password-123');
  const first = await runtimes.acquire(alice, { hold: true });
  await assert.rejects(runtimes.acquire(bob), (error) => error.status === 503);
  const call = (entry, path, body) => fetch(`http://127.0.0.1:${entry.port}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${entry.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (response) => { assert.equal(response.status, 200); return response.json(); });
  await call(first, '/api/keys', { provider: 'openrouter', keys: ['recycled-key-12345'] });
  const state = await call(first, '/api/state');
  // Ensure this empty task is persisted before the idle worker is recycled.
  await call(first, '/api/message', { text: '/save' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  runtimes.release(first);
  const second = await runtimes.acquire(bob);
  assert.notEqual(first.token, second.token);
  const resumed = await runtimes.acquire(alice);
  assert.notEqual(resumed.token, first.token);
  const restored = await call(resumed, '/api/state');
  assert.equal(restored.cwd, state.cwd);
  assert.equal((await call(resumed, '/api/keys?provider=openrouter')).keys.length, 1);
  assert.equal(process.env.SOLUNA_INTERNAL_TOKEN, undefined);
});
