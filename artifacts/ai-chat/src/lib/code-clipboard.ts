type ClipboardWriter = { writeText: (text: string) => Promise<void> };

/** Never normalize whitespace or report success before the browser accepts it. */
export async function copyRawCode(text: string, clipboard: ClipboardWriter | undefined = globalThis.navigator?.clipboard): Promise<void> {
  if (!clipboard?.writeText) throw new Error('Clipboard is unavailable. Select the code and copy it manually.');
  try {
    await clipboard.writeText(text);
  } catch {
    throw new Error('Clipboard access failed. Select the code and copy it manually.');
  }
}

/** HAST positions cover the Markdown fence; retain the original line endings. */
export function rawCodeFromSource(source: string, start: number | undefined, end: number | undefined, fallback: string): string {
  if (start === undefined || end === undefined) return fallback;
  const block = source.slice(start, end);
  const opening = /^( {0,3})(`{3,}|~{3,})[^\r\n]*(?:\r\n|\n|\r)/.exec(block);
  if (!opening) return fallback; // Nested/indented blocks use Markdown's decoded code.
  const marker = opening[2][0];
  const closing = new RegExp(`^ {0,3}${marker}{${opening[2].length},}[\\t ]*(?:\\r?\\n)?$`, 'gm');
  const body = block.slice(opening[0].length);
  const close = closing.exec(body);
  const raw = close ? body.slice(0, close.index) : body;
  const indent = opening[1].length;
  return indent ? raw.replace(new RegExp(`^ {1,${indent}}`, 'gm'), '') : raw;
}
