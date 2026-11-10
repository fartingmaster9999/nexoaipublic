/** Presentation-only sections: concatenating them reproduces the provider text exactly. */
export function splitReasoning(text: string): string[] {
  const paragraphs = text.match(/[\s\S]*?(?:\r?\n[ \t]*\r?\n|$)/g)?.filter(Boolean) ?? [];
  const sections: string[] = [];
  for (const paragraph of paragraphs) {
    let remaining = paragraph;
    while (remaining.length > 640) {
      const prefix = remaining.slice(0, 480);
      const endings = [...prefix.matchAll(/[.!?]["')\]]*\s+/g)];
      const lastEnding = endings.at(-1);
      const sentenceEnd = lastEnding ? lastEnding.index! + lastEnding[0].length : 0;
      const whitespaceEnd = Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf(' '), prefix.lastIndexOf('\t')) + 1;
      const end = sentenceEnd >= 160 ? sentenceEnd : whitespaceEnd >= 160 ? whitespaceEnd : 480;
      sections.push(remaining.slice(0, end));
      remaining = remaining.slice(end);
    }
    if (remaining) sections.push(remaining);
  }
  return sections;
}
