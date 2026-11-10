import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pino from "pino";
import pinoHttp from "pino-http";
import {
  buildGeminiImageRequest, GeminiSseDecoder, geminiImageErrorMessage, requestGeminiImageStream,
  validateImageData, visibleGeminiText,
} from "../src/lib/gemini-image.ts";
import { createImageChatRouter } from "../src/routes/image-chat.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2q9ioAAAAASUVORK5CYII=";
const image = { mimeType: "image/png", data: png };
const input = { messages: [{ role: "user", content: "What is in this picture?" }], image };

function createSseApp({ getApiKey = () => "test-only-key", fetchImpl = async () => new Response("", { status: 200 }) } = {}) {
  const app = express();
  app.use(pinoHttp({ logger: pino({ level: "silent" }) }));
  app.use(express.json({ limit: "5mb" }));
  app.use("/api", createImageChatRouter({ getApiKey, fetchImpl, now: () => new Date("2026-11-06T12:00:00Z") }));
  return app;
}

async function withServer(app, run) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}/api/chat/image`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("Gemini image request carries image data, current time and selected thinking level", () => {
  const request = buildGeminiImageRequest({
    messages: [
      { role: "user", content: "Look at this" },
      { role: "assistant", content: "I can help." },
      { role: "user", content: "Read the chart" },
    ],
    image,
    deepthink: true,
    timeZone: "America/Chicago",
  }, new Date("2026-11-06T12:00:00Z"));
  assert.equal(request.contents[0].role, "user");
  assert.equal(request.contents[1].role, "model");
  assert.deepEqual(request.contents.at(-1).parts.at(-1), { inlineData: image });
  assert.equal(request.generationConfig.thinkingConfig.thinkingLevel, "high");
  assert.match(request.systemInstruction.parts[0].text, /2026-11-06T12:00:00\.000Z/);
  assert.match(request.systemInstruction.parts[0].text, /America\/Chicago/);
});

test("image validation rejects bad base64, mismatched signatures, and payloads over 3 MB", () => {
  assert.doesNotThrow(() => validateImageData("image/png", png));
  assert.throws(() => validateImageData("image/jpeg", png), /type/);
  assert.throws(() => validateImageData("image/png", "not_base64"), /base64/);
  const tooLarge = Buffer.alloc(3 * 1024 * 1024 + 1, 1).toString("base64");
  assert.throws(() => validateImageData("image/png", tooLarge), /size/);
});

test("Gemini SSE decoder handles split frames and never exposes thought parts", () => {
  const decoder = new GeminiSseDecoder();
  const payload = [
    { candidates: [{ content: { parts: [{ text: "A chart shows " }, { text: "private thought", thought: true }] } }] },
    { candidates: [{ content: { parts: [{ text: "two bars." }] } }] },
  ].map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("");
  const bytes = new TextEncoder().encode(payload);
  const events = [
    ...decoder.push(bytes.subarray(0, 17)),
    ...decoder.push(bytes.subarray(17, 49)),
    ...decoder.push(bytes.subarray(49)),
    ...decoder.push(),
  ];
  assert.equal(events.map(visibleGeminiText).join(""), "A chart shows two bars.");
});

test("Gemini SSE decoder rejects oversized complete events", () => {
  const decoder = new GeminiSseDecoder();
  const oversized = `data: "${"x".repeat(1_000_001)}"\n\n`;
  assert.throws(() => decoder.push(new TextEncoder().encode(oversized)), /oversized event/);
});

test("Gemini request keeps the key in a header, not in its URL", async () => {
  let captured;
  const request = buildGeminiImageRequest(input);
  await requestGeminiImageStream("test-only-key", request, new AbortController().signal, async (url, init) => {
    captured = { url: String(url), init };
    return new Response("", { status: 200 });
  });
  assert.match(captured.url, /models\/gemini-3\.8-flash:streamGenerateContent\?alt=sse$/);
  assert.equal(new URL(captured.url).searchParams.has("key"), false);
  assert.equal(captured.init.headers["x-goog-api-key"], "test-only-key");
  assert.equal(JSON.parse(captured.init.body).contents.at(-1).parts.at(-1).inlineData.data, png);
});

test("image route explains a missing Gemini key without contacting Google", async () => {
  let calls = 0;
  await withServer(createSseApp({ getApiKey: () => undefined, fetchImpl: async () => { calls++; return new Response(""); } }), async (url) => {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    assert.equal(response.status, 401);
    assert.match((await response.json()).error, /Gemini API key/);
  });
  assert.equal(calls, 0);
});

test("image route streams visible Gemini text and excludes hidden thought parts", async () => {
  let captured;
  const upstream = [
    { candidates: [{ content: { parts: [{ text: "It appears to be " }, { text: "hidden thought", thought: true }] } }] },
    { candidates: [{ content: { parts: [{ text: "a simple chart." }] } }] },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  await withServer(createSseApp({
    fetchImpl: async (url, init) => {
      captured = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
      return new Response(upstream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    },
  }), async (url) => {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    assert.equal(response.status, 200);
    const events = (await response.text()).split(/\r?\n/).filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    assert.equal(events.filter((event) => typeof event.content === "string").map((event) => event.content).join(""), "It appears to be a simple chart.");
    assert.equal(events.at(-1).done, true);
  });
  assert.match(captured.url, /gemini-3\.8-flash/);
  assert.equal(captured.headers["x-goog-api-key"], "test-only-key");
  assert.deepEqual(captured.body.contents.at(-1).parts.at(-1).inlineData, image);
});

test("invalid image signatures and provider failures are safe and bounded", async () => {
  let calls = 0;
  await withServer(createSseApp({
    fetchImpl: async () => { calls++; return new Response("DO NOT RETURN UPSTREAM BODY", { status: 429 }); },
  }), async (url) => {
    const invalid = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, image: { mimeType: "image/jpeg", data: png } }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(calls, 0);

    const limited = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const text = await limited.text();
    assert.match(text, /temporarily rate-limited/);
    assert.equal(text.includes("DO NOT RETURN UPSTREAM BODY"), false);
  });
  assert.equal(geminiImageErrorMessage(401), "Gemini could not authorize this request. Check your Gemini API key in Settings.");
  assert.equal(geminiImageErrorMessage(429), "Gemini is temporarily rate-limited. Please try again later.");
});

test("closing the browser stream aborts the upstream Gemini request", async () => {
  let upstreamSignal;
  await withServer(createSseApp({
    fetchImpl: async (_url, init) => {
      upstreamSignal = init.signal;
      let source;
      const body = new ReadableStream({
        start(controller) {
          source = controller;
          controller.enqueue(new TextEncoder().encode(
            `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "partial answer" }] } }] })}\n\n`,
          ));
        },
      });
      init.signal.addEventListener("abort", () => {
        try { source.close(); } catch { /* Already closed during cleanup. */ }
      }, { once: true });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    },
  }), async (url) => {
    const controller = new AbortController();
    const response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal: controller.signal,
    });
    const reader = response.body.getReader();
    let partial = "";
    while (!partial.includes("partial answer")) {
      const { value, done } = await reader.read();
      if (done) break;
      partial += new TextDecoder().decode(value);
    }
    assert.match(partial, /partial answer/);
    controller.abort();
    for (let attempt = 0; attempt < 50 && !upstreamSignal?.aborted; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(upstreamSignal.aborted, true);
    await reader.cancel().catch(() => {});
  });
});
