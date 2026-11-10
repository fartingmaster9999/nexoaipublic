import assert from 'node:assert/strict';
import { delay, waitFor, withFixture } from './browser-harness.mjs';

// Use the real App with deterministic provider responses; no live inference/billing.
await withFixture('tests/image-chat.html', async ({ cdp, evaluate, navigate }) => {
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/api/chat')) {
        const requests = JSON.parse(localStorage.getItem('test-chat-requests') || '[]');
        requests.push(JSON.parse(init.body));
        localStorage.setItem('test-chat-requests', JSON.stringify(requests));
        return new Response([
          { content: 'The next message uses the updated mode settings.' },
          { done: true },
        ].map(event => 'data: ' + JSON.stringify(event) + '\\n\\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (!url.endsWith('/api/agent')) return original(input, init);
      const body = JSON.parse(init.body);
      const requests = JSON.parse(localStorage.getItem('test-requests') || '[]');
      requests.push(body);
      localStorage.setItem('test-requests', JSON.stringify(requests));
      const scenario = localStorage.getItem('test-scenario');
      const sse = events => new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\\n\\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });
      if (scenario === 'wait') {
        return sse([{ model: 'qwen', agentProvider: 'groq', agentTask: 'coding' },
          { agentRetry: { afterMs: 30000, history: body.agentHistory || [] } }, { done: true }]);
      }
      if (scenario === 'write' && !body.agentHistory?.length && !body.agentReview) {
        return sse([{ model: 'qwen', agentProvider: 'groq', agentTask: 'coding' }, { agentTool: {
          tool: 'write_project', callId: 'write-once', thoughtSignature: 'signature', history: [],
          arguments: { entrypoint: 'index.html', files: [{ path: 'index.html', content: '<h1>Saved once</h1>' }] }
        } }, { done: true }]);
      }
      if (scenario === 'tool' && !body.agentHistory?.length && !body.agentReview) {
        return sse([{ model: 'qwen', agentProvider: 'groq', agentTask: 'coding' }, { agentTool: {
          tool: 'run_code', callId: 'run-once', thoughtSignature: 'signature', history: [],
          arguments: { language: 'javascript', code: "console.log('completed-before-reload')" }
        } }, { done: true }]);
      }
      if (['tool', 'write'].includes(scenario) && body.agentReview) {
        return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
      }
      return sse([{ content: 'Recovered build complete.' }, { done: true }]);
    };
  })();` });
  await navigate();
  const findCheckpoint = `(() => { const key = Object.keys(localStorage).find(key => key.startsWith('nexo-agent-continuation:')); return key ? JSON.parse(localStorage.getItem(key)) : null; })()`;
  const requests = () => evaluate(`JSON.parse(localStorage.getItem('test-requests') || '[]')`);
  async function openSaved(id) {
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-testid="button-start-from-home"]'))`), 'home after reload');
    await evaluate(`document.querySelector('[data-testid="button-start-from-home"]').click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-testid="conversation-${id}"]'))`), 'saved conversation');
    await evaluate(`document.querySelector('[data-testid="select-conversation-${id}"]').click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-testid="agent-recovery"]'))`), 'explicit recovery notice');
  }
  async function send(text) {
    await evaluate(`document.querySelector('[data-testid="input-message"]').focus()`);
    await cdp('Input.insertText', { text });
    await evaluate(`document.querySelector('[data-testid="button-send-message"]').click()`);
  }

  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-testid="button-start-from-home"]'))`), 'home');
  await evaluate(`localStorage.setItem('test-scenario', 'wait'); document.querySelector('[data-testid="button-start-from-home"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-testid="toggle-agent"]'))`), 'composer');
  await evaluate(`document.querySelector('[data-testid="toggle-agent"]').click()`);
  await waitFor(() => evaluate(`localStorage.getItem('nexo-agent') === '1'`), 'Agent preference saved before opening second tab');
  const openedModeSyncTab = await evaluate(`window.modeSyncTab = window.open(location.href, 'nexo-mode-sync'); Boolean(window.modeSyncTab)`);
  assert.equal(openedModeSyncTab, true, 'a second browser tab must open for cross-tab testing');
  await waitFor(() => evaluate(`(() => { try { return Boolean(window.modeSyncTab?.document.querySelector('[data-testid="toggle-agent"]')); } catch { return false; } })()`), 'second tab mode controls');
  assert.equal(await evaluate(`document.querySelector('[data-testid="toggle-agent"]').textContent.trim()`), 'Agent');
  assert.equal(await evaluate(`document.querySelector('[data-testid="toggle-deepthink"]').textContent.trim()`), 'Deepthink');
  await send('Build with a provider wait');
  await waitFor(() => evaluate(`(${findCheckpoint})?.phase === 'waiting'`), 'checkpoint before provider wait');
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-testid="button-stop-response"]'))`), 'streaming provider wait');
  const pressKey = async (selector, key, code, keyCode) => {
    await evaluate(`document.querySelector('${selector}').focus()`);
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, text: key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
  };
  await pressKey('[data-testid="toggle-deepthink"]', 'Enter', 'Enter', 13);
  assert.equal(await evaluate(`document.querySelector('[data-testid="toggle-deepthink"]').getAttribute('aria-pressed')`), 'true');
  await pressKey('[data-testid="toggle-deepthink"]', ' ', 'Space', 32);
  assert.equal(await evaluate(`document.querySelector('[data-testid="toggle-deepthink"]').getAttribute('aria-pressed')`), 'false');
  await pressKey('[data-testid="toggle-deepthink"]', 'Enter', 'Enter', 13);
  await pressKey('[data-testid="toggle-agent"]', ' ', 'Space', 32);
  assert.equal(await evaluate(`document.querySelector('[data-testid="toggle-agent"]').getAttribute('aria-pressed')`), 'false');
  await pressKey('[data-testid="toggle-agent"]', 'Enter', 'Enter', 13);
  assert.equal(await evaluate(`document.querySelector('[data-testid="toggle-agent"]').getAttribute('aria-pressed')`), 'true');
  await pressKey('[data-testid="toggle-agent"]', ' ', 'Space', 32);
  const streamingModes = await evaluate(`(() => {
    const deepthink = document.querySelector('[data-testid="toggle-deepthink"]');
    const agent = document.querySelector('[data-testid="toggle-agent"]');
    return {
      deepthink: { text: deepthink.textContent.trim(), name: deepthink.getAttribute('aria-label'), pressed: deepthink.getAttribute('aria-pressed'), description: deepthink.getAttribute('aria-description'), title: deepthink.title, active: deepthink.classList.contains('is-on') },
      agent: { text: agent.textContent.trim(), name: agent.getAttribute('aria-label'), pressed: agent.getAttribute('aria-pressed'), description: agent.getAttribute('aria-description'), title: agent.title, active: agent.classList.contains('is-on') }
    };
  })()`);
  assert.deepEqual([streamingModes.deepthink.text, streamingModes.deepthink.name, streamingModes.deepthink.pressed, streamingModes.deepthink.active], ['Deepthink', 'Deepthink', 'true', true]);
  assert.match(streamingModes.deepthink.description, /next message; this reply keeps its original mode/);
  assert.match(streamingModes.deepthink.title, /Uses deeper reasoning/);
  assert.deepEqual([streamingModes.agent.text, streamingModes.agent.name, streamingModes.agent.pressed, streamingModes.agent.active], ['Agent', 'Agent', 'false', false]);
  assert.match(streamingModes.agent.description, /Off\. Select to route/);
  assert.match(streamingModes.agent.description, /next message; this reply keeps its original route/);
  assert.match(streamingModes.agent.title, /Off\. Select to route/);
  const readTabModes = (tab) => `(() => {
    const doc = ${tab}.document;
    const read = id => {
      const button = doc.querySelector('[data-testid="toggle-' + id + '"]');
      return {
        pressed: button.getAttribute('aria-pressed'),
        active: button.classList.contains('is-on'),
        description: button.getAttribute('aria-description'),
        title: button.title,
      };
    };
    return { deepthink: read('deepthink'), agent: read('agent') };
  })()`;
  await evaluate(`document.querySelector('[data-testid="toggle-deepthink"]').click()`);
  await waitFor(() => evaluate(`${readTabModes('window.modeSyncTab')}.deepthink.pressed === 'false'`), 'Deepthink change in first tab syncs to second');
  await evaluate(`document.querySelector('[data-testid="toggle-agent"]').click()`);
  await waitFor(() => evaluate(`${readTabModes('window.modeSyncTab')}.agent.pressed === 'true'`), 'Agent change in first tab syncs to second');
  const secondTabAfterFirstChange = await evaluate(readTabModes('window.modeSyncTab'));
  assert.deepEqual([secondTabAfterFirstChange.deepthink.pressed, secondTabAfterFirstChange.deepthink.active], ['false', false]);
  assert.match(secondTabAfterFirstChange.deepthink.description, /Off\. Select for deeper reasoning/);
  assert.match(secondTabAfterFirstChange.deepthink.title, /Off\. Select for deeper reasoning/);
  assert.deepEqual([secondTabAfterFirstChange.agent.pressed, secondTabAfterFirstChange.agent.active], ['true', true]);
  assert.match(secondTabAfterFirstChange.agent.description, /Routes your next message to Agent/);
  assert.match(secondTabAfterFirstChange.agent.title, /Routes your next message to Agent/);
  await evaluate(`window.modeStorageEvents = []; window.addEventListener('storage', event => { if (['nexo-deepthink', 'nexo-agent'].includes(event.key)) window.modeStorageEvents.push({ key: event.key, value: event.newValue }); })`);
  await evaluate(`window.modeSyncTab.document.querySelector('[data-testid="toggle-deepthink"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('[data-testid="toggle-deepthink"]').getAttribute('aria-pressed') === 'true'`), 'Deepthink change in second tab syncs to first');
  await evaluate(`window.modeSyncTab.document.querySelector('[data-testid="toggle-agent"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('[data-testid="toggle-agent"]').getAttribute('aria-pressed') === 'false'`), 'Agent change in second tab syncs to first');
  const firstTabAfterSecondChange = await evaluate(readTabModes('window'));
  assert.deepEqual([firstTabAfterSecondChange.deepthink.pressed, firstTabAfterSecondChange.deepthink.active], ['true', true]);
  assert.match(firstTabAfterSecondChange.deepthink.description, /Uses deeper reasoning/);
  assert.match(firstTabAfterSecondChange.deepthink.description, /next message; this reply keeps its original mode/);
  assert.match(firstTabAfterSecondChange.deepthink.title, /Uses deeper reasoning/);
  assert.deepEqual([firstTabAfterSecondChange.agent.pressed, firstTabAfterSecondChange.agent.active], ['false', false]);
  assert.match(firstTabAfterSecondChange.agent.description, /Off\. Select to route/);
  assert.match(firstTabAfterSecondChange.agent.description, /next message; this reply keeps its original route/);
  assert.match(firstTabAfterSecondChange.agent.title, /Off\. Select to route/);
  await evaluate(`(() => {
    const record = event => {
      if (['nexo-deepthink', 'nexo-agent'].includes(event.key)) {
        event.currentTarget.modeStorageEvents.push({ key: event.key, value: event.newValue, trusted: event.isTrusted });
      }
    };
    window.modeStorageEvents = [];
    window.addEventListener('storage', record);
    window.modeSyncTab.modeStorageEvents = [];
    window.modeSyncTab.addEventListener('storage', record);
  })()`);
  const rapidModeChanges = [
    ['deepthink', 'window'],
    ['deepthink', 'window.modeSyncTab'],
    ['deepthink', 'window'],
    ['deepthink', 'window.modeSyncTab'],
    ['agent', 'window'],
    ['agent', 'window.modeSyncTab'],
    ['agent', 'window'],
    ['agent', 'window.modeSyncTab'],
    ['deepthink', 'window.modeSyncTab'],
    ['deepthink', 'window'],
    ['agent', 'window.modeSyncTab'],
    ['agent', 'window'],
  ];
  const expectedModes = { deepthink: true, agent: false };
  const storageKeyForMode = { deepthink: 'nexo-deepthink', agent: 'nexo-agent' };
  for (const [mode, tab] of rapidModeChanges) {
    const previous = expectedModes[mode];
    await evaluate(`${tab}.document.querySelector('[data-testid="toggle-${mode}"]').click()`);
    expectedModes[mode] = !previous;
    await waitFor(() => evaluate(`(() => {
      const expected = localStorage.getItem('${storageKeyForMode[mode]}') === '1' ? 'true' : 'false';
      const first = document.querySelector('[data-testid="toggle-${mode}"]');
      const second = window.modeSyncTab.document.querySelector('[data-testid="toggle-${mode}"]');
      return first.getAttribute('aria-pressed') === expected &&
        second.getAttribute('aria-pressed') === expected &&
        first.classList.contains('is-on') === (expected === 'true') &&
        second.classList.contains('is-on') === (expected === 'true');
    })()`), `rapid ${mode} update from ${tab === 'window' ? 'first' : 'second'} tab settles`);
    assert.equal(await evaluate(`localStorage.getItem('${storageKeyForMode[mode]}')`), expectedModes[mode] ? '1' : '0');
  }
  const settledModes = await evaluate(`(() => ({
    first: ${readTabModes('window')},
    second: ${readTabModes('window.modeSyncTab')},
    deepthink: localStorage.getItem('nexo-deepthink'),
    agent: localStorage.getItem('nexo-agent'),
    trustedEvents: [...window.modeStorageEvents, ...window.modeSyncTab.modeStorageEvents].filter(event => event.trusted).length
  }))()`);
  assert.deepEqual([settledModes.deepthink, settledModes.agent], [expectedModes.deepthink ? '1' : '0', expectedModes.agent ? '1' : '0']);
  assert.equal(settledModes.trustedEvents, rapidModeChanges.length, 'each user toggle should produce one storage event, with no receiving-tab write echo');
  for (const tabModes of [settledModes.first, settledModes.second]) {
    assert.deepEqual([tabModes.deepthink.pressed, tabModes.deepthink.active], [expectedModes.deepthink ? 'true' : 'false', expectedModes.deepthink]);
    assert.deepEqual([tabModes.agent.pressed, tabModes.agent.active], [expectedModes.agent ? 'true' : 'false', expectedModes.agent]);
  }
  await evaluate(`(() => {
    window.dispatchEvent(new StorageEvent('storage', { key: 'nexo-deepthink', newValue: '${expectedModes.deepthink ? '0' : '1'}', storageArea: localStorage }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'nexo-agent', newValue: '${expectedModes.agent ? '0' : '1'}', storageArea: localStorage }));
  })()`);
  await waitFor(() => evaluate(`(() => {
    const first = ${readTabModes('window')};
    const second = ${readTabModes('window.modeSyncTab')};
    return first.deepthink.pressed === '${expectedModes.deepthink ? 'true' : 'false'}' &&
      first.agent.pressed === '${expectedModes.agent ? 'true' : 'false'}' &&
      second.deepthink.pressed === first.deepthink.pressed &&
      second.agent.pressed === first.agent.pressed;
  })()`), 'stale storage events cannot undo the newest saved modes');
  assert.equal((await requests())[0].deepthink, false, 'changes in either tab must not alter the in-flight request mode');
  assert.equal((await requests()).length, 1, 'changes in either tab must not start a second request or change the in-flight Agent route');
  assert.equal(await evaluate(`[...window.modeStorageEvents, ...window.modeSyncTab.modeStorageEvents].filter(event => event.trusted).length`), rapidModeChanges.length, 'receiving tabs must not echo mode changes back into storage');
  const waiting = await evaluate(findCheckpoint);
  assert.equal(waiting.retries, 1);
  await cdp('Page.reload');
  await openSaved(waiting.conversationId);
  const recoveryText = await evaluate(`document.querySelector('[data-testid="agent-recovery"]')?.textContent || ''`);
  assert.match(recoveryText, /saved files and completed steps are safe/i);
  assert.match(recoveryText, /completed steps will not be repeated/i);
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="button-resume-agent"]'))`), true, 'a resumable checkpoint must offer an explicit resume action');
  await delay(400);
  assert.equal((await requests()).length, 1, 'reload and selection must not request inference');
  assert.equal(await evaluate(`document.querySelectorAll('iframe').length`), 0, 'reload must not execute a preview');
  // Leave a bounded window so the resume click must still wait before requesting.
  await evaluate(`(() => { const key = 'nexo-agent-continuation:' + encodeURIComponent(${JSON.stringify(waiting.conversationId)}); const c = JSON.parse(localStorage.getItem(key)); c.waitUntil = Date.now() + 1200; localStorage.setItem(key, JSON.stringify(c)); localStorage.setItem('test-scenario', 'finish'); })()`);
  await evaluate(`document.querySelector('[data-testid="button-resume-agent"]').click()`);
  await delay(200);
  assert.equal((await requests()).length, 1, 'explicit resume respects remaining wait');
  await waitFor(async () => (await requests()).length === 2, 'resumed provider request');
  await waitFor(() => evaluate(`document.body.textContent.includes('Recovered build complete.')`), 'completed resumed response');
  assert.equal((await requests())[1].agentRetryCount, 1);
  assert.equal((await requests())[1].deepthink, false, 'resuming keeps the original request mode');
  await waitFor(() => evaluate(`!(${findCheckpoint})`), 'completed checkpoint cleanup');
  await send('Use the updated next-message modes');
  await waitFor(() => evaluate(`JSON.parse(localStorage.getItem('test-chat-requests') || '[]').length === 1`), 'next message with updated modes');
  const nextMessage = await evaluate(`JSON.parse(localStorage.getItem('test-chat-requests'))[0]`);
  assert.equal(nextMessage.deepthink, true);
  await waitFor(() => evaluate(`document.body.textContent.includes('The next message uses the updated mode settings.')`), 'updated mode response');
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-testid="button-send-message"]'))`), 'next message completion');
  await pressKey('[data-testid="toggle-deepthink"]', 'Enter', 'Enter', 13);
  await pressKey('[data-testid="toggle-agent"]', ' ', 'Space', 32);
  assert.equal(await evaluate(`document.querySelector('[data-testid="toggle-deepthink"]').getAttribute('aria-pressed')`), 'false');
  assert.equal(await evaluate(`document.querySelector('[data-testid="toggle-agent"]').getAttribute('aria-pressed')`), 'true');

  // Start a separate request, complete the real browser runner, reload during its optional review.
  await evaluate(`document.querySelector('[data-testid="button-close-workspace"]')?.click()`);
  await evaluate(`localStorage.setItem('test-scenario', 'tool')`);
  await send('Run a tool then recover it');
  await waitFor(() => evaluate(`(${findCheckpoint})?.history?.at(-1)?.result.includes('stdout: completed-before-reload')`), 'completed tool result saved before review', 25000);
  const completed = await evaluate(findCheckpoint);
  const count = (await requests()).length;
  await cdp('Page.reload');
  await openSaved(completed.conversationId);
  await delay(300);
  assert.equal((await requests()).length, count, 'completed code must not rerun or request on reload');
  await evaluate(`localStorage.setItem('test-scenario', 'finish'); document.querySelector('[data-testid="button-resume-agent"]').click()`);
  await waitFor(async () => (await requests()).length === count + 1, 'continuation carrying completed output');
  const continued = (await requests()).at(-1);
  assert.equal(continued.agentHistory.at(-1).callId, 'run-once');
  assert.match(continued.agentHistory.at(-1).result, /stdout: completed-before-reload/);
  await waitFor(() => evaluate(`!(${findCheckpoint})`), 'tool build completion');

  // Corrupt and future-version records never expose a resume action or change history.
  await evaluate(`document.querySelector('[data-testid="button-close-workspace"]')?.click()`);
  for (const raw of ['{bad', '{"version":999}']) {
    await evaluate(`localStorage.setItem('nexo-agent-continuation:' + encodeURIComponent(${JSON.stringify(completed.conversationId)}), ${JSON.stringify(raw)})`);
    await cdp('Page.reload');
    await openSaved(completed.conversationId);
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="button-resume-agent"]'))`), false);
    assert.equal((await requests()).length, count + 1);
    await evaluate(`document.querySelector('[data-testid="button-dismiss-recovery"]').click()`);
  }

  // Stop persists an explicit cancellation and is not offered as resumable after reload.
  await evaluate(`localStorage.setItem('test-scenario', 'wait')`);
  await send('Cancel this build');
  await waitFor(() => evaluate(`(${findCheckpoint})?.phase === 'waiting'`), 'cancellable wait');
  const cancelled = await evaluate(findCheckpoint);
  await evaluate(`document.querySelector('[data-testid="button-stop-response"]').click()`);
  await waitFor(() => evaluate(`(${findCheckpoint})?.phase === 'cancelled'`), 'saved cancellation');
  const stoppedCount = (await requests()).length;
  await cdp('Page.reload');
  await openSaved(cancelled.conversationId);
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="button-resume-agent"]'))`), false);
  assert.equal((await requests()).length, stoppedCount);
  await evaluate(`document.querySelector('[data-testid="button-dismiss-recovery"]').click()`);

  // A saved file update is not replayed on reload or resume, and opt-outs survive.
  await evaluate(`localStorage.setItem('test-scenario', 'write')`);
  await send('Write an app once');
  await waitFor(() => evaluate(`(${findCheckpoint})?.history?.at(-1)?.tool === 'write_project' && (${findCheckpoint})?.phase === 'ready'`), 'saved project tool result', 25000);
  const written = await evaluate(findCheckpoint);
  await evaluate(`(() => {
    const key = 'nexo-project-v1:' + encodeURIComponent(${JSON.stringify(written.conversationId)});
    const p = JSON.parse(localStorage.getItem(key));
    p.files[0].content = '<h1>Manual edit after the write</h1>';
    p.selectedPaths = [];
    localStorage.setItem(key, JSON.stringify(p));
  })()`);
  const projectKey = `nexo-project-v1:${encodeURIComponent(written.conversationId)}`;
  const manuallyEditedBeforeReload = await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(projectKey)})).files[0].content`);
  assert.equal(manuallyEditedBeforeReload, '<h1>Manual edit after the write</h1>', 'manual project edits must be saved before reload');
  await delay(100);
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(projectKey)})).files[0].content`), '<h1>Manual edit after the write</h1>', 'the active app must not overwrite a newer saved project');
  const writeCount = (await requests()).length;
  await cdp('Page.reload');
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(projectKey)})).files[0].content`), '<h1>Manual edit after the write</h1>', 'a page reload must not revert project files');
  await openSaved(written.conversationId);
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(projectKey)})).files[0].content`), '<h1>Manual edit after the write</h1>', 'reload must preserve manual project edits');
  assert.equal((await requests()).length, writeCount);
  await evaluate(`localStorage.setItem('test-scenario', 'finish'); document.querySelector('[data-testid="button-resume-agent"]').click()`);
  await waitFor(async () => (await requests()).length === writeCount + 1, 'write continuation');
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(projectKey)})).files[0].content`), '<h1>Manual edit after the write</h1>', 'resume must preserve manual project edits');
  const writeContinuation = (await requests()).at(-1);
  assert.equal(writeContinuation.agentHistory.at(-1).callId, 'write-once');
  assert.equal(writeContinuation.agentHistory.at(-1).arguments.files[0].content, '', 'historical source respects deselection');
  assert.equal(writeContinuation.projectFiles, undefined);
  const savedProject = await evaluate(`JSON.parse(localStorage.getItem('nexo-project-v1:' + encodeURIComponent(${JSON.stringify(written.conversationId)})))`);
  assert.equal(savedProject.files[0].content, '<h1>Manual edit after the write</h1>');
  assert.deepEqual(savedProject.selectedPaths, []);
  console.log('PASS: provider wait and completed tool reload; explicit resume; no automatic execution or write replay; source privacy; cancellation; corrupt/versioned records.');
});
