import { lazy, Suspense, useMemo, useState } from 'react';
import { sanitizeQuizProgress, type InteractiveWidget, type QuizProgress } from '@/lib/interactive-widgets';

const QuizView = lazy(() => import('./quiz-view'));
const ChartView = lazy(() => import('./chart-view'));
export default function InteractiveWidgetView({ widget, progress, onProgressChange }: {
  widget: InteractiveWidget; progress?: QuizProgress; onProgressChange?: (progress: QuizProgress) => void;
}) {
  const [temporary, setTemporary] = useState<QuizProgress>();
  const safeProgress = useMemo(() => widget.type === 'quiz' ? sanitizeQuizProgress(progress ?? temporary, widget) : null, [progress, temporary, widget]);
  return <Suspense fallback={<div className="widget-fallback" role="status">Loading {widget.type}…</div>}>
    {widget.type === 'chart' ? <ChartView widget={widget} /> : <QuizView widget={widget} progress={safeProgress!}
      onProgressChange={onProgressChange ?? setTemporary} />}
  </Suspense>;
}
