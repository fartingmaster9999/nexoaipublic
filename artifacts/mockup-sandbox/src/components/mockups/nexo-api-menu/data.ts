export type ThemeId = "midnight" | "graphite" | "abyss" | "paper" | "dune";
export type AccentId = "blue" | "cyan" | "violet" | "emerald" | "amber" | "rose";

type Palette = Record<string, string>;
export const THEMES: { id: ThemeId; name: string; note: string; vars: Palette }[] = [
  { id: "midnight", name: "Midnight", note: "The original black and blue", vars: { background: "240 4% 4.5%", foreground: "240 6% 93%", border: "240 4% 15%", card: "240 5% 7.5%", sidebar: "240 5% 6%" } },
  { id: "graphite", name: "Graphite", note: "Neutral charcoal, low glare", vars: { background: "230 6% 9%", foreground: "40 10% 90%", border: "230 5% 18%", card: "230 6% 12%", sidebar: "230 7% 7%" } },
  { id: "abyss", name: "Abyss", note: "Deep navy, ink-blue panels", vars: { background: "226 52% 9%", foreground: "210 40% 93%", border: "224 40% 19%", card: "226 48% 12%", sidebar: "227 56% 7%" } },
  { id: "paper", name: "Paper", note: "Cool daylight, blue ink", vars: { background: "216 30% 97%", foreground: "222 35% 12%", border: "216 22% 86%", card: "216 40% 99%", sidebar: "216 28% 94%" } },
  { id: "dune", name: "Dune", note: "Warm sand, quiet contrast", vars: { background: "38 38% 95%", foreground: "28 25% 14%", border: "35 22% 82%", card: "40 45% 97%", sidebar: "36 32% 91%" } },
];

export const ACCENTS: { id: AccentId; name: string; hsl: string }[] = [
  { id: "blue", name: "Nexo blue", hsl: "214 95% 58%" },
  { id: "cyan", name: "Cyan", hsl: "190 85% 46%" },
  { id: "violet", name: "Violet", hsl: "258 78% 64%" },
  { id: "emerald", name: "Emerald", hsl: "156 62% 42%" },
  { id: "amber", name: "Amber", hsl: "36 92% 52%" },
  { id: "rose", name: "Rose", hsl: "346 78% 60%" },
];
