import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pino from "pino";
import pinoHttp from "pino-http";
import {
  availableGeminiAgentModels, buildGeminiAgentRequest, collectAgentResponse, GeminiAgentApiError,
  GEMINI_AGENT_MODEL, MAX_AGENT_HTML_PREVIEW_RUNS,
  requestGeminiAgentStream, validateAgentHistory,
} from "../src/lib/gemini-agent.ts";
import { buildGroqAgentRequest, collectGroqAgentResponse, GROQ_AGENT_MODEL } from "../src/lib/groq-agent.ts";
import { CODING_FALLBACK } from "../src/lib/model-routing.ts";
import { createAgentRouter } from "../src/routes/agent.ts";

const input = {
  messages: [{ role: "user", content: "What changed in the latest release?" }],
  timeZone: "America/Chicago",
};

test("Gemini model discovery checks exact IDs, streaming, context, and server-side key headers", async () => {
  const requests = [];
  const models = await availableGeminiAgentModels("never-in-url", async (url, init) => {
    requests.push({ url: new URL(url), init });
    const page = requests.length === 1
      ? {
        models: [
          { name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["streamGenerateContent"], inputTokenLimit: 131072, outputTokenLimit: 8192 },
          { name: "models/gemini-3.1-flash-lite", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 131072, outputTokenLimit: 8192 },
          { name: "models/embedding-only", supportedGenerationMethods: ["embedContent"], inputTokenLimit: 131072, outputTokenLimit: 8192 },
          { name: "models/gemma-4-31b-it", supportedGenerationMethods: ["streamGenerateContent"], inputTokenLimit: 4096, outputTokenLimit: 8192 },
        ],
        nextPageToken: "next",
      }
      : {
        models: [
          { name: "models/gemma-4-26b-a4b-it", supportedGenerationMethods: ["streamGenerateContent"], inputTokenLimit: 131072, outputTokenLimit: 8192 },
        ],
      };
    return new Response(JSON.stringify(page), { status: 200 });
  });
  assert.deepEqual(models.map((model) => model.name), [
    "models/gemini-3.5-flash-lite",
    "models/gemini-3.1-flash-lite",
    "models/gemma-4-26b-a4b-it",
  ]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.searchParams.has("key"), false);
  assert.equal(requests[0].init.headers["x-goog-api-key"], "never-in-url");
  assert.equal(requests[1].url.searchParams.get("pageToken"), "next");
});

test("Gemma Agent requests keep tool calls while omitting Gemini-only thinking signatures", () => {
  const model = "gemma-4-31b-it";
  const request = buildGeminiAgentRequest(input, new Date("2026-11-07T12:00:00Z"), true, undefined, model);
  assert.equal(request.generationConfig.thinkingConfig, undefined);
  assert.ok(request.tools);

  const response = collectAgentResponse([modelEvent([{
    functionCall: {
      name: "run_code",
      id: "gemma-tool-1",
      args: { language: "javascript", code: "console.log(1)" },
    },
  }])], { allowMissingThoughtSignature: true });
  assert.equal(response.calls[0].thoughtSignature, "gemma-agent-v1");
  const continuation = buildGeminiAgentRequest({
    ...input,
    agentHistory: [{
      tool: "run_code",
      callId: "gemma-tool-1",
      thoughtSignature: response.calls[0].thoughtSignature,
      arguments: response.calls[0].arguments,
      result: "1",
    }],
  }, new Date("2026-11-07T12:00:00Z"), true, undefined, model);
  assert.equal(JSON.stringify(continuation.contents).includes("thoughtSignature"), false);
});

test("Agent selects catalog-verified Flash-Lite and Gemma models for specialist tasks", async () => {
  const requested = [];
  await withServer(createSseApp({
    fetchImpl: async (url, init) => {
      requested.push({ url: String(url), body: JSON.parse(init.body) });
      return geminiResponse([modelEvent([{ text: "Specialist answer." }])]);
    },
  }), async (url) => {
    for (const [task, expectedModel] of [
      ["fast_worker", "gemini-3.5-flash-lite"],
      ["document", "gemma-4-26b-a4b-it"],
    ]) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, agentTask: task }),
      });
      const events = await readEvents(response);
      assert.equal(response.status, 200);
      assert.ok(events.some((event) => event.model === expectedModel));
      assert.ok(events.some((event) => event.agentTask === task));
      assert.match(requested.at(-1).url, new RegExp(`/models/${expectedModel}:`));
      if (expectedModel.startsWith("gemma-")) {
        assert.equal(requested.at(-1).body.generationConfig.thinkingConfig, undefined);
      }
    }
  });
});

test("Agent surfaces a compatible Flash-Lite fallback instead of claiming the preferred model", async () => {
  const available = [
    { name: "models/gemini-3.1-flash-lite", supportedGenerationMethods: ["streamGenerateContent"], inputTokenLimit: 131072, outputTokenLimit: 8192 },
    { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["streamGenerateContent"], inputTokenLimit: 131072, outputTokenLimit: 8192 },
  ];
  await withServer(createSseApp({
    getGeminiModels: async () => available,
    fetchImpl: async () => geminiResponse([modelEvent([{ text: "Fallback answer." }])]),
  }), async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, agentTask: "fast_worker" }),
    });
    const events = await readEvents(response);
    assert.equal(events[0].model, "gemini-3.1-flash-lite");
    assert.match(events.find((event) => event.notice)?.notice.message ?? "", /Gemini 3\.5 Flash-Lite.*compatible model Gemini 3\.1 Flash-Lite/);
  });
});

test("Agent fails clearly when no catalog-verified Gemini model supports the task", async () => {
  await withServer(createSseApp({ getGeminiModels: async () => [] }), async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, agentProvider: "gemini", agentTask: "fast_worker" }),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /No catalog-verified Gemini model/);
  });
});

function modelEvent(parts) {
  return { candidates: [{ content: { parts } }] };
}

function geminiResponse(events, status = 200) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

function createSseApp({
  getApiKey = () => "test-only-key",
  getGroqClient = () => undefined,
  getGeminiModels = async () => [
    { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["streamGenerateContent"], inputTokenLimit: 131072, outputTokenLimit: 65536 },
    { name: "models/gemini-3.6-flash", supportedGenerationMethods: ["streamGenerateContent"], inputTokenLimit: 131072, outputTokenLimit: 65536 },
    { name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["streamGenerateContent"], inputTokenLimit: 131072, outputTokenLimit: 65536 },
    { name: "models/gemini-3.1-flash-lite", supportedGenerationMethods: ["streamGenerateContent"], inputTokenLimit: 131072, outputTokenLimit: 65536 },
    { name: "models/gemma-4-31b-it", supportedGenerationMethods: ["streamGenerateContent"], inputTokenLimit: 131072, outputTokenLimit: 65536 },
    { name: "models/gemma-4-26b-a4b-it", supportedGenerationMethods: ["streamGenerateContent"], inputTokenLimit: 131072, outputTokenLimit: 65536 },
  ],
  fetchImpl,
  search,
  providerIdleMs,
  logger = pino({ level: "silent" }),
} = {}) {
  const app = express();
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: "5mb" }));
  app.use("/api", createAgentRouter({
    getApiKey,
    getGroqClient,
    getGeminiModels,
    fetchImpl,
    search,
    now: () => new Date("2026-11-06T18:30:00Z"),
    providerIdleMs,
  }));
  return app;
}

function planningQwenClient(requests, project) {
  return {
    models: { list: async () => ({ data: [{
      id: CODING_FALLBACK, active: true, context_window: 131072, max_completion_tokens: 16384,
    }] }) },
    chat: { completions: { create: async (request) => {
      requests.push(request);
      return (async function* () {
        if (project && requests.length === 1) {
          yield { choices: [{ delta: { tool_calls: [{
            index: 0, id: "planned-project",
            function: { name: "write_project", arguments: JSON.stringify(project) },
          }] } }] };
        } else {
          yield { choices: [{ delta: { content: "The build is ready." } }] };
        }
      })();
    } } },
  };
}

test("Gemini planning is tool-free, bounded, and does not claim a tool limit", () => {
  const request = buildGeminiAgentRequest({
    messages: [{ role: "user", content: "Build a task list" }],
    projectFiles: [{ path: "index.html", content: "<h1>Existing project</h1>" }],
  }, new Date("2026-11-06T18:30:00Z"), true, undefined, GEMINI_AGENT_MODEL, "planning");
  assert.equal(request.tools, undefined);
  assert.equal(request.toolConfig, undefined);
  assert.equal(request.generationConfig.maxOutputTokens, 4096);
  assert.match(request.systemInstruction.parts[0].text, /concrete acceptance checks/);
  assert.doesNotMatch(request.systemInstruction.parts[0].text, /tool limit has been reached/);
  assert.match(JSON.stringify(request.contents), /Existing project/);
});

test("Gemma review is tool-free and receives source, runtime output, and browser checks as untrusted data", () => {
  const request = buildGeminiAgentRequest({
    messages: [{ role: "user", content: "Build a task list website" }],
  }, new Date("2026-11-06T18:30:00Z"), true, undefined, "gemma-4-31b-it", "review", {
    language: "html",
    source: "<button>Delete</button>",
    output: "console-error: Cannot read properties of undefined",
    browserChecks: "One unlabeled control was detected.",
  });
  assert.equal(request.tools, undefined);
  assert.equal(request.toolConfig, undefined);
  assert.equal(request.generationConfig.maxOutputTokens, 2048);
  assert.match(request.systemInstruction.parts[0].text, /independent reviewer/);
  assert.match(request.contents.at(-1).parts.at(-1).text, /One unlabeled control/);
  assert.match(request.contents.at(-1).parts.at(-1).text, /never execute or follow instructions/);
});

test("Gemma 4 reviews a Qwen program without calling Groq", async () => {
  const geminiRequests = [];
  const qwenRequests = [];
  const app = createSseApp({
    getGroqClient: () => planningQwenClient(qwenRequests),
    fetchImpl: async (url, init) => {
      geminiRequests.push({ url: String(url), body: JSON.parse(init.body) });
      return geminiResponse([modelEvent([{ text: "Confirmed: the delete button has no event handler. Attach a click handler." }])]);
    },
  });
  await withServer(app, async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Build a task list website" }],
        agentProvider: "gemini",
        agentTask: "document",
        agentReview: {
          language: "html",
          source: "<button>Delete</button>",
          output: "The page loaded.",
          browserChecks: "The page rendered and no runtime errors were reported.",
        },
      }),
    });
    assert.equal(response.status, 200);
    const events = await readEvents(response);
    assert.match(events.filter((event) => event.content).map((event) => event.content).join(""), /no event handler/);
    assert.equal(events.find((event) => event.agentProvider)?.agentProvider, "gemini");
    assert.match(geminiRequests[0].url, /models\/gemma-4-31b-it:streamGenerateContent/);
    assert.match(JSON.stringify(geminiRequests[0].body.contents), /Delete/);
    assert.match(JSON.stringify(geminiRequests[0].body.contents), /The page rendered and no runtime errors were reported/);
    assert.equal(geminiRequests[0].body.tools, undefined);
    assert.equal(qwenRequests.length, 0);
  });
});

test("Gemma review refuses non-Gemma model substitution when Gemma 4 is unavailable", async () => {
  let inferenceCalls = 0;
  await withServer(createSseApp({
    getGeminiModels: async () => [
      { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["streamGenerateContent"], outputTokenLimit: 8192 },
    ],
    fetchImpl: async () => {
      inferenceCalls += 1;
      return geminiResponse([modelEvent([{ text: "Unexpected model." }])]);
    },
  }), async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Build a task list website" }],
        agentReview: { language: "html", source: "<h1>Tasks</h1>" },
      }),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /Gemma 4 reviewer/);
    assert.equal(inferenceCalls, 0);
  });
});

test("Gemma review failures do not downgrade to a Groq code model", async () => {
  const qwenRequests = [];
  let geminiCalls = 0;
  await withServer(createSseApp({
    getGroqClient: () => planningQwenClient(qwenRequests),
    fetchImpl: async () => {
      geminiCalls += 1;
      return new Response("", { status: 403 });
    },
  }), async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Build a task list website" }],
        agentReview: { language: "html", source: "<h1>Tasks</h1>" },
      }),
    });
    assert.equal(response.status, 200);
    const events = await readEvents(response);
    assert.ok(events.some((event) => typeof event.error === "string"));
    assert.equal(geminiCalls, 1);
    assert.equal(qwenRequests.length, 0);
  });
});

test("Coding calls Gemini once for planning, then Qwen builds and continues without replanning", async () => {
  const qwenRequests = [];
  const geminiRequests = [];
  const project = { entrypoint: "index.html", files: [{ path: "index.html", content: "<h1>Tasks</h1>" }] };
  const groq = planningQwenClient(qwenRequests, project);
  const app = createSseApp({
    getGroqClient: () => groq,
    fetchImpl: async (url, init) => {
      geminiRequests.push({ url: String(url), body: JSON.parse(init.body) });
      return geminiResponse([modelEvent([
        { text: "private-provider-thought", thought: true },
        { text: "Acceptance checks: add, complete, and delete tasks; use local state and labeled controls." },
      ])]);
    },
  });
  await withServer(app, async (url) => {
    const prompt = { messages: [{ role: "user", content: "Build a task list website" }] };
    const events = await readEvents(await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(prompt),
    }));
    assert.equal(events.some((event) => event.error), false);
    assert.ok(events.some((event) => event.activity?.id === "agent-gemini-plan" && event.activity.status === "complete"));
    const tool = events.find((event) => event.agentTool)?.agentTool;
    assert.equal(tool.tool, "write_project");
    assert.match(JSON.stringify(qwenRequests[0].messages), /Acceptance checks: add, complete, and delete tasks/);
    assert.doesNotMatch(JSON.stringify(qwenRequests), /private-provider-thought/);
    const continuationResponse = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...prompt,
        agentProvider: "groq",
        agentHistory: [{
          tool: "write_project", callId: tool.callId, arguments: tool.arguments,
          thoughtSignature: tool.thoughtSignature,
          result: "HTML preview loaded with no runtime errors.",
        }],
      }),
    });
    assert.equal(continuationResponse.status, 200);
    const continued = await readEvents(continuationResponse);
    assert.equal(continued.some((event) => event.error), false);
    assert.match(continued.map((event) => event.content ?? "").join(""), /build is ready/);
    assert.equal(geminiRequests.length, 1);
    assert.match(geminiRequests[0].url, /:streamGenerateContent/);
    assert.equal(geminiRequests[0].body.tools, undefined);
    assert.ok(qwenRequests.every((request) => request.model === CODING_FALLBACK));
  });
});

test("Non-coding Agent work prefers Gemini even when Groq is configured", async () => {
  const qwenRequests = [];
  let geminiCalls = 0;
  await withServer(createSseApp({
    getGroqClient: () => planningQwenClient(qwenRequests),
    fetchImpl: async () => {
      geminiCalls += 1;
      return geminiResponse([modelEvent([{ text: "Gravity attracts masses." }])]);
    },
  }), async (url) => {
    const events = await readEvents(await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Explain gravity simply" }] }),
    }));
    assert.equal(events.some((event) => event.error), false);
    assert.equal(events.find((event) => event.agentProvider)?.agentProvider, "gemini");
    assert.equal(geminiCalls, 1);
    assert.equal(qwenRequests.length, 0);
  });
});

test("Unavailable Gemini planning does not block Qwen or claim a rate limit", async () => {
  const qwenRequests = [];
  let geminiCalls = 0;
  await withServer(createSseApp({
    getGroqClient: () => planningQwenClient(qwenRequests, {
      entrypoint: "index.html", files: [{ path: "index.html", content: "<h1>Tasks</h1>" }],
    }),
    fetchImpl: async () => {
      geminiCalls += 1;
      return new Response("", { status: 403 });
    },
  }), async (url) => {
    const events = await readEvents(await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Build a task list website" }] }),
    }));
    assert.equal(events.some((event) => event.error), false);
    assert.ok(events.some((event) => event.activity?.id === "agent-gemini-plan" && event.activity.status === "error"));
    assert.ok(geminiCalls > 0 && geminiCalls <= 2);
    assert.equal(qwenRequests[0].model, CODING_FALLBACK);
  });
});

test("Coding without a Gemini key stays on Qwen and explains the skipped plan", async () => {
  const qwenRequests = [];
  await withServer(createSseApp({
    getApiKey: () => undefined,
    getGroqClient: () => planningQwenClient(qwenRequests, {
      entrypoint: "index.html", files: [{ path: "index.html", content: "<h1>Tasks</h1>" }],
    }),
    fetchImpl: async () => { throw new Error("Gemini must not be called without a key"); },
  }), async (url) => {
    const events = await readEvents(await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Build a task list website" }] }),
    }));
    assert.equal(events.some((event) => event.error), false);
    assert.ok(events.some((event) => event.activity?.label.includes("isn't configured on this server")));
    assert.equal(qwenRequests[0].model, CODING_FALLBACK);
  });
});

test("Qwen Agent request enables bounded autonomous build-and-test tools", () => {
  const request = buildGroqAgentRequest({ ...input, deepthink: true }, new Date("2026-11-06T18:30:00Z"));
  assert.equal(GROQ_AGENT_MODEL, CODING_FALLBACK);
  assert.equal(request.model, CODING_FALLBACK);
  assert.equal(request.reasoning_effort, "high");
  assert.equal(request.reasoning_format, "parsed");
  assert.equal(request.tool_choice, "auto");
  assert.equal(request.parallel_tool_calls, false);
  assert.match(request.messages[0].content, /small app or multi-file project, use write_project/);
  assert.deepEqual(request.tools.map((tool) => tool.function.name), ["web_search", "run_code", "write_project"]);
  assert.deepEqual(request.tools.map((tool) => tool.function.name), ["web_search", "run_code", "write_project"]);
});

test("Qwen Agent decoder collects streamed tool arguments and rejects invalid JSON", async () => {
  const chunks = async function* () {
    yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "qwen-call", function: { name: "run_code", arguments: "{\"language\":\"javascript\"," } }] } }] };
    yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"code\":\"console.log(2+2)\"}" } }] } }] };
  };
  const result = await collectGroqAgentResponse(chunks(), new AbortController().signal);
  assert.equal(result.calls[0].tool, "run_code");
  assert.deepEqual(result.calls[0].arguments, { language: "javascript", code: "console.log(2+2)" });
  assert.equal(result.calls[0].thoughtSignature, "groq-agent-v1");
  await assert.rejects(
    collectGroqAgentResponse((async function* () {
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "bad", function: { name: "run_code", arguments: "{" } }] } }] };
    })(), new AbortController().signal),
    /invalid Agent tool arguments/,
  );
  const project = await collectGroqAgentResponse((async function* () {
    yield { choices: [{ delta: { tool_calls: [{
      index: 0,
      id: "qwen-project",
      function: { name: "write_project", arguments: JSON.stringify({
        entrypoint: "index.html",
        files: [{ path: "index.html", content: "<h1>Project</h1>" }],
      }) },
    }] } }] };
  })(), new AbortController().signal);
  assert.equal(project.calls[0].tool, "write_project");
  assert.equal(project.calls[0].arguments.entrypoint, "index.html");
});

async function withServer(app, run) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}/api/agent`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function readEvents(response) {
  return (await response.text()).split(/\r?\n/).filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

test("Agent request uses the supported Gemini model, current time, and selected thinking level", () => {
  const request = buildGeminiAgentRequest({ ...input, deepthink: true }, new Date("2026-11-06T18:30:00Z"));
  assert.equal(GEMINI_AGENT_MODEL, "gemini-3.8-flash");
  assert.equal(request.generationConfig.thinkingConfig.thinkingLevel, "high");
  assert.equal(request.toolConfig.functionCallingConfig.mode, "AUTO");
  assert.match(request.systemInstruction.parts[0].text, /2026-11-06T18:30:00\.000Z/);
  assert.match(request.systemInstruction.parts[0].text, /America\/Chicago/);
  assert.match(request.systemInstruction.parts[0].text, /Do not expose private chain-of-thought/);
  const normal = buildGeminiAgentRequest({ ...input, deepthink: false });
  assert.equal(normal.generationConfig.thinkingConfig.thinkingLevel, "medium");
});

test("Agent sends a validated image to Gemini without adding it to tool history", () => {
  const image = {
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLKrQAAAABJRU5ErkJggg==",
  };
  const request = buildGeminiAgentRequest({ ...input, image });
  assert.deepEqual(request.contents[0].parts[1], { inlineData: image });
  assert.match(request.systemInstruction.parts[0].text, /attached image as visual context/);
  const continuation = buildGeminiAgentRequest({
    ...input,
    image,
    agentHistory: [{
      tool: "web_search",
      callId: "search-1",
      thoughtSignature: "opaque-signature",
      arguments: { query: "latest release" },
      result: "Release notes",
    }],
  });
  assert.deepEqual(continuation.contents[0].parts[1], { inlineData: image });
  assert.equal(JSON.stringify(continuation.contents.slice(1)).includes(image.data), false);
  assert.throws(() => buildGeminiAgentRequest({ ...input, image: { ...image, mimeType: "image/jpeg" } }), /Invalid image|match its content/);
});

test("Agent request keeps the key in a header and preserves function call IDs and signatures", async () => {
  let captured;
  const history = [{
    tool: "run_code",
    callId: "call-1",
    thoughtSignature: "opaque-signature",
    arguments: { language: "javascript", code: "console.log('ok')" },
    result: "stdout: ok",
  }];
  const request = buildGeminiAgentRequest({ ...input, agentHistory: history });
  await requestGeminiAgentStream("test-only-key", request, new AbortController().signal, async (url, init) => {
    captured = { url: String(url), init, body: JSON.parse(init.body) };
    return new Response("", { status: 200 });
  });
  assert.equal(new URL(captured.url).searchParams.has("key"), false);
  assert.equal(captured.init.headers["x-goog-api-key"], "test-only-key");
  const modelCall = captured.body.contents.at(-2).parts[0];
  const functionResult = captured.body.contents.at(-1).parts[0].functionResponse;
  assert.equal(modelCall.functionCall.id, "call-1");
  assert.equal(modelCall.thoughtSignature, "opaque-signature");
  assert.equal(functionResult.id, "call-1");
  assert.equal(functionResult.response.result, "stdout: ok");
});

test("Agent decoder omits private thought text and validates bounded tool history", () => {
  const response = collectAgentResponse([
    modelEvent([
      { text: "private reasoning", thought: true },
      { text: "Visible answer." },
    ]),
  ]);
  assert.equal(response.text, "Visible answer.");
  assert.deepEqual(response.calls, []);
  assert.equal(validateAgentHistory([]), null);
  assert.equal(validateAgentHistory([{
    tool: "write_project", callId: "project", thoughtSignature: "sig",
    arguments: {
      entrypoint: "index.html",
      files: [{ path: "index.html", content: "<h1>Ready</h1>" }, { path: "styles.css", content: "body{}" }],
    },
    result: "The project preview loaded.",
  }]), null);
  assert.match(validateAgentHistory([{
    tool: "run_code", callId: "x", thoughtSignature: "sig",
    arguments: { language: "powershell", code: "Write-Host 1" }, result: "no",
  }]), /code history/);
  assert.match(validateAgentHistory([{
    tool: "web_search", callId: "x", thoughtSignature: "sig",
    arguments: { query: "news" }, result: "x".repeat(8_001),
  }]), /invalid or too large/);
  assert.match(validateAgentHistory([{
    tool: "write_project", callId: "project", thoughtSignature: "sig",
    arguments: { entrypoint: "../index.html", files: [{ path: "../index.html", content: "x" }] },
    result: "x",
  }]), /project history/);
});

test("Agent build guidance requires bounded self-review without claiming host or visual access", () => {
  const prompt = buildGeminiAgentRequest(input).systemInstruction.parts[0].text;
  assert.match(prompt, /acceptance checklist/);
  assert.match(prompt, /empty pages, horizontal overflow, missing labels, and broken images/);
  assert.match(prompt, /cannot rewrite Nexo's host application/);
  assert.match(prompt, /Do not claim to have inspected screenshots/);
});

test("Agent caps project previews across snippet and project revisions", async () => {
  let calls = 0;
  const history = [
    {
      tool: "run_code", callId: "old-html", thoughtSignature: "old-signature",
      arguments: { language: "html", code: "<h1>First</h1>" }, result: "Preview loaded.",
    },
    ...[1, 2].map((index) => ({
      tool: "write_project", callId: `old-project-${index}`, thoughtSignature: "old-signature",
      arguments: { entrypoint: "index.html", files: [{ path: "index.html", content: `<h1>Revision ${index}</h1>` }] },
      result: "Preview loaded with structural checks.",
    })),
  ];
  await withServer(createSseApp({
    getGroqClient: () => ({
      models: { list: async () => ({ data: [{
        id: CODING_FALLBACK, active: true, context_window: 131072, max_completion_tokens: 16384,
      }] }) },
      chat: { completions: { create: async (request) => {
        if (request.model !== CODING_FALLBACK) return { choices: [] };
        calls++;
        if (calls === 1) return (async function* () {
          yield { choices: [{ delta: { tool_calls: [{
            index: 0, id: "fourth-project", type: "function", function: {
              name: "write_project", arguments: JSON.stringify({
                entrypoint: "index.html", files: [{ path: "index.html", content: "<h1>Fourth</h1>" }],
              }),
            },
          }] } }] };
        })();
        assert.match(JSON.stringify(request.messages), /revision limit/);
        assert.equal(request.tool_choice, "required");
        return (async function* () {
          yield { choices: [{ delta: { content: "The project is ready; further refinements need a new request." } }] };
        })();
      } } },
    }),
  }), async (url) => {
    const events = await readEvents(await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, agentHistory: history }),
    }));
    assert.equal(events.some((event) => event.agentTool), false);
    assert.ok(events.some((event) => event.error?.includes("last build still has errors")));
    assert.equal(events.some((event) => event.content?.includes("project is ready")), false);
  });
  assert.equal(calls, 2);
});

test("Agent includes only user-selected project files in provider context", () => {
  const projectFiles = [{ path: "src/main.js", content: "console.log('selected')" }];
  const gemini = buildGeminiAgentRequest({ ...input, projectFiles });
  const groq = buildGroqAgentRequest({ ...input, projectFiles });
  assert.match(gemini.contents[0].parts[0].text, /src\/main\.js/);
  assert.match(gemini.contents[0].parts[0].text, /selected/);
  assert.doesNotMatch(gemini.contents[0].parts[0].text, /unselected/);
  assert.match(groq.messages[1].content, /src\/main\.js/);
  assert.doesNotMatch(groq.messages[1].content, /unselected/);
});

test("Agent route reports missing Gemini configuration without making an upstream call", async () => {
  let calls = 0;
  await withServer(createSseApp({
    getApiKey: () => undefined,
    fetchImpl: async () => { calls++; return new Response(""); },
  }), async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /Gemini API key in Settings/);
  });
  assert.equal(calls, 0);
});

test("Agent rejects invalid image bytes before contacting Gemini", async () => {
  let calls = 0;
  await withServer(createSseApp({
    fetchImpl: async () => { calls++; return geminiResponse([modelEvent([{ text: "unexpected" }])]); },
  }), async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, image: { mimeType: "image/png", data: "bm90LWltYWdl" } }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /JPEG, PNG, or WebP image under 3 MB/);
  });
  assert.equal(calls, 0);
});

test("Agent retries a transient Gemini 503 once before streaming a successful answer", async () => {
  let calls = 0;
  await withServer(createSseApp({
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? new Response("temporary upstream failure", { status: 503, headers: { "Retry-After": "0" } })
        : geminiResponse([modelEvent([{ text: "Gemini recovered." }])]);
    },
  }), async (url) => {
    const response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    const events = await readEvents(response);
    assert.equal(response.status, 200);
    assert.equal(events.filter((event) => event.content).map((event) => event.content).join(""), "Gemini recovered.");
  });
  assert.equal(calls, 2);
});

test("Gemini decoder preserves terminal metadata and detects in-stream API errors", () => {
  const exhausted = collectAgentResponse([
    modelEvent([{ text: "Private thought", thought: true }]),
    { candidates: [{ finishReason: "MAX_TOKENS" }] },
  ]);
  assert.equal(exhausted.text, "");
  assert.equal(exhausted.finishReason, "MAX_TOKENS");
  assert.equal(collectAgentResponse([{ promptFeedback: { blockReason: "SAFETY" } }]).blockReason, "SAFETY");
  assert.throws(
    () => collectAgentResponse([{ error: { code: 429, message: "SENSITIVE_PROVIDER_BODY" } }]),
    (error) => error instanceof GeminiAgentApiError && error.status === 429 && !error.message.includes("SENSITIVE"),
  );
});

for (const deepthink of [false, true]) {
  test(`Agent recovers an empty token-exhausted response with Deepthink ${deepthink ? "on" : "off"}`, async () => {
    const requests = [];
    await withServer(createSseApp({
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return requests.length === 1
          ? geminiResponse([
            modelEvent([{ text: "Private thought", thought: true }]),
            { candidates: [{ finishReason: "MAX_TOKENS" }] },
          ])
          : geminiResponse([modelEvent([{ text: "A complete, visible answer." }])]);
      },
    }), async (url) => {
      const events = await readEvents(await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, deepthink }),
      }));
      assert.equal(events.filter((event) => event.content).map((event) => event.content).join(""), "A complete, visible answer.");
      assert.equal(events.some((event) => event.error), false);
      assert.equal(JSON.stringify(events).includes("Private thought"), false);
      assert.equal(events.at(-1).done, true);
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].generationConfig.maxOutputTokens, deepthink ? 16384 : 8192);
    assert.equal(requests[1].generationConfig.maxOutputTokens, deepthink ? 32768 : 16384);
    assert.equal(requests[1].generationConfig.thinkingConfig.thinkingLevel, deepthink ? "medium" : "low");
    assert.deepEqual(requests[1].contents, requests[0].contents);
    assert.deepEqual(requests[1].tools, requests[0].tools);
  });
}

test("Agent bounds empty response recovery and does not retry a safety block", async () => {
  for (const blocked of [false, true]) {
    let calls = 0;
    await withServer(createSseApp({
      fetchImpl: async () => {
        calls++;
        return geminiResponse([blocked
          ? { promptFeedback: { blockReason: "SAFETY" } }
          : { candidates: [{ finishReason: "MAX_TOKENS" }] }]);
      },
    }), async (url) => {
      const events = await readEvents(await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
      }));
      assert.match(events.find((event) => event.error)?.error ?? "", blocked ? /blocked this response/ : /output budget/);
    });
    assert.equal(calls, blocked ? 1 : 2);
  }
});

test("Gemini in-stream rate limits use the existing Qwen fallback", async () => {
  const groqClient = {
    models: { list: async () => ({ data: [{
      id: CODING_FALLBACK,
      active: true,
      context_window: 131072,
      max_completion_tokens: 16384,
    }] }) },
    chat: { completions: { create: async () => (async function* () {
      yield { choices: [{ delta: { content: "Qwen completed the request." } }] };
    })() } },
  };
  await withServer(createSseApp({
    getGroqClient: () => groqClient,
    fetchImpl: async () => geminiResponse([{ error: { code: 429, message: "SENSITIVE_PROVIDER_BODY" } }]),
  }), async (url) => {
    const events = await readEvents(await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    }));
    assert.equal(events.some((event) => event.agentProvider === "groq"), true);
    assert.equal(events.filter((event) => event.content).map((event) => event.content).join(""), "Qwen completed the request.");
    assert.equal(JSON.stringify(events).includes("SENSITIVE_PROVIDER_BODY"), false);
  });
});

test("Gemini image requests cannot bypass the vision route using a text-task override", async () => {
  const image = {
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLKrQAAAABJRU5ErkJggg==",
  };
  let geminiRequest;
  let groqRequest;
  const groqClient = {
    models: { list: async () => ({ data: [{
      id: CODING_FALLBACK,
      active: true,
      context_window: 131072,
      max_completion_tokens: 16384,
    }] }) },
    chat: { completions: { create: async (request) => {
      groqRequest = request;
      return (async function* () {
        yield { choices: [{ delta: { content: "I can continue with the text prompt." } }] };
      })();
    } } },
  };
  await withServer(createSseApp({
    getGroqClient: () => groqClient,
    fetchImpl: async (_url, init) => {
      geminiRequest = JSON.parse(init.body);
      return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
    },
  }), async (url) => {
    const events = await readEvents(await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, image, agentProvider: "gemini", agentTask: "reasoning" }),
    }));
    assert.equal(events.some((event) => event.agentProvider === "groq"), false);
    assert.deepEqual(geminiRequest.contents[0].parts[1], { inlineData: image });
    assert.equal(groqRequest, undefined, "Groq is not a vision fallback");
    assert.ok(events.some((event) => /image|vision/.test(event.error ?? "")));
    assert.equal(JSON.stringify(events).includes(image.data), false, "fallback events expose no image bytes");
  });
});

test("Agent logs known parser failures without logging credentials or upstream bodies", async () => {
  const logs = [];
  const logger = pino({ level: "info" }, { write: (line) => logs.push(JSON.parse(line)) });
  await withServer(createSseApp({
    logger,
    fetchImpl: async () => geminiResponse([modelEvent([{
      functionCall: { name: "run_code", args: { language: "javascript", code: "console.log(1)" } },
    }])]),
  }), async (url) => {
    const response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    const events = await readEvents(response);
    assert.ok(events.some((event) => event.error));
  });
  const failure = logs.find((entry) => entry.event === "agent.stream.failed");
  assert.equal(failure.failureKind, "Error");
  assert.equal(failure.failureReason, "Gemini returned an incomplete Agent tool request.");
  assert.equal(JSON.stringify(logs).includes("test-only-key"), false);
  assert.equal(JSON.stringify(logs).includes("console.log(1)"), false);
});

test("Agent never copies unknown transport error messages into diagnostics", async () => {
  const logs = [];
  const logger = pino({ level: "info" }, { write: (line) => logs.push(JSON.parse(line)) });
  await withServer(createSseApp({
    logger,
    fetchImpl: async () => { throw new Error("SENSITIVE_PROVIDER_BODY: test-only-key"); },
  }), async (url) => {
    const response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    const body = await response.text();
    assert.match(body, /could not complete/);
    assert.equal(body.includes("SENSITIVE_PROVIDER_BODY"), false);
  });
  const failure = logs.find((entry) => entry.event === "agent.stream.failed");
  assert.equal(failure.failureKind, "Error");
  assert.equal(failure.failureReason, undefined);
  assert.equal(JSON.stringify(logs).includes("SENSITIVE_PROVIDER_BODY"), false);
  assert.equal(JSON.stringify(logs).includes("test-only-key"), false);
});

test("Agent visibly switches to the supported fallback model after repeated Gemini 5xx errors", async () => {
  let calls = 0;
  const urls = [];
  let fallbackRequest;
  await withServer(createSseApp({
    fetchImpl: async (url, init) => {
      calls++;
      urls.push(String(url));
      if (calls <= 2) {
        return new Response("temporary upstream failure", { status: 503, headers: { "Retry-After": "0" } });
      }
      fallbackRequest = JSON.parse(init.body);
      return geminiResponse([modelEvent([{ text: "Fallback answer." }])]);
    },
  }), async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, deepthink: true }),
    });
    const events = await readEvents(response);
    assert.equal(events.filter((event) => event.content).map((event) => event.content).join(""), "Fallback answer.");
    assert.deepEqual(events.filter((event) => event.model).map((event) => event.model), ["gemini-3.8-flash", "gemini-3.6-flash"]);
    assert.match(events.find((event) => event.notice)?.notice.message ?? "", /switched to Gemini 3\.6 Flash/);
  });
  assert.equal(calls, 3);
  assert.match(urls[0], /models\/gemini-3\.8-flash:/);
  assert.match(urls[2], /models\/gemini-3\.6-flash:/);
  assert.equal(fallbackRequest.generationConfig.thinkingConfig.thinkingLevel, "high");
});

test("Agent switches models when the primary stream stalls before its first event", async () => {
  let calls = 0;
  const urls = [];
  await withServer(createSseApp({
    providerIdleMs: 10,
    fetchImpl: async (url, init) => {
      calls++;
      urls.push(String(url));
      if (calls === 1) {
        return new Response(new ReadableStream({
          start(streamController) {
            const onAbort = () => streamController.error(new Error("provider attempt aborted"));
            if (init.signal.aborted) onAbort();
            else init.signal.addEventListener("abort", onAbort, { once: true });
          },
        }));
      }
      return geminiResponse([modelEvent([{ text: "Recovered after the stall." }])]);
    },
  }), async (url) => {
    const response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    const events = await readEvents(response);
    assert.equal(events.filter((event) => event.content).map((event) => event.content).join(""), "Recovered after the stall.");
    assert.deepEqual(events.filter((event) => event.model).map((event) => event.model), ["gemini-3.8-flash", "gemini-3.6-flash"]);
    assert.match(events.find((event) => event.notice)?.notice.message ?? "", /switched to Gemini 3\.6 Flash/);
  });
  assert.equal(calls, 2);
  assert.match(urls[0], /models\/gemini-3\.8-flash:/);
  assert.match(urls[1], /models\/gemini-3\.6-flash:/);
});

test("Agent retries the same model after a stalled tool continuation", async () => {
  let calls = 0;
  const urls = [];
  await withServer(createSseApp({
    providerIdleMs: 10,
    fetchImpl: async (url, init) => {
      calls++;
      urls.push(String(url));
      if (calls === 1) {
        return new Response(new ReadableStream({
          start(streamController) {
            const onAbort = () => streamController.error(new Error("provider attempt aborted"));
            if (init.signal.aborted) onAbort();
            else init.signal.addEventListener("abort", onAbort, { once: true });
          },
        }));
      }
      return geminiResponse([modelEvent([{ text: "Continuation recovered." }])]);
    },
  }), async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...input,
        agentHistory: [{
          tool: "web_search",
          callId: "prior-search",
          thoughtSignature: "prior-signature",
          arguments: { query: "official current release" },
          result: "The official release page lists the current release.",
        }],
      }),
    });
    const events = await readEvents(response);
    assert.equal(events.filter((event) => event.content).map((event) => event.content).join(""), "Continuation recovered.");
  });
  assert.equal(calls, 2);
  assert.equal(urls.every((url) => url.includes("/models/gemini-3.8-flash:")), true);
});

test("Gemini rate limits switch Agent to Qwen and keep code-tool history on Groq", async () => {
  let geminiCalls = 0;
  const groqRequests = [];
  const groqClient = {
    models: { list: async () => ({ data: [{
      id: CODING_FALLBACK,
      active: true,
      context_window: 131072,
      max_completion_tokens: 16384,
    }] }) },
    chat: { completions: { create: async (request) => {
      groqRequests.push(request);
      const callNumber = groqRequests.length;
      return (async function* () {
        if (callNumber === 1) {
          yield { choices: [{ delta: { tool_calls: [{
            index: 0,
            id: "qwen-code-1",
            type: "function",
            function: { name: "run_code", arguments: '{"language":"javascript","code":"console.log(2+2)"}' },
          }] } }] };
        } else {
          yield { choices: [{ delta: { content: "I built and tested the code successfully." } }] };
        }
      })();
    } } },
  };
  await withServer(createSseApp({
    fetchImpl: async () => {
      geminiCalls++;
      return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
    },
    getGroqClient: () => groqClient,
  }), async (url) => {
    const firstResponse = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, agentProvider: "gemini" }),
    });
    const firstEvents = await readEvents(firstResponse);
    assert.equal(firstResponse.status, 200);
    assert.equal(firstEvents.some((event) => event.agentProvider === "groq"), true);
    assert.match(firstEvents.find((event) => event.notice)?.notice.message ?? "", /Groq model Qwen3\.8 27B/);
    const tool = firstEvents.find((event) => event.agentTool)?.agentTool;
    assert.equal(tool.arguments.language, "javascript");

    const continuation = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...input,
        agentProvider: "groq",
        agentModel: CODING_FALLBACK,
        agentTask: "reasoning",
        agentHistory: [{
          tool: "run_code",
          callId: tool.callId,
          thoughtSignature: tool.thoughtSignature,
          arguments: tool.arguments,
          result: "stdout: 4",
        }],
      }),
    });
    const continuationEvents = await readEvents(continuation);
    assert.equal(continuationEvents.filter((event) => event.content).map((event) => event.content).join(""), "I built and tested the code successfully.");
  });
  assert.equal(geminiCalls, 2, "Gemini is retried once, then the selected fallback handles continuation");
  assert.equal(groqRequests.length, 2);
  assert.equal(groqRequests[0].model, CODING_FALLBACK);
  assert.equal(groqRequests[0].tool_choice, "auto");
  assert.equal(groqRequests[1].messages.at(-2).tool_calls[0].id, "qwen-code-1");
  assert.equal(groqRequests[1].messages.at(-1).tool_call_id, "qwen-code-1");
});

test("Agent searches only when the model requests it and continues with bounded public sources", async () => {
  const requests = [];
  const searches = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    if (requests.length === 1) {
      return geminiResponse([modelEvent([{
        functionCall: { name: "web_search", id: "search-1", args: { query: "latest release notes" } },
        thoughtSignature: "search-signature",
      }])]);
    }
    return geminiResponse([modelEvent([{ text: "The latest release changed the interface." }])]);
  };
  await withServer(createSseApp({
    fetchImpl,
    search: async (query) => {
      searches.push(query);
      return {
        context: "Release notes published recently.",
        retrievedAt: "2026-11-06T18:30:00.000Z",
        sources: [
          { title: "Release notes", url: "https://example.com/releases/latest", retrieval: "search_excerpt" },
          { title: "Private target", url: "http://127.0.0.1/private" },
        ],
      };
    },
  }), async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
    const events = await readEvents(response);
    assert.equal(events.filter((event) => event.content).map((event) => event.content).join(""), "The latest release changed the interface.");
    assert.equal(events.find((event) => event.sources)?.sources[0].retrieval, "search_excerpt");
    assert.equal(events.find((event) => event.sources)?.sources[0].retrievedAt, "2026-11-06T18:30:00.000Z");
    assert.equal(events.some((event) => event.sources?.some((source) => source.url === "http://127.0.0.1/private")), false);
    assert.equal(events.at(-1).done, true);
  });
  assert.deepEqual(searches, ["latest release notes"]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers["x-goog-api-key"], "test-only-key");
  assert.equal(requests[1].body.contents.at(-2).parts[0].thoughtSignature, "search-signature");
  assert.equal(requests[1].body.contents.at(-1).parts[0].functionResponse.response.result, "Release notes published recently.");
});

test("Agent sends code requests to the browser client and accepts its bounded execution result", async () => {
  const image = {
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLKrQAAAABJRU5ErkJggg==",
  };
  const requests = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (requests.length === 1) {
      return geminiResponse([modelEvent([{
        functionCall: { name: "run_code", id: "code-1", args: { language: "javascript", code: "console.log('agent-ok')" } },
        thoughtSignature: "code-signature",
      }])]);
    }
    return geminiResponse([modelEvent([{ text: "The browser run printed agent-ok." }])]);
  };
  await withServer(createSseApp({ fetchImpl }), async (url) => {
    const first = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, image }),
    });
    const firstEvents = await readEvents(first);
    assert.deepEqual(requests[0].contents[0].parts[1], { inlineData: image });
    assert.equal(JSON.stringify(firstEvents).includes(image.data), false, "image bytes are not returned in Agent events");
    const toolEvent = firstEvents.find((event) => event.agentTool)?.agentTool;
    assert.deepEqual(toolEvent.arguments, { language: "javascript", code: "console.log('agent-ok')" });
    assert.equal(firstEvents.at(-1).done, true);

    const continued = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...input,
        image,
        agentHistory: [{
          tool: "run_code",
          callId: toolEvent.callId,
          thoughtSignature: toolEvent.thoughtSignature,
          arguments: toolEvent.arguments,
          result: "stdout: agent-ok",
        }],
      }),
    });
    const continuationEvents = await readEvents(continued);
    assert.equal(continuationEvents.filter((event) => event.content).map((event) => event.content).join(""), "The browser run printed agent-ok.");
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].contents[0].parts[1], { inlineData: image });
  assert.equal(requests[1].contents.at(-2).parts[0].functionCall.id, "code-1");
  assert.equal(requests[1].contents.at(-2).parts[0].thoughtSignature, "code-signature");
  assert.equal(requests[1].contents.at(-1).parts[0].functionResponse.response.result, "stdout: agent-ok");
});

test("Agent sends bounded project files to the browser client and accepts its run result", async () => {
  const files = [
    { path: "index.html", content: '<h1>Project</h1><link rel="stylesheet" href="styles.css">' },
    { path: "styles.css", content: "h1 { color: navy; }" },
  ];
  const requests = [];
  const groqRequests = [];
  const groqClient = {
    models: { list: async () => ({ data: [{
      id: CODING_FALLBACK, active: true, context_window: 131072, max_completion_tokens: 16384,
    }] }) },
    chat: { completions: { create: async (request) => {
      groqRequests.push(request);
      return (async function* () {
        yield { choices: [{ delta: { content: "The project preview is ready." } }] };
      })();
    } } },
  };
  const fetchImpl = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return requests.length === 1
      ? geminiResponse([modelEvent([{
          functionCall: { name: "write_project", id: "project-1", args: { entrypoint: "index.html", files } },
          thoughtSignature: "project-signature",
        }])])
      : geminiResponse([modelEvent([{ text: "The project preview is ready." }])]);
  };
  await withServer(createSseApp({ fetchImpl, getGroqClient: () => groqClient }), async (url) => {
    const first = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, agentProvider: "gemini" }),
    });
    const firstEvents = await readEvents(first);
    const toolEvent = firstEvents.find((event) => event.agentTool)?.agentTool;
    assert.equal(toolEvent.tool, "write_project");
    assert.deepEqual(toolEvent.arguments, { files, entrypoint: "index.html" });
    assert.equal(firstEvents.at(-1).done, true);

    const continued = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...input,
        projectFiles: [{ path: "styles.css", content: "h1 { color: navy; }" }],
        agentHistory: [{
          tool: "write_project",
          callId: toolEvent.callId,
          thoughtSignature: toolEvent.thoughtSignature,
          arguments: toolEvent.arguments,
          result: "Project preview loaded with no browser errors.",
        }],
      }),
    });
    const continuationEvents = await readEvents(continued);
    assert.equal(continuationEvents.filter((event) => event.content).map((event) => event.content).join(""), "The project preview is ready.");
    const qwen = groqRequests.find((request) => request.model === CODING_FALLBACK);
    assert.match(JSON.stringify(qwen.messages), /styles\.css/);
    assert.doesNotMatch(JSON.stringify(qwen.messages), /not-selected\.js/);
    assert.equal(qwen.messages.at(-2).tool_calls[0].function.name, "write_project");
    assert.match(qwen.messages.at(-1).content, /Project preview loaded with no browser errors/);
  });
  assert.equal(requests.length, 1, "project continuation moves from Gemini to Qwen");
});

test("Agent rejects unselected project paths that escape the project boundary", async () => {
  let calls = 0;
  await withServer(createSseApp({ fetchImpl: async () => { calls++; return new Response(""); } }), async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...input,
        projectFiles: [{ path: "../private.js", content: "console.log('no')" }],
      }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /selected project files are invalid/i);
  });
  assert.equal(calls, 0);
});

test("Agent caps HTML previews at three runs and returns the limit to the model", async () => {
  const requests = [];
  const fetchImpl = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    if (requests.length === 1) {
      return geminiResponse([modelEvent([{
        functionCall: { name: "run_code", id: "html-fourth", args: { language: "html", code: "<h1>Another preview</h1>" } },
        thoughtSignature: "html-fourth-signature",
      }])]);
    }
    return geminiResponse([modelEvent([{ text: "I stopped after the preview limit." }])]);
  };
  const history = Array.from({ length: MAX_AGENT_HTML_PREVIEW_RUNS }, (_, index) => ({
    tool: "run_code",
    callId: `html-${index + 1}`,
    thoughtSignature: `html-signature-${index + 1}`,
    arguments: { language: "html", code: `<h1>Preview ${index + 1}</h1>` },
    result: `Preview ${index + 1} rendered.`,
  }));
  await withServer(createSseApp({ fetchImpl }), async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, agentHistory: history }),
    });
    const events = await readEvents(response);
    assert.equal(events.filter((event) => event.content).map((event) => event.content).join(""), "I stopped after the preview limit.");
    assert.equal(events.some((event) => event.agentTool), false, "The fourth HTML tool call is not dispatched to the browser");
    assert.ok(events.some((event) => event.activity?.label === "HTML preview revision limit reached"));
  });
  assert.equal(requests.length, 2);
  assert.match(requests[1].contents.at(-1).parts[0].functionResponse.response.result, /revision limit was reached after three runs/i);
});

test("Agent reuses prior search and code results instead of repeating tool side effects", async () => {
  const requests = [];
  let searchCalls = 0;
  const fetchImpl = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    if (requests.length === 1) {
      return geminiResponse([modelEvent([{
        functionCall: { name: "web_search", id: "search-first", args: { query: "release details" } },
        thoughtSignature: "sig-search-first",
      }])]);
    }
    if (requests.length === 2) {
      return geminiResponse([modelEvent([{
        functionCall: { name: "web_search", id: "search-repeat", args: { query: "release details" } },
        thoughtSignature: "sig-search-repeat",
      }])]);
    }
    if (requests.length === 3) {
      return geminiResponse([modelEvent([{
        functionCall: { name: "run_code", id: "code-first", args: { language: "javascript", code: "console.log(2 + 2)" } },
        thoughtSignature: "sig-code-first",
      }])]);
    }
    if (requests.length === 4) {
      return geminiResponse([modelEvent([{
        functionCall: { name: "run_code", id: "code-repeat", args: { language: "javascript", code: "console.log(2 + 2)" } },
        thoughtSignature: "sig-code-repeat",
      }])]);
    }
    return geminiResponse([modelEvent([{ text: "I reused both earlier results." }])]);
  };
  await withServer(createSseApp({
    fetchImpl,
    search: async () => {
      searchCalls++;
      return {
        context: "Release details.",
        retrievedAt: "2026-11-06T18:30:00.000Z",
        sources: [{ title: "Release", url: "https://example.com/release" }],
      };
    },
  }), async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...input,
        agentHistory: [{
          tool: "run_code",
          callId: "earlier-code",
          thoughtSignature: "sig-earlier-code",
          arguments: { language: "javascript", code: "console.log(2 + 2)" },
          result: "stdout: 4",
        }],
      }),
    });
    const events = await readEvents(response);
    assert.equal(events.filter((event) => event.content).map((event) => event.content).join(""), "I reused both earlier results.");
    assert.equal(events.some((event) => event.agentTool), false, "duplicate code must not be sent back to the browser");
  });
  assert.equal(searchCalls, 1, "duplicate search does not scrape twice");
  assert.equal(requests.length, 5);
  assert.match(requests[2].contents.at(-1).parts[0].functionResponse.response.result, /previous result/);
  assert.match(requests[4].contents.at(-1).parts[0].functionResponse.response.result, /already ran/);
});

test("Agent reports unavailable search without claiming facts were verified", async () => {
  let calls = 0;
  await withServer(createSseApp({
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? geminiResponse([modelEvent([{
          functionCall: { name: "web_search", id: "search-error", args: { query: "current event" } },
          thoughtSignature: "search-error-signature",
        }])])
        : geminiResponse([modelEvent([{ text: "I could not verify current details because web search was unavailable." }])]);
    },
    search: async () => { throw new Error("internal scraper detail"); },
  }), async (url) => {
    const response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    const events = await readEvents(response);
    assert.equal(events.filter((event) => event.content).map((event) => event.content).join(""), "I could not verify current details because web search was unavailable.");
    assert.equal(events.some((event) => event.activity?.status === "error" && event.activity.kind === "search"), true);
    assert.equal(events.some((event) => JSON.stringify(event).includes("internal scraper detail")), false);
  });
});

test("Agent sanitizes failed image requests without emitting image bytes or provider errors", async () => {
  const image = {
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLKrQAAAABJRU5ErkJggg==",
  };
  const providerError = "SENSITIVE_PROVIDER_BODY:provider-internal-diagnostic";
  const logs = [];
  const logger = pino({ level: "info" }, { write: (line) => logs.push(JSON.parse(line)) });
  await withServer(createSseApp({
    fetchImpl: async () => new Response(providerError, { status: 401 }),
    logger,
  }), async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, image }),
    });
    const body = await response.text();
    assert.match(body, /could not authorize/);
    assert.equal(body.includes("SENSITIVE_PROVIDER_BODY"), false);
    assert.equal(body.includes(image.data), false, "image bytes are absent from emitted error events");
  });

  const serializedLogs = JSON.stringify(logs);
  assert.equal(serializedLogs.includes(image.data), false, "server logs omit uploaded image bytes");
  assert.equal(serializedLogs.includes(providerError), false, "server logs omit the provider response body");
  const failure = logs.find((entry) => entry.event === "agent.stream.failed");
  assert.ok(failure, "server logs retain a structured failure record");
  assert.equal(failure.provider, "gemini");
  assert.match(failure.model, /^(?:gemini|gemma)-/, "server logs retain the selected provider model");
  assert.equal(failure.status, 401);
  assert.equal(failure.failureKind, "gemini_http");
  assert.equal(failure.failureReason, "HTTP 401");
});

test("cancelling an image-bearing Agent request aborts its in-flight Gemini request", async () => {
  const image = {
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLKrQAAAABJRU5ErkJggg==",
  };
  let upstreamSignal;
  let upstreamBody;
  await withServer(createSseApp({
    fetchImpl: async (_url, init) => {
      upstreamSignal = init.signal;
      upstreamBody = JSON.parse(init.body);
      let source;
      const body = new ReadableStream({
        start(controller) {
          source = controller;
          init.signal.addEventListener("abort", () => {
            try { source.close(); } catch { /* The response may already have closed. */ }
          }, { once: true });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  }), async (url) => {
    const controller = new AbortController();
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, image }),
      signal: controller.signal,
    });
    const reader = response.body.getReader();
    const first = await reader.read();
    const emittedBeforeCancellation = new TextDecoder().decode(first.value);
    assert.match(emittedBeforeCancellation, /gemma-4-31b-it/);
    assert.equal(emittedBeforeCancellation.includes(image.data), false, "emitted Agent events never contain image bytes");
    for (let attempt = 0; attempt < 50 && !upstreamSignal; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(upstreamSignal, "Gemini request was started");
    assert.deepEqual(upstreamBody.contents[0].parts[1], { inlineData: image });
    controller.abort();
    for (let attempt = 0; attempt < 50 && !upstreamSignal.aborted; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(upstreamSignal.aborted, true);
    assert.equal(emittedBeforeCancellation.includes(image.data), false);
    await reader.cancel().catch(() => {});
  });
});
