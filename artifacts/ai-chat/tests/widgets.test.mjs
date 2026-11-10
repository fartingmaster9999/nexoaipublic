import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWidget, parseWidget, sanitizeQuizProgress, parseQuizStates } from '../src/lib/interactive-widgets.ts';
import { fencedBlocks } from '../src/lib/fenced-blocks.ts';
import { extractSnippets } from '../src/lib/code-extract.ts';
import { parseConversation } from '../src/lib/conversation-storage.ts';
import { quiz, chart, math, donut, bar, scatter, fence } from './widget-data.mjs';

test('all chart types and biology quiz validate into bounded declarative data', () => {
  for (const widget of [quiz, chart, math, donut, bar, scatter]) assert.equal(parseWidget(JSON.stringify(widget)).status, 'valid');
  const parsed = validateWidget(math).widget;
  assert.equal(parsed.series[0].points.length, 61);
  assert.equal(parsed.series[0].points[30].y, 0);
  assert.equal(parsed.series[1].points[0].y, 9);
  assert.ok(Math.abs(parsed.series[0].points.at(-1).y - Math.sin(3)) < 1e-12);
});

test('version 2 mathematical expressions are parsed and calculated deterministically', () => {
  const expressionWidget = (expression, min, max, samples) => ({
    ...math, version: 2, id: 'expression', title: 'Expression plot',
    series: [{ id: 'curve', name: expression, formula: { expression, min, max, samples } }],
  });
  const sinc = validateWidget(expressionWidget('sin(x)/x', -2, 2, 5));
  assert.equal(sinc.status, 'valid');
  assert.deepEqual(sinc.widget.series[0].points.map((point) => point.y), [Math.sin(-2) / -2, Math.sin(-1) / -1, null, Math.sin(1), Math.sin(2) / 2]);
  assert.deepEqual(sinc.widget.series[0].calculation, { expression: 'sin(x)/x', min: -2, max: 2, samples: 5 });

  const logarithm = validateWidget(expressionWidget('log(x)', -2, 2, 5));
  assert.equal(logarithm.status, 'valid');
  assert.deepEqual(logarithm.widget.series[0].points.map((point) => point.y), [null, null, null, 0, Math.log(2)]);
  assert.equal(logarithm.widget.version, 2);

  const tangent = validateWidget(expressionWidget('tan(x)', 0, 3, 2));
  assert.equal(tangent.status, 'valid');
  assert.deepEqual(tangent.widget.series[0].points.map((point) => point.y), [0, null, Math.tan(3)]);
  const sampledTangent = validateWidget(expressionWidget('tan(x)', 0, 3, 81));
  assert.equal(sampledTangent.status, 'valid');
  assert.ok(sampledTangent.widget.series[0].points.some((point) => point.y === null));
  assert.equal(validateWidget({ ...expressionWidget('x^2', -2, 2, 5), version: 1 }).status, 'invalid');
});

test('implicit multiplication and piecewise rules evaluate safely with boundary gaps', () => {
  const expressionWidget = (expression, min = 1, max = 3, samples = 3) => ({
    ...math, version: 2, id: 'expression', title: 'Expression plot',
    series: [{ id: 'curve', name: expression, formula: { expression, min, max, samples } }],
  });
  for (const [expression, expected] of [
    ['2x', 4],
    ['2(x+1)', 6],
    ['(x+1)(x-1)', 3],
    ['2sin(x)', 2 * Math.sin(2)],
    ['3pi', 3 * Math.PI],
  ]) {
    const result = validateWidget(expressionWidget(expression));
    assert.equal(result.status, 'valid', expression);
    assert.ok(Math.abs(result.widget.series[0].points[1].y - expected) < 1e-12, expression);
  }

  const exactBoundary = validateWidget(expressionWidget('piecewise(x^2: x < 0; x: x >= 0)', -2, 2, 5));
  assert.equal(exactBoundary.status, 'valid');
  assert.deepEqual(exactBoundary.widget.series[0].points.map((point) => point.y), [4, 1, null, 1, 2]);
  const betweenSamples = validateWidget(expressionWidget('piecewise(x^2: x < 0; x: x >= 0)', -2, 2, 4));
  assert.equal(betweenSamples.status, 'valid');
  assert.ok(betweenSamples.widget.series[0].points.some((point) => point.y === null && Math.abs(point.x) < 1e-10));
  const unmatchedDomain = validateWidget(expressionWidget('piecewise(sqrt(x): x > 0)', -2, 2, 5));
  assert.equal(unmatchedDomain.status, 'valid');
  assert.deepEqual(unmatchedDomain.widget.series[0].points.map((point) => point.y), [null, null, null, Math.sqrt(1), Math.sqrt(2)]);
});

test('expression parser rejects malformed, excessive, and unsafe expressions', () => {
  const expressionWidget = (expression, min = -2, max = 2, samples = 5) => ({
    ...math, version: 2, id: 'expression',
    series: [{ id: 'curve', name: 'curve', formula: { expression, min, max, samples } }],
  });
  for (const expression of [
    'x +', 'sin(x', 'unknown(x)', 'x; alert(1)', 'globalThis.process', 'piecewise(x^2 x < 0)', 'sqrt(-1) +',
    '(' .repeat(25) + 'x' + ')'.repeat(25),
    Array.from({ length: 49 }, () => 'x').join('+'),
  ]) assert.equal(validateWidget(expressionWidget(expression)).status, 'invalid', expression);
  for (const formula of [
    { expression: 'x', min: 1, max: 1, samples: 5 },
    { expression: 'x', min: -1e7, max: 1e7, samples: 5 },
    { expression: 'x', min: -1, max: 1, samples: 401 },
  ]) {
    assert.equal(validateWidget({ ...math, version: 2, series: [{ id: 'curve', name: 'curve', formula }] }).status, 'invalid');
  }
});

test('malformed, oversized, unknown and invalid numerical output fail without throwing', () => {
  for (const value of ['{', '{}', 'null', JSON.stringify({ ...quiz, type: 'html' }), 'x'.repeat(60001), '"' + '✓'.repeat(21000) + '"']) assert.equal(parseWidget(value).status, 'invalid');
  for (const change of [
    { version: 3 }, { id: '__proto__' }, { questions: [] },
    { questions: [{ ...quiz.questions[0], answerId: 'missing' }] },
    { questions: [quiz.questions[0], quiz.questions[0]] },
  ]) assert.equal(validateWidget({ ...quiz, ...change }).status, 'invalid');
  for (const bad of [Infinity, NaN, 1e14, '123', undefined]) {
    assert.equal(validateWidget({ ...chart, series: [{ id: 'x', name: 'X', points: [{ x: 0, y: bad }] }] }).status, 'invalid');
  }
  assert.equal(validateWidget({ ...chart, series: [{ id: '__x', name: 'X', points: [{ x: 0, y: 1 }] }] }).status, 'invalid');
  assert.equal(validateWidget({ ...math, series: [{ ...math.series[0], formula: { fn: 'eval', min: 0, max: 2 } }] }).status, 'invalid');
  assert.equal(validateWidget({ ...math, series: [{ ...math.series[0], formula: { fn: 'exp', min: 0, max: 1000 } }] }).status, 'invalid');
  assert.equal(validateWidget({ ...math, series: [{ ...math.series[0], formula: { fn: 'sin', min: 0, max: 2, samples: 100000 } }] }).status, 'invalid');
});

test('provenance, dates, nonnegative composition and missing values are enforced', () => {
  assert.equal(validateWidget({ ...chart, provenance: { kind: 'verified', detail: 'Test' } }).status, 'invalid');
  assert.equal(validateWidget({ ...chart, provenance: { kind: 'verified', detail: 'Test', sources: [{ title: 'unsafe', url: 'javascript:alert(1)' }] } }).status, 'invalid');
  assert.equal(validateWidget({ ...donut, series: [{ ...donut.series[0], points: [{ x: 'A', y: -1 }, { x: 'B', y: 2 }] }] }).status, 'invalid');
  const temporal = (date) => ({ ...chart, x: { label: 'Date', type: 'time' }, series: [{ id: 'one', name: 'One', points: [{ x: date, y: 1 }] }] });
  assert.equal(validateWidget(temporal('2026-02-30')).status, 'invalid');
  assert.equal(validateWidget(temporal('2026-01-01T12:00:00')).status, 'invalid');
  assert.equal(validateWidget(temporal('2026-01-01T23:30:00-05:00')).status, 'valid');
  assert.equal(validateWidget(chart).widget.series[1].points[1].y, null);
  assert.equal(validateWidget({ ...scatter, series: [{ id: 'one', name: 'One', points: [{ x: 1, y: 2 }, { x: 1, y: 3 }] }] }).status, 'valid');
});

test('quiz progress is bounded, answer-compatible and attached to persisted message identities', () => {
  const progress = { index: 2, answers: { q1: 'a', q2: 'bad', constructor: 'a' }, submitted: ['q1', 'q2', 'unknown', 'q1'] };
  const safe = sanitizeQuizProgress(progress, quiz);
  assert.deepEqual(safe, { index: 1, answers: { q1: 'a' }, submitted: ['q1'] });
  const conversation = parseConversation({ id: 'one', title: 'Biology', createdAt: 1, updatedAt: 2,
    messages: [{ id: 'message-one', role: 'assistant', content: fence(quiz), quizProgress: { '0:biology': safe } }] });
  assert.equal(conversation.messages[0].id, 'message-one');
  assert.deepEqual(conversation.messages[0].quizProgress['0:biology'], safe);
  assert.deepEqual(parseQuizStates({ __proto__: { polluted: true }, nonsense: safe }), {});
});

test('widget fences never become runnable code, including code-like strings and partial JSON', () => {
  const withCodeString = { ...quiz, fallback: 'Example ```python\\nprint(7)\\n``` is text, not executable.' };
  assert.deepEqual(extractSnippets(fence(withCodeString)), []);
  assert.deepEqual(extractSnippets('```nexo-widget\n{"type":"quiz","text":"```python\nprint(7)'), []);
  const text = fence(quiz) + '\n\n```python\nprint(7)\n```\n\n~~~javascript\nconsole.log(1)\n~~~';
  assert.equal(fencedBlocks(text).length, 3);
  assert.deepEqual(extractSnippets(text).map((s) => s.language), ['python', 'javascript']);
  assert.equal(fencedBlocks('```nexo-widget\n{"version":1')[0].complete, false);
});

test('math-like text inside executable fences is preserved literally', () => {
  const source = '```python\nprint(r"$x^2$ and \\(literal\\)")\n```';
  assert.equal(fencedBlocks(source)[0].code, 'print(r"$x^2$ and \\(literal\\)")\n');
  assert.equal(extractSnippets(source)[0].code, 'print(r"$x^2$ and \\(literal\\)")');
});
