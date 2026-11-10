export type FencedBlock = { start: number; end: number; tag: string; code: string; complete: boolean };

/** Match whole line fences, skipping their contents even for unknown languages. */
export function fencedBlocks(source: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/gm;
  let match: RegExpExecArray | null;
  while (blocks.length < 200 && (match = opening.exec(source))) {
    const bodyStart = opening.lastIndex;
    const closing = new RegExp(`^ {0,3}${match[1][0]}{${match[1].length},}[\\t ]*(?:\\r?\\n|$)`, 'gm');
    closing.lastIndex = bodyStart;
    const close = closing.exec(source);
    const end = close ? closing.lastIndex : source.length;
    blocks.push({ start: match.index, end, tag: match[2].trim().split(/\s+/)[0].toLowerCase(),
      code: source.slice(bodyStart, close?.index ?? source.length), complete: !!close });
    opening.lastIndex = end;
    if (!close || end === match.index) break;
  }
  return blocks;
}
