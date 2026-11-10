import { useId } from 'react';
import { Check, X, ArrowRight, RotateCcw } from 'lucide-react';
import type { QuizProgress, QuizWidget } from '@/lib/interactive-widgets';
import './interactive.css';

type Props = { widget: QuizWidget; progress: QuizProgress; onProgressChange: (p: QuizProgress) => void };

export default function QuizView({ widget, progress, onProgressChange }: Props) {
  const uid = useId();
  const qs = widget.questions;
  const total = qs.length;
  const index = Math.max(0, Math.min(total, progress.index));
  const done = index >= total;
  const score = qs.filter((q) => progress.submitted.includes(q.id) && progress.answers[q.id] === q.answerId).length;
  const set = (patch: Partial<QuizProgress>) => onProgressChange({ ...progress, ...patch });

  if (done) {
    const pct = Math.round((score / total) * 100);
    return (
      <section className="nx-widget nx-quiz" aria-label={`Quiz: ${widget.title}`} data-testid={`quiz-${widget.id}`}>
        <header className="nx-w-head"><span className="nx-w-kicker">Quiz complete</span><h3 className="nx-w-title">{widget.title}</h3></header>
        <div className="nx-quiz-final" role="status">
          <div className="nx-quiz-score" data-testid="text-quiz-score"><strong>{score}</strong><span>/ {total}</span></div>
          <p>{pct >= 80 ? 'Solid grasp. Review the explanations for anything that felt like a guess.' : pct >= 50 ? 'Partly there. The missed questions are worth a second pass.' : 'A good place to start. Retry once the explanations have settled.'}</p>
        </div>
        <ol className="nx-quiz-recap">
          {qs.map((q, i) => {
            const ok = progress.answers[q.id] === q.answerId;
            return <li key={q.id} className={ok ? 'is-right' : 'is-wrong'}>{ok ? <Check size={14} aria-hidden /> : <X size={14} aria-hidden />}<span className="sr-only">{ok ? 'Correct: ' : 'Incorrect: '}</span><span>{i + 1}. {q.prompt}</span></li>;
          })}
        </ol>
        <div className="nx-quiz-actions">
          <button type="button" className="nx-btn" onClick={() => onProgressChange({ index: 0, answers: {}, submitted: [] })} data-testid="button-quiz-retry"><RotateCcw size={14} aria-hidden />Retry quiz</button>
        </div>
      </section>
    );
  }

  const q = qs[index];
  const selected = progress.answers[q.id];
  const submitted = progress.submitted.includes(q.id);
  const correct = selected === q.answerId;
  const promptId = `${uid}-prompt`;
  const choose = (oid: string) => { if (!submitted) set({ answers: { ...progress.answers, [q.id]: oid } }); };

  return (
    <section className="nx-widget nx-quiz" aria-label={`Quiz: ${widget.title}`} data-testid={`quiz-${widget.id}`}>
      <header className="nx-w-head">
        <span className="nx-w-kicker">Quiz · {index + 1} of {total}</span>
        <h3 className="nx-w-title">{widget.title}</h3>
        {widget.description && <p className="nx-w-desc">{widget.description}</p>}
        <div className="nx-quiz-track" role="progressbar" aria-label="Quiz progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={progress.submitted.length}>
          {qs.map((qq, i) => <i key={qq.id} className={progress.submitted.includes(qq.id) ? (progress.answers[qq.id] === qq.answerId ? 'is-right' : 'is-wrong') : i === index ? 'is-current' : ''} />)}
        </div>
      </header>
      <p id={promptId} className="nx-quiz-prompt">{q.prompt}</p>
      <div role="radiogroup" aria-labelledby={promptId} className="nx-quiz-options">
        {q.options.map((o, i) => {
          const isSel = selected === o.id, isAns = o.id === q.answerId;
          const state = submitted ? (isAns ? 'is-right' : isSel ? 'is-wrong' : 'is-dim') : isSel ? 'is-selected' : '';
          return (
            <label key={o.id} className={`nx-quiz-opt ${state}`} data-testid={`option-${q.id}-${o.id}`}>
              <input type="radio" name={`${uid}-${q.id}`} value={o.id} checked={isSel} disabled={submitted} onChange={() => choose(o.id)} />
              <span className="nx-opt-key" aria-hidden>{String.fromCharCode(65 + i)}</span>
              <span className="nx-opt-text">{o.text}</span>
              {submitted && isAns && <Check size={15} aria-label="Correct answer" />}
              {submitted && isSel && !isAns && <X size={15} aria-label="Your answer, incorrect" />}
            </label>
          );
        })}
      </div>
      <div aria-live="polite">
        {submitted && (
          <div className={`nx-quiz-feedback ${correct ? 'is-right' : 'is-wrong'}`} data-testid="text-quiz-feedback">
            <strong>{correct ? 'Correct.' : 'Not quite.'}</strong> <span>{q.explanation}</span>
          </div>
        )}
      </div>
      <div className="nx-quiz-actions">
        <span className="nx-quiz-tally">{score} correct so far</span>
        {!submitted ? (
          <button type="button" className="nx-btn" disabled={!selected} onClick={() => set({ submitted: [...progress.submitted, q.id] })} data-testid="button-quiz-submit">Check answer</button>
        ) : (
          <button type="button" className="nx-btn" onClick={() => set({ index: index + 1 })} data-testid="button-quiz-next">{index + 1 < total ? 'Next question' : 'See results'}<ArrowRight size={14} aria-hidden /></button>
        )}
      </div>
    </section>
  );
}
