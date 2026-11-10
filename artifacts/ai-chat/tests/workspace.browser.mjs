import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function waitFor(check, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await delay(80);
  }
  throw new Error(`Timed out: ${label}`);
}
const port = await freePort(), debugPort = await freePort();
const profile = await mkdtemp(path.join(tmpdir(), 'nexo-workspace-'));
const vite = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: packageDir, env: { ...process.env, PORT: String(port), BASE_PATH: '/' }, stdio: 'ignore',
});
const browser = spawn(process.env.CHROMIUM_PATH ?? '/repl/tools/bin/chromium', [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
  `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
let socket, sequence = 0;
const pending = new Map(), requests = [];
const timings = {};
function cdp(method, params = {}, timeout = 15000) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeout);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression, timeout) {
  const response = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeout);
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result?.value;
}
const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
async function wheelOverSecondCodeBlock(deltaY) {
  const point = await evaluate(`(() => {
    const element = document.querySelectorAll('.code-block pre')[1];
    const scroller = document.querySelector('[data-testid="fixture-chat-scroll"]');
    let rect = element.getBoundingClientRect();
    const pane = scroller.getBoundingClientRect();
    scroller.scrollTop += rect.top - (pane.top + 80);
    rect = element.getBoundingClientRect();
    return { before: scroller.scrollTop, x: rect.left + Math.min(rect.width / 2, 120), y: rect.top + 24 };
  })()`);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY });
  await delay(100);
  return point.before;
}
async function wheelOver(selector, deltaY) {
  const point = await evaluate(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: Math.max(4, Math.min(rect.top + rect.height / 2, innerHeight - 4)) };
  })()`);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY });
  await delay(100);
}
async function touchSwipe(selector, distance = 260) {
  const point = await evaluate(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: Math.max(12, Math.min(rect.top + rect.height / 2, innerHeight - 92)) };
  })()`);
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y + 80 }] });
  await cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y + 80 - distance }] });
  await delay(80);
  await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: false });
  await delay(100);
}
async function touchSwipeOverSecondCodeBlock() {
  const point = await evaluate(`(() => {
    const element = document.querySelectorAll('.code-block pre')[1];
    const scroller = document.querySelector('[data-testid="fixture-chat-scroll"]');
    let rect = element.getBoundingClientRect();
    const pane = scroller.getBoundingClientRect();
    scroller.scrollTop += rect.top - (pane.top + 80);
    rect = element.getBoundingClientRect();
    return { before: scroller.scrollTop, x: rect.left + Math.min(rect.width / 2, 120), y: rect.top + 24 };
  })()`);
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y }] });
  await cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y - 240 }] });
  await delay(80);
  await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: false });
  await delay(100);
  return point.before;
}
async function pressKey(selector, key, code, windowsVirtualKeyCode) {
  if (selector) await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, text: key === 'Enter' ? '\r' : undefined });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
}
async function pressTab(shift = false) {
  const modifiers = shift ? 8 : 0;
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
}
const width = () => evaluate(`document.querySelector('[data-testid="panel-workspace"]').getBoundingClientRect().width`);
const changeLanguage = (language) => evaluate(`(() => {
  const select = document.querySelector('[data-testid="select-language"]');
  select.value = ${JSON.stringify(language)};
  select.dispatchEvent(new Event('change', {bubbles:true}));
})()`);
async function dragDivider(kind, delta) {
  const rect = await evaluate(`(() => { const r = document.querySelector('[data-testid="separator-workspace"]').getBoundingClientRect(); return {x:r.x+5,y:200}; })()`);
  if (kind === 'touch') {
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rect.x, y: rect.y }] });
    await cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: rect.x - delta, y: rect.y }] });
    await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: false });
  } else {
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x - delta, y: rect.y, button: 'left', buttons: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x - delta, y: rect.y, button: 'left' });
  }
  await delay(100);
}
try {
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/tests/workspace.html`)).ok; } catch { return false; } }, 'Vite');
  let target;
  await waitFor(async () => {
    try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((item) => item.type === 'page'); return !!target; } catch { return false; }
  }, 'Chromium');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url);
    if (!message.id) return;
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message)); else call.resolve(message.result);
  });
  await cdp('Page.enable');
  await cdp('Network.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/tests/workspace.html` });
  await waitFor(() => evaluate(`!!window.__workspaceFixture && document.querySelectorAll('.code-block').length === 2`), 'Markdown');
  const beforeCodeWheel = await wheelOverSecondCodeBlock(500);
  assert.ok(await evaluate(`document.querySelector('[data-testid="fixture-chat-scroll"]').scrollTop > ${beforeCodeWheel}`), 'Vertical wheel over a code block continues scrolling the chat');
  await evaluate(`document.querySelector('[data-testid="fixture-chat-scroll"]').scrollTop = 0`);
  assert.ok(!requests.some((url) => /codemirror_lang-(python|javascript|html)/.test(url)), 'No grammar before workspace is opened');
  await evaluate(`window.__copied = []; Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{writeText:async text=>window.__copied.push(text)} });`);
  await click('.code-block button');
  await waitFor(() => evaluate(`window.__copied.length === 1`), 'raw copy');
  assert.equal(await evaluate('window.__copied[0]'), '\tprint("hello ✓")  \r\n\r\n');
  await evaluate(`navigator.clipboard.writeText = async()=>{throw new Error('denied')}`);
  await click('.code-block:nth-of-type(2) button');
  await waitFor(() => evaluate(`document.querySelector('.code-copy-error')?.textContent.includes('manually')`), 'denied feedback');
  const editorStarted = await evaluate('performance.now()');
  await evaluate(`navigator.clipboard.writeText = async text=>window.__copied.push(text); window.__workspaceFixture.open(true);`);
  await waitFor(() => evaluate(`!!document.querySelector('.cm-content')`), 'CodeMirror mount');
  const editorMounted = await evaluate('performance.now()');
  timings.editorMountMs = Math.round(editorMounted - editorStarted);
  assert.equal(await evaluate(`document.querySelector('.cm-content')?.getAttribute('contenteditable')`), 'true', 'Plain-text editing is available while highlighting loads');
  await waitFor(() => evaluate(`!document.querySelector('.ws-language-status')`), 'Python highlighting');
  timings.languageReadyMs = Math.round(await evaluate('performance.now()') - editorMounted);
  timings.workspaceReadyMs = Math.round(await evaluate('performance.now()') - editorStarted);
  assert.equal(await evaluate(`document.querySelector('[data-testid="console-output"]').textContent.trim()`), 'Run code to see output.', 'Console starts with only a short prompt');
  assert.ok(requests.some((url) => /codemirror_lang-python/.test(url)));
  assert.ok(!requests.some((url) => /codemirror_lang-(javascript|html)/.test(url)), 'Python does not download other grammars');
  assert.equal(await evaluate(`document.querySelector('[data-testid="button-toggle-wrap"]').getAttribute('aria-pressed')`), 'false');
  const wrappedSource = `print("${'wide'.repeat(80)}")\n`;
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await cdp('Input.insertText', { text: wrappedSource });
  await click('[data-testid="button-toggle-wrap"]');
  assert.equal(await evaluate(`document.querySelector('[data-testid="button-toggle-wrap"]').getAttribute('aria-pressed')`), 'true');
  assert.equal(await evaluate(`document.querySelector('.cm-content').classList.contains('cm-lineWrapping')`), true, 'Wrap is a CodeMirror display extension');
  await click('[aria-label="Copy workspace code"]');
  await waitFor(() => evaluate(`window.__copied.at(-1) === ${JSON.stringify(wrappedSource)}`), 'wrapped editor copy preserves raw source');
  await evaluate(`navigator.clipboard.writeText = async()=>{throw new Error('denied')}`);
  await click('[aria-label="Copy workspace code"]');
  await waitFor(() => evaluate(`document.querySelector('.code-copy-error')?.textContent.includes('manually')`), 'workspace clipboard denial feedback');
  await evaluate(`navigator.clipboard.writeText = async text=>window.__copied.push(text)`);
  await click('[data-testid="button-toggle-wrap"]');
  assert.equal(await evaluate(`document.querySelector('.cm-content').classList.contains('cm-lineWrapping')`), false, 'Wrap can be disabled without changing source');
  await click('[data-testid="button-toggle-wrap"]');
  const original = await width();
  await dragDivider('mouse', 80);
  assert.ok(await width() >= original + 70, 'Pointer resize');
  const afterMouse = await width();
  await dragDivider('touch', 40);
  assert.ok(await width() >= afterMouse + 30, 'Touch resize');
  await evaluate(`document.querySelector('[data-testid="separator-workspace"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))`);
  assert.equal(await width(), 320);
  await evaluate(`document.querySelector('[data-testid="separator-workspace"]').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))`);
  const expanded = await width();
  assert.ok(expanded <= 1104);
  await delay(300);
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await cdp('Input.insertText', { text: 'print("edited")\n' });
  await click('[aria-label="Copy workspace code"]');
  await waitFor(() => evaluate(`window.__copied.at(-1) === 'print("edited")\\n'`), 'edited code copy');
  await evaluate(`window.__workspaceFixture.generated('python','print("new generated version")')`);
  await delay(100);
  assert.ok(await evaluate(`document.querySelector('.cm-content').textContent.includes('edited')`), 'Generated updates preserve edits');
  await changeLanguage('javascript');
  await changeLanguage('html');
  await waitFor(() => evaluate(`!document.querySelector('.ws-language-status') && document.querySelector('select').value === 'html'`), 'rapid mode switch');
  assert.ok(requests.some((url) => /codemirror_lang-html/.test(url)));
  const isolatedPage = `<!doctype html><html><head><title>Preview isolation</title></head><body>
    <h1>Responsive preview</h1><p id="boundary"></p>
    <script>
      let parentBlocked = false, storageBlocked = false;
      try { parent.document.documentElement.dataset.previewEscape = "yes"; } catch (_) { parentBlocked = true; }
      try { localStorage.setItem("preview-secret-probe", "bad"); } catch (_) { storageBlocked = true; }
      fetch("http://127.0.0.1:${port}/api/preview-probe").catch(() => {});
      document.querySelector("#boundary").textContent = [
        parentBlocked ? "parent-blocked" : "parent-accessible",
        storageBlocked ? "storage-blocked" : "storage-accessible",
        typeof process === "undefined" ? "no-server-runtime" : "server-runtime"
      ].join("|");
      console.error("PREVIEW_CONSOLE_DIAGNOSTIC");
      setTimeout(() => { throw new Error("PREVIEW_RUNTIME_DIAGNOSTIC"); }, 0);
    </script>
  </body></html>`;
  await evaluate(`window.__workspaceFixture.conversation('html-preview-test'); window.__workspaceFixture.generated('html', ${JSON.stringify(isolatedPage)});`);
  await click('[data-testid="button-run-code"]');
  await waitFor(() => evaluate(`document.querySelector('[data-testid="preview-diagnostics"]')?.textContent.includes("PREVIEW_RUNTIME_DIAGNOSTIC")`), 'HTML runtime diagnostics');
  assert.equal(await evaluate(`document.querySelector('[data-testid="frame-preview"]').getAttribute('sandbox')`), 'allow-scripts');
  assert.ok(await evaluate(`document.querySelector('[data-testid="frame-preview"]').getBoundingClientRect().width > 0`), 'The HTML document is visible in a responsive full-width preview');
  assert.equal(await evaluate(`(() => { try { document.querySelector('[data-testid="frame-preview"]').contentWindow.document; return false; } catch (error) { return error.name === 'SecurityError'; } })()`), true, 'The opaque-origin frame cannot be read by the app');
  assert.equal(await evaluate(`document.documentElement.dataset.previewEscape ?? ''`), '', 'Preview cannot access the application document');
  assert.equal(await evaluate(`localStorage.getItem('preview-secret-probe')`), null, 'Preview cannot access application local storage');
  assert.ok(await evaluate(`document.querySelector('[data-testid="preview-diagnostics"]').textContent.includes('PREVIEW_CONSOLE_DIAGNOSTIC')`), 'console errors are surfaced in the workspace');
  assert.ok(!requests.some((url) => url.includes('/api/preview-probe')), 'The preview CSP blocks requests to the app origin');
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await pressKey(null, 'Escape', 'Escape', 27);
  assert.ok(await evaluate(`!!document.querySelector('[data-testid="panel-workspace"]')`), 'Escape in the code editor remains available to the editor');
  await evaluate(`window.__workspaceFixture.openSettings()`);
  await waitFor(() => evaluate(`!!document.querySelector('[data-testid="dialog-settings"]')`), 'settings dialog open');
  await pressKey(null, 'Escape', 'Escape', 27);
  await waitFor(() => evaluate(`!document.querySelector('[data-testid="dialog-settings"]')`), 'settings dialog Escape close');
  assert.ok(await evaluate(`!!document.querySelector('[data-testid="panel-workspace"]')`), 'Escape closes the settings dialog without closing the workspace');
  const longEditorCode = Array.from({ length: 180 }, (_, index) => `print("scroll-line-${index}")`).join('\n');
  await evaluate(`window.__workspaceFixture.conversation('desktop-scroll-test'); window.__workspaceFixture.generated('python', ${JSON.stringify(longEditorCode)});`);
  await waitFor(() => evaluate(`document.querySelector('.cm-content')?.textContent.includes('scroll-line-179')`), 'long editor content');
  await wheelOver('.cm-scroller', 640);
  assert.ok(await evaluate(`document.querySelector('.cm-scroller').scrollTop > 0`), 'Mouse wheel scrolls the code editor itself');
  await evaluate(`window.__workspaceFixture.conversation('workspace-fixture')`);
  await waitFor(() => evaluate(`document.querySelector('.cm-content')?.textContent.includes('edited')`), 'restore original workspace draft');
  await evaluate(`document.querySelector('[data-testid="button-run-code"]').focus()`);
  await pressKey(null, 'Escape', 'Escape', 27);
  await waitFor(() => evaluate(`!document.querySelector('[data-testid="panel-workspace"]')`), 'desktop Escape workspace close');
  await waitFor(() => evaluate(`document.activeElement?.dataset.testid === 'button-conversation-control'`), 'desktop workspace focus return');
  assert.equal(await evaluate(`document.activeElement?.dataset.testid`), 'button-conversation-control', 'Escape returns focus to the conversation control on desktop');
  await evaluate(`document.querySelector('[data-testid="fixture-chat-scroll"]').scrollTop = 0`);
  await wheelOver('[data-testid="fixture-chat-scroll"]', 480);
  assert.ok(await evaluate(`document.querySelector('[data-testid="fixture-chat-scroll"]').scrollTop > 0`), 'Mouse wheel scrolls chat after the code workspace closes');
  await pressKey('[data-testid="button-conversation-control"]', 'Enter', 'Enter', 13);
  await waitFor(() => evaluate(`!!document.querySelector('.cm-content')`), 'workspace reopen');
  assert.equal(await width(), expanded, 'Saved width survives remount');
  assert.ok(await evaluate(`document.querySelector('.cm-content').textContent.includes('edited')`), 'Edited draft survives remount');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 700, deviceScaleFactor: 1, mobile: true });
  await waitFor(async () => await width() === 390, 'phone workspace width');
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await cdp('Input.insertText', { text: longEditorCode });
  await waitFor(() => evaluate(`document.querySelector('.cm-content')?.textContent.includes('scroll-line-179')`), 'long phone editor content');
  await touchSwipe('.cm-scroller');
  assert.ok(await evaluate(`document.querySelector('.cm-scroller').scrollTop > 0`), 'Touch scrolls the code editor itself');
  await evaluate(`document.querySelector('[aria-label="Language"]').focus()`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.workspace-resizer')).display`), 'none');
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), 'No phone overflow');
  await waitFor(() => evaluate(`document.activeElement?.closest('[data-testid="panel-workspace"]') === document.querySelector('[data-testid="panel-workspace"]')`), 'mobile workspace initial focus');
  assert.equal(await evaluate(`document.activeElement?.getAttribute('aria-label')`), 'Language', 'Workspace opening focuses its first control on mobile');
  await pressTab(true);
  assert.equal(await evaluate(`document.activeElement?.dataset.testid`), 'button-ask-fix', 'Shift+Tab wraps to the last workspace control on mobile');
  await pressTab();
  assert.equal(await evaluate(`document.activeElement?.getAttribute('aria-label')`), 'Language', 'Tab wraps to the first workspace control on mobile');
  await evaluate(`document.querySelector('[data-testid="button-conversation-control"]').focus()`);
  assert.ok(await evaluate(`Boolean(document.activeElement?.closest('[data-testid="panel-workspace"]'))`), 'Programmatic focus cannot escape the mobile workspace');
  await pressKey('[data-testid="button-close-workspace"]', 'Escape', 'Escape', 27);
  await waitFor(() => evaluate(`!document.querySelector('[data-testid="panel-workspace"]')`), 'phone Escape workspace close');
  await waitFor(() => evaluate(`document.activeElement?.dataset.testid === 'button-conversation-control'`), 'mobile workspace focus return');
  assert.equal(await evaluate(`document.activeElement?.dataset.testid`), 'button-conversation-control', 'Escape returns focus to the conversation control on mobile');
  await evaluate(`document.querySelector('[data-testid="fixture-chat-scroll"]').scrollTop = 0`);
  await touchSwipe('[data-testid="fixture-chat-scroll"]');
  assert.ok(await evaluate(`document.querySelector('[data-testid="fixture-chat-scroll"]').scrollTop > 0`), 'Touch scrolls chat after the code workspace closes');
  await evaluate(`document.querySelector('[data-testid="fixture-chat-scroll"]').scrollTop = 0`);
  const beforeCodeTouch = await touchSwipeOverSecondCodeBlock();
  assert.ok(await evaluate(`document.querySelector('[data-testid="fixture-chat-scroll"]').scrollTop > ${beforeCodeTouch}`), 'Touch over a code block continues scrolling the chat');
  await pressKey('[data-testid="button-conversation-control"]', 'Enter', 'Enter', 13);
  await waitFor(() => evaluate(`!!document.querySelector('[data-testid="panel-workspace"]')`), 'mobile workspace reopen');
  assert.equal(await width(), 390, 'Workspace reopens at phone width');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const runPython = (code) => evaluate(`window.__workspaceFixture.execute({language:'python', code:${JSON.stringify(code)}})`, 120000);
  const firstPythonStarted = await evaluate('performance.now()');
  const plain = await runPython('import sys\nprint("simple:", 2+3)\nprint("scientific:", any(name in sys.modules for name in ("numpy","scipy","matplotlib")))');
  timings.firstPythonRunMs = Math.round(await evaluate('performance.now()') - firstPythonStarted);
  assert.ok(!plain.error, plain.error);
  assert.ok(plain.outputs.some((item) => item.text === 'scientific: False'));
  const secondPythonStarted = await evaluate('performance.now()');
  const secondPython = await runPython('print("warm run", "sys" in globals())');
  timings.secondPythonRunMs = Math.round(await evaluate('performance.now()') - secondPythonStarted);
  assert.ok(!secondPython.error, secondPython.error);
  assert.ok(secondPython.outputs.some((item) => item.text === 'warm run False'), 'A warm runtime still starts each snippet with fresh variables');
  const javascriptStarted = await evaluate('performance.now()');
  const javascript = await evaluate(`window.__workspaceFixture.execute({language:'javascript',code:'console.log("js ready")'})`, 120000);
  timings.javascriptRunMs = Math.round(await evaluate('performance.now()') - javascriptStarted);
  assert.ok(!javascript.error, javascript.error);
  assert.ok(javascript.outputs.some((item) => item.text === 'js ready'));
  const scientificStarted = await evaluate('performance.now()');
  const scientific = await runPython('import numpy as np\nfrom scipy.special import factorial\nprint("numerics:", int(np.arange(5).sum()), factorial(5, exact=True))');
  timings.numpyScipyRunMs = Math.round(await evaluate('performance.now()') - scientificStarted);
  assert.ok(!scientific.error, scientific.error);
  assert.ok(scientific.outputs.some((item) => item.text === 'numerics: 10 120'));
  const warmScientificStarted = await evaluate('performance.now()');
  const warmScientific = await runPython('import numpy as np\nfrom scipy.special import factorial\nprint("warm numerics:", int(np.arange(5).sum()), factorial(5, exact=True))');
  timings.numpyScipyWarmMs = Math.round(await evaluate('performance.now()') - warmScientificStarted);
  assert.ok(!warmScientific.error, warmScientific.error);
  assert.ok(warmScientific.outputs.some((item) => item.text === 'warm numerics: 10 120'));
  const matplotlibStarted = await evaluate('performance.now()');
  const plot = await runPython('import matplotlib.pyplot as plt\nplt.plot([0,1],[0,1])\nprint("plot ready")');
  timings.matplotlibRunMs = Math.round(await evaluate('performance.now()') - matplotlibStarted);
  assert.ok(!plot.error, plot.error);
  assert.ok(plot.outputs.some((item) => item.kind === 'image' && item.dataUrl?.startsWith('data:image/png;base64,')), 'Conditional plot capture');
  const warmPlotStarted = await evaluate('performance.now()');
  const warmPlot = await runPython('import matplotlib.pyplot as plt\nplt.plot([0,1],[1,0])\nprint("warm plot")');
  timings.matplotlibWarmMs = Math.round(await evaluate('performance.now()') - warmPlotStarted);
  assert.ok(!warmPlot.error, warmPlot.error);
  assert.ok(warmPlot.outputs.some((item) => item.kind === 'image' && item.dataUrl?.startsWith('data:image/png;base64,')));
  const concurrent = await Promise.all([
    runPython('print("queued one")'),
    runPython('print("queued two")'),
  ]);
  assert.ok(concurrent.every((result) => !result.error), 'Concurrent run requests are serialized safely');
  const scrollCode = `for (let i=0;i<60;i++){ console.log("row "+i); await new Promise(resolve=>setTimeout(resolve,15)); }`;
  await evaluate(`window.__workspaceFixture.conversation('console-scroll-test'); window.__workspaceFixture.generated('javascript', ${JSON.stringify(scrollCode)});`);
  await waitFor(() => evaluate(`document.querySelector('[data-testid="select-language"]')?.value === 'javascript' && !document.querySelector('.ws-language-status')`), 'scroll test JavaScript mode');
  const consoleStarted = await evaluate('performance.now()');
  await click('[data-testid="button-run-code"]');
  await waitFor(() => evaluate(`document.querySelectorAll('[data-testid="console-output"] pre.c-stdout').length >= 30`), 'scrollable streaming output');
  await evaluate(`(() => { const el=document.querySelector('[data-testid="console-output"]'); el.scrollTop=0; el.dispatchEvent(new Event('scroll')); })()`);
  await waitFor(() => evaluate(`document.querySelectorAll('[data-testid="console-output"] pre.c-stdout').length >= 40`), 'output while reading older lines');
  assert.equal(await evaluate(`document.querySelector('[data-testid="console-output"]').scrollTop`), 0, 'New output does not pull a reader away from older lines');
  await evaluate(`(() => { const el=document.querySelector('[data-testid="console-output"]'); el.scrollTop=el.scrollHeight; el.dispatchEvent(new Event('scroll')); })()`);
  await waitFor(() => evaluate(`document.querySelectorAll('[data-testid="console-output"] pre.c-stdout').length >= 45`), 'output after returning to bottom');
  await waitFor(() => evaluate(`(() => { const el=document.querySelector('[data-testid="console-output"]'); return el.scrollHeight-el.clientHeight-el.scrollTop <= 2; })()`), 'console follows output after returning to bottom');
  assert.ok(await evaluate(`(() => { const el=document.querySelector('[data-testid="console-output"]'); return el.scrollHeight-el.clientHeight-el.scrollTop <= 2; })()`), 'New output follows only after the reader returns to the bottom');
  await waitFor(() => evaluate(`!document.querySelector('[data-testid="status-run"]')`), 'streaming run completion');
  timings.consoleStreamMs = Math.round(await evaluate('performance.now()') - consoleStarted);
  const finalConsoleText = await evaluate(`document.querySelector('[data-testid="console-output"]').textContent`);
  assert.ok(finalConsoleText.includes('row 59'));
  assert.ok(!/Loading JavaScript libraries|Runs Python|Supported packages load/.test(finalConsoleText), 'Console contains user output without explanatory boilerplate');
  const cancelled = await evaluate(`(async()=>{ const ctrl=new AbortController(); setTimeout(()=>ctrl.abort(),50); try { await window.__workspaceFixture.execute({language:'python',code:'while True: pass',signal:ctrl.signal}); return false; } catch(error) { return error.name==='AbortError' && !!document.querySelector('iframe[hidden]'); } })()`);
  assert.equal(cancelled, true);
  const recovered = await runPython('print("recovered after stop")');
  assert.ok(!recovered.error, recovered.error);
  assert.ok(recovered.outputs.some((item) => item.text === 'recovered after stop'));
  await evaluate(`window.__workspaceFixture.open(false); window.__workspaceFixture.conversation('project-reopen-check'); window.__workspaceFixture.saveProject([
    {path:'index.html',content:'<h1>Saved project</h1>'},
    {path:'styles.css',content:'h1 { color: navy; }'}
  ],'index.html',['styles.css'])`);
  await waitFor(() => evaluate(`!document.querySelector('[data-testid="panel-workspace"]')`), 'close before reopening saved project');
  await evaluate(`window.__workspaceFixture.open(true)`);
  await waitFor(() => evaluate(`document.querySelector('[data-testid="project-files-panel"]')?.textContent.includes("2 files")`), 'saved project reopens');
  assert.equal(await evaluate(`document.querySelector('[aria-label="Share styles.css with Nexo"]')?.checked`), true, 'Selected project context survives workspace close and reopen');
  await evaluate(`window.__workspaceFixture.open(false)`);
  await waitFor(() => evaluate(`!document.querySelector('[data-testid="panel-workspace"]')`), 'close reopened project');
  await evaluate(`window.__workspaceFixture.open(true)`);
  await waitFor(() => evaluate(`document.querySelector('[data-testid="project-files-panel"]')?.textContent.includes("Saved project")`), 'project survives a second workspace mount');
  assert.equal(await evaluate(`document.querySelector('[aria-label="Share styles.css with Nexo"]')?.checked`), true, 'Selected files remain selected after a second reopen');
  await evaluate(`localStorage.setItem('nexo-conversation-v2:focus-check', ${JSON.stringify(JSON.stringify({
    conversation: { id: 'focus-check', title: 'Focus check', messages: [{ id: 'focus-message', role: 'user', content: 'Test keyboard focus.' }], createdAt: 1, updatedAt: 2 },
    updatedAt: 2,
  }))})`);
  await evaluate(`localStorage.setItem('nexo-provider-groq-key', 'test-only-groq-key')`);
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await waitFor(() => evaluate(`!!document.querySelector('[data-testid="button-start-from-home"]')`), 'chat home');
  await pressKey('[data-testid="button-start-from-home"]', 'Enter', 'Enter', 13);
  await waitFor(() => evaluate(`!!document.querySelector('[data-testid="button-toggle-sidebar"]')`), 'conversation page');
  assert.equal(await evaluate(`document.querySelector('[data-testid="button-toggle-sidebar"]').getAttribute('aria-expanded')`), 'true');
  await pressKey('[data-testid="button-toggle-sidebar"]', 'Enter', 'Enter', 13);
  await waitFor(() => evaluate(`document.querySelector('[data-testid="button-toggle-sidebar"]')?.getAttribute('aria-expanded') === 'false'`), 'desktop sidebar close');
  await waitFor(() => evaluate(`document.activeElement?.dataset.testid === 'button-toggle-sidebar'`), 'desktop sidebar focus return');
  assert.equal(await evaluate(`document.activeElement?.dataset.testid`), 'button-toggle-sidebar', 'Sidebar close returns focus to its toggle on desktop');
  await pressKey('[data-testid="button-toggle-sidebar"]', 'Enter', 'Enter', 13);
  await waitFor(() => evaluate(`document.querySelector('[data-testid="button-toggle-sidebar"]')?.getAttribute('aria-expanded') === 'true'`), 'desktop sidebar reopen');
  await pressKey('[data-testid="button-open-settings"]', 'Tab', 'Tab', 9);
  assert.equal(await evaluate(`document.activeElement?.dataset.testid`), 'separator-sidebar', 'Desktop sidebar keeps the normal tab order instead of trapping focus');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 700, deviceScaleFactor: 1, mobile: true });
  await waitFor(() => evaluate(`Boolean(document.activeElement?.closest('#history-sidebar'))`), 'mobile sidebar initial focus');
  await pressTab(true);
  assert.equal(await evaluate(`document.activeElement?.dataset.testid`), 'button-open-settings', 'Shift+Tab wraps to the last sidebar control on mobile');
  await pressTab();
  assert.equal(await evaluate(`document.activeElement?.dataset.testid`), 'button-home', 'Tab wraps to the first sidebar control on mobile');
  await evaluate(`document.querySelector('[data-testid="button-toggle-sidebar"]').focus()`);
  assert.ok(await evaluate(`Boolean(document.activeElement?.closest('#history-sidebar'))`), 'Programmatic focus cannot escape the mobile sidebar');
  await pressKey(null, 'Escape', 'Escape', 27);
  await waitFor(() => evaluate(`document.querySelector('[data-testid="button-toggle-sidebar"]')?.getAttribute('aria-expanded') === 'false'`), 'mobile sidebar close');
  await waitFor(() => evaluate(`document.activeElement?.dataset.testid === 'button-toggle-sidebar'`), 'mobile sidebar focus return');
  assert.equal(await evaluate(`document.activeElement?.dataset.testid`), 'button-toggle-sidebar', 'Sidebar close returns focus to its toggle on mobile');
  console.log('Workspace timings (ms):', JSON.stringify(timings));
  console.log('Workspace browser checks passed: lazy editor, line wrapping, exact copy/denial, scroll recovery/following, draft restore, queued runs, on-demand languages/packages, warm Python, plots and cancellation.');
} finally {
  socket?.close();
  for (const child of [browser, vite]) child.kill('SIGTERM');
  await delay(500);
  for (const child of [browser, vite]) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await rm(profile, { recursive: true, force: true });
}
