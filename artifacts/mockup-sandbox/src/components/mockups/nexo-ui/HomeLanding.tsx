import { useEffect, useState, type Ref } from 'react';
import { ArrowRight, ArrowUpRight, Code2, Compass, Lightbulb } from 'lucide-react';

type Prompt = { label: string; text: string };

type Props = {
  logoUrl: string;
  prompts: Prompt[];
  onStart: () => void;
  onPrompt: (text: string) => void;
  onOpenHistory?: (trigger: HTMLButtonElement) => void;
  historyOpen?: boolean;
  headingRef?: Ref<HTMLHeadingElement>;
};

const startingPoints = [
  { title: 'Make a clear plan', note: 'Turn a crowded week into steps you can keep.', prompt: 0, Icon: Compass, tag: 'Plan' },
  { title: 'Understand an idea', note: 'The plain version, with one good example.', prompt: 1, Icon: Lightbulb, tag: 'Learn' },
  { title: 'Start building', note: 'Working code that opens in the workspace.', prompt: 3, Icon: Code2, tag: 'Build' },
];

const examples = [
  { ask: 'I have six things due and no idea where to start.', steps: ['Sort by what blocks others', 'Pick one to finish today', 'Park the rest with a date'] },
  { ask: 'Why does compound interest feel so slow, then so fast?', steps: ['Growth earns on growth', 'Early years look flat', 'The curve bends later'] },
  { ask: 'Plot a damped sine wave in Python.', steps: ['import numpy, matplotlib', 'y = e^(-t/4) · sin(2πt)', 'Run it in the workspace'] },
];

export function HomeLanding({ logoUrl, prompts, onStart, onPrompt, onOpenHistory, historyOpen = false, headingRef }: Props) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer: number | undefined;
    const sync = () => {
      window.clearInterval(timer);
      timer = undefined;
      if (!preference.matches && document.visibilityState === 'visible') {
        timer = window.setInterval(() => setActive((i) => (i + 1) % examples.length), 5200);
      }
    };
    sync();
    preference.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      window.clearInterval(timer);
      preference.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  const example = examples[active];

  return (
    <div className="home-landing" data-testid="home-landing">
      <div className="landing-topline lx-in" style={{ ['--d' as string]: '0ms' }}>
        <button
          className="landing-wordmark"
          type="button"
          onClick={(event) => onOpenHistory?.(event.currentTarget)}
          aria-label={historyOpen ? 'Close conversation history' : 'Open conversation history'}
          aria-expanded={historyOpen}
          aria-controls="history-sidebar"
          data-testid="button-home-history"
        >
          <img src={logoUrl} alt="" aria-hidden="true" /> Nexo AI
        </button>
      </div>

      <div className="landing-hero">
        <div className="landing-copy">
          <h1 ref={headingRef} tabIndex={-1} className="lx-in" style={{ ['--d' as string]: '60ms' }}>
            <span className="lx-line">Bring the half-idea.</span>
            <span className="lx-line lx-accent">Leave with the next step.</span>
          </h1>
          <p className="landing-intro lx-in" style={{ ['--d' as string]: '140ms' }}>
            A question, a tangle of thoughts, a stubborn bug. Nexo thinks it through with you, and when the answer is code, a workspace opens so you can run it.
          </p>
          <div className="landing-actions lx-in" style={{ ['--d' as string]: '220ms' }}>
            <button className="landing-primary" type="button" onClick={onStart} data-testid="button-start-from-home">
              <span>Start a conversation</span>
              <span className="landing-primary-icon"><ArrowRight size={16} aria-hidden="true" /></span>
            </button>
            <span className="landing-action-note">or type straight into the box below</span>
          </div>
        </div>

        <div className="landing-visual lx-in" style={{ ['--d' as string]: '180ms' }} aria-hidden="true">
          <div className="landing-preview">
            <div className="landing-preview-head">
              <span className="lx-pager">{examples.map((_, i) => <b key={i} className={i === active ? 'is-on' : ''} />)}</span>
            </div>
            <div className="lx-swap" key={active}>
              <div className="landing-preview-question">{example.ask}</div>
              <ol className="lx-steps">
                {example.steps.map((s, i) => (
                  <li key={s} style={{ ['--i' as string]: i }}><span>{String(i + 1).padStart(2, '0')}</span>{s}</li>
                ))}
              </ol>
            </div>
            <div className="lx-caption">Illustrative example, not a live reply</div>
          </div>
        </div>
      </div>

      <div className="landing-prompts">
        {startingPoints.map(({ title, note, prompt, Icon, tag }, i) => {
          const suggestion = prompts[prompt];
          return (
            <button
              className="landing-prompt lx-in"
              style={{ ['--d' as string]: `${360 + i * 70}ms` }}
              type="button"
              key={title}
              onClick={() => suggestion && onPrompt(suggestion.text)}
              data-testid={`home-prompt-${prompt}`}
            >
              <span className="landing-prompt-icon"><Icon size={17} aria-hidden="true" /></span>
              <span className="landing-prompt-copy"><em>{tag}</em><b>{title}</b><small>{note}</small></span>
              <ArrowUpRight size={15} className="landing-prompt-arrow" aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
