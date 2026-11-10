import assert from 'node:assert/strict';
import { withFixture, waitFor } from './browser-harness.mjs';

const manifest = steps => `<script type="application/json" id="nexo-interaction-checks">${JSON.stringify({ steps })}</script>`;
const formSteps = [
  { action: 'fill', selector: '#task', value: 'Local item' },
  { action: 'click', selector: '#add' },
  { action: 'assertText', selector: '#tasks', value: 'Local item' },
  { action: 'assertValue', selector: '#task', value: '' },
  { action: 'fill', selector: '#task', value: 'Second item' },
  { action: 'submit', selector: '#form' },
  { action: 'assertCount', selector: '#tasks li', value: 2 },
];
const form = broken => `<form id="form"><label for="task">Task</label><input id="task" required>
  <button id="add">Add</button></form><ul id="tasks"></ul>
  <script>document.querySelector('form').addEventListener('submit',event=>{
    event.preventDefault();${broken ? '' : `const item=document.createElement('li');item.textContent=document.querySelector('#task').value;
    document.querySelector('#tasks').append(item);document.querySelector('#task').value='';`}
  });</script>${manifest(formSteps)}`;
const counterSteps = [
  { action: 'assertText', selector: '#count', value: '0' },
  { action: 'click', selector: '#increment' },
  { action: 'assertText', selector: '#count', value: '1' },
  { action: 'click', selector: '#increment' },
  { action: 'assertText', selector: '#count', value: '2' },
  { action: 'check', selector: '#enabled', value: true },
  { action: 'assertChecked', selector: '#enabled', value: true },
];
const counter = broken => `<button id="increment">Increment</button><output id="count">0</output>
  <label><input type="checkbox" id="enabled">Enabled</label>
  <script>let count=0;document.querySelector('#increment').onclick=()=>{
    setTimeout(()=>document.querySelector('#count').textContent=String(count${broken ? '' : '+=1'}),120);
  };</script>${manifest(counterSteps)}`;

await withFixture('tests/preview-interactions.html', async ({ evaluate, requests }) => {
  await waitFor(() => evaluate('!!window.__interactions'), 'interaction fixture');
  const run = source => evaluate(`window.__interactions.run(${JSON.stringify(source)})`);
  for (const [name, source, failedStep] of [
    ['working form', form(false), undefined], ['broken form', form(true), 3],
    ['working counter', counter(false), undefined], ['broken counter', counter(true), 3],
  ]) {
    const actual = await run(source);
    assert.deepEqual(actual.diagnostics, [], `${name} runtime`);
    assert.equal(actual.result.status, 'complete', name);
    const failure = actual.result.steps.find(step => step.reason !== 'ok');
    assert.equal(failure?.step, failedStep, name);
    if (failedStep) {
      assert.equal(failure.reason, 'mismatch');
      assert.equal(actual.result.steps.length, failedStep, 'stops after first failure');
      assert.match(actual.text, /Nexo execution status: failed/);
    } else {
      assert.ok(actual.result.steps.every(step => step.reason === 'ok'));
      assert.match(actual.text, /Only the supplied local checks passed/);
    }
    assert.doesNotMatch(JSON.stringify(actual.result), /Local item|Second item|<|cookie|secret/);
    assert.equal(await evaluate(`document.querySelector('[data-testid="frame-preview"]').getAttribute('sandbox')`), 'allow-scripts');
    assert.equal(await evaluate(`(() => {try{return document.querySelector('[data-testid="frame-preview"]').contentWindow.document.body.innerText;}catch(_){return 'blocked';}})()`), 'blocked');
    console.log(`PASS ${name}`);
  }
  const invalid = await run(`<button id="increment">Increment</button>${manifest([{ action: 'eval', selector: '#increment', value: 'parent.document.body' }])}`);
  assert.equal(invalid.result.status, 'invalid');
  const noPlan = await run('<h1>No interaction plan</h1>');
  assert.equal(noPlan.result.status, 'not-requested');
  assert.match(noPlan.text, /not verified/);
  const missing = await run(manifest([{ action: 'assertText', selector: '#missing', value: 'x' }]));
  assert.equal(missing.result.steps[0].reason, 'target');
  const disabled = await run(`<button disabled id="off">Off</button>${manifest([
    { action: 'click', selector: '#off' }, { action: 'assertText', selector: '#off', value: 'Off' },
  ])}`);
  assert.equal(disabled.result.steps[0].reason, 'target');
  const validation = await run(`<form id="form"><input id="required" required><button>Add</button></form><output id="count">0</output>
    <script>document.querySelector('form').onsubmit=()=>document.querySelector('#count').textContent='1';</script>
    ${manifest([{ action: 'submit', selector: '#form' }, { action: 'assertText', selector: '#count', value: '0' }])}`);
  assert.ok(validation.result.steps.every(step => step.reason === 'ok'), 'native validity retained');
  // Inject forged reports while checks are pending (not merely after completion).
  const forgedSource = counter(false).replace('</script>', `</script><script>
    window.addEventListener('load',()=>{
      const id=document.scripts[0].textContent.match(/var previewId="([^"]+)"/)[1];
      parent.postMessage({type:'nexo-preview-interactions',previewId:'wrong-id',result:{status:'not-requested',steps:[]}},'*');
      parent.postMessage({type:'nexo-preview-interactions',previewId:id,result:{status:'complete',steps:[{step:1,action:'eval',reason:'ok'}]}},'*');
      parent.postMessage({type:'nexo-preview-interactions',previewId:id,result:{status:'complete',steps:[{step:1,action:'assertText',reason:'ok'}]}},'*');
    });
  </script>`);
  await evaluate(`void(window.__pendingInteraction=window.__interactions.run(${JSON.stringify(forgedSource)}))`);
  const activeId = await evaluate('window.__interactions.id()');
  await evaluate(`(() => {
    const id=${JSON.stringify(activeId)};
    const forged={type:'nexo-preview-interactions',previewId:id,result:{status:'complete',steps:[
      ${counterSteps.map((step, index) => JSON.stringify({ step: index + 1, action: step.action, reason: 'error' })).slice(0, 1).join(',')}
    ]}};
    window.postMessage(forged,'*');
    const sibling=document.createElement('iframe');sibling.sandbox='allow-scripts';
    sibling.srcdoc='<script>parent.postMessage('+JSON.stringify(forged)+',"*")<\\/script>';document.body.append(sibling);
  })()`);
  assert.equal(await evaluate(`new Promise(resolve=>setTimeout(()=>resolve(window.__interactions.read(${JSON.stringify(activeId)}) ?? null),100))`), null,
    'wrong source, origin, ID, malformed, and incomplete results rejected while active');
  const genuine = await evaluate('window.__pendingInteraction');
  assert.ok(genuine.result.steps.every(step => step.reason === 'ok'), 'only genuine result accepted');
  assert.ok(!requests.some(url => /api\/agent|groq|gemini|openai/.test(url)), 'no provider or credential requests');
  console.log('PASS invalid, missing, disabled, form validity, opaque origin, and message boundary checks');
});
