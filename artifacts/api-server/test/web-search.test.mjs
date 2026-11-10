import test from "node:test";
import assert from "node:assert/strict";
import { createWebSearch } from "../src/lib/web-search.ts";
import { buildChatRequest } from "../src/lib/chat-request.ts";

const usablePage = (overrides = {}) => ({
  title: "Public source",
  url: "https://example.com/news",
  description: "A current public update.",
  ...overrides,
});

const firecrawlResponse = (pages) => new Response(JSON.stringify({
  success: true,
  data: { web: pages },
}), { headers: { "Content-Type": "application/json" } });

test("missing Firecrawl customer connection falls back to direct public search", async () => {
  let fallbackCalls = 0;
  const search = createWebSearch({
    firecrawlSearch: async () => new Response(
      JSON.stringify({ error: "No customer connection configured" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    ),
    scrapePublicSearch: async () => { fallbackCalls++; return [usablePage()]; },
  });

  const result = await search("latest public update");
  assert.equal(result.provider, "public-scraper");
  assert.equal(result.sources[0].url, "https://example.com/news");
  assert.equal(fallbackCalls, 1);
});

test("Firecrawl rate limits use fallback and temporarily skip the unavailable provider", async () => {
  let clock = 1000;
  let firecrawlCalls = 0;
  const search = createWebSearch({
    now: () => clock,
    firecrawlSearch: async () => { firecrawlCalls++; return new Response("", { status: 429 }); },
    scrapePublicSearch: async (query) => [usablePage({ url: `https://example.com/${encodeURIComponent(query)}` })],
  });

  assert.equal((await search("rate limited one")).provider, "public-scraper");
  assert.equal((await search("rate limited two")).provider, "public-scraper");
  assert.equal(firecrawlCalls, 1);
  clock += 300001;
  await search("rate limited three");
  assert.equal(firecrawlCalls, 2);
});

test("Firecrawl timeout falls back without a live request", async () => {
  let fallbackCalls = 0;
  const search = createWebSearch({
    firecrawlSearch: async () => { throw new DOMException("Timed out", "TimeoutError"); },
    scrapePublicSearch: async () => { fallbackCalls++; return [usablePage()]; },
  });
  assert.equal((await search("timeout case")).provider, "public-scraper");
  assert.equal(fallbackCalls, 1);
});

test("malformed Firecrawl JSON and empty results both use direct scraping", async (t) => {
  const cases = [
    ["malformed JSON", async () => new Response("{not json", { status: 200 })],
    ["empty results", async () => firecrawlResponse([])],
    ["malformed response shape", async () => new Response('{"success":true,"data":{"web":"bad"}}')],
  ];
  for (const [label, firecrawlSearch] of cases) {
    await t.test(label, async () => {
      let fallbackCalls = 0;
      const search = createWebSearch({
        firecrawlSearch,
        scrapePublicSearch: async () => { fallbackCalls++; return [usablePage()]; },
      });
      assert.equal((await search(label)).provider, "public-scraper");
      assert.equal(fallbackCalls, 1);
    });
  }
});

test("unsafe source URLs are excluded and retrieved context stays bounded", async () => {
  const pages = [
    usablePage({ markdown: "A".repeat(5000) }),
    usablePage({ title: "Private host", url: "https://localhost/private", markdown: "must not appear" }),
    usablePage({ title: "Plain HTTP", url: "http://example.net/article", markdown: "must not appear" }),
    usablePage({ title: "Credential URL", url: "https://user:pass@example.org/", markdown: "must not appear" }),
    usablePage({ title: "Second source", url: "https://example.org/news", markdown: "B".repeat(5000) }),
    usablePage({ title: "Third source", url: "https://example.net/news", markdown: "C".repeat(5000) }),
  ];
  const search = createWebSearch({
    firecrawlSearch: async () => firecrawlResponse(pages),
    scrapePublicSearch: async () => assert.fail("Valid Firecrawl results should not fall back"),
  });

  const result = await search("bounded safe context");
  assert.equal(result.provider, "firecrawl");
  assert.deepEqual(result.sources.map((source) => source.url), [
    "https://example.com/news",
    "https://example.org/news",
    "https://example.net/news",
  ]);
  assert.ok(result.context.length <= 6500);
  assert.doesNotMatch(result.context, /must not appear|localhost|user:pass/);
});

test("sources distinguish readable page text from blocked or short-page excerpts", async () => {
  const search = createWebSearch({
    firecrawlSearch: async () => firecrawlResponse([
      usablePage({ markdown: `  ${"Readable page text. ".repeat(15)}  ` }),
      usablePage({
        title: "Blocked page",
        url: "https://example.com/blocked",
        description: "Only this search-result description was available.",
      }),
      usablePage({
        title: "Short page",
        url: "https://example.com/short",
        description: "Short page search result.",
        markdown: "A page returned too little text to verify.",
      }),
    ]),
  });

  const result = await search("page retrieval labels");
  assert.deepEqual(result.sources.map(({ retrieval }) => retrieval), ["page", "search_excerpt", "search_excerpt"]);
  assert.match(result.context, /Scraped page:/);
  assert.match(result.context, /Search excerpt only:/);
  assert.match(result.context, /Only this search-result description was available/);
  assert.doesNotMatch(result.context, /A page returned too little text to verify/);
});

test("successful results are cached until their deterministic expiry", async () => {
  let clock = 5000;
  let calls = 0;
  const search = createWebSearch({
    now: () => clock,
    cacheTtlMs: 100,
    firecrawlSearch: async () => { calls++; return firecrawlResponse([usablePage()]); },
  });

  const fresh = await search("cache me");
  assert.equal(fresh.cached, false);
  assert.equal(fresh.retrievedAt, new Date(5000).toISOString());
  const cached = await search(" CACHE ME ");
  assert.equal(cached.cached, true);
  assert.equal(cached.retrievedAt, fresh.retrievedAt, "cached results retain their original retrieval time");
  assert.equal(calls, 1);
  clock += 101;
  const refreshed = await search("cache me");
  assert.equal(refreshed.cached, false);
  assert.equal(refreshed.retrievedAt, new Date(clock).toISOString());
  assert.notEqual(refreshed.retrievedAt, fresh.retrievedAt);
  assert.equal(calls, 2);
});

test("identical in-flight queries share one retrieval", async () => {
  let calls = 0;
  let resolveResponse;
  const response = new Promise((resolve) => { resolveResponse = resolve; });
  const search = createWebSearch({
    firecrawlSearch: async () => { calls++; return response; },
  });

  const first = search("same query");
  const second = search(" SAME QUERY ");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  resolveResponse(firecrawlResponse([usablePage()]));
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult, secondResult);
});

test("total retrieval failure remains an error and chat context forbids invented current facts", async () => {
  const search = createWebSearch({
    firecrawlSearch: async () => new Response("", { status: 503 }),
    scrapePublicSearch: async () => { throw new Error("Public search is unavailable"); },
  });
  await assert.rejects(search("latest unverified fact"), /Public search is unavailable/);

  const request = buildChatRequest(
    { messages: [{ role: "user", content: "What is the latest update?" }] },
    new Date("2026-11-04T12:00:00Z"),
    { searchFailed: true },
  );
  assert.match(request.messages[0].content, /External web search failed/);
  assert.match(request.messages[0].content, /Do not invent recent facts or sources/);
});
