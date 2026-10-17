import test from 'node:test';
import assert from 'node:assert/strict';
import { Jobs } from '../src/web/jobs.js';

test('idle is emitted only after all queued work clears the running state', async () => {
  const jobs = new Jobs();
  const states = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  jobs.on('idle', () => states.push([jobs.running, jobs.queuedCount]));
  jobs.push({ id: 'first', run: () => gate });
  jobs.push({ id: 'second', run: async () => {} });
  assert.deepEqual(states, []);
  release();
  await jobs.waitIdle();
  assert.deepEqual(states, [[null, 0]]);
});

test('failed work also emits idle and permits the next turn', async () => {
  const jobs = new Jobs();
  const errors = [];
  let idle = 0;
  jobs.on('failed', ({ error }) => errors.push(error));
  jobs.on('idle', () => { assert.equal(jobs.running, null); idle++; });
  jobs.push({ id: 'failure', run: async () => { throw new Error('provider unavailable'); } });
  await jobs.waitIdle();
  assert.deepEqual(errors, ['provider unavailable']);
  assert.equal(idle, 1);
});
