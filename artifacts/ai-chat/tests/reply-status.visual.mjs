import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromium = process.env.CHROMIUM_PATH ?? '/repl/tools/bin/chromium';

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitFor(check, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError}` : ''}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(3000),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

const vitePort = await freePort();
const cdpPort = await freePort();
const profileDir = await mkdtemp(path.join(tmpdir(), 'reply-status-chromium-'));
const vite = spawn(
  'pnpm',
  ['exec', 'vite', '--config', 'vite.config.ts', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
  { cwd: packageDir, stdio: 'ignore' },
);
const browser = spawn(
  chromium,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let socket;
let nextId = 0;
const pending = new Map();

function cdp(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`DevTools command timed out: ${method}`));
    }, 10000);
    pending.set(id, {
      resolve(value) {
        clearTimeout(timeout);
        resolve(value);
      },
      reject(error) {
        clearTimeout(timeout);
        reject(error);
      },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text ?? 'Browser evaluation failed');
  }
  return response.result?.value;
}

try {
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${vitePort}/tests/reply-status.html`);
    return response.ok;
  }, 'the test-only Vite fixture');
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
    const targets = await response.json();
    return targets.find((item) => item.type === 'page');
  }, 'Chromium DevTools');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message));
    else call.resolve(message.result);
  });

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${vitePort}/tests/reply-status.html` });
  await waitFor(async () => {
    try {
      return (await evaluate('window.__replyStatusFixtureReady')) === true;
    } catch {
      return false;
    }
  }, 'the ReplyStatus fixture to render');
  await delay(100);

  const baseline = await evaluate('window.__verifyReplyStatusFixture()');
  const transitions = await evaluate('window.__runReplyStatusTransitions()');
  await cdp('Emulation.setEmulatedMedia', {
    media: 'screen',
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await waitFor(async () => (await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches")) === true, 'reduced-motion preference to apply');
  const reducedMotion = await evaluate('window.__verifyReducedMotion()');
  await cdp('Emulation.setEmulatedMedia', {
    media: 'screen',
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });
  await waitFor(async () => (await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches")) === false, 'reduced-motion preference to clear');
  const restoredMotion = await evaluate('window.__verifyMotionRestored()');

  const errors = [
    ...baseline.errors,
    ...transitions.errors,
    ...reducedMotion.errors,
    ...restoredMotion.errors,
  ];
  if (errors.length) {
    console.error('ReplyStatus visual regression checks failed:');
    for (const error of errors) console.error(`- ${error}`);
    console.error(JSON.stringify({ geometry: baseline.geometry, loopSamples: baseline.loopSamples }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(`ReplyStatus visual regression checks passed (${baseline.geometry.length} states, ${baseline.loopSamples.length} loop endpoints, live transitions, 32 rerenders, reduced-motion toggled).`);
  }
} finally {
  socket?.close();
  await Promise.all([stopProcess(browser), stopProcess(vite)]);
  await rm(profileDir, { recursive: true, force: true });
}
