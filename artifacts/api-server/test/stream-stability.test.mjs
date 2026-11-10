import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ChatEventDecoder, consumeChatStream } from "../../ai-chat/src/lib/chat-stream.ts";
import { loadConversations, LEGACY_KEY, RECORD_PREFIX, parseConversation } from "../../ai-chat/src/lib/conversation-storage.ts";
import { boundedHistory, estimateTokens, buildChatRequest } from "../src/lib/chat-request.ts";
import { writeChatEvent } from "../src/lib/chat-runtime.ts";
import { prepareRequestMessages } from "../../ai-chat/src/lib/request-context.ts";

const encode = value => new TextEncoder().encode(value);
test("browser request packaging sends bounded complete turns without reasoning or UI metadata", () => {
  const history = Array.from({length:20}, (_, i) => ({role:i%2 ? 'assistant' : 'user', content:'x'.repeat(12000), reasoning:'private trace'}));
  history.push({role:'user',content:'newest',deepthink:true});
  const packaged = prepareRequestMessages(history);
  assert.deepEqual(packaged,[{role:'user',content:'newest'}]);
  assert.ok(JSON.stringify(packaged).length < 100);
  assert.throws(() => prepareRequestMessages([{role:'user',content:'x'.repeat(12001)}]), /too long/);
});
test("SSE handles every byte boundary, Unicode, CRLF, heartbeat and done", () => {
  const decoder = new ChatEventDecoder();
  const payload = ': keepalive\r\n\r\ndata: {"content":"Hi 🌎 世界"}\r\n\r\ndata: {"reasoning":"trace"}\n\ndata: [DONE]\n\n';
  const result = [];
  for (const byte of encode(payload)) result.push(...decoder.push(new Uint8Array([byte])));
  result.push(...decoder.push());
  assert.deepEqual(result, [{content:"Hi 🌎 世界"},{reasoning:"trace"},{done:true}]);
});
test("SSE fails explicitly on malformed JSON, incorrect types, and oversized frames", () => {
  for (const payload of ['data: nope\n\n', 'data: {"content":12}\n\n', 'data: {"done":"true"}\n\n', `data: ${'x'.repeat(1000001)}`]) {
    assert.throws(() => new ChatEventDecoder().push(encode(payload)));
  }
});
test("stream releases its reader and cancels upstream after the terminal event", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(encode('data: {"content":"hello"}\n\ndata: {"done":true}\n\n')); },
    cancel() { cancelled = true; },
  });
  const events = [];
  await consumeChatStream(stream, new AbortController(), event => events.push(event));
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
  assert.equal(events[0].content, 'hello');
});
test("EOF without done is explicit and does not discard delivered partial text", async () => {
  const events = [];
  const stream = new ReadableStream({ start(c) { c.enqueue(encode('data: {"content":"partial"}\n\n')); c.close(); } });
  await assert.rejects(consumeChatStream(stream, new AbortController(), e => events.push(e)), /before the response finished/);
  assert.equal(events[0].content, 'partial');
  assert.equal(stream.locked, false);
});
test("idle timeout aborts a hanging read and releases resources", async () => {
  const controller = new AbortController();
  const stream = new ReadableStream({});
  await assert.rejects(consumeChatStream(stream, controller, () => {}, 10), /stalled/);
  assert.equal(controller.signal.aborted, true);
  assert.equal(stream.locked, false);
});
test("explicit cancellation is distinct from connection failure", async () => {
  const controller = new AbortController();
  const stream = new ReadableStream({});
  const result = consumeChatStream(stream, controller, () => {}, 1000);
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(stream.locked, false);
});
test("server backpressure waits for drain and removes listeners", async () => {
  const response = new EventEmitter();
  response.write = () => false;
  const controller = new AbortController();
  let completed = false;
  const pending = writeChatEvent(response, {content:"data"}, controller.signal).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  response.emit('drain');
  await pending;
  assert.equal(response.listenerCount('drain'), 0);
  assert.equal(response.listenerCount('close'), 0);
});
test("server backpressure abort removes listeners without leaking promises", async () => {
  const response = new EventEmitter();
  response.write = () => false;
  const controller = new AbortController();
  const pending = writeChatEvent(response, {}, controller.signal);
  controller.abort();
  await assert.rejects(pending);
  assert.equal(response.listenerCount('drain'), 0);
  assert.equal(response.listenerCount('close'), 0);
});
test("history pruning preserves intact recent user/assistant turns and newest prompt", () => {
  const history = [
    {role:'user',content:'old'.repeat(2000)}, {role:'assistant',content:'old answer'.repeat(2000)},
    {role:'user',content:'recent question'}, {role:'assistant',content:'recent answer'},
    {role:'user',content:'current question'},
  ];
  assert.deepEqual(boundedHistory(history, 2000), history.slice(-3));
  const newest = [{role:'user',content:'界'.repeat(12000)}];
  assert.deepEqual(boundedHistory(newest, 1000), newest);
  assert.ok(estimateTokens('界'.repeat(20)) > estimateTokens('a'.repeat(20)));
  const request = buildChatRequest({messages:history});
  assert.match(request.messages[0].content, /Earlier conversation turns were omitted/);
});
function memoryStorage(values) {
  const map = new Map(Object.entries(values));
  return { get length() { return map.size; }, key: i => [...map.keys()][i], getItem: k => map.get(k) ?? null };
}
const conversation = (id, content = 'hello') => ({id,title:id,createdAt:1,updatedAt:2,messages:[{role:'user',content}]});
test("legacy history is retained, new records override only their chat, tombstones prevent resurrection", () => {
  const storage = memoryStorage({
    [LEGACY_KEY]: JSON.stringify([conversation('a'),conversation('b'),conversation('c')]),
    [RECORD_PREFIX+'b']: JSON.stringify({conversation:conversation('b','updated'),updatedAt:3}),
    [RECORD_PREFIX+'c']: JSON.stringify({conversation:null,updatedAt:4}),
  });
  const result = loadConversations(storage);
  assert.deepEqual(result.map(c => c.id), ['a','b']);
  assert.equal(result[1].messages[0].content, 'updated');
  assert.equal(JSON.parse(storage.getItem(LEGACY_KEY)).length, 3);
});
test("one corrupt record cannot hide unrelated valid history", () => {
  let invalid = 0;
  const result = loadConversations(memoryStorage({
    [LEGACY_KEY]:'broken',
    [RECORD_PREFIX+'bad']:'broken',
    [RECORD_PREFIX+'valid']:JSON.stringify({conversation:conversation('valid'),updatedAt:2}),
  }), () => invalid++);
  assert.equal(invalid, 2);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'valid');
});
test("malformed stored messages are rejected and optional metadata is sanitized", () => {
  assert.equal(parseConversation({...conversation('x'),messages:[{role:'user',content:12}]}),null);
  const result = parseConversation({...conversation('x'),messages:[{role:'assistant',content:'safe',activity:{},reasoning:3}]});
  assert.equal(result.messages[0].reasoning,undefined);
  assert.deepEqual(result.messages[0].activity,[]);
});
