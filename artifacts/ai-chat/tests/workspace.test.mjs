import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { copyRawCode, rawCodeFromSource } from '../src/lib/code-clipboard.ts';
import { makePreviewHtml, sanitizePreviewDiagnostic, reportPreviewReview, reportPreviewDiagnostics, readPreviewReview } from '../src/lib/code-runner.ts';
import { sanitizePreviewReview, formatPreviewReview, previewReviewInstrumentation, previewReviewHasIssues } from '../src/lib/preview-review.ts';
test('Agent treats browser structural defects as repairable failures, not successful builds', () => {
  const healthy = { emptyPage: false, horizontalOverflow: false, brokenImages: 0, unlabeledControls: 0 };
  assert.equal(previewReviewHasIssues(undefined), false);
  assert.equal(previewReviewHasIssues(healthy), false);
  for (const defect of [{ emptyPage: true }, { horizontalOverflow: true }, { brokenImages: 1 }, { unlabeledControls: 2 }]) {
    assert.equal(previewReviewHasIssues({ ...healthy, ...defect }), true);
  }
});
import { savedWorkspaceState, WORKSPACE_DRAFT_KEY } from '../src/lib/workspace-recovery.ts';
import { previewFormInstrumentation } from '../src/lib/preview-forms.ts';
import { workspaceBounds, clampWorkspaceWidth } from '../src/lib/workspace-size.ts';
import { loadEditorLanguage } from '../src/lib/editor-language.ts';
import {
  bundleHtmlProject,
  createSavedProject,
  deleteSavedProject,
  createAgentProject,
  readSavedProject,
  selectedProjectFiles,
  validateProjectFiles,
  writeSavedProject,
} from '../src/lib/project-workspace.ts';

test('clipboard receives exact raw bytes and does not succeed before write resolves', async () => {
  const code = '\tprint("✓")  \r\n\n';
  let received, resolveWrite, completed = false;
  const write = copyRawCode(code, { writeText: (value) => {
    received = value;
    return new Promise((resolve) => { resolveWrite = resolve; });
  } }).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(received, code);
  assert.equal(completed, false);
  resolveWrite();
  await write;
  assert.equal(completed, true);
});

test('clipboard denial and unavailable APIs are explicit failures', async () => {
  await assert.rejects(copyRawCode('x', {}), /unavailable.*manually/);
  await assert.rejects(copyRawCode('x', { writeText: async () => { throw new Error('denied'); } }), /failed.*manually/);
});

test('fenced code keeps indentation, CRLF, blank lines and unknown language bytes', () => {
  for (const [source, expected] of [
    ['```python\n\tprint("hi")  \n\n```', '\tprint("hi")  \n\n'],
    ['```python\nprint(r"$x^2$ and \\(literal\\)")\n```', 'print(r"$x^2$ and \\(literal\\)")\n'],
    ['~~~rust\r\n  let x = 2;\r\n~~~', '  let x = 2;\r\n'],
    ['```\nx\n```', 'x\n'],
    ['```js\npartial', 'partial'],
    ['  ```python\n    print(1)\n  ```', '  print(1)\n'],
  ]) assert.equal(rawCodeFromSource(source, 0, source.length, 'fallback'), expected);
  assert.equal(rawCodeFromSource('> ```\n> x\n> ```', 0, 16, 'x\n'), 'x\n');
});

test('workspace bounds preserve readable chat and adapt to tablet/mobile', () => {
  assert.deepEqual(workspaceBounds(1440, 260), { min: 320, max: 844 });
  assert.deepEqual(workspaceBounds(900, 260), { min: 320, max: 852 });
  assert.deepEqual(workspaceBounds(390), { min: 390, max: 390 });
  assert.equal(clampWorkspaceWidth(3000, workspaceBounds(1440, 420)), 684);
  assert.equal(clampWorkspaceWidth(-1, workspaceBounds(1440)), 320);
});

test('workspace reopening finds only the current conversation and survives independent corrupt records', () => {
  const records = new Map([
    ['nexo-project-v1:agent-chat', '{broken project'],
    [WORKSPACE_DRAFT_KEY, JSON.stringify({
      'code-chat': { language: 'javascript', code: 'console.log(42)', edited: true },
      'empty-draft': { language: 'python', code: '', edited: true },
      'invalid-draft': { language: 'shell', code: 'no' },
    })],
  ]);
  const storage = { getItem: (key) => records.get(key) ?? null };
  assert.deepEqual(savedWorkspaceState(storage, 'agent-chat'), { hasProject: true, hasDraft: false });
  assert.deepEqual(savedWorkspaceState(storage, 'code-chat'), { hasProject: false, hasDraft: true });
  assert.deepEqual(savedWorkspaceState(storage, 'empty-draft'), { hasProject: false, hasDraft: true });
  assert.deepEqual(savedWorkspaceState(storage, 'invalid-draft'), { hasProject: false, hasDraft: false });
  assert.deepEqual(savedWorkspaceState(storage, 'other-chat'), { hasProject: false, hasDraft: false });
  assert.deepEqual(savedWorkspaceState(storage, null), { hasProject: false, hasDraft: false });
  records.set(WORKSPACE_DRAFT_KEY, '{corrupt');
  assert.deepEqual(savedWorkspaceState(storage, 'agent-chat'), { hasProject: true, hasDraft: false });
  assert.deepEqual(savedWorkspaceState({ getItem: () => { throw new Error('blocked'); } }, 'agent-chat'),
    { hasProject: false, hasDraft: false });
});

test('HTML preview is instrumented, network-restricted, and diagnostics are bounded', () => {
  const preview = makePreviewHtml(
    '<!doctype html><html><head><title>Preview</title></head><body><h1>Ready</h1></body></html>',
    'preview-test-id',
  );
  assert.ok(preview.startsWith('<!doctype html><html>'));
  assert.match(preview, /default-src &#39;none&#39;|default-src 'none'/);
  assert.match(preview, /connect-src &#39;none&#39;|connect-src 'none'/);
  assert.match(preview, /nexo-preview-diagnostic/);
  assert.match(preview, /preview-test-id/);
  assert.match(preview, /<h1>Ready<\/h1>/);
  assert.doesNotMatch(preview, /allow-same-origin/);
  assert.doesNotMatch(preview, /allow-forms/);
  assert.match(preview, /form-action 'none'/);

  const diagnostic = sanitizePreviewDiagnostic({
    kind: 'error',
    message: 'x'.repeat(900),
    source: 'https://example.test/assets/app.js?private=value#section',
    line: 12,
  });
  assert.equal(diagnostic.message.length, 600);
  assert.equal(diagnostic.source, 'https://example.test/assets/app.js');
  assert.equal(diagnostic.line, 12);
  assert.equal(sanitizePreviewDiagnostic({ kind: 'unexpected', message: 'x' }), null);
});

test('sandbox form bridge runs local submit handlers with validation and no navigation', () => {
  const listeners = new Map();
  class Form {
    isConnected = true;
    noValidate = false;
    valid = true;
    events = [];
    elements = [];
    reportValidity() { return this.valid; }
    dispatchEvent(event) { this.events.push(event); return false; }
  }
  class Submit {
    constructor(type, options) { this.type = type; Object.assign(this, options); }
  }
  vm.runInNewContext(previewFormInstrumentation(), {
    window: { addEventListener: (type, listener) => listeners.set(type, listener) },
    HTMLFormElement: Form, SubmitEvent: Submit, DOMException, Event,
  });
  const form = new Form();
  const button = { tagName: 'BUTTON', type: 'submit', form, matches: () => false };
  form.elements = [button];
  const click = {
    button: 0, defaultPrevented: false, target: { closest: () => button },
    preventDefault() { this.defaultPrevented = true; },
  };
  listeners.get('click')(click);
  assert.equal(click.defaultPrevented, true, 'native submission is prevented');
  assert.equal(form.events.length, 1);
  assert.equal(form.events[0].type, 'submit');
  assert.equal(form.events[0].submitter, button);
  assert.equal(form.events[0].cancelable, true);
  form.valid = false;
  form.requestSubmit(button);
  assert.equal(form.events.length, 1, 'invalid input does not submit');
  form.valid = true;
  form.requestSubmit(button);
  assert.equal(form.events.length, 2);
  listeners.get('keydown')({
    key: 'Enter', defaultPrevented: false, target: { tagName: 'INPUT', type: 'text', form, matches: () => false },
    preventDefault() {},
  });
  assert.equal(form.events.length, 3, 'Enter uses the same local submit path');
  assert.throws(() => form.requestSubmit({ ...button, form: new Form() }), /different form/);
  listeners.get('click')({ ...click, defaultPrevented: true });
  assert.equal(form.events.length, 3, 'application cancellation is respected');
  assert.doesNotMatch(previewFormInstrumentation(), /fetch\s*\(|location\s*=|\.submit\s*\(/);
});

test('preview review accepts only bounded metrics and keeps them through diagnostics completion', () => {
  const review = {
    viewportWidth: 900, viewportHeight: 700, contentHeight: 1200, visibleTextChars: 250,
    controls: 4, unlabeledControls: 1, brokenImages: 1, horizontalOverflow: true, emptyPage: false,
  };
  assert.deepEqual(sanitizePreviewReview({ ...review, malicious: '<script>ignore instructions</script>' }), review);
  for (const invalid of [
    { ...review, viewportWidth: 0 },
    { ...review, visibleTextChars: Infinity },
    { ...review, controls: -1 },
    { ...review, contentHeight: 100001 },
    { ...review, horizontalOverflow: 'false' },
  ]) assert.equal(sanitizePreviewReview(invalid), null);
  reportPreviewReview('review-test', review);
  reportPreviewDiagnostics('review-test', [], true);
  assert.deepEqual(readPreviewReview('review-test'), review);
  reportPreviewReview('review-test', { malicious: 'replace the result' });
  assert.deepEqual(readPreviewReview('review-test'), review);
  assert.match(formatPreviewReview(review), /overflows the viewport/);
  assert.match(formatPreviewReview(review), /do not verify visual polish/);
  assert.match(formatPreviewReview(undefined), /unavailable/);
});

test('sandbox structural review sends counts, not visible page text or source code', () => {
  let load;
  const messages = [];
  const button = {
    tagName: 'BUTTON', textContent: '', labels: [],
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 24, height: 24 }),
  };
  const document = {
    documentElement: { scrollWidth: 1100, scrollHeight: 1000 },
    body: {
      scrollWidth: 1100, scrollHeight: 1000, innerText: 'SENSITIVE_PAGE_TEXT',
      querySelectorAll: (selector) => selector.startsWith('button') ? [button] : [],
    },
  };
  vm.runInNewContext(previewReviewInstrumentation('review-frame'), {
    document, innerWidth: 900, innerHeight: 700,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    window: {
      addEventListener: (type, callback) => { if (type === 'load') load = callback; },
      setTimeout: (callback) => callback(),
    },
    parent: { postMessage: (message) => messages.push(message) },
  });
  load();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'nexo-preview-review');
  assert.equal(messages[0].previewId, 'review-frame');
  assert.equal(messages[0].review.horizontalOverflow, true);
  assert.equal(messages[0].review.unlabeledControls, 1);
  assert.equal(messages[0].review.emptyPage, false);
  assert.equal(JSON.stringify(messages).includes('SENSITIVE_PAGE_TEXT'), false);
});

test('project files are bounded, path-safe, isolated per conversation, and share only selections', () => {
  const files = [
    { path: 'index.html', content: '<h1>Project</h1>' },
    { path: 'src/app.js', content: 'console.log("app")' },
  ];
  assert.throws(() => validateProjectFiles([{ path: '../secret', content: 'x' }]), /relative paths|letters, numbers/);
  assert.throws(() => validateProjectFiles([{ path: 'x.js', content: 'x'.repeat(12_001) }]), /at most 12,000/);
  assert.throws(() => validateProjectFiles(Array.from({ length: 9 }, (_, index) => ({ path: `${index}.js`, content: '' }))), /1–8 files/);

  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const project = createSavedProject(files, 'index.html', ['src/app.js']);
  writeSavedProject(storage, 'chat/one', project);
  assert.deepEqual(readSavedProject(storage, 'chat/one'), project);
  assert.deepEqual(readSavedProject(storage, 'chat/two'), null);
  assert.deepEqual(selectedProjectFiles(project), [files[1]]);
  deleteSavedProject(storage, 'chat/one');
  assert.deepEqual(readSavedProject(storage, 'chat/one'), null, 'deleting a conversation also removes its project record');
});

test('HTML project preview embeds only local CSS and classic JavaScript assets', () => {
  const html = bundleHtmlProject([
    { path: 'site/index.html', content: '<html><head><link rel="stylesheet" href="../styles/site.css"></head><body><h1>Local project</h1><script src="../scripts/app.js"></script></body></html>' },
    { path: 'styles/site.css', content: 'h1 { color: navy; }' },
    { path: 'scripts/app.js', content: 'document.body.dataset.loaded = "yes";' },
  ], 'site/index.html');
  assert.match(html, /<style>h1 \{ color: navy; \}<\/style>/);
  assert.match(html, /<script>document\.body\.dataset\.loaded = "yes";<\/script>/);
  assert.doesNotMatch(html, /href="\.\.\/styles/);
  assert.doesNotMatch(html, /src="\.\.\/scripts/);
  assert.throws(() => bundleHtmlProject([
    { path: 'index.html', content: '<link rel="stylesheet" href="missing.css">' },
  ], 'index.html'), /stylesheet.*not found/);
  assert.throws(() => bundleHtmlProject([
    { path: 'index.html', content: '<script type="module" src="app.js"></script>' },
    { path: 'app.js', content: 'export {}' },
  ], 'index.html'), /does not support JavaScript modules/);
});

test('Agent follow-ups retain generated source while respecting explicit deselection', () => {
  const files = [{ path: 'index.html', content: '<button>Run</button>' }, { path: 'app.js', content: 'void 0' }];
  const first = createAgentProject(files, 'index.html', null);
  assert.deepEqual(first.selectedPaths, ['index.html', 'app.js']);
  const optedOut = { ...first, selectedPaths: ['index.html'] };
  const revised = createAgentProject([...files, { path: 'style.css', content: 'button{}' }], 'index.html', optedOut);
  assert.deepEqual(revised.selectedPaths, ['index.html', 'style.css']);
  assert.deepEqual(selectedProjectFiles(revised).map((file) => file.path), ['index.html', 'style.css']);
  assert.deepEqual(createSavedProject(files, 'index.html').selectedPaths, [], 'manual projects are not auto-shared');
});

test('partial Agent edits preserve assets and reject broken updates before replacing a project', () => {
  const original = createAgentProject([
    { path: 'index.html', content: '<link rel="stylesheet" href="style.css"><button>Original</button><script src="app.js"></script>' },
    { path: 'style.css', content: 'button { color: blue; }' },
    { path: 'app.js', content: 'document.querySelector("button").value = "ready";' },
  ], 'index.html', null);
  const revised = createAgentProject([
    { path: 'index.html', content: '<link rel="stylesheet" href="style.css"><button>Revised</button><script src="app.js"></script>' },
  ], 'index.html', original);
  assert.equal(revised.files.length, 3);
  assert.equal(revised.files.find((file) => file.path === 'style.css').content, 'button { color: blue; }');
  assert.match(bundleHtmlProject(revised.files, revised.entrypoint), /value = "ready"/);
  const snapshot = JSON.stringify(revised);
  assert.throws(() => createAgentProject([
    { path: 'index.html', content: '<link rel="stylesheet" href="missing.css">' },
  ], 'index.html', revised), /stylesheet.*not found/);
  assert.equal(JSON.stringify(revised), snapshot, 'invalid updates do not mutate the working project');
});

test('deferred project scripts run after the DOM in order without losing shared globals', () => {
  const html = bundleHtmlProject([
    { path: 'index.html', content: '<html><head><script defer src="a.js"></script><script src="b.js" defer></script></head><body><button id="action">Run</button></body></html>' },
    { path: 'a.js', content: 'const action = document.getElementById("action");' },
    { path: 'b.js', content: 'action.value = "working";' },
  ], 'index.html');
  assert.ok(html.indexOf('<button') < html.indexOf('const action'));
  assert.ok(html.indexOf('const action') < html.indexOf('action.value'));
  assert.ok(html.indexOf('action.value') < html.indexOf('</body>'));
  const button = {};
  const context = vm.createContext({ document: { getElementById: () => button } });
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(script[1], context);
  assert.equal(button.value, 'working');
});

test('editor modes are selected dynamically and repeated loads share a promise', async () => {
  const first = loadEditorLanguage('python');
  assert.equal(first, loadEditorLanguage('python'));
  assert.equal((await first).language.name, 'python');
  assert.equal((await loadEditorLanguage('javascript')).language.name, 'javascript');
  assert.equal((await loadEditorLanguage('html')).language.name, 'html');
});

test('Python worker stays warm, isolates each snippet, and loads only requested packages', async () => {
  const html = await readFile(new URL('../public/code-runner.html', import.meta.url), 'utf8');
  const source = html.match(/<script id="worker-source" type="text\/plain">([\s\S]*?)<\/script>/)[1];
  const imports = [], scripts = [], executed = [], messages = [], namespaces = [];
  let pyodideLoads = 0;
  const context = vm.createContext({
    importScripts: (url) => scripts.push(url),
    postMessage: (message) => messages.push(message),
    _: {},
    math: {},
    loadPyodide: async () => {
      pyodideLoads++;
      return {
        setStdout() {}, setStderr() {}, globals: { set() {} },
        loadPackage: () => assert.fail('Unconditional packages must not load'),
        loadPackagesFromImports: async (code) => imports.push(code),
        runPython: () => {
          const namespace = { set() {}, destroy() {} };
          namespaces.push(namespace);
          return namespace;
        },
        runPythonAsync: async (code, options) => { executed.push({ code, options }); },
      };
    },
  });
  context.self = context;
  vm.runInContext(source, context);
  const codes = ['print(5)', 'import numpy as np\nprint(np.arange(3))', 'import matplotlib.pyplot as plt\nplt.plot([1,2])'];
  for (const [index, code] of codes.entries()) {
    await context.onmessage({ data: { type: 'run', runId: `python-${index}`, language: 'python', code } });
    assert.equal(imports.at(-1), code);
  }
  assert.equal(scripts.length, 1, 'Python runtime loads once and JavaScript libraries remain unloaded');
  assert.ok(scripts[0].includes('pyodide'));
  assert.equal(pyodideLoads, 1);
  assert.equal(namespaces.length, codes.length, 'Each snippet receives a fresh Python namespace');
  assert.notEqual(namespaces[0], namespaces[1]);
  assert.notEqual(namespaces[1], namespaces[2]);
  assert.ok(executed.some(({ code }) => code.includes('MPLBACKEND')));
  assert.ok(codes.every((code) => executed.some((run) => run.code === code && run.options?.globals)));
  assert.equal(messages.filter((message) => message.type === 'done' && !message.error).length, 3);
  assert.ok(messages.every((message) => message.runId));

  await context.onmessage({ data: { type: 'run', runId: 'javascript-1', language: 'javascript', code: 'console.log("ok")' } });
  assert.equal(scripts.length, 3, 'Lodash and MathJS load only when JavaScript runs');
  await context.onmessage({ data: { type: 'run', runId: 'python-4', language: 'python', code: 'print("again")' } });
  assert.equal(scripts.length, 3, 'Switching languages does not reload the warm runtime or libraries');
  assert.equal(pyodideLoads, 1);
  assert.equal(namespaces.length, codes.length + 1);
  assert.ok(messages.some((message) => message.type === 'done' && message.runId === 'javascript-1' && !message.error));
  assert.ok(messages.some((message) => message.type === 'done' && message.runId === 'python-4' && !message.error));
});
