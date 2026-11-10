const SEARCH_URL = "https://api.firecrawl.dev/v2/search";

type Options = {
  apiKey?: string;
  isVercel?: boolean;
  fetchImpl?: typeof fetch;
};

/**
 * Direct credentials make search portable. The connector is loaded lazily only
 * for the existing Replit runtime, never during a Vercel cold start.
 */
export function createFirecrawlSearch({ apiKey, isVercel = false, fetchImpl = fetch }: Options = {}) {
  let connector: Promise<(url: string, init: RequestInit) => Promise<Response>> | undefined;
  return async (init: RequestInit): Promise<Response> => {
    if (apiKey) {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${apiKey}`);
      return fetchImpl(SEARCH_URL, { ...init, headers });
    }
    if (isVercel) {
      // searchWeb catches this and immediately uses its public-scraper fallback.
      throw new Error("Direct Firecrawl credentials are not configured");
    }
    connector ??= import("@replit/connectors-sdk").then(({ ReplitConnectors }) =>
      new ReplitConnectors().createProxyFetch("firecrawl"));
    return (await connector)(SEARCH_URL, init);
  };
}
