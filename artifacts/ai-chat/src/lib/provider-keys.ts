const GROQ_KEY_STORAGE = 'nexo-provider-groq-key';
const GEMINI_KEY_STORAGE = 'nexo-provider-gemini-key';

export type ProviderKeys = {
  groqApiKey: string;
  geminiApiKey: string;
};

export function readProviderKeys(): ProviderKeys {
  try {
    return {
      groqApiKey: window.localStorage.getItem(GROQ_KEY_STORAGE)?.trim() ?? '',
      geminiApiKey: window.localStorage.getItem(GEMINI_KEY_STORAGE)?.trim() ?? '',
    };
  } catch {
    return { groqApiKey: '', geminiApiKey: '' };
  }
}

export function writeProviderKeys(keys: ProviderKeys): void {
  try {
    if (keys.groqApiKey) window.localStorage.setItem(GROQ_KEY_STORAGE, keys.groqApiKey);
    else window.localStorage.removeItem(GROQ_KEY_STORAGE);
    if (keys.geminiApiKey) window.localStorage.setItem(GEMINI_KEY_STORAGE, keys.geminiApiKey);
    else window.localStorage.removeItem(GEMINI_KEY_STORAGE);
  } catch {
    throw new Error('Browser storage is unavailable. Allow this site to store data, then try again.');
  }
}
