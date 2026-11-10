import * as Dialog from '@radix-ui/react-dialog';
import { Check, KeyRound, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { ACCENTS, THEMES, type AccentId, type ThemeId } from '@/hooks/use-theme';

type Props = {
  open: boolean; onOpenChange: (v: boolean) => void;
  section: 'api' | 'appearance'; onSectionChange: (section: 'api' | 'appearance') => void;
  themeId: ThemeId; accentId: AccentId; setTheme: (t: ThemeId) => void; setAccent: (a: AccentId) => void;
  groqConfigured: boolean;
  geminiConfigured: boolean;
  onSaveApiKeys: (keys: { groqApiKey: string; geminiApiKey: string }) => void;
  onRemoveGroqApiKey: () => void;
  onRemoveGeminiApiKey: () => void;
};

export function SettingsDialog({
  open, onOpenChange, section, onSectionChange, themeId, accentId, setTheme, setAccent,
  groqConfigured, geminiConfigured, onSaveApiKeys, onRemoveGroqApiKey, onRemoveGeminiApiKey,
}: Props) {
  const [groqDraft, setGroqDraft] = useState('');
  const [geminiDraft, setGeminiDraft] = useState('');
  const [keyError, setKeyError] = useState('');

  useEffect(() => {
    if (open) {
      setGroqDraft('');
      setGeminiDraft('');
      setKeyError('');
    }
  }, [open, groqConfigured, geminiConfigured]);

  const saveKeys = (event: FormEvent) => {
    event.preventDefault();
    if (!groqConfigured && !groqDraft.trim()) {
      setKeyError('A Groq API key is required to use Nexo AI.');
      return;
    }
    if (groqDraft.length > 512 || geminiDraft.length > 512) {
      setKeyError('API keys must be 512 characters or fewer.');
      return;
    }
    try {
      onSaveApiKeys({ groqApiKey: groqDraft.trim(), geminiApiKey: geminiDraft.trim() });
      setGroqDraft('');
      setGeminiDraft('');
      setKeyError('');
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : 'The API keys could not be saved.');
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="nx-overlay" />
        <Dialog.Content className="nx-dialog nx-settings-dialog" data-testid="dialog-settings">
          <div className="nx-dialog-head nx-settings-header">
            <div>
              <Dialog.Title className="nx-dialog-title">Settings</Dialog.Title>
              <Dialog.Description className="nx-dialog-desc">Manage provider connections and workspace preferences.</Dialog.Description>
            </div>
            {groqConfigured && <Dialog.Close className="icon-btn" aria-label="Close settings" data-testid="button-close-settings"><X size={16} /></Dialog.Close>}
          </div>
          <div className="nx-settings-layout">
            <nav className="nx-settings-nav" aria-label="Settings menu">
              <button type="button" className={`nx-settings-nav-item ${section === 'api' ? 'is-active' : ''}`}
                aria-current={section === 'api' ? 'page' : undefined} onClick={() => onSectionChange('api')} data-testid="settings-nav-api">
                <KeyRound size={16} aria-hidden="true" /><span>API Keys</span>
                {!groqConfigured && <span className="nx-settings-required" aria-label="Required">!</span>}
              </button>
              <button type="button" className={`nx-settings-nav-item ${section === 'appearance' ? 'is-active' : ''}`}
                aria-current={section === 'appearance' ? 'page' : undefined} onClick={() => onSectionChange('appearance')} data-testid="settings-nav-appearance">
                <span className="nx-settings-theme-icon" aria-hidden="true">Aa</span><span>Appearance</span>
              </button>
            </nav>
            <div className="nx-settings-panel" key={section}>
              {section === 'api' ? (
                <section aria-labelledby="settings-api-title">
                  <h2 className="nx-settings-title" id="settings-api-title">API Keys</h2>
                  <p className="nx-settings-intro">Connect your own AI providers. Keys stay in this browser and are not stored on Nexo’s server.</p>
                  <form className="provider-keys-form" onSubmit={saveKeys}>
                    <div className="nx-group-label">AI providers</div>
                    <div className="provider-key-field">
                      <label className="provider-key-label" htmlFor="groq-api-key">Groq API key <span>Required</span></label>
                      <ol className="provider-key-guide">
                        <li>Sign in to Groq, or create a Groq account.</li>
                        <li><a className="provider-key-link" href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer">Groq API Keys<span className="sr-only"> (opens in a new tab)</span></a></li>
                        <li>Create an API key and copy it.</li>
                        <li>Paste it in the Groq field below, then select Save keys.</li>
                      </ol>
                      <div className="provider-key-input-wrap">
                        <KeyRound size={15} aria-hidden="true" />
                        <input
                          id="groq-api-key"
                          className="provider-key-input"
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          maxLength={512}
                          value={groqDraft}
                          onChange={(event) => setGroqDraft(event.target.value)}
                          placeholder={groqConfigured ? 'Saved in this browser — paste to replace' : 'Paste your Groq API key'}
                          aria-required="true"
                          data-testid="input-groq-api-key"
                        />
                      </div>
                      {groqConfigured && <button type="button" className="provider-key-remove" onClick={() => {
                        try { onRemoveGroqApiKey(); setKeyError(''); }
                        catch (error) { setKeyError(error instanceof Error ? error.message : 'The Groq key could not be removed.'); }
                      }}>Remove Groq key</button>}
                    </div>
                    <div className="provider-key-field">
                      <label className="provider-key-label" htmlFor="gemini-api-key">Gemini API key <span>Optional</span></label>
                      <ol className="provider-key-guide">
                        <li>Sign in to Google AI Studio, or create a Google account.</li>
                        <li><a className="provider-key-link" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer">Google AI Studio API Keys<span className="sr-only"> (opens in a new tab)</span></a></li>
                        <li>Create an API key and copy it.</li>
                        <li>Paste it in the Gemini field below, then select Save keys.</li>
                      </ol>
                      <div className="provider-key-input-wrap">
                        <KeyRound size={15} aria-hidden="true" />
                        <input
                          id="gemini-api-key"
                          className="provider-key-input"
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          maxLength={512}
                          value={geminiDraft}
                          onChange={(event) => setGeminiDraft(event.target.value)}
                          placeholder={geminiConfigured ? 'Saved in this browser — paste to replace' : 'Paste your Gemini API key'}
                          data-testid="input-gemini-api-key"
                        />
                      </div>
                      {geminiConfigured && <button type="button" className="provider-key-remove" onClick={() => {
                        try { onRemoveGeminiApiKey(); setKeyError(''); }
                        catch (error) { setKeyError(error instanceof Error ? error.message : 'The Gemini key could not be removed.'); }
                      }}>Remove Gemini key</button>}
                    </div>
                    {keyError && <p className="provider-key-error" role="alert">{keyError}</p>}
                    <button className="provider-key-save" type="submit" data-testid="button-save-api-keys">Save keys</button>
                    <p className="provider-key-note">Groq is required for text chat. Gemini is optional; image analysis and some Agent features need a Gemini key. Keep your keys private—never share or publish them—and review usage and billing limits with each provider before use. Keys stay on this device, and anyone with access to this browser profile can use them.</p>
                  </form>
                </section>
              ) : (
                <section aria-labelledby="settings-appearance-title">
                  <h2 className="nx-settings-title" id="settings-appearance-title">Appearance</h2>
                  <p className="nx-settings-intro">Choose a theme and accent color for your workspace.</p>
                  <div className="nx-group-label" id="theme-label">Theme</div>
                  <div className="theme-grid" role="radiogroup" aria-labelledby="theme-label">
                    {THEMES.map((t) => (
                      <button key={t.id} type="button" role="radio" aria-checked={themeId === t.id}
                        className={`theme-card ${themeId === t.id ? 'is-on' : ''}`} onClick={() => setTheme(t.id)} data-testid={`theme-${t.id}`}>
                        <span className="theme-swatch" style={{ background: `hsl(${t.vars.background})`, borderColor: `hsl(${t.vars.border})` }}>
                          <i style={{ background: `hsl(${t.vars.sidebar})` }} />
                          <b style={{ background: `hsl(${t.vars.card})`, borderColor: `hsl(${t.vars.border})` }} />
                          <em style={{ background: 'hsl(var(--primary))' }} />
                        </span>
                        <span className="theme-name">{t.name}{themeId === t.id && <Check size={13} aria-hidden="true" />}</span>
                        <span className="theme-note">{t.note}</span>
                      </button>
                    ))}
                  </div>
                  <div className="nx-group-label" id="accent-label">Accent</div>
                  <div className="accent-row" role="radiogroup" aria-labelledby="accent-label">
                    {ACCENTS.map((a) => (
                      <button key={a.id} type="button" role="radio" aria-checked={accentId === a.id} aria-label={a.name} title={a.name}
                        className={`accent-dot ${accentId === a.id ? 'is-on' : ''}`} style={{ background: `hsl(${a.hsl})` }}
                        onClick={() => setAccent(a.id)} data-testid={`accent-${a.id}`} />
                    ))}
                  </div>
                </section>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
