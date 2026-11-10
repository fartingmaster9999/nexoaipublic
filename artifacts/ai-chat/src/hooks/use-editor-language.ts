import { useEffect, useMemo, useState } from 'react';
import { loadEditorLanguage } from '@/lib/editor-language';
import type { RunLanguage } from '@/lib/code-runner';

type Mode = Awaited<ReturnType<typeof loadEditorLanguage>>;
export function useEditorLanguage(language: RunLanguage) {
  const [state, setState] = useState<{ language: RunLanguage; mode: Mode | null; error: boolean }>({ language, mode: null, error: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setState({ language, mode: null, error: false });
    loadEditorLanguage(language).then(
      (mode) => { if (active) setState({ language, mode, error: false }); },
      () => { if (active) setState({ language, mode: null, error: true }); },
    );
    return () => { active = false; };
  }, [language, attempt]);
  // Never give a new language the previous language's highlighting while loading.
  const mode = state.language === language ? state.mode : null;
  return {
    extensions: useMemo(() => mode ? [mode] : [], [mode]),
    error: state.language === language && state.error,
    loading: !mode && !(state.language === language && state.error),
    retry: () => setAttempt((value) => value + 1),
  };
}
