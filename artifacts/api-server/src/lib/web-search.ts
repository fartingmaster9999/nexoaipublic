import { createFirecrawlSearch } from "./firecrawl-client";
import { extractSearchSources } from "./search-activity";
import { isPublicUrl, scrapePublicSearch as defaultScrapePublicSearch, type ScrapedPage } from "./public-scraper";
import { logger } from "./logger";

type SearchPage = ScrapedPage;
const MIN_PAGE_TEXT_CHARS = 200;
function hasReadablePageText(markdown: string | undefined): markdown is string {
  return typeof markdown === "string" && markdown.replace(/\s+/g, " ").trim().length >= MIN_PAGE_TEXT_CHARS;
}

export type SearchResult = {
  sources: { title: string; url: string; retrieval: "page" | "search_excerpt" }[];
  context: string;
  cached: boolean;
  provider: "firecrawl" | "public-scraper";
  retrievedAt: string;
};
type WebSearchDependencies = {
  firecrawlSearch?: (init: RequestInit) => Promise<Response>;
  scrapePublicSearch?: (query: string) => Promise<SearchPage[]>;
  now?: () => number;
  cacheTtlMs?: number;
};

export function createWebSearch({
  firecrawlSearch = createFirecrawlSearch({
    apiKey: process.env.FIRECRAWL_API_KEY,
    isVercel: process.env.VERCEL === "1",
  }),
  scrapePublicSearch = defaultScrapePublicSearch,
  now = Date.now,
  cacheTtlMs = 120000,
}: WebSearchDependencies = {}) {
  const cache = new Map<string, { expires: number; result: SearchResult }>();
  const pending = new Map<string, Promise<SearchResult>>();
  let firecrawlUnavailableUntil = 0;

  return async function searchWeb(query: string): Promise<SearchResult> {
    query = query.trim().slice(0, 1000);
    if (!query) throw new Error("Search query is empty");
    const key = query.toLowerCase().trim();
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return { ...cached.result, cached: true };
    const active = pending.get(key);
    if (active) return active;
    if (pending.size >= 20) throw new Error("Web search is temporarily busy");
    const task = (async (): Promise<SearchResult> => {
      // One external call searches and scrapes three pages in parallel. No Groq tools.
      let pages: SearchPage[] = [];
      let provider: SearchResult["provider"] = "firecrawl";
      try {
        if (firecrawlUnavailableUntil > now()) throw new Error("Connection not available");
        const response = await firecrawlSearch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query, limit: 3, sources: ["web"], timeout: 12000,
            scrapeOptions: { formats: ["markdown"], onlyMainContent: true, timeout: 8000 },
          }),
          signal: AbortSignal.timeout(18000),
        });
        if (!response.ok) {
          logger.warn({ service: "firecrawl", status: response.status }, "External search connection unavailable");
          firecrawlUnavailableUntil = now() + 300000;
          throw new Error("External search is unavailable");
        }
        const body = await response.json() as {
          success?: unknown;
          data?: { web?: unknown } | null;
        } | null;
        const results = body?.success === true && Array.isArray(body.data?.web)
          ? body.data.web
          : [];
        pages = results.filter((page): page is SearchPage =>
          typeof page === "object" && page !== null
          && typeof page.title === "string" && typeof page.url === "string"
          && (page.description === undefined || typeof page.description === "string")
          && (page.markdown === undefined || typeof page.markdown === "string"));
        if (!pages.length) throw new Error("No external search results");
      } catch {
        provider = "public-scraper";
        pages = await scrapePublicSearch(query);
      }
      const sources = extractSearchSources([{ type: "external", search_results: { results: pages } }])
        .filter((source) => isPublicUrl(source.url));
      if (!sources.length) throw new Error("No usable public sources were found");
      const context = sources.map((source, i) => {
        const page = pages.find((p) => p.url === source.url);
        const markdown = page?.markdown;
        const pageRead = hasReadablePageText(markdown);
        return `[${i + 1}] ${source.title}\n${source.url}\n${pageRead ? "Scraped page:" : "Search excerpt only:"} ${(pageRead ? markdown : page?.description || "").slice(0, 1900)}`;
      }).join("\n\n").slice(0, 6500);
      const retrievedAtMs = now();
      const result: SearchResult = {
        sources: sources.map((source) => {
          const page = pages.find((candidate) => candidate.url === source.url);
          return { ...source, retrieval: hasReadablePageText(page?.markdown) ? "page" : "search_excerpt" };
        }),
        context,
        cached: false,
        provider,
        retrievedAt: new Date(retrievedAtMs).toISOString(),
      };
      if (cache.size >= 100) cache.delete(cache.keys().next().value!);
      cache.set(key, { expires: retrievedAtMs + cacheTtlMs, result });
      return result;
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  };
}

export const searchWeb = createWebSearch();
