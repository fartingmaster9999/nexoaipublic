import { fencedBlocks } from './fenced-blocks.ts';

type MathOpening = { start: number; isDisplay: boolean; escapedTwice: boolean };

const INLINE_OPEN = '\\(';
const INLINE_CLOSE = '\\)';
const DISPLAY_OPEN = '\\[';
const DISPLAY_CLOSE = '\\]';
const DOUBLE_INLINE_OPEN = '\\\\(';
const DOUBLE_INLINE_CLOSE = '\\\\)';
const DOUBLE_DISPLAY_OPEN = '\\\\[';
const DOUBLE_DISPLAY_CLOSE = '\\\\]';
const RAW_TEX_COMMAND = /\\(?:frac|dfrac|tfrac|sqrt|sum|prod|int|oint|lim|alpha|beta|gamma|delta|theta|pi|sigma|mu|infty|cdot|times|leq|geq|neq|approx|equiv|partial|nabla|text|left|right|begin|end|overline|underline|hat|bar|vec|boxed|mathbb|mathcal|mathrm|operatorname|sin|cos|tan|log|ln|exp|pm|mp|rightarrow|to|implies|therefore|quad|qquad|cases|matrix|det|Pr|mathbf|dots)\b/;
const DOUBLE_TEX_COMMAND = /\\\\(?=(?:frac|dfrac|tfrac|sqrt|sum|prod|int|oint|lim|alpha|beta|gamma|delta|theta|pi|sigma|mu|infty|cdot|times|leq|geq|neq|approx|equiv|partial|nabla|text|left|right|begin|end|overline|underline|hat|bar|vec|boxed|mathbb|mathcal|mathrm|operatorname|sin|cos|tan|log|ln|exp|pm|mp|rightarrow|to|implies|therefore|quad|qquad|cases|matrix|det|Pr|mathbf|dots)\b)/g;

function isEscapedAt(source: string, index: number) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor--) slashes++;
  return slashes % 2 === 1;
}

function findUnescaped(source: string, token: string, from: number) {
  let index = source.indexOf(token, from);
  while (index >= 0 && isEscapedAt(source, index)) index = source.indexOf(token, index + token.length);
  return index;
}

function findCodeSpanEnd(source: string, start: number, ticks: number) {
  const marker = '`'.repeat(ticks);
  let end = source.indexOf(marker, start + ticks);
  while (end >= 0) {
    const isLongerRun = source[end - 1] === '`' || source[end + ticks] === '`';
    if (!isLongerRun) return end + ticks;
    end = source.indexOf(marker, end + ticks);
  }
  return -1;
}

function findMathOpening(source: string, from: number): MathOpening | null {
  for (let cursor = from; cursor < source.length;) {
    if (source[cursor] === '`') {
      let ticks = 1;
      while (source[cursor + ticks] === '`') ticks++;
      const codeEnd = findCodeSpanEnd(source, cursor, ticks);
      if (codeEnd >= 0) {
        cursor = codeEnd;
        continue;
      }
    }
    if (!isEscapedAt(source, cursor)) {
      if (source.startsWith(DOUBLE_INLINE_OPEN, cursor)) return { start: cursor, isDisplay: false, escapedTwice: true };
      if (source.startsWith(DOUBLE_DISPLAY_OPEN, cursor)) return { start: cursor, isDisplay: true, escapedTwice: true };
    }
    if (!isEscapedAt(source, cursor)) {
      if (source.startsWith(INLINE_OPEN, cursor)) return { start: cursor, isDisplay: false, escapedTwice: false };
      if (source.startsWith(DISPLAY_OPEN, cursor)) return { start: cursor, isDisplay: true, escapedTwice: false };
    }
    cursor++;
  }
  return null;
}

function isBareMathLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed || line.startsWith('    ') || line.startsWith('\t') || /[`$]/.test(trimmed)
    || trimmed.includes(INLINE_OPEN) || trimmed.includes(DISPLAY_OPEN)
    || trimmed.includes(DOUBLE_INLINE_OPEN) || trimmed.includes(DOUBLE_DISPLAY_OPEN)) return false;

  const hasTexCommand = RAW_TEX_COMMAND.test(trimmed);
  const hasEquationSyntax = /[=<>^_∑∫√±×÷≤≥≠≈]/.test(trimmed);
  if (!hasTexCommand && !hasEquationSyntax) return false;

  if (hasTexCommand) {
    const prose = trimmed.replace(/\\[A-Za-z]+/g, ' ').replace(/[{}[\]\\]/g, ' ');
    const words = prose.match(/[A-Za-z]{3,}/g) ?? [];
    return words.length <= 2;
  }

  const words = trimmed.match(/[A-Za-z]{3,}/g) ?? [];
  return words.length === 0 && /[A-Za-z0-9]/.test(trimmed);
}

function normalizeBareMathLines(source: string) {
  let insideDisplayMath = false;
  const parts = source.split(/(\r?\n)/);
  let output = '';
  for (let index = 0; index < parts.length;) {
    const line = parts[index];
    if (line === '\n' || line === '\r\n') {
      output += line;
      index++;
      continue;
    }
    if (insideDisplayMath || line.includes('$$')) {
      const delimiters = line.match(/\$\$/g)?.length ?? 0;
      if (delimiters % 2 === 1) insideDisplayMath = !insideDisplayMath;
      output += line;
      if (parts[index + 1]) output += parts[index + 1];
      index += 2;
      continue;
    }
    const environment = line.match(/^ {0,3}\\begin\{([A-Za-z]+\*?)\}\s*$/)?.[1];
    if (environment && !line.includes('`')) {
      const close = `\\end{${environment}}`;
      let end = index + 2;
      while (end < parts.length) {
        const candidate = parts[end];
        if (candidate === '\n' || candidate === '\r\n') {
          end++;
          continue;
        }
        if (candidate.trim() === close) break;
        if (candidate.includes('```') || candidate.includes('~~~')) break;
        end += 2;
      }
      if (end < parts.length) {
        const formula = parts.slice(index, end + 1).join('').trim();
        output += `\n\n$$\n${formula}\n$$\n\n`;
        index = end + 1;
        continue;
      }
    }
    if (!isBareMathLine(line)) {
      output += line;
      if (parts[index + 1]) output += parts[index + 1];
      index += 2;
      continue;
    }
    const expression = line.trim().replace(DOUBLE_TEX_COMMAND, '\\');
    output += `\n\n$$\n${expression}\n$$\n\n`;
    if (parts[index + 1]) output += parts[index + 1];
    index += 2;
  }
  return output;
}

/** Convert common TeX delimiters without touching fenced or inline code source. */
function normalizeMathSegment(source: string) {
  let output = '';
  let cursor = 0;
  while (cursor < source.length) {
    if (source[cursor] === '`') {
      let ticks = 1;
      while (source[cursor + ticks] === '`') ticks++;
      const end = findCodeSpanEnd(source, cursor, ticks);
      if (end >= 0) {
        output += source.slice(cursor, end);
        cursor = end;
        continue;
      }
    }

    const opening = findMathOpening(source, cursor);
    if (!opening) {
      output += source.slice(cursor);
      break;
    }

    const { start, isDisplay, escapedTwice } = opening;
    const open = isDisplay
      ? escapedTwice ? DOUBLE_DISPLAY_OPEN : DISPLAY_OPEN
      : escapedTwice ? DOUBLE_INLINE_OPEN : INLINE_OPEN;
    const close = isDisplay
      ? escapedTwice ? DOUBLE_DISPLAY_CLOSE : DISPLAY_CLOSE
      : escapedTwice ? DOUBLE_INLINE_CLOSE : INLINE_CLOSE;
    const end = findUnescaped(source, close, start + open.length);
    const expression = end >= 0
      ? source.slice(start + open.length, end).replace(DOUBLE_TEX_COMMAND, '\\').trim()
      : '';
    if (end < 0 || !expression) {
      output += source.slice(cursor, start + open.length);
      cursor = start + open.length;
      continue;
    }

    output += source.slice(cursor, start);
    output += isDisplay ? `\n\n$$\n${expression}\n$$\n\n` : `$${expression}$`;
    cursor = end + close.length;
  }
  return normalizeBareMathLines(output);
}

/**
 * Normalize TeX emitted with common single- or double-escaped delimiters.
 * Fenced code and inline code spans are kept byte-for-byte.
 */
export function normalizeMathDelimiters(source: string) {
  const codeBlocks = fencedBlocks(source);
  if (codeBlocks.length === 0) return normalizeMathSegment(source);

  let result = '';
  let cursor = 0;
  for (const block of codeBlocks) {
    result += normalizeMathSegment(source.slice(cursor, block.start));
    result += source.slice(block.start, block.end);
    cursor = block.end;
  }
  return result + normalizeMathSegment(source.slice(cursor));
}
