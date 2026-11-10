export type ProjectFile = { path: string; content: string };
export type SavedProject = {
  files: ProjectFile[];
  entrypoint: string;
  selectedPaths: string[];
};

export const MAX_PROJECT_FILES = 8;
export const MAX_PROJECT_FILE_CHARS = 12_000;
export const MAX_PROJECT_TOTAL_CHARS = 12_000;
export const MAX_PROJECT_PATH_CHARS = 160;
const PROJECT_KEY_PREFIX = 'nexo-project-v1:';

export function validateProjectFiles(value: unknown): ProjectFile[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PROJECT_FILES) {
    throw new Error(`A project must contain 1–${MAX_PROJECT_FILES} files.`);
  }
  const seen = new Set<string>();
  let totalChars = 0;
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('A project file is invalid.');
    const file = item as Record<string, unknown>;
    if (typeof file.path !== 'string' || !file.path || file.path.length > MAX_PROJECT_PATH_CHARS ||
        file.path.startsWith('/') || file.path.includes('\\') || /[\u0000-\u001f\u007f]/.test(file.path)) {
      throw new Error('Project file paths must be short, relative paths without control characters.');
    }
    const segments = file.path.split('/');
    if (segments.some((part) => !part || part === '.' || part === '..') || !/^[A-Za-z0-9._/-]+$/.test(file.path)) {
      throw new Error('Project file paths may use letters, numbers, dots, underscores, and hyphens only.');
    }
    if (seen.has(file.path)) throw new Error(`The project contains the file “${file.path}” more than once.`);
    if (typeof file.content !== 'string' || file.content.length > MAX_PROJECT_FILE_CHARS || file.content.includes('\0')) {
      throw new Error(`Each project file must contain at most ${MAX_PROJECT_FILE_CHARS.toLocaleString()} characters.`);
    }
    totalChars += file.content.length;
    if (totalChars > MAX_PROJECT_TOTAL_CHARS) {
      throw new Error(`Project files must total at most ${MAX_PROJECT_TOTAL_CHARS.toLocaleString()} characters.`);
    }
    seen.add(file.path);
    return { path: file.path, content: file.content };
  });
}

export function createSavedProject(
  files: unknown,
  entrypoint: string,
  selectedPaths: string[] = [],
): SavedProject {
  const safeFiles = validateProjectFiles(files);
  if (!safeFiles.some((file) => file.path === entrypoint)) throw new Error('The project entry file is missing.');
  const existing = new Set(safeFiles.map((file) => file.path));
  return {
    files: safeFiles,
    entrypoint,
    selectedPaths: [...new Set(selectedPaths.filter((path) => existing.has(path)))],
  };
}

export function projectStorageKey(conversationId: string): string {
  return `${PROJECT_KEY_PREFIX}${encodeURIComponent(conversationId)}`;
}

/** Agent-authored files are already provider-visible; keep explicit opt-outs. */
export function createAgentProject(files: unknown, entrypoint: string, previous: SavedProject | null): SavedProject {
  const updates = validateProjectFiles(files);
  const merged = new Map(previous?.files.map((file) => [file.path, file]) ?? []);
  updates.forEach((file) => merged.set(file.path, file));
  const next = createSavedProject([...merged.values()], entrypoint, previous?.selectedPaths);
  // Validate references before persisting or replacing the working preview.
  bundleHtmlProject(next.files, entrypoint);
  const existing = new Set(previous?.files.map((file) => file.path) ?? []);
  const selected = new Set(next.selectedPaths);
  next.files.forEach((file) => { if (!existing.has(file.path)) selected.add(file.path); });
  return { ...next, selectedPaths: [...selected] };
}

export function readSavedProject(storage: Storage, conversationId: string): SavedProject | null {
  const raw = storage.getItem(projectStorageKey(conversationId));
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Saved project data could not be read. Export a backup before replacing it.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Saved project data is invalid.');
  const record = value as Record<string, unknown>;
  if (typeof record.entrypoint !== 'string' ||
      (record.selectedPaths !== undefined && (!Array.isArray(record.selectedPaths) || record.selectedPaths.some((path) => typeof path !== 'string')))) {
    throw new Error('Saved project data is invalid.');
  }
  return createSavedProject(
    record.files,
    record.entrypoint,
    (record.selectedPaths as string[] | undefined) ?? [],
  );
}

export function writeSavedProject(storage: Storage, conversationId: string, project: SavedProject): void {
  const safe = createSavedProject(project.files, project.entrypoint, project.selectedPaths);
  storage.setItem(projectStorageKey(conversationId), JSON.stringify(safe));
}

export function deleteSavedProject(storage: Storage, conversationId: string): void {
  storage.removeItem(projectStorageKey(conversationId));
}

export function selectedProjectFiles(project: SavedProject | null): ProjectFile[] {
  if (!project) return [];
  const selected = new Set(project.selectedPaths);
  return project.files.filter((file) => selected.has(file.path));
}

export function projectLanguage(path: string): 'python' | 'javascript' | 'html' {
  const extension = path.split('.').at(-1)?.toLowerCase();
  if (extension === 'html' || extension === 'htm') return 'html';
  if (extension === 'py') return 'python';
  return 'javascript';
}

function getAttribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function localAssetPath(source: string, fromPath: string): string | null {
  if (!source || source.startsWith('#') || source.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(source)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(source.split(/[?#]/, 1)[0]);
  } catch {
    throw new Error(`A local project asset path is malformed: ${source}`);
  }
  const parts = fromPath.split('/').slice(0, -1);
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) throw new Error('A local project asset cannot resolve outside the project.');
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join('/');
}

function escapeRawText(value: string, tag: 'script' | 'style'): string {
  const closingTag = tag === 'script' ? '</script' : '</style';
  return value.replace(new RegExp(closingTag, 'ig'), (match) => `<\\${match.slice(1)}`);
}

/** Inline only local text assets; the resulting document still runs in the existing opaque-origin iframe. */
export function bundleHtmlProject(files: ProjectFile[], entrypoint: string): string {
  const safeFiles = validateProjectFiles(files);
  const fileMap = new Map(safeFiles.map((file) => [file.path, file.content]));
  let html = fileMap.get(entrypoint);
  if (html === undefined) throw new Error('The HTML entry file is missing.');
  const deferredScripts: string[] = [];

  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = getAttribute(tag, 'rel');
    const href = getAttribute(tag, 'href');
    if (!rel?.toLowerCase().split(/\s+/).includes('stylesheet') || !href) return tag;
    const path = localAssetPath(href, entrypoint);
    if (path === null) return tag;
    const css = fileMap.get(path);
    if (css === undefined) throw new Error(`The project stylesheet “${path}” was not found.`);
    return `<style>${escapeRawText(css, 'style')}</style>`;
  });
  html = html.replace(/<script\b([^>]*)\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))([^>]*)>\s*<\/script\s*>/gi,
    (tag, before: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, unquoted: string | undefined, after: string) => {
      const src = doubleQuoted ?? singleQuoted ?? unquoted ?? '';
      const path = localAssetPath(src, entrypoint);
      if (path === null) return tag;
      if (getAttribute(tag, 'type')?.toLowerCase() === 'module') {
        throw new Error('This project preview does not support JavaScript modules yet. Use classic script files referenced by index.html.');
      }
      const script = fileMap.get(path);
      if (script === undefined) throw new Error(`The project script “${path}” was not found.`);
      const bundled = `<script>${escapeRawText(script, 'script')}</script>`;
      // Inline scripts ignore defer. Move deferred local assets after the DOM,
      // preserving their order and shared global scope instead of wrapping them.
      if (/\sdefer(?:\s|=|>)/i.test(tag) && !/\sasync(?:\s|=|>)/i.test(tag)) {
        deferredScripts.push(bundled);
        return '';
      }
      return bundled;
    });
  if (deferredScripts.length) {
    const scripts = deferredScripts.join('\n');
    html = /<\/body\s*>/i.test(html)
      ? html.replace(/<\/body\s*>/i, (closing) => `${scripts}\n${closing}`)
      : `${html}\n${scripts}`;
  }
  return html;
}
