import test from 'node:test';
import assert from 'node:assert/strict';
import { trackRecoveryEvent } from '../src/lib/recovery-analytics.ts';
import { agentCheckpointKey, readAgentCheckpoint, writeAgentCheckpoint, deleteAgentCheckpoint } from '../src/lib/agent-checkpoint.ts';
import { AGENT_BUILD_DEADLINE_MS } from '../src/lib/request-deadlines.ts';

const checkpoint = () => ({
  version: 1, conversationId: 'private-conversation', assistantId: 'private-reply',
  messages: [{ role: 'user', content: 'PRIVATE PROMPT' }],
  deepthink: false, imageRequired: true, provider: 'groq', model: 'private-model', task: 'coding',
  history: [], toolCalls: 0, retries: 0, startedAt: Date.now(), waitUntil: 0, phase: 'ready',
});
const storage = () => {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
};

test('tracker is optional and sync/async failures cannot escape', async () => {
  const original = globalThis.window;
  try {
    delete globalThis.window;
    trackRecoveryEvent('agent_recovery_resume', { phase: 'ready', image_required: false });
    for (const umami of [
      undefined,
      { track() { throw new Error('tracker unavailable'); } },
      { track() { return Promise.reject(new Error('network unavailable')); } },
    ]) {
      globalThis.window = { umami };
      const store = storage(), saved = checkpoint();
      assert.doesNotThrow(() => trackRecoveryEvent('agent_recovery_cancel', { location: 'stop', resumed: true }));
      assert.doesNotThrow(() => writeAgentCheckpoint(store, saved));
      assert.deepEqual(readAgentCheckpoint(store, saved.conversationId).checkpoint, saved);
      store.setItem(agentCheckpointKey(saved.conversationId), '{bad');
      assert.equal(readAgentCheckpoint(store, saved.conversationId).reason, 'invalid');
      assert.doesNotThrow(() => deleteAgentCheckpoint(store, saved.conversationId));
      assert.equal(store.getItem(agentCheckpointKey(saved.conversationId)), null);
      await new Promise(resolve => setImmediate(resolve));
    }
  } finally { globalThis.window = original; }
});

test('rejected checkpoints emit only fixed reasons and deduplicate repeated reads', () => {
  const original = globalThis.window, events = [];
  globalThis.window = { umami: { track: (name, data) => { events.push({ name, data }); } } };
  try {
    const store = storage(), saved = checkpoint(), key = agentCheckpointKey(saved.conversationId);
    for (const raw of ['{PRIVATE SOURCE', JSON.stringify({ ...saved, version: 999 })]) {
      store.setItem(key, raw);
      readAgentCheckpoint(store, saved.conversationId);
    }
    assert.equal(events.length, 1);
    writeAgentCheckpoint(store, saved);
    readAgentCheckpoint(store, saved.conversationId);
    writeAgentCheckpoint(store, { ...saved, startedAt: Date.now() - AGENT_BUILD_DEADLINE_MS - 100 });
    assert.equal(readAgentCheckpoint(store, saved.conversationId).reason, 'expired');
    readAgentCheckpoint(store, saved.conversationId);
    const inaccessible = { getItem() { throw new Error('PRIVATE ERROR'); } };
    assert.equal(readAgentCheckpoint(inaccessible, 'private-conversation').reason, 'storage_unavailable');
    readAgentCheckpoint(inaccessible, 'private-conversation');
    assert.deepEqual(events, ['invalid', 'expired', 'storage_unavailable'].map(reason => ({
      name: 'agent_checkpoint_rejected', data: { reason },
    })));
    assert.equal(store.getItem(key), JSON.stringify({ ...saved, startedAt: JSON.parse(store.getItem(key)).startedAt }));
    for (const event of events) {
      assert.ok(event.name.length < 50);
      assert.match(event.name, /^[a-z_]+$/);
      assert.doesNotMatch(JSON.stringify(event), /PRIVATE|private-|groq|coding/);
    }
  } finally { globalThis.window = original; }
});
