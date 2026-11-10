import { projectStorageKey } from './project-workspace.ts';

export const WORKSPACE_DRAFT_KEY = 'nexo-code-drafts-v1';

/** Check for recoverable work without loading editor runtimes or running any code. */
export function savedWorkspaceState(storage: Pick<Storage, 'getItem'>, conversationId: string | null) {
  if (!conversationId) return { hasProject: false, hasDraft: false };
  let hasProject = false;
  let hasDraft = false;
  try {
    // Keep malformed projects reachable too: the workspace shows the read error.
    hasProject = storage.getItem(projectStorageKey(conversationId)) !== null;
  } catch { /* Storage may be disabled; live generated snippets remain available. */ }
  try {
    const drafts = JSON.parse(storage.getItem(WORKSPACE_DRAFT_KEY) ?? '{}');
    const draft = drafts && Object.hasOwn(drafts, conversationId) ? drafts[conversationId] : null;
    hasDraft = Boolean(draft && typeof draft.code === 'string' &&
      ['python', 'javascript', 'html'].includes(draft.language));
  } catch { /* A corrupt draft must not hide an independent saved project. */ }
  return { hasProject, hasDraft };
}
