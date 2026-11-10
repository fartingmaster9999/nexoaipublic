import { createRoot } from 'react-dom/client';
import App from '../src/App';
import { MessageMarkdown } from '../src/components/message-markdown';
import { quiz, chart, math, expression, bar, scatter, donut, fence } from './widget-data.mjs';
import '../src/index.css';
import '../src/nexo.css';
import '../src/refine.css';
import '../src/landing.css';

// Dev/test entry only, not imported by the production app or build.
const preview = new URLSearchParams(location.search).has('preview');
const nativeFetch = window.fetch.bind(window);
Object.assign(window, { __widgetRequests: [] });
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.endsWith('/api/chat')) return nativeFetch(input, init);
  const request = JSON.parse(String(init?.body));
  const prompt = request.messages.at(-1).content.toLowerCase();
  (window as unknown as { __widgetRequests: unknown[] }).__widgetRequests.push(request);
  let content = 'A normal **Markdown** answer, with no interactive widget.';
  if (prompt.includes('quiz')) content = 'Try these biology questions.\n\n' + fence(quiz);
  else if (prompt.includes('expression plot')) content = fence(expression);
  else if (prompt.includes('raw math')) content = 'A formula without delimiters:\n\n\\frac{a+b}{c}\n\nA plain equation:\n\nx^2 + y^2 = z^2';
  else if (prompt.includes('render math')) content = 'Ordinary text keeps its spacing with an inline formula $x^2 + y^2 = z^2$.\n\n' +
    'The standalone equation follows:\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\n' +
    'The bracketed display form follows:\n\n\\[\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}\\]\n\n' +
    'The parenthesized form \\(a+b\\) is inline too, while `$literal math$ and \\(literal\\)` stays code.';
  else if (prompt.includes('broken math')) content = String.raw`An unmatched delimiter stays readable: $x+1.

Unsupported notation stays visible: \(\definitelyUndefinedNexoCommand{x}\).`;
  else if (prompt.includes('math')) content = fence(math);
  else if (prompt.includes('scatter')) content = fence(scatter);
  else if (prompt.includes('donut')) content = fence(donut);
  else if (prompt.includes('bar')) content = fence(bar);
  else if (prompt.includes('graph')) content = fence(chart);
  else if (prompt.includes('malformed')) content = 'Still readable.\n\n```nexo-widget\n{"version":1,bad}\n```';
  else if (prompt.includes('unknown')) content = fence({ ...quiz, type: 'execute', fallback: 'Unsupported interactive answer.' });
  else if (prompt.includes('partial')) content = '```nexo-widget\n{"version":1,"type":"quiz"';
  else if (prompt.includes('unverified')) content = fence({ ...chart, provenance: { kind: 'verified', detail: 'Unsourced', sources: [{ title: 'Unknown', url: 'https://example.com/' }] } });
  else if (prompt.includes('code')) content = 'Equation \\(x^2\\) is rendered before the example.\n\n```python\nprint(r"$x^2$ and \\(literal\\)")\n```';
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (value: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      // First frame deliberately contains unfinished JSON.
      const split = Math.min(90, content.length - 1);
      emit({ content: content.slice(0, split) });
      timer = setTimeout(() => {
        emit({ content: content.slice(split) });
        emit({ done: true });
        controller.close();
      }, 400);
    },
    cancel() { clearTimeout(timer); },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
};
if (!preview) history.replaceState(null, '', '/');
createRoot(document.getElementById('root')!).render(preview
  ? <div style={{ height: '100dvh', overflow: 'auto', padding: '24px 16px' }}><div className="markdown" style={{ maxWidth: 720, margin: 'auto' }}>
      <MessageMarkdown content={'A quick way to check your understanding.\n\n' + fence(quiz)} />
      <MessageMarkdown content={fence(chart)} />
    </div></div>
  : <App />);
