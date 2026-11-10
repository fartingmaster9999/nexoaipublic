import { lazy, Suspense, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MessageMarkdown } from '../src/components/message-markdown';
import { SettingsDialog } from '../src/components/settings-dialog';
import { executeCode } from '../src/lib/code-runner';
import { createSavedProject, writeSavedProject } from '../src/lib/project-workspace';
import type { RunLanguage } from '../src/lib/code-runner';
import '../src/index.css';
import '../src/nexo.css';
import '../src/refine.css';
import '../src/ux-polish.css';
import '../src/answer-format.css';

const CodeWorkspace = lazy(() => import('../src/components/code-workspace').then((module) => ({ default: module.CodeWorkspace })));
const raw = '\tprint("hello ✓")  \r\n\r\n';
const longRust = Array.from({ length: 72 }, (_, index) => `let value_${index} = ${index};`).join('\n');
const markdown = `Inline \`not a block\`.\n\n\`\`\`python\r\n${raw}\`\`\`\n\n~~~rust\n${longRust}\n~~~`;

function Fixture() {
  const [open, setOpen] = useState(new URLSearchParams(location.search).has('open'));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [language, setLanguage] = useState<RunLanguage>('python');
  const [code, setCode] = useState('print("hello")\n');
  const [conversation, setConversation] = useState('workspace-fixture');
  const conversationControlRef = useRef<HTMLButtonElement>(null);
  Object.assign(window, {
    __workspaceFixture: {
      raw,
      open: (value: boolean) => flushSync(() => setOpen(value)),
      openSettings: () => flushSync(() => setSettingsOpen(true)),
      generated: (value: RunLanguage, text: string) => flushSync(() => { setLanguage(value); setCode(text); }),
      conversation: (value: string) => flushSync(() => setConversation(value)),
      saveProject: (files: { path: string; content: string }[], entrypoint: string, selectedPaths: string[] = []) =>
        writeSavedProject(localStorage, conversation, createSavedProject(files, entrypoint, selectedPaths)),
      execute: executeCode,
    },
  });
  return <div className="app-shell">
    <main className="main-pane"><div className="messages" data-testid="fixture-chat-scroll" style={{ height: 320, flex: 'none' }}>
      <div className="markdown" style={{ padding: 28 }}>
        <h1>Workspace checks</h1>
        <button ref={conversationControlRef} type="button" onClick={() => setOpen(true)} data-testid="button-conversation-control">Conversation</button>
        <div className="message-text markdown"><MessageMarkdown content={markdown} /></div>
        <div aria-hidden="true" style={{ height: 1000 }} />
      </div>
    </div></main>
    {open && <Suspense fallback={<div data-testid="workspace-loading">Loading workspace…</div>}>
      <CodeWorkspace conversationId={conversation}
        snippets={[{ language, code, label: 'Test code', complete: true }]}
        onClose={() => setOpen(false)}
        returnFocus={() => conversationControlRef.current?.focus({ preventScroll: true })}
        onAskFix={() => {}} canAsk isLight={false} />
    </Suspense>}
    <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} section="appearance" onSectionChange={() => {}}
      themeId="midnight" accentId="blue" setTheme={() => {}} setAccent={() => {}}
      groqConfigured onSaveApiKeys={() => {}} onRemoveGroqApiKey={() => {}} onRemoveGeminiApiKey={() => {}} />
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
