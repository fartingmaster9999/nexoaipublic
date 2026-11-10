import { useState, type FormEvent } from "react";
import { ArrowUp, Check, ChevronDown, Copy, Menu, MoreHorizontal, Paperclip, Plus, Sparkles } from "lucide-react";
import "./answer-craft.css";

const sampleCode = `import numpy as np
import matplotlib.pyplot as plt

t = np.linspace(0, 10, 400)
y = np.exp(-t / 4) * np.sin(2 * np.pi * t)

fig, ax = plt.subplots(figsize=(8, 4))
ax.plot(t, y, color="#7da9ff", linewidth=2)
ax.set(xlabel="Time (s)", ylabel="Amplitude")
ax.grid(alpha=0.18)
plt.show()`;

export function AnswerCraft() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState<string[]>([]);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(sampleCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setSent((items) => [...items, text]);
    setDraft("");
  };

  return (
    <div className="ac-shell">
      <aside className={`ac-rail ${menuOpen ? "ac-rail-open" : ""}`}>
        <div className="ac-brand">
          <div className="ac-mark" aria-hidden="true"><Sparkles size={16} /></div>
          <span>Nexo<span className="ac-brand-ai"> AI</span></span>
          <button className="ac-icon-button ac-rail-close" onClick={() => setMenuOpen(false)} aria-label="Close navigation"><ChevronDown size={17} /></button>
        </div>
        <button className="ac-new-chat" onClick={() => setSent([])}><Plus size={16} /> New conversation</button>
        <div className="ac-rail-label">RECENT</div>
        <button className="ac-thread active"><span className="ac-thread-dot" />Plot a damped sine wave</button>
        <button className="ac-thread">Explain Fourier transforms</button>
        <button className="ac-thread">Notes for Monday</button>
        <div className="ac-rail-bottom"><span className="ac-user-mark">M</span><span className="ac-user-label">Mira Chen</span><MoreHorizontal size={18} /></div>
      </aside>

      {menuOpen && <button className="ac-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
      <main className="ac-main">
        <header className="ac-topbar">
          <button className="ac-icon-button ac-menu" onClick={() => setMenuOpen((open) => !open)} aria-label="Toggle navigation"><Menu size={19} /></button>
          <div className="ac-model">Nexo 2.1 <ChevronDown size={14} /></div>
          <div className="ac-top-actions"><span className="ac-status"><i /> All systems ready</span><button className="ac-icon-button" aria-label="More conversation options"><MoreHorizontal size={19} /></button></div>
        </header>

        <div className="ac-scroll">
          <section className="ac-thread-view" aria-label="Conversation">
            <div className="ac-user-question">
              <div className="ac-question-label">YOU <span>·</span> 10:42 AM</div>
              <p>Write a Python script that plots a damped sine wave with Matplotlib.</p>
            </div>

            <article className="ac-answer">
              <div className="ac-answer-meta">
                <div className="ac-assistant-mark"><Sparkles size={15} /></div>
                <span>Nexo</span><span className="ac-meta-divider">·</span><span className="ac-muted">Thought for a moment</span>
                <button className="ac-icon-button ac-answer-menu" aria-label="More answer options"><MoreHorizontal size={18} /></button>
              </div>

              <div className="ac-prose">
                <p className="ac-lead">A damped sine wave is a regular oscillation whose amplitude shrinks over time. Multiply a sine function by an exponential decay to get the curve:</p>

                <div className="ac-equation" role="math" aria-label="y of t equals exponential negative t over tau times sine of omega t">
                  <span className="ac-equation-y">y(t)</span>
                  <span>=</span>
                  <span className="ac-exp">e<sup>−t/τ</sup></span>
                  <span className="ac-equation-times">·</span>
                  <span className="ac-sin">sin(ωt)</span>
                  <span className="ac-equation-note">decay envelope × oscillation</span>
                </div>

                <h2>Build the curve</h2>
                <p>Here, <code>τ</code> sets how quickly the wave fades, while <code>ω</code> controls how fast it oscillates. The example uses a decay constant of 4 seconds and a frequency of one cycle per second.</p>

                <div className="ac-code">
                  <div className="ac-code-head"><span><i className="ac-language-dot" />Python</span><button onClick={copyCode} aria-label="Copy Python code">{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Copied" : "Copy"}</button></div>
                  <pre tabIndex={0} aria-label="Python example"><code>{sampleCode}</code></pre>
                </div>

                <h2>What to notice</h2>
                <ul className="ac-list">
                  <li><strong>The envelope:</strong> <code>np.exp(-t / 4)</code> steadily lowers the peak amplitude.</li>
                  <li><strong>The rhythm:</strong> <code>2 * np.pi * t</code> gives one complete cycle per second.</li>
                  <li><strong>The result:</strong> the oscillation keeps its shape while each peak moves closer to zero.</li>
                </ul>

                <aside className="ac-callout"><span className="ac-callout-mark">i</span><p>To make the wave fade faster, reduce the denominator in <code>np.exp(-t / 4)</code>. A value of <code>2</code> halves the decay time.</p></aside>

                <p>Run the script to see the curve. Adjust the decay constant or frequency to explore how each parameter changes its shape.</p>
              </div>
              <div className="ac-feedback"><button onClick={copyCode}><Copy size={14} /> Copy code</button><span className="ac-feedback-sep" /><button aria-label="More answer actions"><MoreHorizontal size={17} /></button></div>
            </article>

            {sent.map((text, index) => <div className="ac-follow-up" key={`${text}-${index}`}><span>YOU</span><p>{text}</p></div>)}
          </section>
        </div>

        <div className="ac-composer-wrap">
          <form className="ac-composer" onSubmit={submit}>
            <textarea rows={1} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
            }} placeholder="Ask a follow-up…" aria-label="Ask a follow-up" />
            <div className="ac-composer-bottom"><button type="button" className="ac-icon-button" aria-label="Attach a file"><Paperclip size={17} /></button><span>Enter to send <span className="ac-key">↵</span></span><button className="ac-send" type="submit" disabled={!draft.trim()} aria-label="Send follow-up"><ArrowUp size={17} /></button></div>
          </form>
          <div className="ac-footnote">Nexo can make mistakes. Check important information.</div>
        </div>
      </main>
    </div>
  );
}
