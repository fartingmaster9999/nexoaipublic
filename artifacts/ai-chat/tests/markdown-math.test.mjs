import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMathDelimiters } from '../src/lib/markdown-math.ts';

test('renders single- and double-escaped inline and display math delimiters', () => {
  assert.equal(normalizeMathDelimiters(String.raw`Inline \(x^2\).`), 'Inline $x^2$.');
  assert.equal(normalizeMathDelimiters(String.raw`Inline \\(x^2\\).`), 'Inline $x^2$.');
  assert.equal(normalizeMathDelimiters(String.raw`\\[x^2 + 1\\]`), '\n\n$$\nx^2 + 1\n$$\n\n');
});

test('wraps standalone formulas that use double-escaped TeX commands', () => {
  assert.equal(normalizeMathDelimiters(String.raw`\\frac{1}{2}`), '\n\n$$\n\\frac{1}{2}\n$$\n\n');
  assert.equal(normalizeMathDelimiters(String.raw`x^2 + 1 = 0`), '\n\n$$\nx^2 + 1 = 0\n$$\n\n');
  const aligned = String.raw`\begin{aligned}
x &= 2 \\
y &= 3
\end{aligned}`;
  assert.equal(normalizeMathDelimiters(aligned), `\n\n$$\n${aligned}\n$$\n\n`);
  assert.equal(normalizeMathDelimiters('$$\nx^2 + 1\n$$'), '$$\nx^2 + 1\n$$');
});

test('does not rewrite code spans, fenced code, or ordinary prose', () => {
  const source = [
    String.raw`Keep \`\\(x^2\\)\` exactly.`,
    '',
    '```python',
    String.raw`print(r"\\frac{1}{2} and \\(x\\)")`,
    '```',
    '',
    String.raw`A path contains \\frac but is ordinary prose.`,
  ].join('\n');
  assert.equal(normalizeMathDelimiters(source), source);
});

test('leaves incomplete delimiters untouched until their closing token arrives', () => {
  assert.equal(normalizeMathDelimiters(String.raw`Answer: \\(x^2`), String.raw`Answer: \\(x^2`);
  assert.equal(normalizeMathDelimiters(String.raw`Answer: \\(x^2\\)`), 'Answer: $x^2$');
});
