import type { RunLanguage } from './code-runner';

type EditorMode = ReturnType<typeof import('@codemirror/lang-python').python>;
const pending = new Map<RunLanguage, Promise<EditorMode>>();
const loaders = {
  python: () => import('@codemirror/lang-python').then((module) => module.python()),
  javascript: () => import('@codemirror/lang-javascript').then((module) => module.javascript()),
  html: () => import('@codemirror/lang-html').then((module) => module.html()),
};

export function loadEditorLanguage(language: RunLanguage): Promise<EditorMode> {
  const cached = pending.get(language);
  if (cached) return cached;
  const task = loaders[language]().catch((error) => {
    pending.delete(language); // A transient chunk failure must be retryable.
    throw error;
  });
  pending.set(language, task);
  return task;
}
