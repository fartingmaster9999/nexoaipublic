import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { Play, Square, Wrench, X, RotateCcw, Download, Terminal, ArrowLeft, Eye, Code2, ScrollText } from 'lucide-react';
import {
  executeCode,
  makePreviewHtml,
  MAX_PREVIEW_DIAGNOSTICS,
  reportPreviewDiagnostics,
  reportPreviewReview,
  reportPreviewInteractions,
  readPreviewInteractions,
  sanitizePreviewDiagnostic,
  type PreviewDiagnostic,
  type RunLanguage,
  type RunOutput,
} from '@/lib/code-runner';
import { LANG_LABEL, STARTERS, type Snippet } from '@/lib/code-extract';
import { CopyCodeButton } from './copy-code-button';
import { useEditorLanguage } from '@/hooks/use-editor-language';
import { useWorkspaceSize } from '@/hooks/use-workspace-size';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { ProjectFilesPanel } from './project-files-panel';
import {
  bundleHtmlProject,
  createAgentProject,
  createSavedProject,
  projectLanguage,
  readSavedProject,
  writeSavedProject,
  type ProjectFile,
  type SavedProject,
} from '@/lib/project-workspace';
import './code-workspace.css';
import { WORKSPACE_DRAFT_KEY } from '@/lib/workspace-recovery';
import { formatInteractionResult, interactionChecksHaveIssues, type InteractionResult } from '@/lib/preview-interactions';

type Draft = { language: RunLanguage; code: string; edited: boolean };
export type AgentWorkspaceTask = {
  id: string;
  language: RunLanguage;
  code: string;
  outputs: RunOutput[];
  status: 'running' | 'complete' | 'error';
  error?: string;
  previewHtml?: string;
  previewId?: string;
  previewDiagnostics?: PreviewDiagnostic[];
  projectFiles?: ProjectFile[];
  projectEntrypoint?: string;
  projectStorageError?: string;
};
const DRAFT_KEY = WORKSPACE_DRAFT_KEY;
const WRAP_KEY = 'nexo-code-wrap-v1';
function readDrafts(): Record<string, Draft> {
  try { const v = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
function readWrapPreference() {
  try {
    const saved = localStorage.getItem(WRAP_KEY);
    if (saved === 'true') return true;
    if (saved === 'false') return false;
  } catch {}
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;
}

type Props = {
  conversationId: string | null;
  snippets: Snippet[];
  onClose: () => void;
  returnFocus: () => void;
  onAskFix: (prompt: string) => void;
  canAsk: boolean;
  isLight: boolean;
  agentCode?: AgentWorkspaceTask | null;
  immersive?: boolean;
  waiting?: boolean;
  visible?: boolean;
};
type View = 'preview' | 'code' | 'console';

export function CodeWorkspace({ conversationId, snippets, onClose, returnFocus, onAskFix, canAsk, isLight, agentCode, immersive = false, waiting = false, visible = true }: Props) {
  const [view, setView] = useState<View>('preview');
  const key = conversationId ?? '__scratch';
  const [drafts, setDrafts] = useState<Record<string, Draft>>(readDrafts);
  const [sel, setSel] = useState(0);
  const [wrapLines, setWrapLines] = useState(readWrapPreference);
  const [running, setRunning] = useState(false);
  const [outputs, setOutputs] = useState<RunOutput[]>([]);
  const [runError, setRunError] = useState('');
  const [runStatus, setRunStatus] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewDiagnostics, setPreviewDiagnostics] = useState<PreviewDiagnostic[]>([]);
  const [previewComplete, setPreviewComplete] = useState(false);
  const [previewInteractions, setPreviewInteractions] = useState<InteractionResult>();
  const [hasRun, setHasRun] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [project, setProject] = useState<SavedProject | null>(null);
  const [activeProjectPath, setActiveProjectPath] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const consoleRef = useRef<HTMLDivElement>(null);
  const previewFrameRef = useRef<HTMLIFrameElement>(null);
  const previewDiagnosticsRef = useRef<PreviewDiagnostic[]>([]);
  const followConsoleRef = useRef(true);
  const outputsRef = useRef(outputs);
  const pendingOutputsRef = useRef<RunOutput[]>([]);
  const outputFrameRef = useRef<number | null>(null);
  const draftsRef = useRef(drafts);
  const saveTimerRef = useRef<number | null>(null);
  const panelRef = useFocusTrap<HTMLElement>(visible && !immersive);
  draftsRef.current = drafts;
  outputsRef.current = outputs;

  const snippetCount = snippets.length;
  useEffect(() => { setSel(Math.max(0, snippetCount - 1)); }, [key, snippetCount]);
  const generated = snippets[Math.min(sel, snippetCount - 1)];
  const draft: Draft = drafts[key] ?? (generated ? { ...generated, edited: false } : { language: 'python', code: STARTERS.python, edited: false });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveTimerRef.current = null;
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts)); setStorageError(''); }
      catch { setStorageError('Your code edits could not be saved in this browser. Copy them before leaving.'); }
    }, 180);
    saveTimerRef.current = timer;
    return () => window.clearTimeout(timer);
  }, [drafts]);

  useEffect(() => {
    try { localStorage.setItem(WRAP_KEY, String(wrapLines)); } catch {}
  }, [wrapLines]);

  const genCode = generated?.code; const genLang = generated?.language;
  useEffect(() => {
    if (!conversationId) {
      setProject(null);
      setActiveProjectPath('');
      return;
    }
    try {
      const saved = readSavedProject(localStorage, conversationId);
      setProject(saved);
      setActiveProjectPath(saved?.entrypoint ?? saved?.files[0]?.path ?? '');
      setStorageError('');
    } catch (error) {
      setProject(null);
      setActiveProjectPath('');
      setStorageError(error instanceof Error ? error.message : 'Saved project data could not be read.');
    }
  }, [conversationId]);

  useEffect(() => {
    if (!agentCode?.projectFiles || !agentCode.projectEntrypoint) return;
    let previous: SavedProject | null = null;
    let persistenceError = agentCode.projectStorageError ?? '';
    try {
      previous = conversationId ? readSavedProject(localStorage, conversationId) : null;
    } catch (error) {
      persistenceError ||= error instanceof Error ? error.message : 'Saved project data could not be read.';
    }
    let next: SavedProject;
    try {
      // The Agent controller saves tool updates before publishing this task.
      // Loading the workspace must not replay an older write over newer edits.
      next = previous && !persistenceError
        ? previous
        : createAgentProject(agentCode.projectFiles, agentCode.projectEntrypoint, previous);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'The project update is invalid; existing files were kept.');
      return;
    }
    setProject(next);
    setActiveProjectPath(next.entrypoint);
    setStorageError(persistenceError);
  }, [agentCode?.id, agentCode?.projectFiles, agentCode?.projectEntrypoint, conversationId]);

  const saveProject = (next: SavedProject | null) => {
    setProject(next);
    if (!conversationId) return;
    try {
      if (next) writeSavedProject(localStorage, conversationId, next);
      else localStorage.removeItem(`nexo-project-v1:${encodeURIComponent(conversationId)}`);
      setStorageError('');
    } catch {
      setStorageError('Project changes could not be saved in this browser. Export a backup before leaving.');
    }
  };
  useEffect(() => {
    if (agentCode) return;
    if (genCode === undefined || !genLang) return;
    setDrafts((d) => {
      const cur = d[key];
      if (cur?.edited || (cur && cur.code === genCode && cur.language === genLang)) return d;
      return { ...d, [key]: { language: genLang, code: genCode, edited: false } };
    });
  }, [key, genCode, genLang, agentCode?.id]);

  useEffect(() => {
    if (!agentCode) return;
    setDrafts((current) => ({ ...current, [key]: { language: agentCode.language, code: agentCode.code, edited: false } }));
    setSel(0);
    setView(agentCode.language === 'html' ? 'preview' : 'console');
  }, [key, agentCode?.id]);

  useEffect(() => {
    if (!agentCode) return;
    outputsRef.current = agentCode.outputs;
    pendingOutputsRef.current = [];
    setOutputs(agentCode.outputs);
    setHasRun(true);
    setRunError(agentCode.error ?? '');
    setRunStatus(agentCode.status === 'running' ? 'Agent is running code…' : '');
    if (agentCode.previewHtml !== undefined) setPreview(agentCode.previewHtml);
    if (agentCode.previewId !== undefined) {
      setPreviewId(agentCode.previewId);
      // The final task update includes the completed diagnostics, even when empty.
      // Do not reset an already checked preview to "loading" on that same ID.
      setPreviewComplete(agentCode.previewDiagnostics !== undefined);
      const initialDiagnostics = agentCode.previewDiagnostics ?? [];
      previewDiagnosticsRef.current = initialDiagnostics;
      setPreviewDiagnostics(initialDiagnostics);
    }
  }, [
    agentCode?.id, agentCode?.outputs, agentCode?.status, agentCode?.error,
    agentCode?.previewHtml, agentCode?.previewId, agentCode?.previewDiagnostics,
  ]);

  useLayoutEffect(() => {
    if (!previewId) return;
    setPreviewInteractions(undefined);
    let completed = false;
    let runtimeComplete = false;
    let interactionsComplete = false;
    const merge = (values: unknown[]) => {
      const next = [...previewDiagnosticsRef.current];
      const seen = new Set(next.map((entry) => `${entry.kind}\n${entry.message}\n${entry.source ?? ''}\n${entry.line ?? ''}`));
      for (const value of values.slice(0, MAX_PREVIEW_DIAGNOSTICS)) {
        const diagnostic = sanitizePreviewDiagnostic(value);
        if (!diagnostic) continue;
        const key = `${diagnostic.kind}\n${diagnostic.message}\n${diagnostic.source ?? ''}\n${diagnostic.line ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (next.length < MAX_PREVIEW_DIAGNOSTICS - 1) next.push(diagnostic);
        else {
          next.push({ kind: 'limit', message: 'Additional preview errors were omitted.' });
          break;
        }
      }
      previewDiagnosticsRef.current = next;
      setPreviewDiagnostics(next);
      return next;
    };
    const finish = (values: unknown[] = []) => {
      if (completed) return;
      completed = true;
      window.clearTimeout(timer);
      const diagnostics = merge(values);
      setPreviewComplete(true);
      reportPreviewDiagnostics(previewId, diagnostics, true);
    };
    const timer = window.setTimeout(() => {
      finish([{ kind: 'timeout', message: 'The browser preview did not finish loading in time.' }]);
    }, 12_000);
    const receive = (event: MessageEvent) => {
      const frame = previewFrameRef.current;
      if (event.origin !== 'null' || event.source !== frame?.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.previewId !== previewId) return;
      if (data.type === 'nexo-preview-diagnostic') {
        const diagnostic = sanitizePreviewDiagnostic(data.diagnostic);
        if (!diagnostic || completed) return;
        const diagnostics = merge([diagnostic]);
        reportPreviewDiagnostics(previewId, diagnostics, false);
      } else if (data.type === 'nexo-preview-review') {
        if (!completed) reportPreviewReview(previewId, data.review);
      } else if (data.type === 'nexo-preview-interactions') {
        if (completed || interactionsComplete || Object.keys(data).sort().join() !== 'previewId,result,type' ||
            !reportPreviewInteractions(previewId, data.result)) return;
        interactionsComplete = true;
        setPreviewInteractions(readPreviewInteractions(previewId));
        if (runtimeComplete) finish();
      } else if (data.type === 'nexo-preview-complete') {
        if (completed || runtimeComplete || !Array.isArray(data.diagnostics) || data.diagnostics.length > MAX_PREVIEW_DIAGNOSTICS) return;
        runtimeComplete = true;
        const diagnostics = merge(data.diagnostics);
        reportPreviewDiagnostics(previewId, diagnostics, false);
        if (interactionsComplete) finish();
      }
    };
    window.addEventListener('message', receive);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('message', receive);
    };
  }, [previewId]);

  useEffect(() => {
    const current = abortRef.current;
    abortRef.current = null;
    current?.abort();
    setRunning(false);
    followConsoleRef.current = true;
    if (outputFrameRef.current !== null) window.cancelAnimationFrame(outputFrameRef.current);
    outputFrameRef.current = null;
    pendingOutputsRef.current = [];
    outputsRef.current = [];
    setOutputs([]); setRunError(''); setRunStatus(''); setPreview(null); setPreviewId(null);
    previewDiagnosticsRef.current = [];
    setPreviewDiagnostics([]); setPreviewComplete(false); setHasRun(false);
  }, [key]);
  useEffect(() => {
    if (!visible || waiting || agentCode || !project || preview || projectLanguage(project.entrypoint) !== 'html') return;
    try {
      const id = crypto.randomUUID();
      setPreview(makePreviewHtml(bundleHtmlProject(project.files, project.entrypoint), id));
      setPreviewId(id);
      setPreviewComplete(false);
      setHasRun(true);
      setView('preview');
    } catch (error) {
      setRunError(error instanceof Error ? error.message : 'The saved preview could not be restored.');
      setView('code');
    }
  }, [project, preview, agentCode, visible, waiting]);
  useEffect(() => () => {
    const current = abortRef.current;
    abortRef.current = null;
    current?.abort();
    if (outputFrameRef.current !== null) window.cancelAnimationFrame(outputFrameRef.current);
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draftsRef.current)); } catch {}
  }, []);
  useEffect(() => {
    const flushDrafts = () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draftsRef.current)); } catch {}
    };
    window.addEventListener('pagehide', flushDrafts);
    return () => window.removeEventListener('pagehide', flushDrafts);
  }, []);

  const flushOutputBatch = useCallback(() => {
    if (outputFrameRef.current !== null) {
      window.cancelAnimationFrame(outputFrameRef.current);
      outputFrameRef.current = null;
    }
    const batch = pendingOutputsRef.current.splice(0);
    if (batch.length === 0) return;
    const next = [...outputsRef.current, ...batch];
    outputsRef.current = next;
    setOutputs(next);
  }, []);

  const handleConsoleScroll = useCallback(() => {
    const element = consoleRef.current;
    if (element) followConsoleRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
  }, []);

  useEffect(() => {
    const element = consoleRef.current;
    if (element && followConsoleRef.current) element.scrollTop = element.scrollHeight;
  }, [outputs, runError, runStatus, running]);

  const setDraft = (patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [key]: { ...draft, ...patch, edited: true } }));
  const editorLanguage = useEditorLanguage(draft.language);
  const editorExtensions = useMemo(() => wrapLines
    ? [...editorLanguage.extensions, EditorView.lineWrapping]
    : editorLanguage.extensions, [editorLanguage.extensions, wrapLines]);
  const workspaceSize = useWorkspaceSize();
  const differs = !!generated && draft.edited && (generated.code !== draft.code || generated.language !== draft.language);
  const close = () => {
    abortRef.current?.abort();
    onClose();
    window.requestAnimationFrame(returnFocus);
  };

  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (event.target instanceof HTMLElement && event.target.closest('.cm-editor')) return;
      if (immersive && event.target instanceof HTMLElement && event.target.closest('textarea, input, select')) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, returnFocus, immersive, visible]);

  const stop = () => {
    const current = abortRef.current;
    if (!current) return;
    abortRef.current = null;
    current.abort();
    flushOutputBatch();
    setRunning(false);
    setRunStatus('');
    const stopped = [...outputsRef.current, { kind: 'status' as const, text: 'Stopped.' }];
    outputsRef.current = stopped;
    setOutputs(stopped);
  };

  const updateProject = (next: SavedProject | null) => {
    saveProject(next);
    if (next && !next.files.some((file) => file.path === activeProjectPath)) {
      setActiveProjectPath(next.entrypoint);
    }
  };
  const handleAddProjectFile = () => {
    const path = window.prompt('New project file path', `file-${(project?.files.length ?? 0) + 1}.js`)?.trim();
    if (!path || !project) return;
    try {
      const next = createSavedProject(
        [...project.files, { path, content: '' }],
        project.entrypoint,
        project.selectedPaths,
      );
      updateProject(next);
      setActiveProjectPath(path);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'The file could not be added.');
    }
  };
  const handleDeleteProjectFile = (path: string) => {
    if (!project) return;
    const files = project.files.filter((file) => file.path !== path);
    if (files.length === 0) {
      updateProject(null);
      setActiveProjectPath('');
      setPreview(null);
      return;
    }
    const entrypoint = project.entrypoint === path ? files[0].path : project.entrypoint;
    const next = createSavedProject(files, entrypoint, project.selectedPaths.filter((selected) => selected !== path));
    updateProject(next);
  };
  const exportProject = () => {
    if (!project) return;
    try {
      const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'nexo-project.json';
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setStorageError('The project could not be exported from this browser.');
    }
  };
  const toggleProjectContext = (path: string, selected: boolean) => {
    if (!project) return;
    updateProject(createSavedProject(
      project.files,
      project.entrypoint,
      selected
        ? [...project.selectedPaths, path]
        : project.selectedPaths.filter((item) => item !== path),
    ));
  };

  const askFix = () => {
    flushOutputBatch();
    const currentOutputs = outputsRef.current;
    const projectShared = project?.files.filter((file) => project.selectedPaths.includes(file.path)) ?? [];
    if (project && projectShared.length === 0) {
      setRunError('Select at least one project file to share with Nexo before asking for a fix.');
      return;
    }
    const previewErrors = previewDiagnosticsRef.current.map((diagnostic) =>
      `${diagnostic.kind}: ${diagnostic.message}${diagnostic.source ? ` (${diagnostic.source}${diagnostic.line ? `:${diagnostic.line}` : ''})` : ''}`
    );
    const errs = [
      runError,
      ...(previewId && interactionChecksHaveIssues(readPreviewInteractions(previewId))
        ? [formatInteractionResult(readPreviewInteractions(previewId))] : []),
      ...currentOutputs.filter((o) => o.kind === 'stderr').map((o) => o.text ?? ''),
      ...previewErrors,
    ].filter(Boolean).join('\n');
    const out = currentOutputs.filter((o) => o.kind === 'stdout').map((o) => o.text ?? '').join('').slice(-800);
    const summary = (errs || out || (hasRun ? 'It ran without visible output.' : 'Not run yet.')).slice(0, 2000);
    if (project) {
      onAskFix(`Please fix the selected project files in my workspace and return the complete corrected project. The selected files are attached as project context. Use the current browser run result to guide the fix.\n\n${errs ? 'Errors' : 'Console'}:\n${summary}`);
    } else {
      const fence = draft.language === 'html' ? 'html' : draft.language;
      onAskFix(`Please fix this ${LANG_LABEL[draft.language]} code from my workspace and return the full corrected version.\n\n\`\`\`${fence}\n${draft.code.slice(0, 8000)}\n\`\`\`\n\n${errs ? 'Errors' : 'Console'}:\n${summary}`);
    }
  };

  const activeProjectFile = project?.files.find((file) => file.path === activeProjectPath);
  const workspaceLanguage = project ? projectLanguage(project.entrypoint) : draft.language;
  const workspaceCode = activeProjectFile?.content ?? draft.code;
  const run = async () => {
    abortRef.current?.abort();
    flushOutputBatch();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    outputsRef.current = [];
    pendingOutputsRef.current = [];
    setRunning(true); setOutputs([]); setRunError(''); setRunStatus('Starting…'); setHasRun(true);
    setPreview(null); setPreviewId(null); setPreviewComplete(false);
    previewDiagnosticsRef.current = [];
    setPreviewDiagnostics([]);
    try {
      const code = project
        ? workspaceLanguage === 'html'
          ? bundleHtmlProject(project.files, project.entrypoint)
          : project.files.find((file) => file.path === project.entrypoint)?.content ?? ''
        : draft.code;
      if (!code.trim()) throw new Error('The selected project entry file is empty.');
      const res = await executeCode({
        language: workspaceLanguage,
        code,
        signal: ctrl.signal,
        onOutput: (output) => {
          if (abortRef.current !== ctrl) return;
          if (output.kind === 'status') {
            setRunStatus(output.text ?? 'Running…');
            return;
          }
          setRunStatus('');
          pendingOutputsRef.current.push(output);
          if (outputFrameRef.current === null) {
            outputFrameRef.current = window.requestAnimationFrame(flushOutputBatch);
          }
        },
      });
      if (abortRef.current !== ctrl) return;
      if (res.previewHtml) {
        setPreview(res.previewHtml);
        setPreviewId(res.previewId ?? null);
      }
      if (res.error && !res.outputs.some((output) => output.kind === 'stderr' && output.text === res.error)) setRunError(res.error);
    } catch (e) {
      if (abortRef.current !== ctrl) return;
      if (e instanceof DOMException && e.name === 'AbortError') {
        const stopped = [...outputsRef.current, { kind: 'status' as const, text: 'Stopped.' }];
        outputsRef.current = stopped;
        setOutputs(stopped);
      }
      else setRunError(e instanceof Error ? e.message : 'The runner failed to start.');
    } finally {
      if (abortRef.current === ctrl) {
        flushOutputBatch();
        abortRef.current = null;
        setRunning(false);
        setRunStatus('');
      }
    }
  };

  const isHtml = workspaceLanguage === 'html';
  const agentRunning = agentCode?.status === 'running';
  const runDisabled = project ? !activeProjectFile?.content.trim() || agentRunning : !draft.code.trim() || agentRunning;
  const editorNode = project ? (
    <ProjectFilesPanel
      files={project.files}
      activePath={activeProjectPath}
      selectedPaths={project.selectedPaths}
      isLight={isLight}
      disabled={running || agentRunning}
      onSelect={setActiveProjectPath}
      onChange={(path, content) => updateProject(createSavedProject(
        project.files.map((file) => file.path === path ? { ...file, content } : file),
        project.entrypoint,
        project.selectedPaths,
      ))}
      onToggleContext={toggleProjectContext}
      onDelete={handleDeleteProjectFile}
      onAdd={handleAddProjectFile}
      onExport={exportProject}
    />
  ) : (
    <div className="ws-editor">
      <CodeMirror value={draft.code} height="100%" theme={isLight ? 'light' : 'dark'} extensions={editorExtensions}
        onChange={(v) => { if (v !== draft.code) setDraft({ code: v }); }} aria-label="Code editor" data-testid="editor-code" />
    </div>
  );
  const previewNode = preview ? (
    <div className="ws-preview-pane" data-testid="preview-pane">
      <iframe
        key={previewId ?? 'html-preview'}
        ref={previewFrameRef}
        className="ws-preview"
        sandbox="allow-scripts"
        srcDoc={preview}
        title="Isolated HTML preview"
        data-testid="frame-preview"
      />
      {!previewComplete && <p className="ws-preview-status" role="status">Loading isolated preview…</p>}
      {previewComplete && previewDiagnostics.length === 0 && (
        <p className="ws-preview-status" role="status">Preview loaded. No runtime errors were reported.</p>
      )}
      {previewComplete && (
        <pre className="ws-preview-status" role={interactionChecksHaveIssues(previewInteractions) ? 'alert' : 'status'}
          data-testid="preview-interaction-results" style={{ whiteSpace: 'pre-wrap' }}>
          {formatInteractionResult(previewInteractions)}
        </pre>
      )}
      {previewDiagnostics.length > 0 && (
        <div className="ws-preview-diagnostics" role="alert" data-testid="preview-diagnostics">
          <strong>Preview diagnostics</strong>
          <ul>
            {previewDiagnostics.map((diagnostic, index) => (
              <li key={`${diagnostic.kind}-${index}`}>
                <span>{diagnostic.kind}</span>{' '}
                <code>{diagnostic.message}</code>
                {diagnostic.source && <small>{diagnostic.source}{diagnostic.line ? `:${diagnostic.line}` : ''}</small>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  ) : null;
  const consoleNode = (
    <div className="ws-console" ref={consoleRef} onScroll={handleConsoleScroll} role="log" aria-live="polite" data-testid="console-output">
      {!hasRun && <p className="c-status">Run code to see output.</p>}
      {outputs.map((o, i) => o.kind === 'image' && o.dataUrl
        ? <img key={i} src={o.dataUrl} alt={`Plot output ${i + 1}`} className="c-img" />
        : <pre key={i} className={`c-${o.kind}`}>{o.text}</pre>)}
      {running && <p className="c-status c-live" data-testid="status-run">{runStatus || 'Running…'}</p>}
      {hasRun && !running && !runError && outputs.length === 0 && !isHtml && <p className="c-status">Finished with no output.</p>}
      {hasRun && !running && isHtml && previewDiagnostics.length > 0 && previewDiagnostics.map((d, i) => (
        <pre key={`pd-${i}`} className="c-stderr">{`${d.kind}: ${d.message}${d.source ? ` (${d.source}${d.line ? `:${d.line}` : ''})` : ''}`}</pre>
      ))}
      {runError && <pre className="c-stderr" role="alert">{runError}</pre>}
    </div>
  );
  const runButton = running ? (
    <button type="button" className="ws-btn stop" onClick={stop} data-testid="button-stop-code"><Square size={13} aria-hidden="true" /> Stop</button>
  ) : (
    <button type="button" className="ws-btn run" onClick={() => void run()} disabled={runDisabled} data-testid="button-run-code">
      <Play size={13} aria-hidden="true" /> {project ? (immersive ? 'Rerun' : 'Run project') : immersive ? 'Rerun' : 'Run'}
    </button>
  );
  const askFixButton = (
    <button type="button" className="ws-mini accent" disabled={!canAsk} onClick={askFix} title={canAsk ? 'Send code and output to Nexo' : 'Wait for the current reply to finish'} data-testid="button-ask-fix"><Wrench size={11} aria-hidden="true" /> Ask Nexo to fix</button>
  );

  if (immersive) {
    const status = waiting ? 'Planning' : agentRunning ? (preview ? 'Checking preview' : 'Building') : agentCode?.status === 'error' ? 'Needs attention' : agentCode ? 'Ready' : 'Idle';
    const tabs: { id: View; label: string; Icon: typeof Eye }[] = [
      { id: 'preview', label: 'Preview', Icon: Eye },
      { id: 'code', label: 'Code', Icon: Code2 },
      { id: 'console', label: 'Console', Icon: ScrollText },
    ];
    const issueCount = previewDiagnostics.length + (runError ? 1 : 0) + outputs.filter((o) => o.kind === 'stderr').length;
    return (
      <section ref={panelRef} id="code-workspace" className="workspace ws-immersive" aria-label="Agent workspace" data-testid="panel-workspace" data-view={view} tabIndex={-1}>
        <header className="wsi-head">
          <button type="button" className="wsi-back" onClick={close} aria-label="Back to chat. Your project stays saved." data-testid="button-close-workspace">
            <ArrowLeft size={15} aria-hidden="true" /><span>Back to chat</span>
          </button>
          <div className="wsi-status" role="status" data-testid="status-workspace">
            <i className={`wsi-dot ${waiting || agentRunning ? 'is-live' : agentCode?.status === 'error' ? 'is-err' : ''}`} aria-hidden="true" />
            <span>{status}</span>
            {project && <small>{project.files.length} {project.files.length === 1 ? 'file' : 'files'}</small>}
          </div>
          <div className="wsi-tabs" role="tablist" aria-label="Workspace view">
            {tabs.map(({ id, label, Icon }) => (
              <button key={id} type="button" role="tab" id={`wsi-tab-${id}`} aria-selected={view === id} aria-controls={`wsi-pane-${id}`}
                className={view === id ? 'is-on' : ''} onClick={() => setView(id)} data-testid={`tab-view-${id}`}>
                <Icon size={13} aria-hidden="true" /><span>{label}</span>
                {id === 'console' && issueCount > 0 && <b className="wsi-badge" aria-label={`${issueCount} issues`}>{issueCount}</b>}
              </button>
            ))}
          </div>
          <div className="wsi-actions">
            {view === 'code' && <button type="button" className={`ws-btn wrap-toggle ${wrapLines ? 'is-on' : ''}`} aria-label="Wrap code lines"
              aria-pressed={wrapLines} onClick={() => setWrapLines((value) => !value)} data-testid="button-toggle-wrap">Wrap</button>}
            <CopyCodeButton text={workspaceCode} label={project && activeProjectFile ? `Copy ${activeProjectFile.path}` : 'Copy workspace code'} />
            {runButton}
          </div>
        </header>
        {storageError && <div className="ws-banner" role="alert">{storageError}</div>}
        <div className="wsi-body">
          {waiting ? (
            <div className="wsi-waiting" role="status" aria-live="polite" data-testid="status-agent-waiting">
              <div className="wsi-frame" aria-hidden="true">
                <div className="wsi-frame-bar"><i /><i /><i /></div>
                <div className="wsi-skel"><span className="w60" /><span className="w90" /><span className="w40" /><span className="block" /></div>
              </div>
              <h2>Nexo is drafting your project</h2>
              <ol className="wsi-steps">
                <li className="is-live">Reading your request</li>
                <li>Writing files</li>
                <li>Running it in an isolated preview</li>
              </ol>
              <p>Keep chatting on the left. The preview will appear here as soon as code arrives.</p>
            </div>
          ) : (
            <>
              <div id="wsi-pane-preview" role="tabpanel" aria-labelledby="wsi-tab-preview" className="wsi-pane" hidden={view !== 'preview'}>
                {previewNode ?? (
                  <div className="wsi-empty">
                    <Eye size={18} aria-hidden="true" />
                    <p>{agentRunning ? 'Running the code. The preview loads here next.' : isHtml ? 'No preview yet. Rerun the project to load it.' : 'This result is not a web page. Open Console for its output.'}</p>
                    {!agentRunning && !isHtml && <button type="button" className="ws-mini" onClick={() => setView('console')} data-testid="button-open-console">Open console</button>}
                  </div>
                )}
              </div>
              <div id="wsi-pane-code" role="tabpanel" aria-labelledby="wsi-tab-code" className="wsi-pane" hidden={view !== 'code'}>
                {!project && editorLanguage.error && <div className="ws-language-status" role="status">
                  Highlighting could not load. Plain-text editing is still available.
                  <button type="button" onClick={editorLanguage.retry}>Retry highlighting</button>
                </div>}
                {view === 'code' && editorNode}
              </div>
              <div id="wsi-pane-console" role="tabpanel" aria-labelledby="wsi-tab-console" className="wsi-pane" hidden={view !== 'console'}>
                <div className="ws-out-head"><span>Console</span><span className="ws-out-actions">{askFixButton}</span></div>
                {consoleNode}
              </div>
            </>
          )}
        </div>
      </section>
    );
  }

  return (
    <aside ref={panelRef} id="code-workspace" className="workspace workspace-resizable" style={{ ['--workspace-width' as string]: `${workspaceSize.width}px` }} aria-label="Code workspace" data-testid="panel-workspace" tabIndex={-1}>
      <div className="workspace-resizer" role="separator" aria-orientation="vertical" aria-label="Resize code workspace"
        aria-controls="code-workspace" tabIndex={0} aria-valuemin={workspaceSize.bounds.min} aria-valuemax={workspaceSize.bounds.max}
        aria-valuenow={workspaceSize.width} aria-valuetext={`${workspaceSize.width} pixels wide`}
        {...workspaceSize.separatorProps} data-testid="separator-workspace" />
      <header className="ws-head">
        <Terminal size={15} aria-hidden="true" className="ws-icon" />
        <span className="ws-title">Workspace</span>
        {agentCode && <span className="ws-agent-label" role="status">{agentRunning ? 'Agent running' : 'Agent result'}</span>}
        {project
          ? <span className="ws-project-label">{project.files.length} project {project.files.length === 1 ? 'file' : 'files'}</span>
          : <select className="ws-select" value={draft.language} aria-label="Language" onChange={(e) => setDraft({ language: e.target.value as RunLanguage })} data-testid="select-language">
              {(Object.keys(LANG_LABEL) as RunLanguage[]).map((l) => <option key={l} value={l}>{LANG_LABEL[l]}</option>)}
            </select>}
        <button type="button" className={`ws-btn wrap-toggle ${wrapLines ? 'is-on' : ''}`} aria-label="Wrap code lines"
          aria-pressed={wrapLines} title="Toggle soft line wrapping" onClick={() => setWrapLines((value) => !value)} data-testid="button-toggle-wrap">Wrap</button>
        {runButton}
        <button type="button" className="icon-btn" onClick={close} aria-label="Close workspace" data-testid="button-close-workspace"><X size={16} /></button>
      </header>
      {storageError && <div className="ws-banner" role="alert">{storageError}</div>}
      {!project && editorLanguage.loading && <div className="ws-language-status" role="status">Loading {LANG_LABEL[draft.language]} highlighting… You can keep editing.</div>}
      {!project && editorLanguage.error && <div className="ws-language-status" role="status">
          Highlighting could not load. Plain-text editing is still available.
          <button type="button" onClick={editorLanguage.retry}>Retry highlighting</button>
        </div>}

      {!project && snippets.length > 1 && (
        <div className="ws-snippets" role="tablist" aria-label="Generated snippets">
          {snippets.map((s, i) => (
            <button key={i} type="button" role="tab" aria-selected={i === sel} className={i === sel ? 'is-on' : ''} onClick={() => setSel(i)} data-testid={`tab-snippet-${i}`}>
              {i + 1}. {LANG_LABEL[s.language]}
            </button>
          ))}
        </div>
      )}
      {!project && differs && (
        <div className="ws-banner" data-testid="status-generated-differs">
          <span>Your edits are kept. Nexo has a newer generated version.</span>
          <button type="button" onClick={() => setDrafts((d) => ({ ...d, [key]: { language: generated!.language, code: generated!.code, edited: false } }))} data-testid="button-load-generated"><Download size={12} /> Load generated version</button>
        </div>
      )}

      {editorNode}

      <div className="ws-out">
        <div className="ws-out-head">
          <span>{isHtml ? 'Preview' : 'Console'}</span>
          <span className="ws-out-actions">
            <CopyCodeButton text={workspaceCode} label={project && activeProjectFile ? `Copy ${activeProjectFile.path}` : 'Copy workspace code'} />
            {!project && <button type="button" className="ws-mini" onClick={() => setDraft({ code: STARTERS[draft.language] })} title="Replace with starter" data-testid="button-reset-code"><RotateCcw size={11} /> Starter</button>}
            {askFixButton}
          </span>
        </div>
        {isHtml && previewNode ? previewNode : consoleNode}
      </div>
    </aside>
  );
}
