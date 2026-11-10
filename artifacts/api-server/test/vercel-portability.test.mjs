import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createFirecrawlSearch } from "../src/lib/firecrawl-client.ts";

test("Vercel Express entrypoint exports the app without requiring PORT", async () => {
  const previousPort = process.env.PORT;
  const previousVercel = process.env.VERCEL;
  delete process.env.PORT;
  process.env.VERCEL = "1";
  try {
    const { default: app } = await import("../src/index.ts");
    assert.equal(typeof app, "function");
  } finally {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
  }
});

test("direct Firecrawl transport preserves request options and uses only its own endpoint", async () => {
  const signal = new AbortController().signal;
  let request;
  const search = createFirecrawlSearch({
    apiKey: "test-only-key",
    isVercel: true,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response('{"success":true}', { headers: { "Content-Type": "application/json" } });
    },
  });
  const result = await search({
    method: "POST", body: '{"query":"test"}',
    headers: { "Content-Type": "application/json" }, signal,
  });
  assert.equal(request.url, "https://api.firecrawl.dev/v2/search");
  assert.equal(request.init.headers.get("Authorization"), "Bearer test-only-key");
  assert.equal(request.init.headers.get("Content-Type"), "application/json");
  assert.equal(request.init.signal, signal);
  assert.equal(request.init.body, '{"query":"test"}');
  assert.equal(result.status, 200);
});

test("Vercel without direct credentials fails immediately for the scraper fallback", async () => {
  const search = createFirecrawlSearch({
    isVercel: true,
    fetchImpl: async () => { assert.fail("Missing credentials must not send a request"); },
  });
  await assert.rejects(search({}), /credentials are not configured/);
});

test("Vercel transport keeps upstream failure statuses and rejects network failures", async () => {
  const limited = createFirecrawlSearch({
    apiKey: "test-only-key", fetchImpl: async () => new Response("", { status: 429 }),
  });
  assert.equal((await limited({})).status, 429);
  const unavailable = createFirecrawlSearch({
    apiKey: "test-only-key", fetchImpl: async () => { throw new Error("network unavailable"); },
  });
  await assert.rejects(unavailable({}), /network unavailable/);
});

test("Vercel services route browser API calls before the static frontend", async () => {
  const config = JSON.parse(await readFile(new URL("../../../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(config.services), ["ai-chat", "api-server", "mockup-sandbox"]);
  assert.deepEqual(config.rewrites, [
    { source: "/api", destination: { service: "api-server" } },
    { source: "/api/:path*", destination: { service: "api-server" } },
    { source: "/(.*)", destination: { service: "ai-chat" } },
  ]);
  const frontend = config.services["ai-chat"];
  const backend = config.services["api-server"];
  assert.equal(frontend.root, "artifacts/ai-chat");
  assert.equal(frontend.outputDirectory, "dist/public");
  assert.equal(frontend.rewrites, undefined);
  assert.equal(frontend.routes, undefined);
  assert.equal(backend.entrypoint, "src/index.ts");
  assert.ok(backend.buildCommand.length > 0);
  assert.equal(backend.functions["src/index.ts"].supportsCancellation, true);
  assert.equal(backend.functions["src/index.ts"].maxDuration, 180);
  const sandbox = config.services["mockup-sandbox"];
  assert.equal(sandbox.root, "artifacts/mockup-sandbox");
  assert.equal(sandbox.framework, "vite");
  assert.equal(sandbox.buildCommand.includes("BASE_PATH=/ "), true);
  assert.equal(sandbox.outputDirectory, "dist");
  for (const forbidden of ["functions", "installCommand", "buildCommand", "outputDirectory", "framework", "routes"]) {
    assert.ok(!(forbidden in config), `${forbidden} must not be top-level in services mode`);
  }
  // Static browser calls use the public rewrite, not runtime-only private URLs.
  for (const service of Object.values(config.services)) assert.ok(!service.bindings?.length);
});
