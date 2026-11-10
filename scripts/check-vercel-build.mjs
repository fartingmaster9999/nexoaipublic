import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { once } from "node:events";
// Deliberately check missing-key recovery rather than consuming real allowances.
assert.ok(!process.env.GROQ_API_KEY, "Run this check with pnpm check:vercel");
const originalPort = process.env.PORT;
delete process.env.PORT;
const { default: app } = await import("../artifacts/api-server/src/index.ts");
if (originalPort !== undefined) process.env.PORT = originalPort;

const server = createServer(app);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  const health = await fetch(`${origin}/api/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  const malformed = await fetch(`${origin}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /valid JSON/);
  const invalid = await fetch(`${origin}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(invalid.status, 400);
  const missingKey = await fetch(`${origin}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
  });
  assert.equal(missingKey.status, 503);
  assert.match((await missingKey.json()).error, /not configured/);
  assert.equal((await fetch(`${origin}/api/unknown`)).status, 404);

  const publicDir = new URL("../artifacts/ai-chat/dist/public/", import.meta.url);
  const html = await readFile(new URL("index.html", publicDir), "utf8");
  assert.match(html, /<div id="root">/);
  assert.ok((await readFile(new URL("nexo-logo.png", publicDir))).length > 0);
  assert.ok((await readFile(new URL("code-runner.html", publicDir))).length > 0);
  const sandboxDir = new URL("../artifacts/mockup-sandbox/dist/", import.meta.url);
  const sandboxHtml = await readFile(new URL("index.html", sandboxDir), "utf8");
  assert.match(sandboxHtml, /(?:src|href)="\/assets\//);
  const sandboxAssets = await readdir(new URL("assets/", sandboxDir));
  assert.ok(sandboxAssets.some(file => file.startsWith("index-") && file.endsWith(".js")));
  console.log("Vercel service smoke checks passed: serverless entrypoint without PORT, validation, missing-key recovery, 404s, frontend, code-runner and sandbox assets.");
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
