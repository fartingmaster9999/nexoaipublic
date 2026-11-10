import test from "node:test";
import assert from "node:assert/strict";
import { createPublicScraper, isPublicAddress, isPublicUrl } from "../src/lib/public-scraper.ts";

test("public scraping rejects private, link-local, loopback and mapped private addresses", () => {
  for (const address of ["127.0.0.1","10.0.0.1","172.16.0.5","192.168.1.1","169.254.169.254","100.64.0.1","::1","fc00::1","fe80::1","::ffff:127.0.0.1"]) {
    assert.equal(isPublicAddress(address),false,address);
  }
  assert.equal(isPublicAddress("8.8.8.8"),true);
});

test("scraper allows only normal public HTTPS targets without embedded credentials", () => {
  for (const url of ["http://example.com","file:///etc/passwd","https://localhost/","https://service.internal/","https://127.0.0.1","https://[::1]/","https://user:pass@example.com","https://example.com:8080"]) {
    assert.equal(isPublicUrl(url),false,url);
  }
  assert.equal(isPublicUrl("https://www.python.org/downloads/"),true);
});

test("direct scraper search uses deterministic HTML fixtures, filters unsafe links, and extracts public pages", async () => {
  const target = "https://www.example.test/current";
  const duckDuckGoUrl = `https://html.duckduckgo.com/html/?kl=us-en&q=${encodeURIComponent("latest fixture")}`;
  const searchHtml = `
    <div class="result">
      <a class="result__a" href="https://html.duckduckgo.com/l/?uddg=${encodeURIComponent(target)}">Fixture headline</a>
      <a class="result__snippet">Fixture search excerpt</a>
    </div>
    <div class="result">
      <a class="result__a" href="http://unsafe.example.test/">Unsafe HTTP</a>
      <a class="result__snippet">Should be ignored</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://localhost/private">Unsafe host</a>
      <a class="result__snippet">Should be ignored</a>
    </div>`;
  const pageText = "Useful article content ".repeat(10);
  const requests = [];
  const lookups = [];
  const scrape = createPublicScraper({
    lookupImpl: async (hostname) => {
      lookups.push(hostname);
      assert.ok(["html.duckduckgo.com", "www.example.test"].includes(hostname));
      return [{ address: "93.184.216.34", family: 4 }];
    },
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (url === duckDuckGoUrl) {
        return new Response(searchHtml, { headers: { "Content-Type": "text/html" } });
      }
      if (url === "https://www.example.test/robots.txt") {
        return new Response("", { status: 404, headers: { "Content-Type": "text/plain" } });
      }
      if (url === target) {
        return new Response(`<html><body><nav>Ignore navigation</nav><main>${pageText}<script>ignore script</script></main></body></html>`, {
          headers: { "Content-Type": "text/html" },
        });
      }
      assert.fail(`Unexpected fixture request: ${url}`);
    },
  });

  const pages = await scrape("latest fixture");
  assert.equal(pages.length, 1);
  assert.equal(pages[0].url, target);
  assert.equal(pages[0].title, "Fixture headline");
  assert.match(pages[0].markdown, /Useful article content/);
  assert.doesNotMatch(pages[0].markdown, /Ignore navigation|ignore script/);
  assert.deepEqual(requests, [duckDuckGoUrl, "https://www.example.test/robots.txt", target]);
  assert.deepEqual(lookups, ["html.duckduckgo.com", "www.example.test", "www.example.test"]);
});
