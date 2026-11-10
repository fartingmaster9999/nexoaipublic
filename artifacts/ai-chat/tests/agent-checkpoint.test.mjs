import test from 'node:test';
import assert from 'node:assert/strict';
import { agentCheckpointKey, readAgentCheckpoint, writeAgentCheckpoint, deleteAgentCheckpoint, privateAgentHistory, extendAgentHistory } from '../src/lib/agent-checkpoint.ts';
import { waitForAgentWindow } from '../src/lib/agent-retry.ts';
import { AGENT_BUILD_DEADLINE_MS } from '../src/lib/request-deadlines.ts';

const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};
const exchange = {
  tool: 'write_project', callId: 'write-once', thoughtSignature: 'signature',
  arguments: { entrypoint: 'index.html', files: [{ path: 'index.html', content: '<h1>Saved</h1>' }, { path: 'private.js', content: 'private source' }] },
  result: 'Nexo execution status: completed.\nstdout: already ran',
};
const checkpoint = (overrides = {}) => ({
  version: 1, conversationId: 'chat-a', assistantId: 'reply', messages: [{ role: 'user', content: 'Build this' }],
  deepthink: true, imageRequired: false, provider: 'groq', model: 'qwen', task: 'coding',
  history: [exchange], toolCalls: 1, retries: 1, startedAt: Date.now(), waitUntil: 0, phase: 'ready', ...overrides,
});

test('roundtrip preserves completed tool results, route, prompt, and per-conversation isolation', () => {
  const store = storage(), saved = checkpoint();
  writeAgentCheckpoint(store, saved);
  assert.deepEqual(readAgentCheckpoint(store, 'chat-a'), { checkpoint: saved, error: '' });
  assert.equal(readAgentCheckpoint(store, 'chat-b').checkpoint, null);
  writeAgentCheckpoint(store, { ...saved, phase: 'cancelled' });
  assert.equal(readAgentCheckpoint(store, 'chat-a').checkpoint.phase, 'cancelled');
  deleteAgentCheckpoint(store, 'chat-a');
  assert.equal(readAgentCheckpoint(store, 'chat-a').checkpoint, null);
});

test('malformed, mismatched, expired and unsupported records fail closed without deleting data', () => {
  for (const raw of [
    '{bad', JSON.stringify(checkpoint({ version: 0 })), JSON.stringify(checkpoint({ version: 2 })),
    JSON.stringify(checkpoint({ conversationId: 'chat-b' })), JSON.stringify(checkpoint({ retries: 4 })),
    JSON.stringify(checkpoint({ history: [{ ...exchange, arguments: { files: 'oops' } }] })),
    JSON.stringify(checkpoint({ history: [exchange, exchange] })),
    JSON.stringify(checkpoint({ startedAt: Date.now() - AGENT_BUILD_DEADLINE_MS - 1 })),
  ]) {
    const store = storage();
    store.setItem(agentCheckpointKey('chat-a'), raw);
    const recovered = readAgentCheckpoint(store, 'chat-a');
    assert.equal(recovered.checkpoint, null);
    assert.ok(recovered.error);
    assert.equal(store.getItem(agentCheckpointKey('chat-a')), raw);
  }
});

test('source deselections redact historical source while keeping the tool contract valid', () => {
  const redacted = privateAgentHistory([exchange], { files: exchange.arguments.files, entrypoint: 'index.html', selectedPaths: ['index.html'] });
  assert.equal(redacted[0].arguments.files[1].content, '');
  assert.equal(exchange.arguments.files[1].content, 'private source');
  assert.equal(redacted[0].result, exchange.result);
  const store = storage();
  writeAgentCheckpoint(store, checkpoint({ history: redacted }));
  assert.ok(readAgentCheckpoint(store, 'chat-a').checkpoint);
  assert.equal(privateAgentHistory([exchange], null)[0].arguments.files[0].content, '');
});

test('completed results cannot be removed or replaced by a continuation', () => {
  assert.deepEqual(extendAgentHistory([exchange], [exchange]), [exchange]);
  assert.throws(() => extendAgentHistory([exchange], []), /unsafe continuation/);
  assert.throws(() => extendAgentHistory([exchange], [{ ...exchange, result: 'different' }]), /unsafe continuation/);
  assert.throws(() => extendAgentHistory([], [exchange, exchange]), /unsafe continuation/);
});

test('reloaded provider wait uses only its remaining window and is cancellable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  const controller = new AbortController();
  let done = false;
  const waiting = waitForAgentWindow(controller.signal, 101_000).then(() => { done = true; });
  t.mock.timers.tick(999);
  await Promise.resolve();
  assert.equal(done, false);
  t.mock.timers.tick(1);
  await waiting;
  assert.equal(done, true);
  await waitForAgentWindow(controller.signal, 99_000);
  const cancelled = waitForAgentWindow(controller.signal, 102_000);
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
});

test('unavailable or full storage fails explicitly before any work can proceed', () => {
  const store = { setItem() { throw new Error('QuotaExceeded'); }, getItem() { throw new Error('disabled'); } };
  assert.throws(() => writeAgentCheckpoint(store, checkpoint()), /build stopped/);
  assert.equal(readAgentCheckpoint(store, 'chat-a').checkpoint, null);
  assert.ok(readAgentCheckpoint(store, 'chat-a').error);
});
