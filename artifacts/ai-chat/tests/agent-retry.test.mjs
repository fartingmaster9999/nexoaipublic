import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForAgentRetry, MAX_AGENT_DEFERRED_RETRIES } from '../src/lib/agent-retry.ts';

test('browser waits the explicit input-token window before resuming', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  let resumed = false;
  const waiting = waitForAgentRetry(controller.signal, 31250).then(() => { resumed = true; });
  t.mock.timers.tick(31000);
  await Promise.resolve();
  assert.equal(resumed, false);
  t.mock.timers.tick(250);
  await waiting;
  assert.equal(resumed, true);
  assert.equal(MAX_AGENT_DEFERRED_RETRIES, 3);
});

test('Stop cancels the browser wait and never reaches the continuation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const reason = new DOMException('Stopped by you', 'AbortError');
  const waiting = waitForAgentRetry(controller.signal, 31250);
  controller.abort(reason);
  await assert.rejects(waiting, (error) => error === reason);
  t.mock.timers.tick(600000);
});

test('unbounded or invalid provider waits are rejected', async () => {
  for (const delay of [0, -1, 0.5, 60251, Infinity, NaN]) {
    await assert.rejects(waitForAgentRetry(new AbortController().signal, delay), /invalid retry delay/);
  }
});
