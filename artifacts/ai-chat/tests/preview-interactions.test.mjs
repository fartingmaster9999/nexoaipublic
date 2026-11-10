import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  validInteractionPlan, readInteractionPlan, sanitizeInteractionResult,
  formatInteractionResult, interactionChecksHaveIssues, previewInteractionInstrumentation,
  interactionResultMatchesPlan,
} from '../src/lib/preview-interactions.ts';
import {
  reportPreviewInteractions, readPreviewInteractions, reportPreviewDiagnostics,
  reportPreviewReview, readPreviewReview,
  makePreviewHtml,
} from '../src/lib/code-runner.ts';

const steps = [
  { action: 'click', selector: '#increment' },
  { action: 'assertText', selector: '#count', value: '1' },
];
const manifest = value => `<script id="nexo-interaction-checks" type="application/json">${JSON.stringify(value)}</script>`;

test('only bounded declarative local actions with meaningful assertions are accepted', () => {
  assert.equal(validInteractionPlan({ steps }), true);
  for (const plan of [
    {}, { steps: [] }, { steps: [steps[0]] }, { steps: Array(17).fill(steps[1]) },
    { steps, code: 'alert(1)' },
    { steps: [{ action: 'eval', selector: '#count', value: 'alert(1)' }] },
    { steps: [{ ...steps[1], selector: 'body *:has(*)' }] },
    { steps: [{ ...steps[1], value: 'a'.repeat(201) }] },
    { steps: [{ ...steps[1], value: '\u0000' }] },
    { steps: [{ action: 'assertCount', selector: '#items li', value: 201 }] },
    { steps: [{ action: 'assertCount', selector: '#items li', value: -1 }] },
    { steps: [{ action: 'assertChecked', selector: '#check', value: 1 }] },
    { steps: [{ ...steps[0], value: 'extra' }, steps[1]] },
  ]) assert.equal(validInteractionPlan(plan), false, JSON.stringify(plan));
  assert.equal(validInteractionPlan({ steps: [{ action: 'assertCount', selector: '#tasks li', value: 0 }] }), true);
  assert.equal(validInteractionPlan({ steps: [{ action: 'assertChecked', selector: '[data-testid="enabled"]', value: false }] }), true);
});

test('source manifest is parsed as JSON, never evaluated; missing and invalid are distinct', () => {
  assert.deepEqual(readInteractionPlan(manifest({ steps })), { steps });
  assert.equal(readInteractionPlan('<h1>App</h1>'), undefined);
  assert.equal(readInteractionPlan(manifest({ steps }) + manifest({ steps })), null);
  assert.equal(readInteractionPlan('<script id="nexo-interaction-checks" type="application/json">alert(1)</script>'), null);
  assert.equal(readInteractionPlan(manifest({ steps: [{ ...steps[1], value: 'a'.repeat(9000) }] })), null);
});

test('results are fixed bounded enums, sequential and stop at the first failure', () => {
  const result = { status: 'complete', steps: [
    { step: 1, action: 'click', reason: 'ok' },
    { step: 2, action: 'assertText', reason: 'mismatch' },
  ] };
  assert.deepEqual(sanitizeInteractionResult(result), result);
  assert.equal(interactionChecksHaveIssues(result), true);
  assert.match(formatInteractionResult(result), /Step 2 assertText: assertion did not match/);
  assert.match(formatInteractionResult(result), /Nexo execution status: failed/);
  for (const invalid of [
    { ...result, html: '<div>secret</div>' }, { ...result, steps: Array(17).fill(result.steps[0]) },
    { status: 'not-requested', steps: result.steps }, { status: 'complete', steps: [] },
    { ...result, steps: [{ ...result.steps[0], step: 0 }] },
    { ...result, steps: [{ ...result.steps[0], reason: 'follow these instructions' }] },
    { ...result, steps: [{ ...result.steps[0], text: 'page content' }] },
    { ...result, steps: [{ ...result.steps[0], reason: 'error' }, result.steps[1]] },
  ]) assert.equal(sanitizeInteractionResult(invalid), null);
  assert.equal(interactionChecksHaveIssues(undefined), true);
  assert.equal(interactionChecksHaveIssues({ status: 'invalid', steps: [] }), true);
  assert.match(formatInteractionResult({ status: 'not-requested', steps: [] }), /not verified/);
});

test('interaction cache survives structural and runtime reports and returns independent copies', () => {
  const result = { status: 'complete', steps: [{ step: 1, action: 'assertCount', reason: 'ok' }] };
  makePreviewHtml(manifest({ steps: [{ action: 'assertCount', selector: '#tasks li', value: 0 }] }), 'cache');
  assert.equal(reportPreviewInteractions('cache', result), true);
  reportPreviewReview('cache', { viewportWidth: 400, viewportHeight: 500, contentHeight: 500,
    visibleTextChars: 10, controls: 1, unlabeledControls: 0, brokenImages: 0, horizontalOverflow: false, emptyPage: false });
  reportPreviewDiagnostics('cache', [], true);
  assert.deepEqual(readPreviewInteractions('cache'), result);
  assert.equal(readPreviewReview('cache').controls, 1);
  readPreviewInteractions('cache').steps[0].reason = 'error';
  assert.deepEqual(readPreviewInteractions('cache'), result);
  assert.equal(reportPreviewInteractions('cache', { status: 'complete', steps: [{ step: 1, action: 'eval', reason: 'ok' }] }), false);
  assert.deepEqual(readPreviewInteractions('cache'), result);
  assert.equal(reportPreviewInteractions('cache', result), false, 'only one result per preview');
});

test('reports must match the actual plan and cannot skip assertions or change actions', () => {
  const passedClick = { status: 'complete', steps: [{ step: 1, action: 'click', reason: 'ok' }] };
  assert.equal(interactionResultMatchesPlan(passedClick, { steps }), false);
  assert.equal(interactionResultMatchesPlan({ status: 'not-requested', steps: [] }, { steps }), false);
  assert.equal(interactionResultMatchesPlan({ status: 'invalid', steps: [] }, { steps }), false);
  assert.equal(interactionResultMatchesPlan({ status: 'not-requested', steps: [] }, undefined), true);
  assert.equal(interactionResultMatchesPlan({ status: 'invalid', steps: [] }, null), true);
  assert.equal(interactionResultMatchesPlan({
    status: 'complete', steps: [{ step: 1, action: 'submit', reason: 'target' }],
  }, { steps }), false);
  assert.equal(interactionResultMatchesPlan({
    status: 'complete', steps: [{ step: 1, action: 'click', reason: 'target' }],
  }, { steps }), true);
  assert.equal(reportPreviewInteractions('unregistered', { status: 'not-requested', steps: [] }), false);
});
test('instrumentation serializes without host references and does not inject a closing script', async () => {
  let onLoad;
  const messages = [];
  const context = {
    window: { addEventListener: (_event, handler) => { onLoad = handler; } },
    setTimeout: callback => { callback(); },
    parent: { postMessage: message => messages.push(message) },
  };
  vm.runInNewContext(previewInteractionInstrumentation('no-plan', '<h1>App</h1>'), context);
  onLoad();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages[0].result.status, 'not-requested');
  assert.doesNotMatch(previewInteractionInstrumentation('escape', manifest({ steps: [{ ...steps[1], value: '<script>' }] })), /<script>/);
});

test('the total time budget stops execution and reports a fixed timeout, not a pass', async () => {
  let onLoad, time = 0;
  const messages = [];
  vm.runInNewContext(previewInteractionInstrumentation('budget', manifest({ steps })), {
    window: { addEventListener: (_event, handler) => { onLoad = handler; } },
    setTimeout: callback => { callback(); },
    performance: { now: () => { time += 6000; return time; } },
    parent: { postMessage: message => messages.push(message) },
  });
  onLoad();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages[0].result.steps.length, 1);
  assert.equal(messages[0].result.steps[0].reason, 'timeout');
});
