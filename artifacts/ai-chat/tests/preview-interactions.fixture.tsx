import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { CodeWorkspace, type AgentWorkspaceTask } from '../src/components/code-workspace';
import { executeCode, waitForPreviewDiagnostics, readPreviewInteractions } from '../src/lib/code-runner';
import { formatInteractionResult, interactionChecksHaveIssues } from '../src/lib/preview-interactions';
import '../src/index.css';
import '../src/nexo.css';
import '../src/components/code-workspace.css';

function Fixture() {
  const [task, setTask] = useState<AgentWorkspaceTask>();
  const [summary, setSummary] = useState('');
  Object.assign(window, {
    __interactions: {
      async run(source: string) {
        const execution = await executeCode({ language: 'html', code: source });
        const next: AgentWorkspaceTask = {
          id: execution.previewId!, language: 'html', code: source, outputs: [], status: 'running', ...execution,
        };
        flushSync(() => { setSummary(''); setTask(next); });
        const diagnostics = await waitForPreviewDiagnostics(execution.previewId!, new AbortController().signal);
        const result = readPreviewInteractions(execution.previewId!);
        const text = formatInteractionResult(result);
        flushSync(() => {
          setSummary(text);
          setTask({ ...next, status: interactionChecksHaveIssues(result) ? 'error' : 'complete', previewDiagnostics: diagnostics });
        });
        return { result, diagnostics, text, id: execution.previewId };
      },
      read: readPreviewInteractions,
      id: () => task?.previewId,
    },
  });
  return <div className="app-shell">
    <main><h1>Sandbox interaction checks</h1><pre data-testid="interaction-summary">{summary}</pre></main>
    <CodeWorkspace conversationId="interaction-fixture" snippets={[]} agentCode={task}
      onClose={() => setTask(undefined)} onAskFix={() => {}} canAsk isLight={false} />
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
