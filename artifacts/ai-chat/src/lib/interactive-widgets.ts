/** Declarative data only. Model-authored JavaScript/HTML/options are never evaluated. */
export type QuizProgress = { index: number; answers: Record<string, string>; submitted: string[] };
export type QuizQuestion = { id: string; prompt: string; options: { id: string; text: string }[]; answerId: string; explanation: string };
type WidgetBase = { version: 1 | 2; id: string; title: string; fallback: string; description?: string };
export type QuizWidget = WidgetBase & { type: 'quiz'; questions: QuizQuestion[] };
export type ChartPoint = { x: string | number; y: number | null };
export type Calculation = { expression: string; min: number; max: number; samples: number };
export type ChartWidget = WidgetBase & {
  type: 'chart'; chartType: 'line' | 'bar' | 'scatter' | 'donut';
  x: { label: string; unit: string; type: 'category' | 'number' | 'time' };
  y: { label: string; unit: string };
  provenance: { kind: 'provided' | 'verified' | 'calculated' | 'illustrative'; detail: string; sources: { title: string; url: string }[] };
  series: { id: string; name: string; points: ChartPoint[]; calculation?: Calculation }[];
};
export type InteractiveWidget = QuizWidget | ChartWidget;
export const WIDGET_LANGUAGE = 'nexo-widget';
export const MAX_WIDGET_BYTES = 60000;
export const emptyQuizProgress = (): QuizProgress => ({ index: 0, answers: {}, submitted: [] });

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid text');
  return value.trim();
}
function id(value: unknown): string {
  const result = text(value, 64);
  if (!/^[a-zA-Z0-9_-]+$/.test(result) || ['__proto__', 'constructor', 'prototype', '__x'].includes(result)) throw new Error('Invalid id');
  return result;
}
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12) throw new Error('Invalid number');
  return value;
}
function list(value: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error('Invalid list');
  return value;
}
function unique(values: string[]) {
  if (new Set(values).size !== values.length) throw new Error('Duplicate id');
}
function object(value: unknown) {
  if (!record(value)) throw new Error('Invalid object');
  return value;
}
function unit(value: unknown) { return value === undefined || value === '' ? '' : text(value, 40); }
function source(value: unknown) {
  const row = object(value), url = new URL(text(row.url, 1000));
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsafe source');
  return { title: text(row.title, 120), url: url.href };
}
const MAX_EXPRESSION_LENGTH = 240;
const MAX_EXPRESSION_TOKENS = 128;
const MAX_EXPRESSION_NODES = 96;
const MAX_EXPRESSION_DEPTH = 24;
const MAX_EXPRESSION_SAMPLES = 400;
const MAX_PIECEWISE_BOUNDARY_PROBES = 48;
const MAX_X_BOUND = 1e6;
const MAX_Y_BOUND = 1e12;

type MathNode =
  | { kind: 'number'; value: number }
  | { kind: 'x' | 'constant'; name: 'x' | 'pi' | 'e' }
  | { kind: 'unary'; op: '+' | '-'; value: MathNode }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/' | '^'; left: MathNode; right: MathNode }
  | { kind: 'call'; name: string; value: MathNode }
  | { kind: 'comparison'; op: '<' | '<=' | '>' | '>=' | '==' | '!='; left: MathNode; right: MathNode }
  | { kind: 'piecewise'; branches: { expression: MathNode; condition: MathNode }[] };

const MATH_FUNCTIONS: Record<string, (value: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, log: Math.log, ln: Math.log, log10: Math.log10,
};

function parseMathExpression(expression: string): MathNode {
  if (expression.length > MAX_EXPRESSION_LENGTH) throw new Error('Expression is too long');
  const tokens: string[] = [];
  for (let i = 0; i < expression.length;) {
    if (/\s/.test(expression[i])) { i++; continue; }
    const rest = expression.slice(i);
    const number = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest)?.[0];
    const name = /^[A-Za-z]+/.exec(rest)?.[0];
    const token = number ?? name ?? /^(?:<=|>=|==|!=)/.exec(rest)?.[0] ?? (/[+\-*/^():;<>]/.test(expression[i]) ? expression[i] : '');
    if (!token) throw new Error('Unsupported expression token');
    tokens.push(token);
    if (tokens.length > MAX_EXPRESSION_TOKENS) throw new Error('Expression has too many tokens');
    i += token.length;
  }
  if (!tokens.length) throw new Error('Empty expression');
  let cursor = 0, nodes = 0;
  const peek = () => tokens[cursor];
  const take = () => tokens[cursor++];
  const node = <T extends MathNode>(result: T): T => {
    if (++nodes > MAX_EXPRESSION_NODES) throw new Error('Expression has too many operations');
    return result;
  };
  const startsImplicitFactor = (token: string | undefined) =>
    token === '(' || /^(?:\d|\.)/.test(token ?? '') ||
    token === 'x' || token === 'pi' || token === 'e' ||
    Object.hasOwn(MATH_FUNCTIONS, token ?? '') || token === 'piecewise';
  const depthCheck = (depth: number) => { if (depth > MAX_EXPRESSION_DEPTH) throw new Error('Expression is too deep'); };
  const additive = (depth: number): MathNode => {
    depthCheck(depth);
    let result = multiplicative(depth);
    while (peek() === '+' || peek() === '-') {
      const op = take() as '+' | '-';
      result = node({ kind: 'binary', op, left: result, right: multiplicative(depth) });
    }
    return result;
  };
  const multiplicative = (depth: number): MathNode => {
    depthCheck(depth);
    let result = unary(depth);
    while (peek() === '*' || peek() === '/' || startsImplicitFactor(peek())) {
      const op = peek() === '*' || peek() === '/' ? take() as '*' | '/' : '*';
      result = node({ kind: 'binary', op, left: result, right: unary(depth) });
    }
    return result;
  };
  const unary = (depth: number): MathNode => {
    depthCheck(depth);
    if (peek() === '+' || peek() === '-') return node({ kind: 'unary', op: take() as '+' | '-', value: unary(depth + 1) });
    return power(depth);
  };
  const power = (depth: number): MathNode => {
    depthCheck(depth);
    const left = primary(depth);
    return peek() === '^' ? node({ kind: 'binary', op: take() as '^', left, right: unary(depth + 1) }) : left;
  };
  const primary = (depth: number): MathNode => {
    depthCheck(depth);
    const token = take();
    if (token === '(') {
      const result = additive(depth + 1);
      if (take() !== ')') throw new Error('Unclosed expression group');
      return result;
    }
    if (/^(?:\d|\.)/.test(token)) {
      const value = Number(token);
      if (!Number.isFinite(value)) throw new Error('Invalid number literal');
      return node({ kind: 'number', value });
    }
    if (token === 'x') return node({ kind: 'x', name: 'x' });
    if (token === 'pi' || token === 'e') return node({ kind: 'constant', name: token });
    if (token === 'piecewise') {
      if (take() !== '(') throw new Error('Piecewise rules require parentheses');
      const branches: { expression: MathNode; condition: MathNode }[] = [];
      while (true) {
        const value = additive(depth + 1);
        if (take() !== ':') throw new Error('Piecewise rules require a condition');
        const left = additive(depth + 1);
        const op = take();
        if (!['<', '<=', '>', '>=', '==', '!='].includes(op)) throw new Error('Invalid piecewise comparison');
        const right = additive(depth + 1);
        branches.push({ expression: value, condition: node({ kind: 'comparison', op: op as '<' | '<=' | '>' | '>=' | '==' | '!=', left, right }) });
        if (branches.length > MAX_EXPRESSION_TOKENS) throw new Error('Too many piecewise rules');
        if (peek() !== ';') break;
        take();
      }
      if (take() !== ')') throw new Error('Unclosed piecewise rules');
      return node({ kind: 'piecewise', branches });
    }
    if (Object.hasOwn(MATH_FUNCTIONS, token)) {
      if (take() !== '(') throw new Error('Functions require parentheses');
      const value = additive(depth + 1);
      if (take() !== ')') throw new Error('Unclosed function argument');
      return node({ kind: 'call', name: token, value });
    }
    throw new Error('Unknown math symbol');
  };
  const result = additive(0);
  if (cursor !== tokens.length) throw new Error('Unexpected expression token');
  return result;
}

type MathEvaluation = { value: number; branches: number[] };
function evaluateMathDetailed(node: MathNode, x: number): MathEvaluation {
  switch (node.kind) {
    case 'number': return { value: node.value, branches: [] };
    case 'x': return { value: x, branches: [] };
    case 'constant': return { value: node.name === 'pi' ? Math.PI : Math.E, branches: [] };
    case 'unary': {
      const result = evaluateMathDetailed(node.value, x);
      return { value: node.op === '-' ? -result.value : result.value, branches: result.branches };
    }
    case 'binary': {
      const left = evaluateMathDetailed(node.left, x), right = evaluateMathDetailed(node.right, x);
      const value = node.op === '+' ? left.value + right.value : node.op === '-' ? left.value - right.value
        : node.op === '*' ? left.value * right.value : node.op === '/' ? right.value === 0 ? NaN : left.value / right.value
        : left.value ** right.value;
      return { value, branches: [...left.branches, ...right.branches] };
    }
    case 'comparison': {
      const left = evaluateMathDetailed(node.left, x), right = evaluateMathDetailed(node.right, x);
      if (!Number.isFinite(left.value) || !Number.isFinite(right.value)) return { value: 0, branches: [...left.branches, ...right.branches] };
      const value = node.op === '<' ? left.value < right.value : node.op === '<=' ? left.value <= right.value
        : node.op === '>' ? left.value > right.value : node.op === '>=' ? left.value >= right.value
        : node.op === '==' ? left.value === right.value : left.value !== right.value;
      return { value: value ? 1 : 0, branches: [...left.branches, ...right.branches] };
    }
    case 'piecewise': {
      for (let index = 0; index < node.branches.length; index++) {
        const branch = node.branches[index];
        if (evaluateMathDetailed(branch.condition, x).value !== 0) {
          const result = evaluateMathDetailed(branch.expression, x);
          return { value: result.value, branches: [index, ...result.branches] };
        }
      }
      return { value: NaN, branches: [-1] };
    }
    case 'call': {
      const result = evaluateMathDetailed(node.value, x);
      return { value: MATH_FUNCTIONS[node.name](result.value), branches: result.branches };
    }
  }
}

function boundedY(y: number): number | null {
  return Number.isFinite(y) && Math.abs(y) <= MAX_Y_BOUND ? y : null;
}

function expressionPoints(formula: Record<string, unknown>): { points: ChartPoint[]; calculation: Calculation } {
  const expression = text(formula.expression, MAX_EXPRESSION_LENGTH);
  const min = finite(formula.min), max = finite(formula.max), samples = finite(formula.samples ?? 201);
  if (Math.abs(min) > MAX_X_BOUND || Math.abs(max) > MAX_X_BOUND || max <= min ||
      max - min > MAX_X_BOUND || !Number.isInteger(samples) || samples < 2 || samples > MAX_EXPRESSION_SAMPLES) throw new Error('Invalid expression bounds');
  const ast = parseMathExpression(expression);
  const sampleAt = (x: number) => {
    const result = evaluateMathDetailed(ast, x);
    return { x, y: boundedY(result.value), branches: result.branches };
  };
  const base = Array.from({ length: samples }, (_, i) => {
    const x = min + (max - min) * i / (samples - 1);
    return sampleAt(x);
  });
  const typicalMagnitude = base.flatMap((point) => point.y === null ? [] : [Math.abs(point.y)]).sort((a, b) => a - b);
  const medianMagnitude = typicalMagnitude.length
    ? typicalMagnitude[Math.floor((typicalMagnitude.length - 1) / 2)] : 0;
  const signature = (branches: number[]) => branches.join(',');
  const boundarySamples = new Set<number>();
  const boundaryGaps = new Map<number, number[]>();
  const findBoundary = (left: number, leftSignature: string, right: number) => {
    const originalLeft = left, originalRight = right;
    for (let probe = 0; probe < MAX_PIECEWISE_BOUNDARY_PROBES; probe++) {
      const middle = (left + right) / 2;
      if (middle === left || middle === right) break;
      if (signature(evaluateMathDetailed(ast, middle).branches) === leftSignature) left = middle;
      else right = middle;
    }
    const x = (left + right) / 2;
    const tolerance = Math.max((originalRight - originalLeft) * 1e-12,
      Number.EPSILON * Math.max(Math.abs(originalLeft), Math.abs(originalRight), 1) * 8);
    const markSample = (endpoint: number) => {
      const index = Math.round((endpoint - min) / (max - min) * (samples - 1));
      if (index >= 0 && index < samples && Math.abs(base[index].x - endpoint) <= tolerance) {
        boundarySamples.add(index);
        return true;
      }
      return false;
    };
    if (x - originalLeft <= tolerance && markSample(originalLeft)) return;
    if (originalRight - x <= tolerance && markSample(originalRight)) return;
    const interval = Math.floor((originalLeft - min) / (max - min) * (samples - 1));
    const values = boundaryGaps.get(interval) ?? [];
    values.push(x);
    boundaryGaps.set(interval, values);
  };
  for (let index = 0; index < base.length - 1; index++) {
    const start = base[index], end = base[index + 1], middle = sampleAt((start.x + end.x) / 2);
    const startSignature = signature(start.branches), middleSignature = signature(middle.branches);
    const endSignature = signature(end.branches);
    if (startSignature !== middleSignature) findBoundary(start.x, startSignature, middle.x);
    if (middleSignature !== endSignature) findBoundary(middle.x, middleSignature, end.x);
  }
  const points: ChartPoint[] = [];
  base.forEach((point, index) => {
    points.push({ x: point.x, y: boundarySamples.has(index) ? null : point.y });
    const next = base[index + 1];
    if (!next || point.y === null || next.y === null) return;
    // Probe between plotted samples. A domain failure or sharp midpoint blow-up
    // becomes an explicit null so the line renderer cannot bridge the pole.
    const x = (point.x + next.x) / 2;
    const y = sampleAt(x).y;
    const scale = Math.max(1, Math.abs(point.y), Math.abs(next.y));
    const signJump = point.y * next.y < 0
      && Math.min(Math.abs(point.y), Math.abs(next.y)) > medianMagnitude * 3
      && Math.max(Math.abs(point.y), Math.abs(next.y)) > medianMagnitude * 8;
    const gaps = boundaryGaps.get(index) ?? [];
    if (y === null || Math.abs(y) > scale * 8 || signJump) gaps.push(x);
    for (const gap of [...new Set(gaps)].sort((a, b) => a - b)) points.push({ x: gap, y: null });
  });
  if (points.length > 1000) throw new Error('Expression output has too many points');
  return { points, calculation: { expression, min, max, samples } };
}

function legacyFormulaPoints(value: unknown): { points: ChartPoint[]; calculation: Calculation } {
  const f = object(value);
  const fn = text(f.fn, 20), a = finite(f.a ?? 1), b = finite(f.b ?? 0), c = finite(f.c ?? 0);
  const min = finite(f.min), max = finite(f.max), samples = finite(f.samples ?? 81);
  if (max <= min || !Number.isInteger(samples) || samples < 2 || samples > 200 ||
      !['linear', 'quadratic', 'sin', 'cos', 'exp'].includes(fn)) throw new Error('Invalid formula');
  const expressions: Record<string, string> = {
    linear: `(${a})*x+(${b})`,
    quadratic: `(${a})*x^2+(${b})*x+(${c})`,
    sin: `(${a})*sin(x+(${b}))+(${c})`,
    cos: `(${a})*cos(x+(${b}))+(${c})`,
    exp: `(${a})*exp(x+(${b}))+(${c})`,
  };
  const points = Array.from({ length: samples }, (_, i) => {
    const x = min + (max - min) * i / (samples - 1);
    const y = fn === 'linear' ? a * x + b : fn === 'quadratic' ? a * x * x + b * x + c
      : fn === 'sin' ? a * Math.sin(x + b) + c : fn === 'cos' ? a * Math.cos(x + b) + c
      : a * Math.exp(x + b) + c;
    return { x: finite(x), y: finite(y) };
  });
  return { points, calculation: { expression: expressions[fn], min, max, samples } };
}
function axis(value: unknown) {
  const row = object(value);
  return { label: text(row.label, 100), unit: unit(row.unit) };
}

export type WidgetResult = { status: 'valid'; widget: InteractiveWidget } | { status: 'invalid'; fallback: string };
export function validateWidget(value: unknown): WidgetResult {
  let fallback = 'This interactive answer could not be displayed. Ask Nexo for a plain-text version.';
  try {
    const row = object(value);
    if (typeof row.fallback === 'string' && row.fallback.trim() && row.fallback.length <= 1600) fallback = row.fallback;
    if (row.version !== 1 && row.version !== 2) throw new Error('Unsupported version');
    const version = row.version;
    const base: WidgetBase = { version, id: id(row.id), title: text(row.title, 180), fallback: text(row.fallback, 1600),
      ...(row.description === undefined ? {} : { description: text(row.description, 800) }) };
    if (row.type === 'quiz') {
      const questions = list(row.questions, 1, 15).map((value): QuizQuestion => {
        const question = object(value);
        const options = list(question.options, 2, 6).map((value) => {
          const option = object(value);
          return { id: id(option.id), text: text(option.text, 500) };
        });
        unique(options.map((option) => option.id));
        const answerId = id(question.answerId);
        if (!options.some((option) => option.id === answerId)) throw new Error('Unknown answer');
        return { id: id(question.id), prompt: text(question.prompt, 1000), options, answerId, explanation: text(question.explanation, 1200) };
      });
      unique(questions.map((question) => question.id));
      return { status: 'valid', widget: { ...base, type: 'quiz', questions } };
    }
    if (row.type !== 'chart' || !['line', 'bar', 'scatter', 'donut'].includes(String(row.chartType))) throw new Error('Unknown widget');
    const chartType = row.chartType as ChartWidget['chartType'];
    const rawX = object(row.x), x = { ...axis(rawX), type: rawX.type as ChartWidget['x']['type'] }, y = axis(row.y);
    if (!['category', 'number', 'time'].includes(x.type)) throw new Error('Unknown axis');
    if (chartType === 'scatter' && x.type !== 'number') throw new Error('Scatter requires numeric axes');
    if (chartType === 'donut' && x.type !== 'category') throw new Error('Composition requires categories');
    const rawProvenance = object(row.provenance);
    const kind = rawProvenance.kind as ChartWidget['provenance']['kind'];
    if (!['provided', 'verified', 'calculated', 'illustrative'].includes(kind)) throw new Error('Missing provenance');
    const provenance = { kind, detail: text(rawProvenance.detail, 800),
      sources: rawProvenance.sources === undefined ? [] : list(rawProvenance.sources, 0, 5).map(source) };
    if (kind === 'verified' && !provenance.sources.length) throw new Error('Verified data requires sources');
    let total = 0;
    const series = list(row.series, 1, chartType === 'donut' ? 1 : 6).map((value) => {
      const series = object(value);
      // Calculations are parsed into a small allowlisted AST and evaluated locally.
      if (kind === 'calculated' && (!series.formula || x.type !== 'number' || !['line', 'scatter'].includes(chartType))) throw new Error('Calculation requires formula');
      if (kind !== 'calculated' && series.formula !== undefined) throw new Error('Unexpected formula');
      if (kind === 'calculated' && version === 2 && chartType !== 'line') throw new Error('Expression plots require a line chart');
      if (kind === 'calculated' && version === 1 && object(series.formula).expression !== undefined) throw new Error('Expressions require schema version 2');
      if (kind === 'calculated' && version === 2 && object(series.formula).expression === undefined) throw new Error('Schema version 2 requires an expression');
      const calculated = kind === 'calculated'
        ? version === 1 ? legacyFormulaPoints(series.formula) : expressionPoints(object(series.formula))
        : null;
      const points = calculated ? calculated.points : list(series.points, chartType === 'donut' ? 2 : 1, chartType === 'donut' ? 5 : 200).map((value): ChartPoint => {
        const point = object(value);
        let px: string | number;
        if (x.type === 'number') px = finite(point.x);
        else if (x.type === 'time') {
          if (typeof point.x !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(point.x)) throw new Error('Invalid date');
          const calendar = new Date(`${point.x.slice(0, 10)}T00:00:00Z`);
          if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== point.x.slice(0, 10)) throw new Error('Invalid calendar date');
          px = Date.parse(point.x);
          if (!Number.isFinite(px)) throw new Error('Invalid date');
        } else px = text(point.x, 100);
        return { x: px, y: point.y === null ? null : finite(point.y) };
      });
      total += points.length;
      if (total > 1000 || points.every((point) => point.y === null)) throw new Error('No usable data');
      if (chartType !== 'scatter') unique(points.map((point) => String(point.x)));
      if (chartType === 'donut' && (points.some((point) => point.y === null || point.y! < 0) || points.reduce((sum, point) => sum + point.y!, 0) <= 0)) throw new Error('Invalid composition');
      if (x.type !== 'category') points.sort((a, b) => Number(a.x) - Number(b.x));
      return { id: id(series.id), name: text(series.name, 100), points, ...(calculated ? { calculation: calculated.calculation } : {}) };
    });
    unique(series.map((series) => series.id));
    return { status: 'valid', widget: { ...base, type: 'chart', chartType, x, y, provenance, series } };
  } catch { return { status: 'invalid', fallback }; }
}

export function parseWidget(raw: string): WidgetResult {
  if (raw.length > MAX_WIDGET_BYTES || new TextEncoder().encode(raw).byteLength > MAX_WIDGET_BYTES) return { status: 'invalid', fallback: 'This interactive answer is too large. Ask Nexo for a smaller chart or quiz.' };
  try { return validateWidget(JSON.parse(raw)); }
  catch { return { status: 'invalid', fallback: 'This interactive answer is incomplete or malformed. Ask Nexo to try again in plain text.' }; }
}

/** State is data attached to its owning message, not a global prompt/title cache. */
export function sanitizeQuizProgress(value: unknown, widget?: QuizWidget): QuizProgress {
  const result = emptyQuizProgress();
  if (!record(value)) return result;
  const questions = widget?.questions;
  const allowed = questions ? new Map(questions.map((q) => [q.id, new Set(q.options.map((o) => o.id))])) : null;
  const entries = record(value.answers) ? Object.entries(value.answers).slice(0, 15) : [];
  result.answers = Object.fromEntries(entries.filter(([key, value]) => {
    try { id(key); id(value); return !allowed || allowed.get(key)?.has(String(value)); } catch { return false; }
  })) as Record<string, string>;
  result.submitted = Array.isArray(value.submitted)
    ? [...new Set(value.submitted.filter((key): key is string => typeof key === 'string' && Object.hasOwn(result.answers, key)))].slice(0, 15) : [];
  const maxIndex = questions ? questions.length : 15;
  result.index = typeof value.index === 'number' && Number.isInteger(value.index) ? Math.max(0, Math.min(maxIndex, value.index)) : 0;
  if (questions) {
    const firstPending = questions.findIndex((q) => !result.submitted.includes(q.id));
    if (firstPending >= 0) result.index = Math.min(result.index, firstPending);
  }
  return result;
}

export function parseQuizStates(value: unknown): Record<string, QuizProgress> | undefined {
  if (!record(value)) return undefined;
  return Object.fromEntries(Object.entries(value).slice(0, 4)
    .filter(([key]) => /^\d{1,8}:[a-zA-Z0-9_-]{1,64}$/.test(key))
    .map(([key, progress]) => [key, sanitizeQuizProgress(progress)]));
}
