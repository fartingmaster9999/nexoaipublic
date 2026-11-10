import { useState } from 'react';
import { Bot, Brain, ImagePlus } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import { CodeWorkspace } from '../src/components/code-workspace';
import { SettingsDialog } from '../src/components/settings-dialog';
import { useThemeSettings } from '../src/hooks/use-theme';
import '../src/index.css';
import '../src/nexo.css';
import '../src/refine.css';
import '../src/landing.css';
import '../src/ux-polish.css';
import '../src/answer-format.css';

function Fixture() {
  const theme = useThemeSettings();
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [settingsSection, setSettingsSection] = useState<'api' | 'appearance'>('api');
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [deepthink, setDeepthink] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
  const [streaming, setStreaming] = useState(false);
  return <div className="app-shell">
    <aside className="sidebar" aria-label="Conversation sidebar">
      <div className="brand"><span className="brand-name">Nexo</span></div>
      <div className="thread-heading">Recent conversations</div>
      <div className="thread-list">
        <button className="thread-select is-active" type="button">Theme contrast check</button>
        <button className="thread-select" type="button">Another conversation</button>
        <p className="thread-empty">Your saved conversations appear here.</p>
      </div>
      <button className="sidebar-settings" type="button" onClick={() => setSettingsOpen(true)}>Appearance settings</button>
    </aside>
    <main className="main-pane">
      <header className="topbar is-home">
        <div className="topbar-left">
          <span className="context-title">Appearance preview conversation</span>
        </div>
        <div className="topbar-right">
          <button className="top-btn" type="button" onClick={() => setSettingsOpen(true)}>Appearance</button>
        </div>
      </header>
      <section className="chat-region home-region" aria-label="Nexo AI home">
        <div className="messages">
        <div className="home-landing">
          <div className="landing-topline"><span className="landing-wordmark">NEXO AI</span><span className="landing-status">READY</span></div>
          <div className="landing-hero">
            <div className="landing-copy">
              <h1>Think clearly.<br /><span className="lx-accent">Build boldly.</span></h1>
              <p className="landing-intro">Ask questions, explore ideas, and create useful work with Nexo.</p>
              <div className="landing-actions">
                <button className="landing-primary" type="button" data-testid="primary-home-action">Start a conversation</button>
                <span className="landing-action-note">Private and ready when you are</span>
              </div>
            </div>
            <div className="landing-visual">
              <div className="landing-preview">
                <div className="landing-preview-head">NEXO · RESPONSE</div>
                <p className="landing-preview-question">Can you help me work through this?</p>
              </div>
            </div>
          </div>
          <div className="landing-start-heading"><h2>Start with an idea</h2></div>
          <div className="landing-prompts">
            <button className="landing-prompt" type="button"><span className="landing-prompt-copy"><em>Explore</em><b>Explain a topic</b><small>Get a clear overview to start from.</small></span></button>
          </div>
        </div>
        </div>
        <div className="composer-wrap">
          <div className="composer">
            <div className="composer-body"><textarea aria-label="Message composer" placeholder="Ask anything..." rows={1} /></div>
          </div>
          <div className="composer-hint">
            <div className="composer-mode-buttons" role="group" aria-label="Message modes">
              <button type="button" className="image-attach-button" aria-label="Attach image" title="Attach an image">
                <ImagePlus size={15} aria-hidden="true" />
              </button>
              <button type="button" className={`mode-toggle deep-toggle ${deepthink ? 'is-on' : ''}`}
                aria-label="Deepthink" aria-pressed={deepthink}
                aria-description={`${deepthink ? 'On. Uses deeper reasoning for your next message.' : 'Off. Select for deeper reasoning on your next message.'}${streaming ? ' Changes apply to your next message; this reply keeps its original mode.' : ''}`}
                title={`${deepthink ? 'On. Uses deeper reasoning for your next message.' : 'Off. Select for deeper reasoning on your next message.'}${streaming ? ' Changes apply to your next message; this reply keeps its original mode.' : ''}`}
                onClick={() => setDeepthink((value) => !value)} data-testid="toggle-deepthink">
                <span className="mode-toggle-icon deep-icon"><Brain size={15} aria-hidden="true" /></span><span>Deepthink</span>
              </button>
              <button type="button" className={`mode-toggle agent-toggle ${agentMode ? 'is-on' : ''}`}
                aria-label="Agent" aria-pressed={agentMode}
                aria-description={`${agentMode ? 'On. Routes your next message to Agent for research and build-and-test tasks.' : 'Off. Select to route your next message to Agent for research and build-and-test tasks.'}${streaming ? ' Changes apply to your next message; this reply keeps its original route.' : ''}`}
                title={`${agentMode ? 'On. Routes your next message to Agent for research and build-and-test tasks.' : 'Off. Select to route your next message to Agent for research and build-and-test tasks.'}${streaming ? ' Changes apply to your next message; this reply keeps its original route.' : ''}`}
                onClick={() => setAgentMode((value) => !value)} data-testid="toggle-agent">
                <span className="mode-toggle-icon agent-icon"><Bot size={15} aria-hidden="true" /></span><span>Agent</span>
              </button>
              <button type="button" hidden data-testid="simulate-streaming" onClick={() => setStreaming((value) => !value)}>Toggle streaming state</button>
              <button type="button" hidden data-testid="reopen-workspace-fixture" onClick={() => setWorkspaceOpen(true)}>Reopen workspace</button>
            </div>
            <span className="hint-keys">Enter to send</span>
            <button className="send-button" type="button" aria-label="Send message">Send</button>
          </div>
        </div>
      </section>
    </main>
    {workspaceOpen && <CodeWorkspace conversationId="theme-fixture" snippets={[{ language: 'python', code: 'print("Theme contrast")\n', label: 'Sample', complete: true }]}
      onClose={() => setWorkspaceOpen(false)} returnFocus={() => {}} onAskFix={() => {}} canAsk isLight={theme.isLight} />}
    <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} section={settingsSection} onSectionChange={setSettingsSection}
      themeId={theme.themeId} accentId={theme.accentId} setTheme={theme.setTheme} setAccent={theme.setAccent}
      groqConfigured onSaveApiKeys={() => {}} onRemoveGroqApiKey={() => {}} onRemoveGeminiApiKey={() => {}} />
  </div>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
