import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startRequestDeadline, RESPONSE_DEADLINE_MS, AGENT_BUILD_DEADLINE_MS, AGENT_REVIEW_DEADLINE_MS,
} from '../src/lib/request-deadlines.ts';

test('Agent continuations get independent response budgets, not one three-minute build budget', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const build = new AbortController();
  const clearBuild = startRequestDeadline(build, AGENT_BUILD_DEADLINE_MS, 'build');
  let clearResponse = startRequestDeadline(build, RESPONSE_DEADLINE_MS, 'response');
  t.mock.timers.tick(120_000);
  clearResponse();
  clearResponse = startRequestDeadline(build, RESPONSE_DEADLINE_MS, 'response');
  t.mock.timers.tick(120_000);
  assert.equal(build.signal.aborted, false, 'continuation survives past three minutes of total build time');
  clearResponse();
  clearBuild();
  t.mock.timers.tick(AGENT_BUILD_DEADLINE_MS);
  assert.equal(build.signal.aborted, false, 'completed timers are cleaned up');
});

test('review deadline aborts only the optional reviewer, leaving Qwen able to continue', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const build = new AbortController();
  const review = new AbortController();
  const clearBuild = startRequestDeadline(build, AGENT_BUILD_DEADLINE_MS, 'build');
  const clearReview = startRequestDeadline(review, AGENT_REVIEW_DEADLINE_MS, 'review');
  t.mock.timers.tick(AGENT_REVIEW_DEADLINE_MS);
  assert.equal(review.signal.reason.message, 'review');
  assert.equal(build.signal.aborted, false);
  clearReview();
  clearBuild();
});

test('unresponsive calls and overall builds still have hard limits', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const response = new AbortController();
  const build = new AbortController();
  startRequestDeadline(response, RESPONSE_DEADLINE_MS, 'response');
  startRequestDeadline(build, AGENT_BUILD_DEADLINE_MS, 'build');
  t.mock.timers.tick(RESPONSE_DEADLINE_MS);
  assert.equal(response.signal.reason.message, 'response');
  assert.equal(build.signal.aborted, false);
  t.mock.timers.tick(AGENT_BUILD_DEADLINE_MS - RESPONSE_DEADLINE_MS);
  assert.equal(build.signal.reason.message, 'build');
});

test('stopping preserves the cancellation reason and clears pending deadlines', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const cleanup = startRequestDeadline(controller, RESPONSE_DEADLINE_MS, 'timeout');
  const reason = new DOMException('Stopped by you', 'AbortError');
  controller.abort(reason);
  cleanup();
  cleanup();
  t.mock.timers.tick(AGENT_BUILD_DEADLINE_MS);
  assert.equal(controller.signal.reason, reason);
});
