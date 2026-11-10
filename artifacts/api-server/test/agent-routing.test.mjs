import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pino from "pino";
import pinoHttp from "pino-http";
import Groq from "groq-sdk";
import { buildGroqAgentRequest, collectGroqAgentResponse, groqAgentFailure } from "../src/lib/groq-agent.ts";
import {
  CODING_FALLBACK,
  PRIMARY_MODEL,
  PROMPT_GUARD_MODEL,
  SAFEGUARD_MODEL,
  SMALL_MODEL,
  markRateLimited,
  clearRateLimit,
  rateLimitDiagnostics,
  codingRateLimitMessage,
  isCoolingDown,
} from "../src/lib/model-routing.ts";
import { createAgentRouter } from "../src/routes/agent.ts";

const catalog = [
  CODING_FALLBACK,
  PRIMARY_MODEL,
  SMALL_MODEL,
  PROMPT_GUARD_MODEL,
  SAFEGUARD_MODEL,
].map((id) => ({
  id,
  active: true,
  context_window: id === PROMPT_GUARD_MODEL ? 512 : 131072,
  max_completion_tokens: id === PROMPT_GUARD_MODEL ? 512 : id === CODING_FALLBACK ? 16384 : 65536,
}));

function createApp(client, search = async () => ({ context: "", sources: [] }), logger = pino({ level: "silent" })) {
  const app = express();
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: "5mb" }));
  app.use("/api", createAgentRouter({
    getApiKey: () => undefined,
    getGroqClient: () => client,
    search,
  }));
  return app;
}

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

async function eventsFrom(response) {
  return (await response.text()).split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

function toolStream() {
  return (async function* () {
    yield { choices: [{ delta: { tool_calls: [{
      index: 0,
      id: "routed-code-call",
      type: "function",
      function: { name: "run_code", arguments: '{"language":"javascript","code":"console.log(2+2)"}' },
    }] } }] };
  })();
}

function textStream(content) {
  return (async function* () {
    yield { choices: [{ delta: { content } }] };
  })();
}

function projectStream(id, project) {
  return (async function* () {
    yield { choices: [{ delta: { tool_calls: [{
      index: 0, id, type: "function",
      function: { name: "write_project", arguments: JSON.stringify(project) },
    }] } }] };
  })();
}

test("Agent request options match Qwen, GPT-OSS and non-reasoning Llama capabilities", () => {
  const input = { messages: [{ role: "user", content: "Explain how rainbows form." }], deepthink: true };
  for (const model of [PRIMARY_MODEL, SMALL_MODEL]) {
    const request = buildGroqAgentRequest(input, new Date(), true, model);
    assert.equal(request.reasoning_effort, "high");
    assert.equal(request.reasoning_format, undefined, "GPT-OSS rejects reasoning_format");
    assert.equal(request.include_reasoning, false);
  }
  const qwen = buildGroqAgentRequest(input, new Date(), true, CODING_FALLBACK);
  assert.equal(qwen.reasoning_format, "parsed");
  assert.equal(qwen.include_reasoning, undefined);
  for (const model of ["meta-llama/llama-3.1-8b-instant", "meta-llama/llama-3.3-70b-versatile"]) {
    const request = buildGroqAgentRequest(input, new Date(), true, model);
    assert.equal(request.reasoning_effort, undefined);
    assert.equal(request.reasoning_format, undefined);
    assert.equal(request.include_reasoning, undefined);
    assert.ok(request.tools);
  }
});

test("non-coding Agent answers with GPT-OSS and falls back from transient model failures", async () => {
  const attempts = [];
  const client = {
    models: { list: async () => ({ data: catalog }) },
    chat: { completions: { create: async (request) => {
      if ([PROMPT_GUARD_MODEL, SAFEGUARD_MODEL].includes(request.model)) return { choices: [] };
      attempts.push(request.model);
      assert.equal(request.reasoning_format, undefined, "GPT-OSS must not receive Qwen-only settings");
      if (request.model === SMALL_MODEL) throw new Groq.APIError(503, { code: "service_unavailable" }, undefined, new Headers());
      assert.equal(request.model, PRIMARY_MODEL);
      return textStream("GPT-OSS completed the answer.");
    } } },
  };
  await withServer(createApp(client), async (url) => {
    const events = await eventsFrom(await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Explain how rainbows form." }], agentProvider: "groq" }),
    }));
    assert.ok(events.some((event) => event.content === "GPT-OSS completed the answer."));
    assert.ok(events.some((event) => event.notice?.id === "agent-model-fallback"));
    assert.equal(events.some((event) => event.error), false);
  });
  assert.deepEqual(attempts, [SMALL_MODEL, SMALL_MODEL, PRIMARY_MODEL]);
});

test("Agent corrects rejected project payloads, runs the build, and consumes its result before finishing", async () => {
  let calls = 0;
  const client = {
    models: { list: async () => ({ data: catalog }) },
    chat: { completions: { create: async (request) => {
      if ([PROMPT_GUARD_MODEL, SAFEGUARD_MODEL].includes(request.model)) return { choices: [] };
      calls += 1;
      if (calls === 1) return projectStream("invalid-project", {
        entrypoint: "index.html", files: [{ path: "../index.html", content: "invalid" }],
      });
      if (calls === 2) {
        assert.equal(request.tool_choice, "required");
        assert.match(request.messages.at(-1).content, /previous project payload was rejected/);
        return projectStream("corrected-project", {
          entrypoint: "index.html", files: [{ path: "index.html",
            content: '<!doctype html><button onclick="this.textContent=Number(this.textContent)+1">0</button>' }],
        });
      }
      assert.match(request.messages.at(-1).content, /Nexo execution status: completed/);
      return textStream("Created the counter. The browser reported no runtime errors; button interactions remain unverified.");
    } } },
  };
  await withServer(createApp(client), async (url) => {
    const body = { messages: [{ role: "user", content: "Build a counter app" }] };
    const post = async (data) => eventsFrom(await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    }));
    const initial = await post(body);
    const tool = initial.find((event) => event.agentTool)?.agentTool;
    assert.ok(tool);
    assert.equal(tool.callId, "corrected-project");
    assert.deepEqual(tool.history, [], "invalid payloads must never enter reusable project history");
    const finished = await post({ ...body, agentHistory: [{
      tool: tool.tool, callId: tool.callId, thoughtSignature: tool.thoughtSignature,
      arguments: tool.arguments, result: "Nexo execution status: completed.\nNo runtime errors reported.",
    }] });
    assert.ok(finished.some((event) => event.content?.includes("Created the counter")));
    assert.equal(finished.some((event) => event.error), false);
  });
  assert.equal(calls, 3);
});

test("Agent cannot report successful completion without a build or after a failed run", async () => {
  const client = {
    models: { list: async () => ({ data: catalog }) },
    chat: { completions: { create: async (request) => {
      if ([PROMPT_GUARD_MODEL, SAFEGUARD_MODEL].includes(request.model)) return { choices: [] };
      assert.equal(request.tool_choice, "required");
      return textStream("Everything works perfectly.");
    } } },
  };
  await withServer(createApp(client), async (url) => {
    for (const agentHistory of [[], [{
      tool: "run_code", callId: "broken", thoughtSignature: "groq-agent-v1",
      arguments: { language: "html", code: "<h1>Broken app</h1>" },
      result: "Nexo execution status: failed.\nExecution error: ReferenceError",
    }]]) {
      const events = await eventsFrom(await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "Build an app" }], agentHistory }),
      }));
      assert.ok(events.some((event) => event.error));
      assert.equal(events.some((event) => event.content?.includes("Everything works")), false);
    }
  });
});

test("coding pins Qwen through an output-budget retry and tool continuation, ignoring old GPT/Gemini routes", async () => {
  clearRateLimit(CODING_FALLBACK);
  const requests = [];
  const client = {
    models: { list: async () => ({ data: catalog }) },
    chat: { completions: { create: async (request) => {
      if (request.model !== CODING_FALLBACK) {
        assert.ok([PROMPT_GUARD_MODEL, SAFEGUARD_MODEL].includes(request.model), "GPT-OSS must not generate code");
        return { choices: [{ message: { content: "0" } }] };
      }
      requests.push(request);
      if (requests.length === 1) throw new Groq.APIError(429, {
        message: "Output tokens per minute (OTPM): Limit 1000, Requested 1434.",
      }, undefined, new Headers());
      if (requests.length === 2) {
        assert.equal(request.max_completion_tokens, 850);
        assert.match(request.messages[0].content, /compact, complete index\.html/);
        return toolStream();
      }
      assert.equal(request.max_completion_tokens, 850);
      assert.match(request.messages.at(-1).content, /stdout: 4/);
      return textStream("Qwen checked the result.");
    } } },
  };
  await withServer(createApp(client), async (url) => {
    const body = {
      messages: [
        { role: "user", content: "Make me a task list app" },
        { role: "assistant", content: "The project is ready." },
        { role: "user", content: "Add a filter to show unfinished tasks" },
      ],
      agentProvider: "gemini", agentModel: PRIMARY_MODEL, agentTask: "reasoning",
    };
    const events = await eventsFrom(await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }));
    const tool = events.find((event) => event.agentTool)?.agentTool;
    assert.ok(tool);
    assert.ok(events.some((event) => event.model === CODING_FALLBACK));
    assert.equal(events.some((event) => event.model?.includes("gpt-oss")), false);
    const continued = await eventsFrom(await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, agentHistory: [{
        tool: tool.tool, callId: tool.callId, thoughtSignature: tool.thoughtSignature,
        arguments: tool.arguments, result: "stdout: 4",
      }] }),
    }));
    assert.ok(continued.some((event) => event.content === "Qwen checked the result."));
  });
  assert.equal(requests.length, 3);
});

test("coding quota failure never substitutes GPT-OSS or claims a fallback succeeded", async () => {
  clearRateLimit(CODING_FALLBACK);
  const attempts = [];
  const client = {
    models: { list: async () => ({ data: catalog }) },
    chat: { completions: { create: async (request) => {
      if ([PROMPT_GUARD_MODEL, SAFEGUARD_MODEL].includes(request.model)) return { choices: [] };
      attempts.push(request.model);
      throw new Groq.APIError(429, { message: "Requests per minute (RPM): Limit 30, Used 30, Requested 1" }, undefined, new Headers());
    } } },
  };
  try {
    await withServer(createApp(client), async (url) => {
      const events = await eventsFrom(await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "Build a browser counter" }] }),
      }));
      assert.match(events.find((event) => event.error)?.error, /Qwen rejected this coding request/);
      assert.equal(events.some((event) => event.notice), false);
    });
    assert.deepEqual(attempts, [CODING_FALLBACK]);
  } finally { clearRateLimit(CODING_FALLBACK); }
});

test("Qwen 413 compacts context once without replaying tools, cutting latest code, or switching providers", async () => {
  for (const recover of [true, false]) {
    const requests = [];
    const code = "<h1>Existing website</h1><button onclick=\"this.textContent='Done'\">Try</button>";
    const input = {
      messages: [
        { role: "user", content: "Previous coding discussion ".repeat(200) },
        { role: "assistant", content: "Previous answer" },
        { role: "user", content: "Finish the existing website without removing its working button." },
      ],
      agentHistory: [{
        tool: "run_code", callId: "existing-website", thoughtSignature: "groq-agent-v1",
        arguments: { language: "html", code }, result: "The existing page loaded. No runtime errors.",
      }],
    };
    const original = JSON.stringify(input);
    const client = {
      models: { list: async () => ({ data: catalog }) },
      chat: { completions: { create: async (request) => {
        if ([PROMPT_GUARD_MODEL, SAFEGUARD_MODEL].includes(request.model)) return { choices: [] };
        requests.push(request);
        assert.equal(request.model, CODING_FALLBACK);
        if (requests.length === 1 || !recover) {
          throw new Groq.APIError(413, { message: "PRIVATE oversized request" }, undefined, new Headers());
        }
        return textStream("The existing website is kept.");
      } } },
    };
    await withServer(createApp(client), async (url) => {
      const events = await eventsFrom(await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: original,
      }));
      assert.equal(requests.length, 2);
      assert.ok(JSON.stringify(requests[1]).length < JSON.stringify(requests[0]).length);
      assert.equal(requests[1].messages.findLast((message) => message.role === "user").content, input.messages.at(-1).content);
      const call = requests[1].messages.find((message) => message.tool_calls)?.tool_calls[0];
      assert.equal(JSON.parse(call.function.arguments).code, code);
      assert.equal(events.some((event) => event.agentTool || event.notice || event.activity?.id === "agent-provider-wait"), false);
      assert.equal(JSON.stringify(events).includes("PRIVATE"), false);
      if (recover) assert.ok(events.some((event) => event.content === "The existing website is kept."));
      else assert.match(events.find((event) => event.error)?.error, /too large \(HTTP 413\)/);
    });
    assert.equal(JSON.stringify(input), original);
  }
});

test("Qwen 413 does not retry when compaction cannot make the request smaller", async () => {
  let attempts = 0;
  const client = {
    models: { list: async () => ({ data: catalog }) },
    chat: { completions: { create: async (request) => {
      if ([PROMPT_GUARD_MODEL, SAFEGUARD_MODEL].includes(request.model)) return { choices: [] };
      attempts++;
      throw new Groq.APIError(413, { message: "PRIVATE" }, undefined, new Headers());
    } } },
  };
  await withServer(createApp(client), async (url) => {
    const events = await eventsFrom(await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Build a small website" }] }),
    }));
    assert.equal(attempts, 1);
    assert.match(events.find((event) => event.error)?.error, /saved project is kept/);
  });
});

test("coding waits repeatedly for explicit provider windows without replaying saved tools", async () => {
  clearRateLimit(CODING_FALLBACK);
  let attempts = 0;
  const client = {
    models: { list: async () => ({ data: catalog }) },
    chat: { completions: { create: async (request) => {
      if ([PROMPT_GUARD_MODEL, SAFEGUARD_MODEL].includes(request.model)) return { choices: [] };
      assert.equal(request.model, CODING_FALLBACK);
      assert.match(request.messages.at(-1).content, /already checked/);
      if (++attempts <= 2) throw new Groq.APIError(429, {
        message: "Output tokens per minute (OTPM): Limit 1000, Used 985, Requested 241. Please try again in 0s.",
      }, undefined, new Headers());
      return textStream("The checked project is ready.");
    } } },
  };
  await withServer(createApp(client), async (url) => {
    const events = await eventsFrom(await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Build a task list app" }],
        agentHistory: [{
          tool: "run_code", callId: "saved-run", thoughtSignature: "groq-agent-v1",
          arguments: { language: "javascript", code: "console.log('checked')" }, result: "already checked",
        }],
      }),
    }));
    assert.ok(events.some((event) => event.activity?.id === "agent-provider-wait" && event.activity.status === "running"));
    assert.equal(events.filter((event) => event.activity?.id === "agent-provider-wait" && event.activity.status === "running").length, 2);
    assert.ok(events.some((event) => event.content === "The checked project is ready."));
    assert.equal(events.some((event) => event.agentTool || event.error), false);
  });
  assert.equal(attempts, 3);
});

test("coding stops after three waits when the browser retry budget is also exhausted", async () => {
  clearRateLimit(CODING_FALLBACK);
  let attempts = 0;
  const client = {
    models: { list: async () => ({ data: catalog }) },
    chat: { completions: { create: async (request) => {
      if ([PROMPT_GUARD_MODEL, SAFEGUARD_MODEL].includes(request.model)) return { choices: [] };
      assert.equal(request.model, CODING_FALLBACK);
      attempts++;
      throw new Groq.APIError(429, { message: "Output tokens per minute (OTPM): Limit 1000, Used 831, Requested 349." }, undefined, new Headers({ "retry-after": "0" }));
    } } },
  };
  try {
    await withServer(createApp(client), async (url) => {
      const events = await eventsFrom(await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "Build a task list app" }], agentRetryCount: 3 }),
      }));
      assert.equal(events.filter((event) => event.activity?.id === "agent-provider-wait" && event.activity.status === "running").length, 3);
      assert.match(events.find((event) => event.error)?.error, /output tokens per minute/);
      assert.equal(events.some((event) => event.agentTool || event.notice), false);
    });
    assert.equal(attempts, 4);
  } finally { clearRateLimit(CODING_FALLBACK); }
});

test("input-token exhaustion defers a complete run and a later request resumes without replaying tools", async () => {
  clearRateLimit(CODING_FALLBACK);
  const requests = [];
  const history = [{
    tool: "run_code", callId: "existing-run", thoughtSignature: "groq-agent-v1",
    arguments: { language: "html", code: "<h1>Existing working code</h1>" },
    result: "No runtime errors. These results must not be executed again.",
  }];
  const input = {
    agentRetryCount: 0,
    messages: [
      { role: "user", content: "Old coding context ".repeat(200) },
      { role: "assistant", content: "An old answer" },
      { role: "user", content: "Finish this website" },
    ],
    agentHistory: history,
  };
  const client = {
    models: { list: async () => ({ data: catalog }) },
    chat: { completions: { create: async (request) => {
      if ([PROMPT_GUARD_MODEL, SAFEGUARD_MODEL].includes(request.model)) return { choices: [] };
      requests.push(request);
      assert.equal(request.model, CODING_FALLBACK);
      if (requests.length <= 4) throw new Groq.APIError(429, {
        message: "PRIVATE input tokens per minute (ITPM): Limit 7000, Used 6658, Requested 3958.",
      }, undefined, new Headers({ "retry-after": "0" }));
      return textStream("The existing website is ready.");
    } } },
  };
  try {
    await withServer(createApp(client), async (url) => {
      const send = (body) => fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }).then(eventsFrom);
      const events = await send(input);
      const deferred = events.find((event) => event.agentRetry)?.agentRetry;
      assert.deepEqual(deferred?.history, history);
      assert.equal(deferred.afterMs, 250);
      assert.equal(events.some((event) => event.error || event.agentTool), false);
      assert.ok(JSON.stringify(requests[1]).length < JSON.stringify(requests[0]).length);
      const resumed = await send({ ...input, agentHistory: deferred.history, agentRetryCount: 1 });
      assert.ok(resumed.some((event) => event.content === "The existing website is ready."));
      assert.equal(resumed.some((event) => event.agentTool || event.error), false);
      assert.equal(requests.at(-1).messages.filter((message) => message.role === "tool").length, 1);
      assert.equal(JSON.stringify(events).includes("PRIVATE"), false);
      assert.equal((await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, agentRetryCount: 4 }),
      })).status, 400);
    });
    assert.equal(requests.length, 5);
  } finally { clearRateLimit(CODING_FALLBACK); }
});

test("legacy clients receive a clear quota error rather than an unsupported retry handoff", async () => {
  clearRateLimit(CODING_FALLBACK);
  const client = {
    models: { list: async () => ({ data: catalog }) },
    chat: { completions: { create: async (request) => {
      if ([PROMPT_GUARD_MODEL, SAFEGUARD_MODEL].includes(request.model)) return { choices: [] };
      throw new Groq.APIError(429, {
        message: "Input tokens per minute (ITPM): Limit 7000, Used 6658, Requested 3958.",
      }, undefined, new Headers({ "retry-after": "0" }));
    } } },
  };
  try {
    await withServer(createApp(client), async (url) => {
      const events = await eventsFrom(await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "Build a small website" }] }),
      }));
      assert.equal(events.some((event) => event.agentRetry), false);
      const message = events.find((event) => event.error)?.error;
      assert.match(message, /input tokens per minute/);
      assert.equal(message.includes("Your saved project"), false);
    });
  } finally { clearRateLimit(CODING_FALLBACK); }
});

test("an empty deferred coding run does not repeat the Gemini planning pass", async () => {
  const client = {
    models: { list: async () => ({ data: catalog }) },
    chat: { completions: { create: async (request) => {
      if ([PROMPT_GUARD_MODEL, SAFEGUARD_MODEL].includes(request.model)) return { choices: [] };
      assert.equal(request.model, CODING_FALLBACK);
      assert.equal(request.tool_choice, "required");
      return toolStream();
    } } },
  };
  const app = express();
  app.use(pinoHttp({ logger: pino({ level: "silent" }) }));
  app.use(express.json());
  app.use("/api", createAgentRouter({
    getApiKey: () => "configured-for-test",
    getGroqClient: () => client,
    getGeminiModels: async () => { assert.fail("a deferred coding request must not restart planning"); },
    fetchImpl: async () => { assert.fail("no Gemini planning call is needed"); },
  }));
  await withServer(app, async (url) => {
    const events = await eventsFrom(await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Build a small website" }],
        agentProvider: "groq", agentRetryCount: 1,
      }),
    }));
    assert.ok(events.some((event) => event.agentTool?.tool === "run_code"));
  });
});

test("stopping the stream cancels a Qwen wait before another model call", async () => {
  clearRateLimit(CODING_FALLBACK);
  let attempts = 0;
  const client = {
    models: { list: async () => ({ data: catalog }) },
    chat: { completions: { create: async (request) => {
      if ([PROMPT_GUARD_MODEL, SAFEGUARD_MODEL].includes(request.model)) return { choices: [] };
      assert.equal(request.model, CODING_FALLBACK);
      attempts++;
      throw new Groq.APIError(429, { message: "Output tokens per minute (OTPM): Limit 1000, Used 831, Requested 349." }, undefined, new Headers({ "retry-after": "10" }));
    } } },
  };
  try {
    await withServer(createApp(client), async (url) => {
      const controller = new AbortController();
      const response = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ messages: [{ role: "user", content: "Build a task list app" }] }),
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let received = "";
      try {
        while (!received.includes("agent-provider-wait")) {
          const chunk = await reader.read();
          assert.equal(chunk.done, false);
          received += decoder.decode(chunk.value, { stream: true });
        }
        controller.abort();
        await assert.rejects(reader.read(), /abort/i);
      } finally { reader.releaseLock(); }
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(attempts, 1);
    });
  } finally { clearRateLimit(CODING_FALLBACK); }
});

test("quota diagnostics recover explicit delays without leaking provider text or confusing daily quotas", () => {
  const error = (message, headers = {}) => new Groq.APIError(429, { message }, undefined, new Headers(headers));
  const body = error("PRIVATE tokens per minute (TPM): Limit 6000, Used 5900, Requested 200. Please try again in 1m2.5s. PRIVATE");
  assert.equal(rateLimitDiagnostics(body).retryAfter, "62.5");
  assert.match(codingRateLimitMessage(body), /tokens per minute \(limit 6000, used 5900, requested 200\)/);
  assert.match(codingRateLimitMessage(body), /at least 63 seconds/);
  assert.equal(codingRateLimitMessage(body).includes("PRIVATE"), false);
  assert.equal(rateLimitDiagnostics(error("tokens per minute (TPM)", { "x-ratelimit-reset-tokens": "500ms" })).retryAfter, "0.5");
  assert.equal(rateLimitDiagnostics(error("tokens per day (TPD)", { "x-ratelimit-reset-tokens": "2s" })).retryAfter, null);
  assert.equal(rateLimitDiagnostics(error("requests per minute (RPM)", { "x-ratelimit-reset-tokens": "2s" })).retryAfter, null);
  assert.equal(rateLimitDiagnostics(error("Please try again in 2s.", { "retry-after": "10" })).retryAfter, "10");
  assert.equal(rateLimitDiagnostics(error("Please try again in never. PRIVATE")).retryAfter, null);
  assert.match(codingRateLimitMessage(error("PRIVATE")), /did not identify the quota/);
  assert.match(codingRateLimitMessage(error("tokens per minute (TPM): Limit 100, Used 0, Requested 200")), /waiting alone may not help/);
});

test("truncated Qwen tool output is rejected before incomplete code can run", async () => {
  const stream = (async function* () {
    yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "partial", function: { name: "write_project", arguments: '{"files":[' } }] } }] };
    yield { choices: [{ delta: {}, finish_reason: "length" }] };
  })();
  await assert.rejects(collectGroqAgentResponse(stream, new AbortController().signal), /No incomplete code was run/);
});
test("Agent rechecks one live model when every candidate has a cached cooldown", async () => {
  const models = [SMALL_MODEL, PRIMARY_MODEL, CODING_FALLBACK];
  for (let index = 0; index < models.length; index++) markRateLimited(models[index], String(600 + index * 100));
  const attempts = [];
  const client = {
    models: { list: async () => ({ data: catalog }) },
    chat: { completions: { create: async (request) => {
      if (models.includes(request.model)) attempts.push(request.model);
      return textStream("Fresh request accepted");
    } } },
  };
  try {
    await withServer(createApp(client), async (url) => {
      const response = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
      });
      assert.equal(response.status, 200);
      const events = await eventsFrom(response);
      assert.ok(events.some((event) => event.content === "Fresh request accepted"));
      assert.equal(events.some((event) => event.error), false);
    });
    assert.deepEqual(attempts, [SMALL_MODEL]);
    assert.equal(isCoolingDown(SMALL_MODEL), false);
  } finally {
    models.forEach(clearRateLimit);
  }
});

test("Agent context includes complete project code once and retains newer selected edits", () => {
  const files = [{ path: "index.html", content: "<p>ORIGINAL_SOURCE_MARKER</p>" }];
  const input = {
    messages: [{ role: "user", content: "Build a task list" }],
    projectFiles: files,
    agentHistory: [{
      tool: "write_project", callId: "saved-project", thoughtSignature: "groq-agent-v1",
      arguments: { files, entrypoint: "index.html" }, result: "The preview loaded.",
    }],
  };
  const unchanged = JSON.stringify(buildGroqAgentRequest(input).messages);
  assert.equal(unchanged.split("ORIGINAL_SOURCE_MARKER").length - 1, 1);
  const edited = JSON.stringify(buildGroqAgentRequest({
    ...input, projectFiles: [{ path: "index.html", content: "<p>NEW_SELECTED_EDIT</p>" }],
  }).messages);
  assert.match(edited, /ORIGINAL_SOURCE_MARKER/);
  assert.match(edited, /NEW_SELECTED_EDIT/);
});

test("Agent logs actual request-size rejection and never claims untried models exhausted", async () => {
  const models = [SMALL_MODEL, PRIMARY_MODEL, CODING_FALLBACK];
  models.forEach((model) => clearRateLimit(model));
  const logs = [];
  const logger = pino({ level: "warn" }, { write: (line) => logs.push(JSON.parse(line)) });
  const client = {
    models: { list: async () => ({ data: catalog }) },
    chat: { completions: { create: async (request) => {
      if (!models.includes(request.model)) return textStream("safe");
      throw new Groq.APIError(429, { message: "PRIVATE_ORG tokens per minute (TPM): Limit 6000, Used 0, Requested 8200 PRIVATE_KEY" }, undefined, new Headers({ "retry-after": "100" }));
    } } },
  };
  await withServer(createApp(client, undefined, logger), async (url) => {
    const events = await eventsFrom(await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
    }));
    const error = events.find((event) => event.error)?.error;
    assert.match(error, /too large/);
    assert.doesNotMatch(error, /Every compatible|temporarily rate-limited/);
    assert.equal(events.some((event) => event.notice?.id === "agent-model-rate-fallback"), false);
  });
  const rejection = logs.find((entry) => entry.event === "agent.provider.rate_limited");
  assert.equal(rejection.status, 429);
  assert.equal(rejection.requestTooLarge, true);
  assert.equal(rejection.quotaRequested, 8200);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE/);
  assert.ok(models.every((model) => !isCoolingDown(model)));
});

test("Groq diagnostics distinguish stream, connection and HTTP errors without provider payloads", () => {
  const streamed = groqAgentFailure(new Groq.APIError(undefined, {
    code: "tool_use_failed", message: "PRIVATE", failed_generation: "PRIVATE",
  }, undefined, new Headers()));
  assert.equal(streamed.kind, "groq_stream");
  assert.equal(streamed.code, "tool_use_failed");
  assert.equal(streamed.status, 422);
  assert.equal(streamed.retryable, true);
  assert.equal(JSON.stringify(streamed).includes("PRIVATE"), false);
  assert.equal(groqAgentFailure(new Groq.APIConnectionError({})).kind, "groq_connection");
  assert.equal(groqAgentFailure(new Groq.APIConnectionTimeoutError({})).kind, "groq_timeout");
  assert.equal(groqAgentFailure(new Groq.APIError(undefined, { code: "rate_limit_exceeded" }, undefined, new Headers())).status, 429);
  assert.equal(groqAgentFailure(new Groq.APIError(401, { message: "PRIVATE" }, undefined, new Headers())).retryable, false);
  assert.equal(groqAgentFailure(new Groq.APIError(undefined, { code: "PRIVATE", type: "invalid_request_error" }, undefined, new Headers())).retryable, false);
});

test("Agent retries a recoverable Groq failure once without exposing failed output or replaying tools", async () => {
  for (const toolFailure of [false, true]) {
    const requests = [];
    const logs = [];
    const logger = pino({ level: "info" }, { write: (line) => logs.push(JSON.parse(line)) });
    const client = {
      models: { list: async () => ({ data: catalog }) },
      chat: { completions: { create: async (request) => {
        if (request.model === PROMPT_GUARD_MODEL) return { choices: [{ message: { content: "0.01" } }] };
        requests.push(request);
        if (requests.length === 1) {
          if (!toolFailure) throw new Groq.APIConnectionError({ message: "PRIVATE" });
          return (async function* () {
            yield { choices: [{ delta: { content: "Discard incomplete output" } }] };
            throw new Groq.APIError(undefined, {
              code: "tool_use_failed", message: "PRIVATE", failed_generation: "PRIVATE",
            }, undefined, new Headers());
          })();
        }
        return textStream("Recovered answer.");
      } } },
    };
    await withServer(createApp(client, undefined, logger), async (url) => {
      const events = await eventsFrom(await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "Give me a quick answer." }] }),
      }));
      assert.equal(events.filter((event) => event.content).map((event) => event.content).join(""), "Recovered answer.");
      assert.equal(events.some((event) => event.agentTool || event.error), false);
      assert.equal(JSON.stringify(events).includes("Discard incomplete output"), false);
      assert.equal(events.at(-1).done, true);
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].model, requests[0].model);
    assert.deepEqual(requests[1].tools, requests[0].tools);
    if (toolFailure) assert.match(requests[1].messages.at(-1).content, /matching their JSON schemas/);
    assert.equal(JSON.stringify(requests).includes("PRIVATE"), false);
    assert.equal(JSON.stringify(logs).includes("PRIVATE"), false);
    assert.ok(logs.some((entry) => entry.event === "agent.groq.retry"));
  }
});

test("Agent caps connection recovery and does not retry authorization failures", async () => {
  for (const status of [undefined, 401]) {
    let calls = 0;
    const client = {
      models: { list: async () => ({ data: catalog }) },
      chat: { completions: { create: async (request) => {
        if (request.model === PROMPT_GUARD_MODEL) return { choices: [{ message: { content: "0.01" } }] };
        calls++;
        if (status === undefined) throw new Groq.APIConnectionError({});
        throw new Groq.APIError(status, { message: "PRIVATE" }, undefined, new Headers());
      } } },
    };
    await withServer(createApp(client), async (url) => {
      const events = await eventsFrom(await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "Give me a quick answer." }] }),
      }));
      assert.ok(events.some((event) => event.error));
      assert.equal(JSON.stringify(events).includes("PRIVATE"), false);
    });
    assert.equal(calls, status === undefined ? 2 : 1);
  }
});

test("malformed Qwen tool JSON is repaired once before execution, then fails clearly if still invalid", async () => {
  for (const recover of [true, false]) {
    let attempts = 0;
    const client = {
      models: { list: async () => ({ data: catalog }) },
      chat: { completions: { create: async (request) => {
        if ([PROMPT_GUARD_MODEL, SAFEGUARD_MODEL].includes(request.model)) return { choices: [] };
        assert.equal(request.model, CODING_FALLBACK);
        attempts++;
        if (attempts > 1) assert.match(request.messages.at(-1).content, /valid tool call/);
        if (recover && attempts > 1) return toolStream();
        return (async function* () {
          yield { choices: [{ delta: { tool_calls: [{
            index: 0, id: "bad", function: { name: "run_code", arguments: '{"PRIVATE":"unfinished' },
          }] } }] };
        })();
      } } },
    };
    await withServer(createApp(client), async (url) => {
      const events = await eventsFrom(await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "Build a browser counter" }] }),
      }));
      assert.equal(attempts, 2);
      assert.equal(JSON.stringify(events).includes("PRIVATE"), false);
      assert.equal(events.some((event) => event.agentTool), recover);
      if (!recover) assert.match(events.find((event) => event.error)?.error, /valid tool request after a retry/);
    });
  }
});

test("Agent routes coding to Qwen, exposes security signals, and preserves model/task on continuation", async () => {
  const modelRequests = [];
  const securityCalls = [];
  const client = {
    models: { list: async () => ({ data: catalog }) },
    chat: { completions: { create: async (request) => {
      if (request.model === PROMPT_GUARD_MODEL) {
        securityCalls.push("prompt-guard");
        return { choices: [{ message: { content: "0.02" } }] };
      }
      if (request.model === SAFEGUARD_MODEL) {
        securityCalls.push("safeguard");
        return { choices: [{ message: { content: '{"violation":1,"category":"test-signal"}' } }] };
      }
      modelRequests.push(request);
      return modelRequests.length === 1
        ? toolStream()
        : textStream("I ran the approved browser task and checked the result.");
    } } },
  };

  await withServer(createApp(client), async (url) => {
    const firstResponse = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Build and test a small JavaScript example." }] }),
    });
    const firstEvents = await eventsFrom(firstResponse);
    assert.equal(firstResponse.status, 200);
    assert.ok(firstEvents.some((event) => event.model === CODING_FALLBACK));
    assert.ok(firstEvents.some((event) => event.agentTask === "coding"));
    assert.ok(firstEvents.some((event) => event.activity?.label.includes("Safeguard raised a review signal")));
    const tool = firstEvents.find((event) => event.agentTool)?.agentTool;
    assert.equal(tool?.tool, "run_code", "a screen signal does not replace the server-approved sandbox tool");

    const secondResponse = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Build and test a small JavaScript example." }],
        agentProvider: "groq",
        agentModel: CODING_FALLBACK,
        agentTask: "coding",
        agentHistory: [{
          tool: tool.tool,
          callId: tool.callId,
          thoughtSignature: tool.thoughtSignature,
          arguments: tool.arguments,
          result: "stdout: 4",
        }],
      }),
    });
    const secondEvents = await eventsFrom(secondResponse);
    assert.equal(secondEvents.filter((event) => event.content).map((event) => event.content).join(""), "I ran the approved browser task and checked the result.");
  });

  assert.deepEqual(modelRequests.map((request) => request.model), [CODING_FALLBACK, CODING_FALLBACK]);
  assert.equal(modelRequests[1].messages.at(-2).tool_calls[0].id, "routed-code-call");
  assert.equal(modelRequests[1].messages.at(-1).tool_call_id, "routed-code-call");
  assert.deepEqual(securityCalls, ["prompt-guard", "safeguard", "prompt-guard"]);
});

test("Unavailable fast-worker specialists surface their compatible model fallback", async () => {
  const client = {
    models: { list: async () => ({ data: catalog }) },
    chat: { completions: { create: async (request) => {
      if (request.model === PROMPT_GUARD_MODEL) return { choices: [{ message: { content: "0.01" } }] };
      if (request.model === SMALL_MODEL) return textStream("Fast worker fallback answer.");
      throw new Error("unexpected model");
    } } },
  };

  await withServer(createApp(client), async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Give me a quick answer in one line." }] }),
    });
    const events = await eventsFrom(response);
    assert.equal(events.find((event) => event.model)?.model, SMALL_MODEL);
    assert.equal(events.find((event) => event.agentTask)?.agentTask, "fast_worker");
    assert.match(events.find((event) => event.notice)?.notice.message ?? "", /preferred Gemini 3\.1\/3\.5 Flash-Lite model is not available/);
    assert.equal(events.filter((event) => event.content).map((event) => event.content).join(""), "Fast worker fallback answer.");
  });
});

test("Agent rejects image work when no catalog-verified vision provider is configured", async () => {
  let generationCalls = 0;
  const client = {
    models: { list: async () => ({ data: catalog }) },
    chat: { completions: { create: async () => { generationCalls++; return textStream("must not run"); } } },
  };

  await withServer(createApp(client), async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Describe the image." }],
        image: {
          mimeType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLKrQAAAABJRU5ErkJggg==",
        },
      }),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /no Gemini vision credential/);
  });
  assert.equal(generationCalls, 0);
});
