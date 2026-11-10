import { previewReviewInstrumentation, sanitizePreviewReview, type PreviewReview } from './preview-review.ts';
import { previewFormInstrumentation } from './preview-forms.ts';
import {
  previewInteractionInstrumentation, sanitizeInteractionResult, readInteractionPlan,
  interactionResultMatchesPlan, type InteractionResult, type InteractionPlan,
} from './preview-interactions.ts';
export { formatPreviewReview } from './preview-review.ts';
export type RunLanguage = 'python' | 'javascript' | 'html';
export type RunOutput = { kind: 'stdout' | 'stderr' | 'status' | 'image'; text?: string; dataUrl?: string };
export type PreviewDiagnosticKind = 'error' | 'unhandled-rejection' | 'console-error' | 'resource-error' | 'timeout' | 'limit';
export type PreviewDiagnostic = {
  kind: PreviewDiagnosticKind;
  message: string;
  source?: string;
  line?: number;
};
export type ExecutionResult = {
  outputs: RunOutput[];
  error?: string;
  previewHtml?: string;
  previewId?: string;
};

export const MAX_PREVIEW_DIAGNOSTICS = 8;
const MAX_PREVIEW_MESSAGE_CHARS = 600;
const MAX_PREVIEW_SOURCE_CHARS = 200;
const PREVIEW_WAIT_MS = 12_000;
const PREVIEW_RESULT_TTL_MS = 30_000;
const PREVIEW_RESULT_CACHE_SIZE = 8;

type PreviewResult = {
  diagnostics: PreviewDiagnostic[]; complete: boolean; savedAt: number;
  review?: PreviewReview; interactions?: InteractionResult; interactionPlan?: InteractionPlan | null;
};
type PreviewWaiter = {
  resolve: (diagnostics: PreviewDiagnostic[]) => void;
  reject: (error: DOMException) => void;
  timer: number;
  signal: AbortSignal;
  abort: () => void;
};
const previewResults = new Map<string, PreviewResult>();
const previewWaiters = new Map<string, Set<PreviewWaiter>>();

function sanitizePreviewSource(source: unknown): string | undefined {
  if (typeof source !== 'string' || !source.trim()) return undefined;
  try {
    const url = new URL(source, 'https://preview.invalid');
    const path = `${url.origin === 'https://preview.invalid' ? '' : url.origin}${url.pathname}`;
    return path.slice(0, MAX_PREVIEW_SOURCE_CHARS) || undefined;
  } catch {
    return source.split(/[?#]/, 1)[0].slice(0, MAX_PREVIEW_SOURCE_CHARS) || undefined;
  }
}

export function sanitizePreviewDiagnostic(value: unknown): PreviewDiagnostic | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const allowedKinds: PreviewDiagnosticKind[] = [
    'error', 'unhandled-rejection', 'console-error', 'resource-error', 'timeout', 'limit',
  ];
  if (!allowedKinds.includes(entry.kind as PreviewDiagnosticKind) || typeof entry.message !== 'string') return null;
  const diagnostic: PreviewDiagnostic = {
    kind: entry.kind as PreviewDiagnosticKind,
    message: entry.message.replace(/\u0000/g, '').slice(0, MAX_PREVIEW_MESSAGE_CHARS) || 'The preview reported an unspecified error.',
  };
  const source = sanitizePreviewSource(entry.source);
  if (source) diagnostic.source = source;
  if (typeof entry.line === 'number' && Number.isSafeInteger(entry.line) && entry.line > 0 && entry.line <= 1_000_000) {
    diagnostic.line = entry.line;
  }
  return diagnostic;
}

function boundedDiagnostics(values: unknown[]): PreviewDiagnostic[] {
  const result: PreviewDiagnostic[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const diagnostic = sanitizePreviewDiagnostic(value);
    if (!diagnostic) continue;
    const signature = `${diagnostic.kind}\n${diagnostic.message}\n${diagnostic.source ?? ''}\n${diagnostic.line ?? ''}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    if (result.length < MAX_PREVIEW_DIAGNOSTICS - 1) result.push(diagnostic);
    else {
      result.push({ kind: 'limit', message: 'Additional preview errors were omitted.' });
      break;
    }
  }
  return result;
}

function rememberPreviewResult(previewId: string, result: PreviewResult) {
  previewResults.delete(previewId);
  previewResults.set(previewId, result);
  const now = Date.now();
  for (const [id, value] of previewResults) {
    if (now - value.savedAt > PREVIEW_RESULT_TTL_MS) previewResults.delete(id);
  }
  while (previewResults.size > PREVIEW_RESULT_CACHE_SIZE) {
    const oldest = previewResults.keys().next().value;
    if (oldest === undefined) break;
    previewResults.delete(oldest);
  }
}

/** Called only after the parent validates the exact sandbox frame and its preview ID. */
export function reportPreviewReview(previewId: string, value: unknown) {
  const review = sanitizePreviewReview(value);
  if (!review) return;
  const existing = previewResults.get(previewId);
  rememberPreviewResult(previewId, {
    interactions: existing?.interactions,
    interactionPlan: existing?.interactionPlan,
    diagnostics: existing?.diagnostics ?? [],
    complete: existing?.complete ?? false,
    savedAt: Date.now(),
    review,
  });
}

export function readPreviewReview(previewId: string): PreviewReview | undefined {
  const cached = previewResults.get(previewId);
  return cached?.review && Date.now() - cached.savedAt <= PREVIEW_RESULT_TTL_MS ? { ...cached.review } : undefined;
}

/** The caller must first validate the opaque origin, exact frame, and preview ID. */
export function reportPreviewInteractions(previewId: string, value: unknown): boolean {
  const interactions = sanitizeInteractionResult(value);
  if (!interactions) return false;
  const existing = previewResults.get(previewId);
  if (!existing || existing.interactions || Date.now() - existing.savedAt > PREVIEW_RESULT_TTL_MS ||
      !interactionResultMatchesPlan(interactions, existing.interactionPlan)) return false;
  rememberPreviewResult(previewId, {
    diagnostics: existing?.diagnostics ?? [], complete: existing?.complete ?? false,
    review: existing?.review, interactionPlan: existing.interactionPlan, interactions, savedAt: Date.now(),
  });
  return true;
}

export function readPreviewInteractions(previewId: string): InteractionResult | undefined {
  const cached = previewResults.get(previewId);
  if (!cached?.interactions || Date.now() - cached.savedAt > PREVIEW_RESULT_TTL_MS) return undefined;
  return sanitizeInteractionResult(cached.interactions) ?? undefined;
}

/** Called only after the parent validates the exact sandbox frame and its preview ID. */
export function reportPreviewDiagnostics(previewId: string, values: unknown[], complete = false) {
  const existing = previewResults.get(previewId);
  const diagnostics = boundedDiagnostics([
    ...(existing?.diagnostics ?? []),
    ...values.slice(0, MAX_PREVIEW_DIAGNOSTICS),
  ]);
  const result = {
    diagnostics, complete: complete || existing?.complete === true, savedAt: Date.now(),
    review: existing?.review, interactions: existing?.interactions, interactionPlan: existing?.interactionPlan,
  };
  rememberPreviewResult(previewId, result);
  if (!result.complete) return;
  const waiters = previewWaiters.get(previewId);
  if (!waiters) return;
  for (const waiter of waiters) {
    window.clearTimeout(waiter.timer);
    waiter.signal.removeEventListener('abort', waiter.abort);
    waiter.resolve(diagnostics);
  }
  previewWaiters.delete(previewId);
}

/** Wait for the displayed sandbox frame to finish its first render and short error-capture window. */
export function waitForPreviewDiagnostics(previewId: string, signal: AbortSignal): Promise<PreviewDiagnostic[]> {
  const cached = previewResults.get(previewId);
  if (cached?.complete && Date.now() - cached.savedAt <= PREVIEW_RESULT_TTL_MS) {
    return Promise.resolve(cached.diagnostics);
  }
  if (signal.aborted) return Promise.reject(new DOMException('Stopped', 'AbortError'));
  return new Promise((resolve, reject) => {
    const waiter: PreviewWaiter = {
      resolve,
      reject,
      signal,
      timer: window.setTimeout(() => {
        removeWaiter();
        resolve([{ kind: 'timeout', message: 'The browser preview did not report completion within 12 seconds.' }]);
      }, PREVIEW_WAIT_MS),
      abort: () => {
        removeWaiter();
        reject(new DOMException('Stopped', 'AbortError'));
      },
    };
    const removeWaiter = () => {
      window.clearTimeout(waiter.timer);
      signal.removeEventListener('abort', waiter.abort);
      const waiters = previewWaiters.get(previewId);
      waiters?.delete(waiter);
      if (waiters?.size === 0) previewWaiters.delete(previewId);
    };
    const waiters = previewWaiters.get(previewId) ?? new Set<PreviewWaiter>();
    waiters.add(waiter);
    previewWaiters.set(previewId, waiters);
    signal.addEventListener('abort', waiter.abort, { once: true });
  });
}

function previewInstrumentation(previewId: string) {
  return `(function(){var previewId=${JSON.stringify(previewId)};var diagnostics=[];var seen=new Set();var limit=${MAX_PREVIEW_DIAGNOSTICS};function text(value){try{if(value instanceof Error)return value.message||value.name;if(typeof value==='string')return value;var result=JSON.stringify(value);return result===undefined?String(value):result;}catch(_){return '[unprintable error]';}}function report(kind,message,source,line){message=text(message).replace(/\\u0000/g,'').slice(0,${MAX_PREVIEW_MESSAGE_CHARS});if(!message)message='The preview reported an unspecified error.';source=typeof source==='string'?source.split(/[?#]/,1)[0].slice(0,${MAX_PREVIEW_SOURCE_CHARS}):'';line=Number.isSafeInteger(line)&&line>0&&line<=1000000?line:undefined;var key=kind+'\\\\n'+message+'\\\\n'+source+'\\\\n'+(line||'');if(seen.has(key)||diagnostics.length>=limit)return;seen.add(key);var diagnostic={kind:kind,message:message};if(source)diagnostic.source=source;if(line)diagnostic.line=line;diagnostics.push(diagnostic);try{parent.postMessage({type:'nexo-preview-diagnostic',previewId:previewId,diagnostic:diagnostic},'*');}catch(_){}}window.addEventListener('error',function(event){if(event.target&&event.target!==window){var target=event.target;report('resource-error','A page resource failed to load.',target.src||target.href||'',0);return;}report('error',event.message||event.error||'A script error occurred.',event.filename,event.lineno);},true);window.addEventListener('unhandledrejection',function(event){report('unhandled-rejection',event.reason);});if(window.console&&typeof console.error==='function'){var originalError=console.error.bind(console);console.error=function(){var args=Array.prototype.slice.call(arguments);report('console-error',args.map(text).join(' '));originalError.apply(console,args);};}window.addEventListener('load',function(){window.setTimeout(function(){try{parent.postMessage({type:'nexo-preview-complete',previewId:previewId,diagnostics:diagnostics},'*');}catch(_){}},600);},{once:true});})();`;
}

/** HTML previews run with an opaque origin and a restrictive policy; never add allow-same-origin. */
export function makePreviewHtml(code: string, previewId: string): string {
  rememberPreviewResult(previewId, {
    diagnostics: [], complete: false, savedAt: Date.now(), interactionPlan: readInteractionPlan(code),
  });
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'";
  const head = `<meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width, initial-scale=1"><script>${previewInstrumentation(previewId)}</script><script>${previewReviewInstrumentation(previewId)}</script><script>${previewFormInstrumentation()}</script><script>${previewInteractionInstrumentation(previewId, code)}</script>`;
  const source = code.replace(/^\s*<!doctype\b[^>]*>/i, '');
  let documentHtml: string;
  if (/<head\b[^>]*>/i.test(source)) {
    documentHtml = source.replace(/<head\b[^>]*>/i, (opening) => `${opening}${head}`);
  } else if (/<html\b[^>]*>/i.test(source)) {
    documentHtml = source.replace(/<html\b[^>]*>/i, (opening) => `${opening}<head>${head}</head>`);
  } else if (/<body\b[^>]*>/i.test(source)) {
    documentHtml = `<html><head>${head}</head>${source}</html>`;
  } else {
    documentHtml = `<html><head>${head}</head><body>${source}</body></html>`;
  }
  return `<!doctype html>${documentHtml}`;
}

/** Untrusted code runs in an opaque-origin iframe and worker, never on the application server. */
type ExecuteOptions = {
  language: RunLanguage;
  code: string;
  onOutput?: (output: RunOutput) => void;
  signal?: AbortSignal;
};

let runnerFrame: HTMLIFrameElement | null = null;
let runnerFramePromise: Promise<HTMLIFrameElement> | null = null;
let runQueue: Promise<unknown> = Promise.resolve();

function getRunnerFrame(): Promise<HTMLIFrameElement> {
  if (runnerFrame?.isConnected && runnerFrame.contentWindow) return Promise.resolve(runnerFrame);
  if (runnerFramePromise) return runnerFramePromise;

  const frame = document.createElement('iframe');
  frame.sandbox.add('allow-scripts');
  frame.hidden = true;
  frame.title = 'Isolated code runner';
  frame.setAttribute('aria-hidden', 'true');

  let resolveFrame!: (value: HTMLIFrameElement) => void;
  let rejectFrame!: (reason: Error) => void;
  let settled = false;
  let loadTimer: number;
  const loading = new Promise<HTMLIFrameElement>((resolve, reject) => {
    resolveFrame = resolve;
    rejectFrame = reject;
  });
  const fail = (message: string) => {
    if (settled) return;
    settled = true;
    window.clearTimeout(loadTimer);
    frame.onload = null;
    frame.onerror = null;
    frame.remove();
    rejectFrame(new Error(message));
  };
  frame.onload = () => {
    if (settled) return;
    settled = true;
    window.clearTimeout(loadTimer);
    runnerFrame = frame;
    resolveFrame(frame);
  };
  frame.onerror = () => fail('The code sandbox failed to load. Check your connection and try again.');
  loadTimer = window.setTimeout(() => fail('The code sandbox took too long to load. Check your connection and try again.'), 15000);
  frame.src = `${import.meta.env.BASE_URL}code-runner.html`;
  document.body.append(frame);

  let tracked: Promise<HTMLIFrameElement>;
  tracked = loading.finally(() => {
    if (runnerFramePromise === tracked) runnerFramePromise = null;
  });
  runnerFramePromise = tracked;
  return tracked;
}

function executeInRunner(options: ExecuteOptions): Promise<ExecutionResult> {
  if (options.signal?.aborted) return Promise.reject(new DOMException('Stopped', 'AbortError'));
  return new Promise((resolve, reject) => {
    const runId = crypto.randomUUID();
    const outputs: RunOutput[] = [];
    let totalSize = 0;
    let settled = false;
    let frame: HTMLIFrameElement | null = null;
    let timer: number;
    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener('message', receive);
      options.signal?.removeEventListener('abort', abort);
    };
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ outputs, error });
    };
    const abort = () => {
      if (settled) return;
      frame?.contentWindow?.postMessage({ type: 'stop', runId }, '*');
      settled = true;
      cleanup();
      reject(new DOMException('Stopped', 'AbortError'));
    };
    const receive = (event: MessageEvent) => {
      if (settled || event.source !== frame?.contentWindow || event.data?.runId !== runId) return;
      const data = event.data;
      if (data.type === 'done') return finish(typeof data.error === 'string' ? data.error.slice(0, 10000) : undefined);
      if (data.type !== 'output' || !['stdout', 'stderr', 'status', 'image'].includes(data.output?.kind)) return;
      const output: RunOutput = { kind: data.output.kind };
      if (typeof data.output.text === 'string') output.text = data.output.text.slice(0, 20000);
      if (typeof data.output.dataUrl === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=\r\n]+$/.test(data.output.dataUrl)) output.dataUrl = data.output.dataUrl.slice(0, 2_000_000);
      totalSize += (output.text?.length ?? 0) + (output.dataUrl?.length ?? 0);
      if (totalSize > 4_000_000 || outputs.length >= 500) {
        frame?.contentWindow?.postMessage({ type: 'stop', runId }, '*');
        return finish('Output limit reached. Reduce the amount of output and run again.');
      }
      outputs.push(output);
      options.onOutput?.(output);
    };
    window.addEventListener('message', receive);
    options.signal?.addEventListener('abort', abort, { once: true });
    timer = window.setTimeout(() => {
      frame?.contentWindow?.postMessage({ type: 'stop', runId }, '*');
      finish('Execution timed out after 90 seconds. The sandbox was stopped.');
    }, 90000);
    getRunnerFrame().then((readyFrame) => {
      frame = readyFrame;
      if (settled) return;
      if (options.signal?.aborted) return abort();
      frame.contentWindow?.postMessage({ type: 'run', runId, language: options.language, code: options.code }, '*');
    }).catch((error: unknown) => {
      finish(error instanceof Error ? error.message : 'The code sandbox failed to start.');
    });
  });
}

export function executeCode(options: ExecuteOptions): Promise<ExecutionResult> {
  if (options.signal?.aborted) return Promise.reject(new DOMException('Stopped', 'AbortError'));
  if (options.language === 'html') {
    const previewId = crypto.randomUUID();
    return Promise.resolve({ outputs: [], previewHtml: makePreviewHtml(options.code, previewId), previewId });
  }
  const next = runQueue.then(() => executeInRunner(options), () => executeInRunner(options));
  runQueue = next.then(() => undefined, () => undefined);
  return next;
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    runnerFrame?.remove();
    runnerFrame = null;
    runnerFramePromise = null;
  });
}
