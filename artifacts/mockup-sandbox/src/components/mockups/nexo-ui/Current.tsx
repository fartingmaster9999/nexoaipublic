import { useState, type FormEvent } from "react";
import { ArrowUp, ArrowUpRight, Brain, MessageSquare, PanelLeft, Play, Plus, Settings2, Terminal, X } from "lucide-react";
import { HomeLanding } from "./HomeLanding";
import "./_group.css";

const logoUrl = "/__mockup/images/nexo-logo.png";
const prompts = [
  { label: "Make a plan", text: "Help me make a realistic plan for a calmer, more focused week." },
  { label: "Understand something", text: "Explain compound interest in plain language, with a simple example." },
  { label: "Find the words", text: "Help me write a thoughtful note to someone I have not checked in with." },
  { label: "Write some code", text: "Write a Python script that plots a damped sine wave with Matplotlib." },
];

export function Current() {
  const [active, setActive] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(typeof window !== "undefined" && window.innerWidth > 767);
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [deepthink, setDeepthink] = useState(false);
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState<string[]>([]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setSent((items) => [...items, text]);
    setDraft("");
    setActive(true);
  };

  return (
    <div className="app-shell">
      {active && sidebarOpen && (
        <aside className="sidebar is-open" style={{ ["--sb-w" as string]: "260px" }} aria-label="Conversation history">
          <div className="brand">
            <button className="brand-home" type="button" onClick={() => setActive(false)} aria-label="Go to Nexo AI home">
              <img className="brand-mark" src={logoUrl} alt="" /><span className="brand-name">Nexo AI</span>
            </button>
            <button className="icon-btn new-chat" type="button" aria-label="New conversation" onClick={() => setSent([])}><Plus size={18} /></button>
            <button className="icon-btn sb-close-mobile" type="button" aria-label="Close history sidebar" onClick={() => setSidebarOpen(false)}><X size={16} /></button>
          </div>
          <div className="thread-heading" aria-hidden="true">Recent</div>
          <div className="thread-list" role="list" aria-label="Saved conversations">
            <div className="thread-item is-active" role="listitem">
              <button type="button" className="thread-select is-active" aria-current="page">
                <MessageSquare className="thread-icon" size={14} /><span className="thread-title">Plot a damped sine wave</span>
              </button>
            </div>
          </div>
          <button className="sidebar-settings" type="button"><Settings2 size={16} /><span>Appearance</span></button>
        </aside>
      )}
      {active && sidebarOpen && <div className="sb-sep" role="separator" aria-orientation="vertical" aria-label="Resize conversation history" />}
      {active && sidebarOpen && <button className="scrim is-visible" aria-label="Close conversation menu" onClick={() => setSidebarOpen(false)} />}

      <main className="main-pane">
        <header className={`topbar ${active ? "" : "is-home"}`}>
          <div className="topbar-left">
            <button className="icon-btn topbar-home" type="button" onClick={() => setActive(false)} aria-label="Go to Nexo AI home" title="Home">
              <img src={logoUrl} alt="" />
            </button>
            {active && <button className="icon-btn" type="button" onClick={() => setSidebarOpen((open) => !open)} aria-label={sidebarOpen ? "Close history sidebar" : "Open history sidebar"} aria-expanded={sidebarOpen}><PanelLeft size={18} /></button>}
            <div className="context-title">{active ? "Plot a damped sine wave" : "Home"}</div>
          </div>
          {!active && <button className="icon-btn home-settings" type="button" aria-label="Appearance" title="Appearance"><Settings2 size={17} /></button>}
        </header>

        <section className={`chat-region ${active ? "" : "home-region"}`} aria-label={active ? "AI conversation" : "Nexo AI home"}>
          <div className="messages">
            {!active ? (
              <HomeLanding logoUrl={logoUrl} prompts={prompts} onStart={() => setActive(true)}
                onPrompt={(text) => { setDraft(text); setActive(true); }} />
            ) : (
              <div className="conversation-flow">
                <article className="message-row user">
                  <div className="avatar user-avatar is-blank" aria-hidden="true" />
                  <div className="message-content"><div className="message-text">Write a Python script that plots a damped sine wave with Matplotlib.</div></div>
                </article>
                <article className="message-row assistant">
                  <div className="avatar" aria-hidden="true"><img src={logoUrl} alt="" /></div>
                  <div className="message-content">
                    <div className="message-text markdown">
                      <p>Here’s a simple way to plot the curve. The exponential envelope controls how quickly its amplitude fades.</p>
                      <h2>What the plot shows</h2>
                      <ul><li>The oscillation comes from the sine function.</li><li>The exponential term gradually reduces its height.</li></ul>
                      <div className="code-block">
                        <div className="code-block-toolbar"><span>python</span><button className="code-copy-button" type="button">Copy</button></div>
                        <pre><code>{`import numpy as np\nimport matplotlib.pyplot as plt\n\nt = np.linspace(0, 10, 400)\ny = np.exp(-t / 4) * np.sin(2 * np.pi * t)\n\nplt.plot(t, y)\nplt.xlabel("Time")\nplt.ylabel("Amplitude")\nplt.show()`}</code></pre>
                      </div>
                      <p>Run it in the workspace to see the curve.</p>
                    </div>
                  </div>
                </article>
                {sent.map((text, index) => <article className="message-row user" key={`${text}-${index}`}><div className="message-content"><div className="message-text">{text}</div></div></article>)}
              </div>
            )}

            <form className={`composer-wrap ${deepthink ? "is-deep" : ""}`} onSubmit={submit} aria-label="Send a message">
              <div className="composer">
                <textarea rows={1} value={draft} onChange={(event) => setDraft(event.target.value)}
                  placeholder={deepthink ? "Describe a hard problem…" : "Ask Nexo AI anything…"} aria-label="Your message" />
              </div>
              <div className="composer-hint">
                <button type="button" aria-pressed={deepthink} className={`deep-toggle ${deepthink ? "is-on" : ""}`} onClick={() => setDeepthink((on) => !on)}>
                  <span className="deep-icon"><Brain size={15} /></span><span>Deepthink{deepthink ? " on" : ""}</span>
                </button>
                <span className="hint-keys">Enter to send · Shift + Enter for new line</span>
                <button className="send-button" type="submit" disabled={!draft.trim()} aria-label="Send message"><ArrowUp size={18} /></button>
              </div>
            </form>
          </div>
        </section>
      </main>

      {active && workspaceOpen && (
        <aside className="workspace workspace-resizable" style={{ ["--workspace-width" as string]: "520px" }} aria-label="Code workspace">
          <div className="workspace-resizer" role="separator" aria-orientation="vertical" aria-label="Resize code workspace" tabIndex={0} />
          <header className="ws-head"><Terminal size={15} className="ws-icon" /><span className="ws-title">Workspace</span>
            <select className="ws-select" aria-label="Language"><option>Python</option><option>JavaScript</option></select>
            <button type="button" className="ws-btn run"><Play size={13} /> Run</button>
            <button type="button" className="icon-btn" onClick={() => setWorkspaceOpen(false)} aria-label="Close workspace"><X size={16} /></button>
          </header>
          <div className="ws-editor"><pre>{`import numpy as np\nimport matplotlib.pyplot as plt\n\nt = np.linspace(0, 10, 400)\ny = np.exp(-t / 4) * np.sin(2 * np.pi * t)\n\nplt.plot(t, y)`}</pre></div>
          <div className="ws-out"><div className="ws-out-head"><span>Console</span><span className="ws-out-actions"><button className="ws-mini">Copy</button><button className="ws-mini accent">Ask Nexo to fix</button></span></div><div className="ws-console"><p className="c-status">Output appears here after you run your code.</p></div></div>
        </aside>
      )}
    </div>
  );
}
