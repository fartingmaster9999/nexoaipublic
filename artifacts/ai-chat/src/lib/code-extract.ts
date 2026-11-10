import type { RunLanguage } from '@/lib/code-runner';
import { fencedBlocks } from './fenced-blocks.ts';

export type Snippet = { language: RunLanguage; code: string; label: string; complete: boolean };

const MAP: Record<string, RunLanguage> = {
  py: 'python', python: 'python', python3: 'python',
  js: 'javascript', javascript: 'javascript', mjs: 'javascript', node: 'javascript',
  html: 'html', htm: 'html', css: 'html',
};

export function extractSnippets(text: string): Snippet[] {
  const out: Snippet[] = [];
  for (const block of fencedBlocks(text)) {
    const tag = block.tag;
    const lang = MAP[tag];
    if (!lang) continue;
    let code = block.code.replace(/\r?\n$/, '');
    if (tag === 'css') code = `<style>\n${code}\n</style>`;
    if (code.trim()) out.push({ language: lang, code, complete: block.complete, label: `${tag} block ${out.length + 1}` });
  }
  return out;
}

export const LANG_LABEL: Record<RunLanguage, string> = { python: 'Python', javascript: 'JavaScript', html: 'HTML / CSS' };
export const STARTERS: Record<RunLanguage, string> = {
  python: '# Python runs in your browser. Supported packages load when imported.\nprint([n ** 2 for n in range(5)])\n',
  javascript: "// JavaScript runs in an isolated worker. _ (Lodash) and math (MathJS) are available.\nconsole.log(_.chunk([1, 2, 3, 4], 2), math.sqrt(-4).toString());\n",
  html: '<h1>Hello from Nexo</h1>\n<style>\n  body { font-family: system-ui; padding: 24px; }\n</style>\n',
};
