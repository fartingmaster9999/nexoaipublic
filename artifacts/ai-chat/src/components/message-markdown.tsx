import { createContext, lazy, memo, Suspense, useContext, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { CopyCodeButton } from './copy-code-button';
import { rawCodeFromSource } from '@/lib/code-clipboard';
import { fencedBlocks, type FencedBlock } from '@/lib/fenced-blocks';
import { normalizeMathDelimiters } from '@/lib/markdown-math';
import { parseWidget, WIDGET_LANGUAGE, type QuizProgress } from '@/lib/interactive-widgets';
import { ErrorBoundary } from './error-boundary';

const InteractiveWidgetView = lazy(() => import('./interactive/widget-view'));
type ProgressHandler = (conversationId: string, messageId: string, widgetKey: string, progress: QuizProgress) => void;
type MarkdownProps = {
  content: string; live?: boolean; conversationId?: string; messageId?: string;
  quizProgress?: Record<string, QuizProgress>; onQuizProgress?: ProgressHandler; sources?: { url: string }[];
};
const MarkdownSource = createContext<MarkdownProps & { blocks: FencedBlock[] }>({ content: '', blocks: [] });
function WidgetFailure() {
  return <div className="widget-fallback" role="status">This interactive answer could not load. Your conversation is still here. Reload the page or ask for a plain-text answer.</div>;
}

const CodeBlock: NonNullable<Components['pre']> = ({ node, children, ...props }) => {
  const context = useContext(MarkdownSource);
  const source = context.content;
  const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code');
  const fallback = code?.type === 'element'
    ? code.children.map((child) => child.type === 'text' ? child.value : '').join('') : '';
  const raw = rawCodeFromSource(source, node?.position?.start.offset, node?.position?.end.offset, fallback);
  const classes = code?.type === 'element' ? code.properties.className : [];
  const language = (Array.isArray(classes) ? classes.join(' ') : String(classes ?? '')).match(/language-([^\s]+)/)?.[1] ?? 'Code';
  const start = node?.position?.start.offset ?? -1;
  const block = context.blocks.find((block) => block.start <= start && block.end >= (node?.position?.end.offset ?? start));
  const result = useMemo(() => language.toLowerCase() === WIDGET_LANGUAGE && block?.complete ? parseWidget(block.code) : null, [language, block?.complete, block?.code]);
  if (language.toLowerCase() === WIDGET_LANGUAGE) {
    if (!block?.complete) return <div className="widget-fallback" role="status">{context.live ? 'Preparing an interactive answer…' : 'This interactive answer was not completed. Ask Nexo to try again.'}</div>;
    const siblings = context.blocks.filter((block) => block.tag === WIDGET_LANGUAGE);
    if (siblings.indexOf(block) >= 4) return <div className="widget-fallback">Ask for fewer charts or quizzes in one answer.</div>;
    if (!result || result.status === 'invalid') return <div className="widget-fallback" role="status">{result?.fallback ?? 'This interactive answer could not be displayed.'}</div>;
    const widget = result.widget;
    if (widget.type === 'chart' && widget.provenance.kind === 'verified') {
      const sourceUrls = new Set((context.sources ?? []).map((source) => { try { return new URL(source.url).href; } catch { return ''; } }));
      if (!widget.provenance.sources.every((source) => sourceUrls.has(source.url))) {
        return <div className="widget-fallback" role="status">This chart's sources could not be verified against this answer's web results. Ask for a sourced chart or provide the data.</div>;
      }
    }
    const widgetKey = `${block.start}:${widget.id}`;
    return <ErrorBoundary FallbackComponent={WidgetFailure} resetKey={widgetKey}><Suspense fallback={<div className="widget-fallback" role="status">Loading interactive answer…</div>}>
      <InteractiveWidgetView widget={widget} progress={context.quizProgress?.[widgetKey]}
        onProgressChange={context.conversationId && context.messageId && context.onQuizProgress
          ? (progress) => context.onQuizProgress!(context.conversationId!, context.messageId!, widgetKey, progress) : undefined} />
    </Suspense></ErrorBoundary>;
  }
  return (
    <div className="code-block">
      <div className="code-block-toolbar"><span>{language}</span><CopyCodeButton text={raw} /></div>
      <pre {...props}>{children}</pre>
    </div>
  );
};

const components: Components = {
  pre: CodeBlock,
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer nofollow" />,
  table: ({ node: _node, ...props }) => <div className="table-wrap"><table {...props} /></div>,
};
const remarkPlugins = [remarkGfm, remarkMath];

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };
/** Completed answers do not reparse Markdown on each streamed chunk or keystroke. */
export const MessageMarkdown = memo(function MessageMarkdown(props: MarkdownProps) {
  const markdown = useMemo(() => normalizeMathDelimiters(props.content), [props.content]);
  const blocks = useMemo(() => fencedBlocks(markdown), [markdown]);
  const context = useMemo(() => ({ ...props, content: markdown, blocks }), [markdown, props.live, props.conversationId, props.messageId, props.quizProgress, props.onQuizProgress, props.sources, blocks]);
  return <MarkdownSource.Provider value={context}><ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={[[rehypeKatex, { throwOnError: false, maxExpand: 500, maxSize: 20 }]]} skipHtml components={components}>{markdown}</ReactMarkdown></MarkdownSource.Provider>;
});
