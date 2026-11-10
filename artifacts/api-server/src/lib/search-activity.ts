type PublicSource = { title: string; url: string };
type ToolResult = {
  type: string;
  browser_results?: { title: string; url: string }[];
  search_results?: { results?: { title?: string; url?: string }[] } | null;
};

/** Only public tool metadata is forwarded, never raw tool output or model reasoning. */
export function extractSearchSources(tools: ToolResult[]): PublicSource[] {
  const sources = new Map<string, PublicSource>();
  for (const tool of tools) {
    const results = [...(tool.browser_results ?? []), ...(tool.search_results?.results ?? [])];
    for (const result of results) {
      if (typeof result.url !== "string") continue;
      try {
        const url = new URL(result.url);
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) continue;
        sources.set(url.href, {
          url: url.href,
          title: typeof result.title === "string" && result.title.trim()
            ? result.title.slice(0, 200) : url.hostname,
        });
      } catch {
        // Reject malformed links, not search content.
      }
    }
  }
  return [...sources.values()].slice(0, 20);
}
