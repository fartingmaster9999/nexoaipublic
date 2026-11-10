import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch } from "undici";
import ipaddr from "ipaddr.js";
import robotsParser from "robots-parser";
import { load } from "cheerio";

export type ScrapedPage = { title: string; url: string; description?: string; markdown?: string };
const USER_AGENT = "NexoAI/1.0 (public information retrieval)";
type ScraperDependencies = {
  lookupImpl?: typeof lookup;
  fetchImpl?: typeof fetch;
};

export function isPublicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === "unicast"; } catch { return false; }
}

export function isPublicUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return url.protocol === "https:" && !url.username && !url.password
      && (!url.port || url.port === "443")
      && host !== "localhost" && !/\.(?:localhost|local|internal)$/i.test(host)
      && (!isIP(host) || isPublicAddress(host));
  } catch { return false; }
}

/** Resolve and pin public IPs on every redirect, with strict byte/time limits. */
async function publicText(
  raw: string,
  maxBytes = 350000,
  { lookupImpl = lookup, fetchImpl = fetch }: ScraperDependencies = {},
): Promise<{ text: string; status: number }> {
  let url = raw;
  for (let redirect = 0; redirect < 3; redirect++) {
    if (!isPublicUrl(url)) throw new Error("Only public HTTPS pages can be scraped");
    const parsed = new URL(url);
    const addresses = await lookupImpl(parsed.hostname.replace(/^\[|\]$/g, ""), { all: true });
    if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) throw new Error("Private network access is blocked");
    const agent = new Agent({ connect: {
      autoSelectFamily: false,
      lookup: (_host, _options, callback) => callback(null, addresses[0]!.address, addresses[0]!.family),
    } });
    try {
      const response = await fetchImpl(url, {
        dispatcher: agent, redirect: "manual", signal: AbortSignal.timeout(4500),
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain,application/xhtml+xml" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("Invalid redirect");
        url = new URL(location, url).href;
        continue;
      }
      if (!response.body) return { text: "", status: response.status };
      const type = response.headers.get("content-type") ?? "";
      if (!/text\/|html|xml/i.test(type)) { await response.body.cancel(); throw new Error("Not a text page"); }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = "", bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        text += decoder.decode(value, { stream: true });
        if (bytes >= maxBytes) { await reader.cancel(); break; }
      }
      return { text: text.slice(0, maxBytes), status: response.status };
    } finally { await agent.close(); }
  }
  throw new Error("Too many redirects");
}

async function scrapePage(page: ScrapedPage, dependencies: ScraperDependencies): Promise<ScrapedPage> {
  try {
    const robotsUrl = new URL("/robots.txt", page.url).href;
    const robots = await publicText(robotsUrl, 80000, dependencies);
    if (robots.status === 401 || robots.status === 403) return page;
    if (robots.status === 200 && robotsParser(robotsUrl, robots.text).isAllowed(page.url, "NexoAI") === false) return page;
    const response = await publicText(page.url, 350000, dependencies);
    if (response.status !== 200) return page;
    const $ = load(response.text);
    $("script,style,nav,header,footer,form,aside,noscript,svg").remove();
    const main = $("main,article,[role=main]").first();
    const content = (main.length ? main : $("body")).text().replace(/\s+/g, " ").trim();
    return content.length > 80 ? { ...page, markdown: content.slice(0, 3500) } : page;
  } catch { return page; } // Retain explicitly labelled search excerpts, never bypass a site's restrictions.
}

export function createPublicScraper(dependencies: ScraperDependencies = {}) {
  return async function scrapePublicSearch(query: string): Promise<ScrapedPage[]> {
    const url = `https://html.duckduckgo.com/html/?kl=us-en&q=${encodeURIComponent(query)}`;
    const response = await publicText(url, 350000, dependencies);
    if (response.status !== 200 || /anomaly\.js|bots use DuckDuckGo/i.test(response.text)) throw new Error("Public search is unavailable");
    const $ = load(response.text);
    const pages: ScrapedPage[] = [];
    $(".result").each((_i, element) => {
      if (pages.length >= 3) return;
      const anchor = $(element).find(".result__a").first();
      const href = anchor.attr("href");
      if (!href) return;
      const link = new URL(href, url);
      const target = link.searchParams.get("uddg") ?? link.href;
      if (!isPublicUrl(target) || pages.some((page) => page.url === target)) return;
      pages.push({
        title: anchor.text().trim().slice(0, 200), url: target,
        description: $(element).find(".result__snippet").text().trim().slice(0, 1200),
      });
    });
    if (!pages.length) throw new Error("No usable public search results");
    return Promise.all(pages.map((page) => scrapePage(page, dependencies)));
  };
}

export const scrapePublicSearch = createPublicScraper();
