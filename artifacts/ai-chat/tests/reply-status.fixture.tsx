import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { LiveReplyIndicator, ReplyStatus, ThinkingPanel, type ChatMessage, type ReplyMode } from '../src/components/answer-details';
import { MessageMarkdown } from '../src/components/message-markdown';
import '../src/nexo.css';
import '../src/refine.css';
import '../src/motion.css';

const cases: Array<{ mode: ReplyMode; compact: boolean }> = [
  { mode: 'normal', compact: false },
  { mode: 'normal', compact: true },
  { mode: 'deep', compact: false },
  { mode: 'deep', compact: true },
  { mode: 'search', compact: false },
  { mode: 'search', compact: true },
];

type TransitionStage = 'normal' | 'deep' | 'search' | 'search-complete' | 'complete' | 'agent-code' | 'agent-complete' | 'agent-error';
let setTransitionStage: ((stage: TransitionStage) => void) | undefined;

function LiveTransitionFixture() {
  const [stage, setStage] = useState<TransitionStage>('normal');
  setTransitionStage = setStage;
  const live = !['complete', 'agent-complete', 'agent-error'].includes(stage);
  const hasContent = stage !== 'normal';
  const searching = stage === 'search';
  const activity: NonNullable<ChatMessage['activity']> = stage === 'agent-code'
    ? [{ id: 'agent-code', label: 'Running Python code in the isolated browser', kind: 'code', status: 'running' }]
    : stage === 'agent-complete'
      ? [{ id: 'agent-code', label: 'Code finished in the isolated browser', kind: 'code', status: 'complete' }]
      : stage === 'agent-error'
        ? [{ id: 'agent-search', label: 'Web search was unavailable', kind: 'search', status: 'error' }]
        : [
          { id: 'agent-work', label: 'Agent is checking sources', kind: 'thinking', status: live ? 'running' : 'complete' },
          ...(searching
            ? [{ id: 'web-search', label: 'Searching the web for sources', kind: 'search' as const, status: 'running' as const }]
            : stage === 'search-complete'
              ? [{ id: 'web-search', label: 'Searching the web for sources', kind: 'search' as const, status: 'complete' as const }]
              : []),
        ];
  const message: ChatMessage = {
    role: 'assistant',
    content: hasContent ? 'This streamed reply stays mounted while its status changes.' : '',
    deepthink: stage !== 'normal',
    agentMode: true,
    activity,
  };

  return (
    <section data-testid="transition-case" data-stage={stage}>
      <ThinkingPanel message={message} live={live} index={999} />
      <div className="message-text" data-testid="transition-message">
        {!hasContent
          ? <LiveReplyIndicator message={message} live={live} />
          : <MessageMarkdown content={message.content} live={live} conversationId="fixture" messageId="transition" />}
        {hasContent && live && <LiveReplyIndicator message={message} live={live} hasContent />}
        {hasContent && live && <span className="typing-caret" aria-hidden="true" />}
      </div>
    </section>
  );
}

function Fixture() {
  return (
    <>
      {cases.map(({ mode, compact }) => {
        const name = `${mode}-${compact ? 'compact' : 'full'}`;
        return (
          <div className="fixture-case" data-case={name} key={name} data-testid={name}>
            <ReplyStatus mode={mode} compact={compact} />
          </div>
        );
      })}
      <LiveTransitionFixture />
      <div className="term is-live">
        <span className="term-ellipsis" aria-hidden="true" />
        <div className="agent-activity-list">
          {['running', 'complete', 'error'].map((status) => (
            <div key={status} className={`agent-activity-item status-${status}`}>
              <span className="agent-activity-dot" aria-hidden="true" />
              <span>{status}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

const root = createRoot(document.getElementById('fixture')!);
let revision = 0;
function render() {
  root.render(
    <div data-stream-revision={revision}>
      <Fixture />
    </div>,
  );
}

render();

Object.assign(window, {
  __triggerStreamRerenders(count: number) {
    for (let i = 0; i < count; i += 1) {
      flushSync(() => {
        revision += 1;
        render();
      });
    }
  },
  __runReplyStatusTransitions() {
    const errors: string[] = [];
    const transition = document.querySelector<HTMLElement>('[data-testid="transition-case"]')!;
    const readStatuses = () => [...transition.querySelectorAll<HTMLElement>('.reply-status')];
    const verifyStatus = (mode: ReplyMode | null, label?: string, compact?: boolean) => {
      const statuses = readStatuses();
      if (statuses.length !== (mode ? 1 : 0)) {
        errors.push(`${stageName()}: expected ${mode ? 1 : 0} live indicators, found ${statuses.length}`);
      }
      const status = statuses[0];
      if (!mode || !status) return;
      if (status.dataset.mode !== mode) errors.push(`${stageName()}: expected ${mode} indicator, found ${status.dataset.mode}`);
      if (status.getAttribute('role') !== 'status') errors.push(`${stageName()}: indicator lost its status role`);
      if (status.getAttribute('aria-label') !== label) errors.push(`${stageName()}: expected accessible label "${label}", found "${status.getAttribute('aria-label')}"`);
      if (status.classList.contains('is-compact') !== Boolean(compact)) errors.push(`${stageName()}: incorrect compact indicator state`);
    };
    const stageName = () => transition.dataset.stage ?? 'transition';
    const setStage = (stage: TransitionStage) => {
      flushSync(() => setTransitionStage?.(stage));
    };
    const verifyAgentRunning = () => {
      const dot = transition.querySelector<HTMLElement>('.status-running .agent-activity-dot');
      if (!dot || getComputedStyle(dot).animationName !== 'rsTmDot') errors.push(`${stageName()}: running Agent marker is not animated`);
    };
    const verifyAgentSummary = (label: string, state: string) => {
      const summary = transition.querySelector<HTMLElement>('[data-testid="agent-progress-999"]');
      if (!summary) {
        errors.push(`${stageName()}: visible Agent progress summary is missing`);
        return;
      }
      if (summary.getAttribute('role') !== 'status' || summary.getAttribute('aria-live') !== (transition.querySelector('.term')?.classList.contains('is-live') ? 'polite' : 'off')) {
        errors.push(`${stageName()}: progress summary does not expose an appropriate accessible status`);
      }
      if (!summary.textContent?.includes(label) || !summary.textContent.includes(state)) {
        errors.push(`${stageName()}: expected progress "${label}" (${state}), found "${summary.textContent}"`);
      }
    };

    const toggle = transition.querySelector<HTMLButtonElement>('[data-testid="toggle-progress-999"]');
    if (!toggle) errors.push('transition: Agent activity toggle is missing');
    verifyAgentSummary('Agent is checking sources', 'In progress');
    if (transition.querySelector('.term-body')) errors.push('transition: detailed activity should stay collapsed by default');
    else if (toggle) flushSync(() => toggle.click());
    const button = transition.querySelector<HTMLButtonElement>('[data-testid="toggle-progress-999"]');
    if (button?.getAttribute('aria-label') !== 'Hide Agent activity') errors.push(`transition: Agent activity accessible label is incorrect (${button?.getAttribute('aria-label') ?? 'missing'})`);
    verifyStatus('normal', 'Working on it', false);
    verifyAgentRunning();

    setStage('deep');
    verifyStatus('deep', 'Deepthink is working', true);
    const streamedParagraph = transition.querySelector<HTMLElement>('.message-text p');
    if (!streamedParagraph) errors.push('deep: streamed reply paragraph is missing');

    setStage('search');
    verifyStatus('search', 'Searching the web for sources', false);
    if (transition.querySelector('.message-text .reply-status')) errors.push('search: a thinking indicator competes with the search indicator');
    if (!transition.querySelector('[data-testid="status-searching-999"]')) errors.push('search: search activity indicator is not inside the activity panel');
    if (transition.querySelector('.message-text p') !== streamedParagraph) errors.push('search: unrelated streamed reply content was remounted');

    setStage('search-complete');
    verifyStatus('deep', 'Deepthink is working', true);
    if (transition.querySelector('[data-testid="status-searching-999"]')) errors.push('search-complete: search indicator remained after search stopped');
    if (transition.querySelector('.message-text p') !== streamedParagraph) errors.push('search-complete: unrelated streamed reply content was remounted');

    setStage('complete');
    verifyStatus(null);
    verifyAgentSummary('Agent is checking sources', 'Done');
    if (transition.querySelector('.term-ellipsis')) errors.push('complete: live header ellipsis remained after completion');
    if (transition.querySelector('.term.is-live')) errors.push('complete: activity panel remained marked live');
    if (transition.querySelector('.message-text p') !== streamedParagraph) errors.push('complete: streamed reply content was remounted');
    const activityButton = transition.querySelector<HTMLButtonElement>('[data-testid="toggle-progress-999"]');
    if (activityButton?.getAttribute('aria-label') !== 'Hide Agent activity') errors.push('complete: Agent activity accessible label changed incorrectly');
    for (const dot of transition.querySelectorAll<HTMLElement>('.agent-activity-dot')) {
      if (getComputedStyle(dot).animationName !== 'none' || getComputedStyle(dot, '::after').animationName !== 'none') {
        errors.push('complete: finished Agent marker is still animated');
      }
    }
    flushSync(() => activityButton?.click());
    setStage('agent-code');
    verifyAgentSummary('Running Python code in the isolated browser', 'In progress');
    if (transition.querySelector('.term-body')) errors.push('agent-code: the current action is hidden when the activity panel is collapsed');
    setStage('agent-complete');
    verifyAgentSummary('Code finished in the isolated browser', 'Done');
    setStage('agent-error');
    verifyAgentSummary('Web search was unavailable', 'Needs attention');
    return { errors };
  },
  __verifyReplyStatusFixture() {
    const errors: string[] = [];
    const runningDot = document.querySelector('.status-running .agent-activity-dot')!;
    if (getComputedStyle(runningDot).animationName !== 'rsTmDot') {
      errors.push('Agent running marker is not animated');
    }
    for (const status of ['complete', 'error']) {
      if (getComputedStyle(document.querySelector(`.status-${status} .agent-activity-dot`)!).animationName !== 'none') {
        errors.push(`Agent ${status} marker must be static`);
      }
    }
    if (getComputedStyle(document.querySelector('.term-ellipsis')!, '::after').animationName !== 'rsTmLabel') {
      errors.push('The live header ellipsis is not animated');
    }
    const cases = [...document.querySelectorAll<HTMLElement>('.fixture-case')];
    const geometries = cases.map((fixtureCase) => {
      const status = fixtureCase.querySelector<HTMLElement>('.reply-status')!;
      const figure = status.querySelector<HTMLElement>('.rs-fig')!;
      const rect = figure.getBoundingClientRect();
      const compact = fixtureCase.dataset.case?.endsWith('-compact');
      const mode = fixtureCase.dataset.case?.split('-')[0];
      const expectedName =
        mode === 'search'
          ? 'Searching the web'
          : mode === 'deep'
            ? 'Deepthink is working'
            : 'Working on it';

      if (status.getAttribute('role') !== 'status') errors.push(`${fixtureCase.dataset.case}: missing status role`);
      if (status.getAttribute('aria-label') !== expectedName) errors.push(`${fixtureCase.dataset.case}: incorrect accessible name`);
      if (figure.getAttribute('aria-hidden') !== 'true') errors.push(`${fixtureCase.dataset.case}: decorative figure is not hidden`);
      if (Math.abs(rect.width - (compact ? 22 : 28)) > 0.1) errors.push(`${fixtureCase.dataset.case}: unexpected indicator width ${rect.width}`);
      if (Math.abs(rect.height - (compact ? 22 : 28)) > 0.1) errors.push(`${fixtureCase.dataset.case}: unexpected indicator height ${rect.height}`);
      if (compact && status.querySelector('.rs-label')) errors.push(`${fixtureCase.dataset.case}: compact label should be visually omitted`);
      if (!compact && status.querySelector('.rs-label')?.textContent !== expectedName) errors.push(`${fixtureCase.dataset.case}: full label is missing`);

      return {
        name: fixtureCase.dataset.case,
        width: rect.width,
        height: rect.height,
        status,
        figure,
        compact,
        mode,
      };
    });

    const originalStatusNodes = geometries.map((item) => item.status);
    const originalFigureNodes = geometries.map((item) => item.figure);
    const originalSizes = geometries.map((item) => ({ width: item.width, height: item.height }));
    (window as any).__triggerStreamRerenders(32);
    if (document.querySelector('[data-stream-revision]')?.getAttribute('data-stream-revision') !== '32') {
      errors.push('stream rerenders did not reach the requested revision');
    }
    geometries.forEach((item, index) => {
      const fixtureCase = document.querySelector<HTMLElement>(`[data-testid="${item.name}"]`)!;
      const status = fixtureCase.querySelector<HTMLElement>('.reply-status')!;
      const figure = status.querySelector<HTMLElement>('.rs-fig')!;
      const rect = figure.getBoundingClientRect();
      if (status !== originalStatusNodes[index] || figure !== originalFigureNodes[index]) {
        errors.push(`${item.name}: indicator nodes changed during streamed rerenders`);
      }
      if (Math.abs(rect.width - originalSizes[index].width) > 0.1 || Math.abs(rect.height - originalSizes[index].height) > 0.1) {
        errors.push(`${item.name}: indicator geometry changed during streamed rerenders`);
      }
    });

    const loopNames = new Set(['rsTmDepth', 'rsTmP1', 'rsTmP2', 'rsTmP3', 'rsTmBrain', 'rsTmSpin', 'rsTmNode', 'rsTmOrbit', 'rsTmCounter', 'rsTmMer']);
    const loopSamples: Array<{ name: string; animation: string; delta: number }> = [];
    for (const item of geometries) {
      const animations = item.figure.getAnimations({ subtree: true }) as CSSAnimation[];
      for (const animation of animations) {
        if (!loopNames.has(animation.animationName)) continue;
        const duration = Number(animation.effect?.getTiming().duration);
        if (!Number.isFinite(duration) || duration <= 0) {
          errors.push(`${item.name}: ${animation.animationName} has no finite loop duration`);
          continue;
        }
        animation.pause();
        animation.currentTime = 0;
        const start = getComputedStyle(animation.effect!.target as Element).transform;
        animation.currentTime = duration - 0.01;
        const end = getComputedStyle(animation.effect!.target as Element).transform;
        const startMatrix = new DOMMatrixReadOnly(start);
        const endMatrix = new DOMMatrixReadOnly(end);
        const delta = Math.max(...startMatrix.toFloat64Array().map((value, index) => Math.abs(value - endMatrix.toFloat64Array()[index])));
        loopSamples.push({ name: item.name, animation: animation.animationName, delta });
        if (delta > 0.002) errors.push(`${item.name}: ${animation.animationName} loop endpoints differ by ${delta}`);
      }
    }
    for (const [mode, required] of [
      ['normal', ['rsTmDepth', 'rsTmP1', 'rsTmP2', 'rsTmP3']],
      ['deep', ['rsTmBrain', 'rsTmSpin', 'rsTmNode']],
      ['search', ['rsTmOrbit', 'rsTmCounter', 'rsTmMer']],
    ] as const) {
      for (const animation of required) {
        if (!loopSamples.some((sample) => sample.name.startsWith(`${mode}-`) && sample.animation === animation)) {
          errors.push(`${mode}: expected ${animation} endpoint check did not run`);
        }
      }
    }

    return {
      errors,
      geometry: geometries.map(({ name, width, height }) => ({ name, width, height })),
      loopSamples,
    };
  },
  __verifyReducedMotion() {
    const errors: string[] = [];
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      errors.push('reduced-motion preference was not enabled in the browser');
    }
    const runningDot = document.querySelector('.status-running .agent-activity-dot')!;
    if (getComputedStyle(runningDot).animationName !== 'none' ||
        getComputedStyle(runningDot, '::after').animationName !== 'none' ||
        getComputedStyle(document.querySelector('.term-ellipsis')!, '::after').animationName !== 'none') {
      errors.push('Agent activity or header ellipsis still animates with reduced motion');
    }
    for (const fixtureCase of document.querySelectorAll<HTMLElement>('.fixture-case')) {
      const name = fixtureCase.dataset.case ?? 'unknown';
      const status = fixtureCase.querySelector<HTMLElement>('.reply-status')!;
      const label = status.querySelector<HTMLElement>('.rs-label');
      const figure = status.querySelector<HTMLElement>('.rs-fig')!;
      if (getComputedStyle(status).animationName !== 'none') errors.push(`${name}: status still animates with reduced motion`);
      if (label && (getComputedStyle(label).animationName !== 'none' || getComputedStyle(label).backgroundImage !== 'none')) {
        errors.push(`${name}: label is not static with reduced motion`);
      }
      for (const element of [figure, ...figure.querySelectorAll<HTMLElement>('*')]) {
        if (getComputedStyle(element).animationName !== 'none') errors.push(`${name}: ${element.className || element.tagName} still animates with reduced motion`);
      }
      if (status.getAttribute('role') !== 'status' || !status.getAttribute('aria-label')) {
        errors.push(`${name}: accessible status was lost with reduced motion`);
      }
    }
    return { errors };
  },
  __verifyMotionRestored() {
    const errors: string[] = [];
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) errors.push('reduced-motion preference was not cleared');
    const expected = ['rsTmDepth', 'rsTmOrbit', 'rsTmCounter', 'rsTmSpin', 'rsTmP2', 'rsTmBrain', 'rsTmNode', 'rsTmDot'];
    for (const animationName of expected) {
      if (!document.getAnimations().some((animation) => (animation as CSSAnimation).animationName === animationName)) {
        errors.push(`${animationName} did not resume after reduced motion was disabled`);
      }
    }
    return { errors };
  },
  __replyStatusFixtureReady: true,
});
