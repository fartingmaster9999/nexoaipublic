import * as Dialog from "@radix-ui/react-dialog";
import { Check, Eye, EyeOff, KeyRound, LockKeyhole, ShieldCheck, Sparkles, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ACCENTS, THEMES, type AccentId, type ThemeId } from "./data";
import "./_group.css";

type Provider = "groq" | "gemini";

export function Refined() {
  const [groqDraft, setGroqDraft] = useState("");
  const [geminiDraft, setGeminiDraft] = useState("");
  const [groqConfigured, setGroqConfigured] = useState(false);
  const [geminiConfigured, setGeminiConfigured] = useState(false);
  const [visible, setVisible] = useState<Record<Provider, boolean>>({ groq: false, gemini: false });
  const [accent, setAccent] = useState<AccentId>("blue");
  const [theme, setTheme] = useState<ThemeId>("midnight");
  const [error, setError] = useState("");

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!groqConfigured && !groqDraft.trim()) { setError("Add a Groq key to continue."); return; }
    if (groqDraft.length > 512 || geminiDraft.length > 512) { setError("API keys must be 512 characters or fewer."); return; }
    if (groqDraft.trim()) setGroqConfigured(true);
    if (geminiDraft.trim()) setGeminiConfigured(true);
    setGroqDraft(""); setGeminiDraft(""); setError("");
  };

  const remove = (provider: Provider) => {
    if (provider === "groq") setGroqConfigured(false);
    else setGeminiConfigured(false);
    setError("");
  };

  const providerField = (provider: Provider) => {
    const isGroq = provider === "groq";
    const title = isGroq ? "Groq" : "Google Gemini";
    const configured = isGroq ? groqConfigured : geminiConfigured;
    const draft = isGroq ? groqDraft : geminiDraft;
    const setDraft = isGroq ? setGroqDraft : setGeminiDraft;
    const inputId = isGroq ? "refined-groq-key" : "refined-gemini-key";
    return <section className="provider-card" key={provider} aria-label={`${title} API key`}>
      <div className="provider-card-top">
        <span className={`provider-mark ${provider}`} aria-hidden="true">{isGroq ? "G" : "✦"}</span>
        <div className="provider-title"><strong>{title}</strong><small>{isGroq ? "Fast, reliable models for everyday chat" : "Optional support for image and Agent features"}</small></div>
        <span className={`provider-badge ${configured ? "connected" : isGroq ? "required" : ""}`}>
          {configured ? <><Check /> Connected</> : isGroq ? "Required" : "Optional"}
        </span>
      </div>
      <label className="refined-field-label" htmlFor={inputId}>{isGroq ? "API key" : "API key"}{configured && <button type="button" className="refined-remove" onClick={() => remove(provider)}>Remove key</button>}</label>
      <div className="provider-key-input-wrap refined-input-wrap">
        <KeyRound size={14} aria-hidden="true" />
        <input id={inputId} className="provider-key-input" type={visible[provider] ? "text" : "password"} autoComplete="off" spellCheck={false} maxLength={512} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={configured ? "Saved on this device · paste to replace" : `Paste your ${isGroq ? "Groq" : "Gemini"} API key`} aria-required={isGroq || undefined} />
        <button type="button" aria-label={`${visible[provider] ? "Hide" : "Show"} ${title} key`} onClick={() => setVisible((state) => ({ ...state, [provider]: !state[provider] }))}>{visible[provider] ? <EyeOff /> : <Eye />}</button>
      </div>
      {isGroq && <p className="refined-helper"><LockKeyhole size={12} />Required to start using Nexo. Your key is stored in this browser.</p>}
    </section>;
  };

  return <>
    <div className="api-frame-backdrop" aria-hidden="true">
      <div className="api-frame-topbar"><div className="api-frame-brand"><span className="api-frame-logo"><Sparkles size={14} /></span>Nexo AI</div><span style={{ color: "hsl(var(--muted-foreground))", fontSize: 11 }}>New conversation</span></div>
      <div className="api-frame-content"><h1 className="api-frame-greeting">What can I help with?</h1><div className="api-frame-prompt" /><div className="api-frame-shortcuts"><span /><span /><span /></div></div>
      <div className="api-frame-composer" />
    </div>
    <Dialog.Root open onOpenChange={() => {}}>
      <Dialog.Portal>
        <Dialog.Overlay className="nx-overlay" />
        <Dialog.Content className="nx-dialog refined-dialog" aria-describedby="provider-settings-description">
          <div className="refined-heading">
            <span className="refined-heading-icon"><KeyRound size={18} /></span>
            <div className="refined-heading-copy">
              <div className="nx-dialog-head"><Dialog.Title className="nx-dialog-title">AI provider keys</Dialog.Title>{groqConfigured && <Dialog.Close className="icon-btn" aria-label="Close settings"><X size={16} /></Dialog.Close>}</div>
              <Dialog.Description className="nx-dialog-desc" id="provider-settings-description">Connect your own models. Keys are saved in this browser, not on Nexo’s servers.</Dialog.Description>
            </div>
          </div>
          <div className="provider-section-title"><h3>Providers</h3><span className="provider-count">{Number(groqConfigured) + Number(geminiConfigured)} of 2 connected</span></div>
          <form onSubmit={save}>
            {providerField("groq")}
            {providerField("gemini")}
            {error && <p className="refined-error" role="alert">{error}</p>}
            <button className="provider-key-save refined-save" type="submit">{groqConfigured || geminiConfigured ? "Save changes" : "Save provider keys"}</button>
          </form>
          <div className="refined-privacy"><ShieldCheck size={14} /><span>Your keys stay on this device and are used only to fulfill your requests. Anyone with access to this browser profile can use them.</span></div>
          <div className="refined-appearance">
            <div className="refined-appearance-heading"><strong>Appearance</strong><span>Personalize your workspace</span></div>
            <div className="refined-theme-grid" role="radiogroup" aria-label="Theme">
              {THEMES.map((item) => <button key={item.id} type="button" role="radio" aria-checked={theme === item.id} className={`refined-theme-option ${theme === item.id ? "is-on" : ""}`} onClick={() => setTheme(item.id)}>
                <span className="refined-theme-swatch" style={{ background: `hsl(${item.vars.background})`, borderColor: `hsl(${item.vars.border})` }}><i style={{ background: `hsl(${item.vars.sidebar})` }} /><b style={{ background: `hsl(${item.vars.card})`, borderColor: `hsl(${item.vars.border})` }} /></span>
                <span>{item.name}{theme === item.id && <Check size={11} />}</span>
              </button>)}
            </div>
            <div className="refined-accent-line"><span>Accent color</span><div className="accent-row" role="radiogroup" aria-label="Accent color">
              {ACCENTS.map((item) => <button key={item.id} type="button" role="radio" aria-checked={accent === item.id} aria-label={item.name} title={item.name} className={`accent-dot ${accent === item.id ? "is-on" : ""}`} style={{ background: `hsl(${item.hsl})` }} onClick={() => setAccent(item.id)} />)}
            </div></div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}
