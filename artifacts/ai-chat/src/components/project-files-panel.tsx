import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { Download, FileCode2, FilePlus2, FolderCode, Trash2 } from 'lucide-react';
import { useEditorLanguage } from '@/hooks/use-editor-language';
import { CopyCodeButton } from './copy-code-button';
import './project-files-panel.css';

export type ProjectFile = { path: string; content: string };

type Props = {
  files: ProjectFile[];
  activePath: string;
  selectedPaths: string[];
  isLight: boolean;
  disabled?: boolean;
  onSelect: (path: string) => void;
  onChange: (path: string, content: string) => void;
  onToggleContext: (path: string, selected: boolean) => void;
  onDelete: (path: string) => void;
  onAdd: () => void;
  onExport: () => void;
};

function languageForPath(path: string): 'html' | 'javascript' | 'python' {
  const extension = path.split('.').pop()?.toLowerCase();
  if (extension === 'html' || extension === 'htm') return 'html';
  if (extension === 'py') return 'python';
  // The shared editor-language hook supports JavaScript, HTML, and Python.
  // CSS files use its JavaScript highlighting mode until a CSS mode is added.
  return 'javascript';
}

function displayName(path: string) {
  return path.split('/').filter(Boolean).pop() || path;
}

export function ProjectFilesPanel({
  files,
  activePath,
  selectedPaths,
  isLight,
  disabled = false,
  onSelect,
  onChange,
  onToggleContext,
  onDelete,
  onAdd,
  onExport,
}: Props) {
  const activeFile = files.find((file) => file.path === activePath);
  const language = useEditorLanguage(languageForPath(activeFile?.path ?? activePath));
  const editorExtensions = useMemo(() => language.extensions, [language.extensions]);

  return (
    <section className="project-files" aria-label="Project files" data-testid="project-files-panel">
      <header className="project-files-head">
        <div className="project-files-heading">
          <FolderCode size={16} aria-hidden="true" />
          <div>
            <h2>Project files</h2>
            <span>{files.length} {files.length === 1 ? 'file' : 'files'}</span>
          </div>
        </div>
        <div className="project-files-actions">
          <button type="button" className="project-files-action" onClick={onAdd} disabled={disabled} aria-label="Add project file">
            <FilePlus2 size={15} aria-hidden="true" /><span>Add file</span>
          </button>
          <button type="button" className="project-files-action" onClick={onExport} disabled={disabled || files.length === 0} aria-label="Export project files">
            <Download size={15} aria-hidden="true" /><span>Export</span>
          </button>
        </div>
      </header>

      <div className="project-files-body">
        <nav className="project-file-list" aria-label="Project file list">
          {files.length > 0 ? files.map((file) => {
            const selected = selectedPaths.includes(file.path);
            const isActive = file.path === activePath;
            const name = displayName(file.path);
            return (
              <div className={`project-file-row${isActive ? ' is-active' : ''}`} key={file.path}>
                <button
                  type="button"
                  className="project-file-select"
                  onClick={() => onSelect(file.path)}
                  disabled={disabled}
                  aria-pressed={isActive}
                  aria-label={`Open ${file.path}`}
                  title={file.path}
                >
                  <FileCode2 size={15} aria-hidden="true" />
                  <span className="project-file-name">{name}</span>
                  {file.path.includes('/') && <span className="project-file-parent">{file.path.slice(0, -(name.length + 1))}</span>}
                </button>
                <label className="project-file-share" title={`Share ${file.path} with Nexo`}>
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={disabled}
                    onChange={(event) => onToggleContext(file.path, event.currentTarget.checked)}
                    aria-label={`Share ${file.path} with Nexo`}
                  />
                  <span>Share</span>
                </label>
              </div>
            );
          }) : (
            <div className="project-files-empty">
              <FileCode2 size={19} aria-hidden="true" />
              <strong>No files yet</strong>
              <span>Add a file to start building this project.</span>
              <button type="button" onClick={onAdd} disabled={disabled}>Add first file</button>
            </div>
          )}
        </nav>

        <div className="project-file-editor">
          {activeFile ? (
            <>
              <div className="project-editor-toolbar">
                <div className="project-editor-title" title={activeFile.path}>
                  <FileCode2 size={14} aria-hidden="true" />
                  <span>{activeFile.path}</span>
                </div>
                <div className="project-editor-controls">
                  <CopyCodeButton text={activeFile.content} label={`Copy ${activeFile.path}`} />
                  <button
                    type="button"
                    className="project-file-delete"
                    onClick={() => onDelete(activeFile.path)}
                    disabled={disabled}
                    aria-label={`Delete ${activeFile.path}`}
                    title={`Delete ${activeFile.path}`}
                  >
                    <Trash2 size={14} aria-hidden="true" /><span>Delete</span>
                  </button>
                </div>
              </div>
              {language.loading && <div className="project-editor-status" role="status">Loading syntax highlighting…</div>}
              {language.error && (
                <div className="project-editor-status" role="status">
                  Highlighting could not load. Editing is still available.
                  <button type="button" onClick={language.retry} disabled={disabled}>Retry</button>
                </div>
              )}
              <div className="project-editor-cm">
                <CodeMirror
                  value={activeFile.content}
                  height="100%"
                  theme={isLight ? 'light' : 'dark'}
                  extensions={editorExtensions}
                  editable={!disabled}
                  readOnly={disabled}
                  onChange={(content) => {
                    if (content !== activeFile.content) onChange(activeFile.path, content);
                  }}
                  aria-label={`Editor for ${activeFile.path}`}
                  data-testid="project-file-editor"
                />
              </div>
            </>
          ) : (
            <div className="project-editor-placeholder">
              <FileCode2 size={20} aria-hidden="true" />
              <span>Select a file to view and edit its contents.</span>
            </div>
          )}
        </div>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {activeFile ? `${activeFile.path} selected` : 'No file selected'}
      </span>
    </section>
  );
}
