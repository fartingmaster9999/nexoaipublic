import test from "node:test";
import assert from "node:assert/strict";
import { requestGeminiWithRetry } from "../src/lib/gemini-retry.ts";

test("Gemini 503 is retried once and can recover", async () => {
  let attempts = 0;
  const response = await requestGeminiWithRetry(async () => {
    attempts++;
    return attempts === 1
      ? new Response("temporarily unavailable", { status: 503, headers: { "Retry-After": "0" } })
      : new Response("ok", { status: 200 });
  }, new AbortController().signal);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  assert.equal(attempts, 2);
});

test("Gemini client errors are not retried", async () => {
  let attempts = 0;
  const response = await requestGeminiWithRetry(async () => {
    attempts++;
    return new Response("unauthorized", { status: 403 });
  }, new AbortController().signal);

  assert.equal(response.status, 403);
  assert.equal(attempts, 1);
});

test("a second Gemini 503 is returned without another retry", async () => {
  let attempts = 0;
  const response = await requestGeminiWithRetry(async () => {
    attempts++;
    return new Response("still unavailable", { status: 503, headers: { "Retry-After": "0" } });
  }, new AbortController().signal);

  assert.equal(response.status, 503);
  assert.equal(attempts, 2);
});

test("long Retry-After hints are returned without an early retry", async () => {
  let attempts = 0;
  const response = await requestGeminiWithRetry(async () => {
    attempts++;
    return new Response("try later", { status: 503, headers: { "Retry-After": "30" } });
  }, new AbortController().signal);

  assert.equal(response.status, 503);
  assert.equal(attempts, 1);
});
