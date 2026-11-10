import { useEffect, useRef, useState } from 'react';

export type ThemeId = 'midnight' | 'graphite' | 'abyss' | 'paper' | 'dune';
export type AccentId = 'blue' | 'cyan' | 'violet' | 'emerald' | 'amber' | 'rose';

type Palette = Record<string, string>;
export const THEMES: { id: ThemeId; name: string; note: string; light: boolean; vars: Palette }[] = [
  { id: 'midnight', name: 'Midnight', note: 'The original black and blue', light: false, vars: {
    background: '240 4% 4.5%', foreground: '240 6% 93%', border: '240 4% 15%', card: '240 5% 7.5%', muted: '240 4% 11%',
    'muted-foreground': '240 5% 65%', secondary: '240 4% 12%', accent: '214 40% 16%', 'accent-foreground': '214 90% 82%',
    sidebar: '240 5% 6%', 'sidebar-border': '240 4% 12%', 'sidebar-accent': '240 4% 11%', 'code-bg': '240 5% 3.5%' } },
  { id: 'graphite', name: 'Graphite', note: 'Neutral charcoal, low glare', light: false, vars: {
    background: '230 6% 9%', foreground: '40 10% 90%', border: '230 5% 18%', card: '230 6% 12%', muted: '230 5% 15%',
    'muted-foreground': '230 5% 60%', secondary: '230 6% 17%', accent: '230 8% 21%', 'accent-foreground': '40 20% 92%',
    sidebar: '230 7% 7%', 'sidebar-border': '230 5% 15%', 'sidebar-accent': '230 6% 14%', 'code-bg': '230 8% 6%' } },
  { id: 'abyss', name: 'Abyss', note: 'Deep navy, ink-blue panels', light: false, vars: {
    background: '226 52% 9%', foreground: '210 40% 93%', border: '224 40% 19%', card: '226 48% 12%', muted: '224 40% 15%',
    'muted-foreground': '220 22% 64%', secondary: '224 46% 18%', accent: '222 55% 24%', 'accent-foreground': '205 90% 84%',
    sidebar: '227 56% 7%', 'sidebar-border': '224 40% 16%', 'sidebar-accent': '224 46% 14%', 'code-bg': '228 58% 6%' } },
  { id: 'paper', name: 'Paper', note: 'Cool daylight, blue ink', light: true, vars: {
    background: '216 30% 97%', foreground: '222 35% 12%', border: '216 22% 86%', card: '216 40% 99%', muted: '216 25% 93%',
    'muted-foreground': '220 12% 42%', secondary: '214 45% 92%', accent: '214 60% 90%', 'accent-foreground': '220 60% 28%',
    sidebar: '216 28% 94%', 'sidebar-border': '216 22% 86%', 'sidebar-accent': '216 30% 89%', 'code-bg': '220 30% 12%' } },
  { id: 'dune', name: 'Dune', note: 'Warm sand, quiet contrast', light: true, vars: {
    background: '38 38% 95%', foreground: '28 25% 14%', border: '35 22% 82%', card: '40 45% 97%', muted: '36 28% 90%',
    'muted-foreground': '30 10% 40%', secondary: '36 32% 89%', accent: '34 40% 86%', 'accent-foreground': '25 40% 24%',
    sidebar: '36 32% 91%', 'sidebar-border': '35 22% 82%', 'sidebar-accent': '36 28% 86%', 'code-bg': '28 22% 13%' } },
];

export const ACCENTS: { id: AccentId; name: string; hsl: string }[] = [
  { id: 'blue', name: 'Nexo blue', hsl: '214 95% 58%' },
  { id: 'cyan', name: 'Cyan', hsl: '190 85% 46%' },
  { id: 'violet', name: 'Violet', hsl: '258 78% 64%' },
  { id: 'emerald', name: 'Emerald', hsl: '156 62% 42%' },
  { id: 'amber', name: 'Amber', hsl: '36 92% 52%' },
  { id: 'rose', name: 'Rose', hsl: '346 78% 60%' },
];

function relativeLuminanceFromHsl(value: string) {
  const [hue, saturation, lightness] = value.split(/\s+/).map((part) => Number.parseFloat(part));
  const h = ((hue % 360) + 360) % 360;
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - chroma / 2;
  const [r, g, b] = h < 60 ? [chroma, x, 0]
    : h < 120 ? [x, chroma, 0]
      : h < 180 ? [0, chroma, x]
        : h < 240 ? [0, x, chroma]
          : h < 300 ? [x, 0, chroma]
            : [chroma, 0, x];
  const linear = (channel: number) => {
    const srgb = channel + m;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastRatio(a: number, b: number) {
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

function primaryForeground(accentHsl: string) {
  const accentLuminance = relativeLuminanceFromHsl(accentHsl);
  const lightForeground = relativeLuminanceFromHsl('0 0% 99%');
  const darkForeground = relativeLuminanceFromHsl('222 40% 6%');
  return contrastRatio(lightForeground, accentLuminance) >= contrastRatio(darkForeground, accentLuminance)
    ? '0 0% 99%'
    : '222 40% 6%';
}

const KEY = 'nexo-theme-v1';
type Saved = { theme: ThemeId; accent: AccentId };
const DEFAULT_SAVED: Saved = { theme: 'midnight', accent: 'blue' };

function parseSaved(raw: string | null): Saved | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<Saved>;
    return {
      theme: THEMES.some((t) => t.id === v.theme) ? v.theme as ThemeId : 'midnight',
      accent: ACCENTS.some((a) => a.id === v.accent) ? v.accent as AccentId : 'blue',
    };
  } catch { return null; }
}

function read(): Saved {
  try { return parseSaved(localStorage.getItem(KEY)) ?? DEFAULT_SAVED; }
  catch { return DEFAULT_SAVED; }
}

export function useThemeSettings() {
  const [saved, setSaved] = useState<Saved>(read);
  const lastPersisted = useRef<string | null>(null);
  const theme = THEMES.find((t) => t.id === saved.theme)!;

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== KEY || event.storageArea !== localStorage || event.newValue === null) return;
      const incoming = parseSaved(event.newValue);
      if (!incoming) return;
      lastPersisted.current = JSON.stringify(incoming);
      setSaved(incoming);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    const serialized = JSON.stringify(saved);
    if (lastPersisted.current === serialized) return;
    try {
      localStorage.setItem(KEY, serialized);
      lastPersisted.current = serialized;
    } catch { /* ignore */ }
  }, [saved]);

  useEffect(() => {
    const root = document.documentElement;
    const accent = ACCENTS.find((a) => a.id === saved.accent)!;
    Object.entries(theme.vars).forEach(([k, v]) => root.style.setProperty(`--${k}`, v));
    ['input', 'sidebar-border'].forEach(() => root.style.setProperty('--input', theme.vars.border));
    root.style.setProperty('--popover', theme.vars.card);
    ['card-foreground', 'popover-foreground', 'secondary-foreground', 'sidebar-foreground'].forEach((k) => root.style.setProperty(`--${k}`, theme.vars.foreground));
    ['primary', 'ring', 'sidebar-primary', 'sidebar-ring'].forEach((k) => root.style.setProperty(`--${k}`, accent.hsl));
    root.style.setProperty('--primary-foreground', primaryForeground(accent.hsl));
    root.classList.toggle('dark', !theme.light);
    root.dataset.theme = theme.id;
  }, [saved, theme]);
  return {
    themeId: saved.theme, accentId: saved.accent, isLight: theme.light,
    setTheme: (t: ThemeId) => setSaved((s) => ({ ...s, theme: t })),
    setAccent: (a: AccentId) => setSaved((s) => ({ ...s, accent: a })),
  };
}
