import * as Dialog from "@radix-ui/react-dialog";
import { Check, KeyRound, Settings2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ACCENTS, THEMES, type AccentId, type ThemeId } from "./data";
import "./_group.css";

type Props = {
  open: boolean; onOpenChange: (v: boolean) => void;
  themeId: ThemeId; accentId: AccentId; setTheme: (t: ThemeId) => void; setAccent: (a: AccentId) => void;
  groqConfigured: boolean; geminiConfigured: boolean;
  onSaveApiKeys: (keys: { groqApiKey: string; geminiApiKey: string }) => void;
  onRemoveGroqApiKey: () => void; onRemoveGeminiApiKey: () => void;
};

function SettingsDialog({
  open, onOpenChange, themeId, accentId, setTheme, setAccent,
  groqConfigured, geminiConfigured, onSaveApiKeys, onRemoveGroqApiKey, onRemoveGeminiApiKey,
}: Props) {
  const [groqDraft, setGroqDraft] = useState("");
  const [geminiDraft, setGeminiDraft] = useState("");
  const [keyError, setKeyError] = useState("");

  const saveKeys = (event: FormEvent) => {
    event.preventDefault();
    if (!groqConfigured && !groqDraft.trim()) { setKeyError("A Groq API key is required to use Nexo AI."); return; }
    if (groqDraft.length > 512 || geminiDraft.length > 512) { setKeyError("API keys must be 512 characters or fewer."); return; }
    try {
      onSaveApiKeys({ groqApiKey: groqDraft.trim(), geminiApiKey: geminiDraft.trim() });
      setGroqDraft(""); setGeminiDraft(""); setKeyError("");
    } catch (error) { setKeyError(error instanceof Error ? error.message : "The API keys could not be saved."); }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="nx-overlay" />
        <Dialog.Content className="nx-dialog" data-testid="dialog-settings">
          <div className="nx-dialog-head">
            <Dialog.Title className="nx-dialog-title">Settings</Dialog.Title>
            {groqConfigured && <Dialog.Close className="icon-btn" aria-label="Close settings" data-testid="button-close-settings"><X size={16} /></Dialog.Close>}
          </div>
          <Dialog.Description className="nx-dialog-desc">Keys stay in this browser and pass through Nexo only to fulfill your requests. Nexo does not save them on its server.</Dialog.Description>
          <form className="provider-keys-form" onSubmit={saveKeys}>
            <div className="nx-group-label">AI provider keys</div>
            <div className="provider-key-field">
              <label className="provider-key-label" htmlFor="groq-api-key">Groq API key <span>Required</span></label>
              <div className="provider-key-input-wrap"><KeyRound size={15} aria-hidden="true" /><input id="groq-api-key" className="provider-key-input" type="password" autoComplete="off" spellCheck={false} maxLength={512} value={groqDraft} onChange={(event) => setGroqDraft(event.target.value)} placeholder={groqConfigured ? "Saved in this browser — paste to replace" : "Paste your Groq API key"} aria-required="true" data-testid="input-groq-api-key" /></div>
              {groqConfigured && <button type="button" className="provider-key-remove" onClick={() => { try { onRemoveGroqApiKey(); setKeyError(""); } catch (error) { setKeyError(error instanceof Error ? error.message : "The Groq key could not be removed."); } }}>Remove Groq key</button>}
            </div>
            <div className="provider-key-field">
              <label className="provider-key-label" htmlFor="gemini-api-key">Gemini API key <span>Optional</span></label>
              <div className="provider-key-input-wrap"><KeyRound size={15} aria-hidden="true" /><input id="gemini-api-key" className="provider-key-input" type="password" autoComplete="off" spellCheck={false} maxLength={512} value={geminiDraft} onChange={(event) => setGeminiDraft(event.target.value)} placeholder={geminiConfigured ? "Saved in this browser — paste to replace" : "Paste your Gemini API key"} data-testid="input-gemini-api-key" /></div>
              {geminiConfigured && <button type="button" className="provider-key-remove" onClick={() => { try { onRemoveGeminiApiKey(); setKeyError(""); } catch (error) { setKeyError(error instanceof Error ? error.message : "The Gemini key could not be removed."); } }}>Remove Gemini key</button>}
            </div>
            {keyError && <p className="provider-key-error" role="alert">{keyError}</p>}
            <button className="provider-key-save" type="submit" data-testid="button-save-api-keys">Save keys</button>
            <p className="provider-key-note">Keys stay on this device. Gemini is optional for text chat, but image analysis and some Agent features need it. Anyone with access to this browser profile can use these keys.</p>
          </form>
          <div className="nx-group-label" id="theme-label">Theme</div>
          <div className="theme-grid" role="radiogroup" aria-labelledby="theme-label">
            {THEMES.map((theme) => <button key={theme.id} type="button" role="radio" aria-checked={themeId === theme.id} className={`theme-card ${themeId === theme.id ? "is-on" : ""}`} onClick={() => setTheme(theme.id)}>
              <span className="theme-swatch" style={{ background: `hsl(${theme.vars.background})`, borderColor: `hsl(${theme.vars.border})` }}><i style={{ background: `hsl(${theme.vars.sidebar})` }} /><b style={{ background: `hsl(${theme.vars.card})`, borderColor: `hsl(${theme.vars.border})` }} /><em style={{ background: "hsl(var(--primary))" }} /></span>
              <span className="theme-name">{theme.name}{themeId === theme.id && <Check size={13} aria-hidden="true" />}</span><span className="theme-note">{theme.note}</span>
            </button>)}
          </div>
          <div className="nx-group-label" id="accent-label">Accent</div>
          <div className="accent-row" role="radiogroup" aria-labelledby="accent-label">
            {ACCENTS.map((accent) => <button key={accent.id} type="button" role="radio" aria-checked={accentId === accent.id} aria-label={accent.name} title={accent.name} className={`accent-dot ${accentId === accent.id ? "is-on" : ""}`} style={{ background: `hsl(${accent.hsl})` }} onClick={() => setAccent(accent.id)} />)}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Current() {
  const [themeId, setThemeId] = useState<ThemeId>("midnight");
  const [accentId, setAccentId] = useState<AccentId>("blue");
  return <>
    <div className="api-frame-backdrop" aria-hidden="true">
      <div className="api-frame-topbar"><div className="api-frame-brand"><span className="api-frame-logo"><Settings2 size={14} /></span>Nexo AI</div><Settings2 size={16} /></div>
      <div className="api-frame-content"><h1 className="api-frame-greeting">What can I help with?</h1><div className="api-frame-prompt" /><div className="api-frame-shortcuts"><span /><span /><span /></div></div>
      <div className="api-frame-composer" />
    </div>
    <SettingsDialog open onOpenChange={() => {}} themeId={themeId} accentId={accentId} setTheme={setThemeId} setAccent={setAccentId} groqConfigured={false} geminiConfigured={false} onSaveApiKeys={() => {}} onRemoveGroqApiKey={() => {}} onRemoveGeminiApiKey={() => {}} />
  </>;
}
