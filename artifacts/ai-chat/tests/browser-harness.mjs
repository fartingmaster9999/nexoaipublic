import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export { delay };
export async function waitFor(check, description, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await delay(70);
  }
  throw new Error(`Timed out: ${description}`);
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
export async function withFixture(fixture, test) {
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const port = await freePort(), debug = await freePort(), requests = [];
  const profile = await mkdtemp(path.join(tmpdir(), 'nexo-widgets-'));
  const vite = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd, env: { ...process.env, PORT: String(port), BASE_PATH: '/' }, stdio: 'ignore',
  });
  const browser = spawn(process.env.CHROMIUM_PATH ?? '/repl/tools/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-popup-blocking',
    '--disable-dev-shm-usage', '--disable-gpu', `--remote-debugging-port=${debug}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let socket, sequence = 0;
  const errors = [];
  const pending = new Map();
  function cdp(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const response = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result?.value;
  }
  const navigate = () => cdp('Page.navigate', { url: `http://127.0.0.1:${port}/${fixture}` });
  try {
    await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/${fixture}`)).ok; } catch { return false; } }, 'test Vite');
    let target;
    await waitFor(async () => { try { target = (await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json()).find((x) => x.type === 'page'); return !!target; } catch { return false; } }, 'Chromium');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url);
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
      if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) errors.push(message.params.args.map((x) => x.description ?? x.value));
      if (message.method === 'Page.javascriptDialogOpening') void cdp('Page.handleJavaScriptDialog', { accept: true });
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message)); else call.resolve(message.result);
    });
    await cdp('Page.enable');
    await cdp('Runtime.enable');
    await cdp('Network.enable');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await navigate();
    await test({ cdp, evaluate, navigate, requests });
  } catch (error) {
    console.error('Fixture diagnostics:', errors, await evaluate(`({path:location.pathname, last:Array.from(document.querySelectorAll('.message-row.assistant')).at(-1)?.textContent, fallback:document.querySelector('.widget-fallback')?.textContent, svg:document.querySelectorAll('.nx-chart svg').length, active:document.querySelector('[data-testid^="active-conversation-"]')?.dataset.testid})`).catch(() => 'unavailable'));
    throw error;
  } finally {
    socket?.close();
    for (const child of [browser, vite]) child.kill('SIGTERM');
    await delay(400);
    for (const child of [browser, vite]) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(profile, { recursive: true, force: true });
  }
}
