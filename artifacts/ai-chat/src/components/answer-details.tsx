import { memo, useState } from 'react';
import { AlertTriangle, Brain, ChevronDown, Info } from 'lucide-react';
import './thinking-motion.css';
import { splitReasoning } from '../lib/reasoning-sections';
import type { QuizProgress } from '../lib/interactive-widgets';

export type Activity = { id: string; label: string; kind?: 'search' | 'thinking' | 'info' | 'code' | 'security'; status?: 'running' | 'complete' | 'error' };
export type AgentTask = 'coding' | 'planning' | 'reasoning' | 'fast_worker' | 'document' | 'synthesis' | 'classification' | 'multimodal';
export type Source = { title: string; url: string; retrieval?: 'page' | 'search_excerpt'; retrievedAt?: string };
export type Notice = { id: string; message: string; model?: string };
export type ChatMessage = {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  imageAttached?: boolean;
  reasoning?: string;
  deepthink?: boolean;
  agentMode?: boolean;
  activity?: Activity[];
  sources?: Source[];
  notices?: Notice[];
  model?: string;
  agentTask?: AgentTask;
  quizProgress?: Record<string, QuizProgress>;
};

export type ReplyMode = 'search' | 'deep' | 'normal';

export function isSearching(message: ChatMessage, live: boolean) {
  return live && (message.activity ?? []).some((a) => a.kind === 'search' && a.status === 'running');
}

function SearchFigure() {
  return (
    <span className="rs-fig rs-search" aria-hidden="true">
      <span className="rs-stage">
        <span className="rs-halo" />
        <span className="rs-globe"><i className="g-mer m1" /><i className="g-mer m2" /><i className="g-lat" /><i className="g-lat t" /><i className="g-lat b" /></span>
        <span className="rs-orbit"><span className="rs-glass"><i className="lens" /><i className="handle" /></span></span>
      </span>
    </span>
  );
}

function BrainFigure() {
  return (
    <span className="rs-fig rs-brain" aria-hidden="true">
      <span className="rs-stage">
        <span className="rs-halo" />
        <span className="rs-layer l1" /><span className="rs-layer l2" /><i className="rs-spark" /><i className="rs-node n1" /><i className="rs-node n2" /><i className="rs-node n3" />
        <span className="rs-brain-icon"><Brain size={16} /></span>
      </span>
    </span>
  );
}

function NormalFigure() {
  return (
    <span className="rs-fig rs-normal" aria-hidden="true">
      <span className="rs-stage">
        <span className="rs-halo" />
        <i className="rs-plane p3" /><i className="rs-plane p2" /><i className="rs-plane p1" /><i className="rs-core" />
      </span>
    </span>
  );
}

function formatRetrievedAt(value: string | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

/** Single status indicator: search takes precedence, then deepthink, then normal. */
export const ReplyStatus = memo(function ReplyStatus({ mode, label, compact = false }: { mode: ReplyMode; label?: string; compact?: boolean }) {
  const text = label ?? (mode === 'search' ? 'Searching the web' : mode === 'deep' ? 'Deepthink is working' : 'Working on it');
  return (
    <span className={`reply-status rs-${mode}-mode${compact ? ' is-compact' : ''}`} role="status" aria-label={text} data-mode={mode} data-testid={mode === 'search' ? 'status-searching' : 'status-thinking'}>
      {mode === 'search' ? <SearchFigure /> : mode === 'deep' ? <BrainFigure /> : <NormalFigure />}
      {!compact && <span className="rs-label">{text}</span>}
    </span>
  );
});

/** Show the reply's thinking mode unless a live search activity owns the status. */
export function LiveReplyIndicator({ message, live, hasContent = false }: { message: ChatMessage; live: boolean; hasContent?: boolean }) {
  if (!live || isSearching(message, live) || (hasContent && !message.deepthink)) return null;
  return <ReplyStatus mode={message.deepthink ? 'deep' : 'normal'} compact={hasContent} />;
}

/** Backwards-compatible wrapper. */
export function BrainThinking({ deep }: { deep: boolean }) {
  return <ReplyStatus mode={deep ? 'deep' : 'normal'} />;
}

export function NoticeBanner({ notices, index }: { notices?: Notice[]; index: number }) {
  if (!notices?.length) return null;
  return (
    <>
      {notices.map((n) => {
        const fallback = n.id === 'model-downgrade' ||
          n.id === 'agent-route-fallback' ||
          n.id === 'agent-model-rate-fallback' ||
          n.id === 'agent-model-fallback' ||
          n.id === 'gemini-agent-route-fallback' ||
          n.id === 'gemini-agent-qwen-fallback' ||
          n.id === 'gemini-agent-model-fallback';
        // Normalize old saved notices too; a successful model switch is not a blocked chat.
        const text = n.id === 'model-downgrade'
          ? 'The main model could not complete this reply. A compatible model is answering—you can keep chatting.'
          : n.message;
        const Icon = fallback ? Info : AlertTriangle;
        return (
          <div key={n.id} className={`notice-banner${fallback ? ' notice-info' : ''}`} role="status" data-testid={`notice-${index}-${n.id}`}>
            <Icon size={14} aria-hidden="true" />
            <span>{text}</span>
          </div>
        );
      })}
    </>
  );
}

export const ThinkingPanel = memo(function ThinkingPanel({ message, live, index }: { message: ChatMessage; live: boolean; index: number }) {
  const reasoning = message.reasoning ?? '';
  const [open, setOpen] = useState(false);
  const searching = isSearching(message, live);
  const agentMode = message.agentMode === true;
  const hasActivity = (message.activity ?? []).length > 0;
  const hasSources = (message.sources ?? []).length > 0;
  if (!live && !reasoning && !hasActivity && !hasSources) return null;
  const activities = message.activity ?? [];
  const runningLabel = searching ? [...activities].reverse().find((a) => a.kind === 'search' && a.status === 'running')?.label : undefined;
  const currentActivity = [...activities].reverse().find((activity) => activity.status === 'running') ?? activities.at(-1);
  const agentProgressStatus = currentActivity?.status ?? (live ? 'running' : 'complete');
  const agentProgressLabel = currentActivity?.label ?? 'Working on your request';
  const agentProgressState = agentProgressStatus === 'running' ? 'In progress' : agentProgressStatus === 'error' ? 'Needs attention' : 'Done';
  const bodyId = `progress-body-${index}`;
  const sections = open && !agentMode ? splitReasoning(reasoning) : [];
  return (
    <div className={`term ${live ? 'is-live' : ''}`} data-testid={`panel-progress-${index}`}>
      <button type="button" className="term-head" aria-expanded={open} aria-controls={open ? bodyId : undefined} aria-label={`${open ? 'Hide' : 'Show'} ${agentMode ? 'Agent activity' : 'model reasoning'}`} onClick={() => setOpen((v) => !v)} data-testid={`toggle-progress-${index}`}>
        <span className="term-prompt" aria-hidden="true">&gt;&gt;&gt;</span>
        <span className="term-title">{agentMode ? (live ? 'Agent is working' : 'Agent activity') : !live && hasSources && !reasoning && !hasActivity ? 'Sources' : message.deepthink ? (live ? 'Deepthinking' : 'Deepthink reasoning') : (live ? 'Thinking' : 'Thought process')}{live && <span className="term-ellipsis" aria-hidden="true" />}</span>
        <ChevronDown size={13} className={`term-chev ${open ? 'is-open' : ''}`} aria-hidden="true" />
      </button>
      {agentMode && !searching && (
        <div className={`agent-progress-summary status-${agentProgressStatus}`} role="status" aria-live={live ? 'polite' : 'off'} aria-atomic="true" data-testid={`agent-progress-${index}`}>
          <span className="agent-progress-mark" aria-hidden="true" />
          <span className="agent-progress-label">{agentProgressLabel}</span>
          <small>{agentProgressState}</small>
        </div>
      )}
      {searching && (
        <div className="term-search" data-testid={`status-searching-${index}`}>
          <ReplyStatus mode="search" label={runningLabel ?? 'Searching the web'} />
        </div>
      )}
      {open && (
        <div className="term-body" id={bodyId}>
          {agentMode ? (
            <div className="agent-activity-list" role="list" data-testid={`agent-activity-${index}`}>
              {(message.activity ?? []).length ? message.activity!.map((activity) => (
                <div className={`agent-activity-item status-${activity.status ?? 'complete'}`} role="listitem" key={activity.id}>
                  <span className="agent-activity-dot" aria-hidden="true" />
                  <span>{activity.label}</span>
                  <small>{activity.status === 'running' ? 'In progress' : activity.status === 'error' ? 'Unavailable' : 'Done'}</small>
                </div>
              )) : (
                <p className="term-note">{live ? 'Agent is deciding whether a tool is needed…' : 'No tools were needed for this response.'}</p>
              )}
              {message.agentTask && <p className="term-note">Task: {message.agentTask.replaceAll('_', ' ')}</p>}
              {message.model && <p className="term-note" data-testid={`agent-model-${index}`}>Active model: {message.model}</p>}
              <p className="term-note">Private model reasoning is not shown; this panel lists tool activity and outcomes.</p>
            </div>
          ) : reasoning ? (
            <div className="reason-flow" data-testid={`reasoning-${index}`}>
              {sections.map((sec, i) => (
                <p key={i} className="reason-sec"><span className="reason-idx" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span><span className="reason-txt">{sec}</span></p>
              ))}
            </div>
          ) : (
            <p className="term-note">{live ? 'Waiting for model reasoning…' : 'No reasoning trace was returned for this response.'}</p>
          )}
          {hasSources && (
            <section className="activity-source-section" aria-label="Sources used">
              <h3 className="activity-head">Sources</h3>
              <ul className="activity-sources">
                {message.sources!.map((source) => {
                  const retrievalLabel = source.retrieval === 'page'
                    ? 'Page read'
                    : source.retrieval === 'search_excerpt'
                      ? 'Search excerpt'
                      : 'Retrieval level unavailable';
                  const retrievedAt = formatRetrievedAt(source.retrievedAt);
                  return (
                    <li key={source.url}>
                      <a href={source.url} target="_blank" rel="noopener noreferrer">
                        <span className="source-title">{source.title}</span>
                        <span className="source-meta">
                          <small className={`source-retrieval${source.retrieval ? ` is-${source.retrieval.replace('_', '-')}` : ' is-unknown'}`}>{retrievalLabel}</small>
                          {retrievedAt && <small className="source-retrieved-at" data-testid={`source-retrieved-at-${encodeURIComponent(source.url)}`}>Retrieved {retrievedAt}</small>}
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
});

export const AnswerActivity = ThinkingPanel;
