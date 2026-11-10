export type InputMessage = { role: "user" | "assistant"; content: string };

export function isCodingRequest(text: string): boolean {
  return /```|\b(code|coding|debug|program(?:ming)?|script|function|algorithms?|numpy|scipy|matplotlib|python|javascript|typescript|html|css|sql|react|vue|svelte|jsx|tsx|java|rust|kotlin|swift|ruby|golang|bash|frontend|backend|refactor|unit tests?|regex|pseudocode|compile|compiler|traceback|stack trace|website|webpage|web app|web site|web page)\b|\b(?:build|create|make|implement|fix|improve|redesign)\b[\s\S]{0,60}\b(?:app|site|game|calculator|counter|dashboard|todo|to-do|task list|button|interface|UI|component)\b/i.test(text);
}

/** 2024 is the user's search policy, not a claim about a model's training cutoff. */
export function needsWebSearch(text: string): boolean {
  const current = /\b(latest|newest|up[- ]to[- ]date|right now|current(?:ly)?|recent|news|today|tonight|tomorrow|yesterday|this (?:week|month|year)|breaking|weather|forecast|stock price|exchange rate|live score|who won|who (?:is|are).{0,60}(?:president|prime minister|ceo|governor))\b/i;
  const years = [...text.matchAll(/\b(?:19|20)\d{2}\b/g)].map((m) => Number(m[0]));
  if (years.length && years.every((year) => year < 2024) && !current.test(text)) return false;
  if (/\b(time|date|day)\b/i.test(text) && /\b(now|today|current)\b|what time is it|what (?:day|date) is it/i.test(text)
    && !/\b(news|weather|event|match|game|release|price|meeting)\b/i.test(text)) return false;
  // Explicit lookups must not be swallowed by the ordinary-coding guard.
  // Requiring web intent also avoids mistaking "binary search" for browsing.
  const explicitWeb = /\b(?:search|browse)(?:\s+the)?\s+(?:web|internet)\b|\b(?:search|check|verify|research|find|read|browse)\b[^\n.!?]{0,80}\b(?:online|on the web|on the internet)\b|\blook\s+up\b/i.test(text);
  if (explicitWeb) return true;
  if (isCodingRequest(text) && !/\b(latest|newest|up[- ]to[- ]date|new (?:api|version)|released?|documentation|202[4-9]|20[3-9]\d)\b|\bcurrent\b.{0,40}\b(?:version|release|api)\b|\b(?:version|release|api)\b.{0,40}\bcurrent\b/i.test(text)) return false;
  return years.some((year) => year >= 2024) || current.test(text);
}

export function buildSearchQuery(messages: InputMessage[]): string {
  const last = messages.at(-1)?.content ?? "";
  const previous = messages.slice(0, -1).reverse().find((message) => message.role === "user")?.content;
  // Resolve short temporal follow-ups without sending the whole private conversation.
  const context = last.length < 100 && /\b(it|that|this|those|about|tomorrow|today)\b/i.test(last) && previous
    ? `${previous.slice(0, 250)} ${last}` : last;
  return context.replace(/```[\s\S]*?```/g, "").replace(/\s+/g, " ").trim().slice(0, 650);
}
