import test from "node:test";
import assert from "node:assert/strict";
import { buildChatRequest, isValidTimeZone, boundedHistory } from "../src/lib/chat-request.ts";
import { extractSearchSources } from "../src/lib/search-activity.ts";
import { needsWebSearch, isCodingRequest, buildSearchQuery } from "../src/lib/chat-policy.ts";
import { chooseModels, openModelStream, USAGE_LIMIT_MESSAGE, PRIMARY_MODEL, SMALL_MODEL, CODING_FALLBACK, markRateLimited, isCoolingDown, rateLimitDiagnostics } from "../src/lib/model-routing.ts";
import { modelsForRequest, recordRateLimit, clearRateLimit, shortProviderRetryDelay } from "../src/lib/model-routing.ts";

const messages = [{ role: "user", content: "What is 17 times 19?" }];

test("normal chat always uses Groq GPT-OSS 120B with medium effort", () => {
  const result = buildChatRequest({ messages });
  assert.equal(result.model, "openai/gpt-oss-120b");
  assert.equal(result.reasoning_effort, "medium");
  assert.equal(result.include_reasoning, true);
  assert.equal(result.stream, true);
  assert.deepEqual(result.messages.at(-1), messages[0]);
});

test("Deepthink raises effort to high without changing provider or model", () => {
  const result = buildChatRequest({ messages, deepthink: true });
  assert.equal(result.reasoning_effort, "high");
  assert.equal(result.model, "openai/gpt-oss-120b");
  assert.equal(result.include_reasoning, true);
  assert.ok(result.max_completion_tokens >= 8192);
});

test("explicitly disabling Deepthink restores medium effort", () => {
  assert.equal(buildChatRequest({ messages, deepthink: false }).reasoning_effort, "medium");
});

test("caller model and effort overrides are ignored and history is unmodified", () => {
  const original = structuredClone(messages);
  const result = buildChatRequest({ messages, model: "other", reasoning_effort: "low" });
  assert.equal(result.model, "openai/gpt-oss-120b");
  assert.equal(result.reasoning_effort, "medium");
  assert.deepEqual(messages, original);
});

test("Groq browser tools stay disabled while provider-exposed reasoning is requested", () => {
  const result = buildChatRequest({ messages });
  assert.equal(result.tools, undefined);
  assert.equal(result.tool_choice, "none");
  assert.equal(result.include_reasoning, true);
});

test("coding instructions require imports and describe packages as on demand", () => {
  const request = buildChatRequest({ messages }, new Date(), { coding: true });
  assert.match(request.messages[0].content, /load only when imported/);
  assert.match(request.messages[0].content, /NumPy, SciPy, Matplotlib, pandas and SymPy load only when imported/);
  assert.match(request.messages[0].content, /Import every library explicitly in Python/);
  assert.match(request.messages[0].content, /Nexo's browser-based IDE/);
  assert.match(request.messages[0].content, /Do not assume Windows, PowerShell, shell access, persistent local files or arbitrary installed packages/);
  assert.match(request.messages[0].content, /Do not add comments unless requested/);
  assert.match(request.messages[0].content, /preserve its existing comments/);
  assert.match(request.messages[0].content, /Keep explanations brief and outside fenced code/);
  assert.match(request.messages[0].content, /Never claim generated code was executed or tested unless actual execution results/);
});

test("answer instructions use Markdown math delimiters and preserve code", () => {
  const prompt = buildChatRequest({ messages }).messages[0].content;
  assert.ok(prompt.includes("$...$"), "Inline math should use Markdown delimiters.");
  assert.ok(prompt.includes("$$...$$"), "Display math should use Markdown delimiters.");
  assert.ok(prompt.includes("\\(...\\)"));
  assert.ok(prompt.includes("\\[...\\]"));
  assert.match(prompt, /Keep math delimiters out of code and preserve literal code exactly/);
});

test("inline widget contract is selective, Groq-only and disabled for explicit runnable code", () => {
  const prompt = (content) => buildChatRequest({ messages: [{ role: 'user', content }] }).messages[0].content;
  for (const content of ['Quiz me on biology', 'Quiz me on Python', 'Plot y = x squared', 'Graph the supplied data']) {
    assert.match(prompt(content), /nexo-widget/);
    assert.match(prompt(content), /never invented URLs or unsourced measurements/);
  }
  for (const content of ['Hello', 'Explain ATP', 'Write Python code to plot a sine wave']) assert.doesNotMatch(prompt(content), /nexo-widget/);
  const result = buildChatRequest({ messages: [{ role: 'user', content: 'Graph sin function' }] }, new Date(), { coding: true });
  assert.match(result.messages[0].content, /nexo-widget/);
  assert.doesNotMatch(result.messages[0].content, /For coding requests, provide complete runnable code/);
  assert.equal(result.model, 'openai/gpt-oss-120b');
});

test("fresh UTC and local clock context comes from the server, not model memory", () => {
  const now = new Date("2026-11-02T18:30:00Z");
  const result = buildChatRequest({ messages, timeZone: "America/Chicago" }, now);
  assert.match(result.messages[0].content, /2026-11-02T18:30:00.000Z/);
  assert.match(result.messages[0].content, /America\/Chicago/);
  assert.match(result.messages[0].content, /12:30:00 PM/);
  assert.equal(isValidTimeZone("America/Chicago"), true);
  assert.equal(isValidTimeZone("not/a/timezone"), false);
});

test("failed web retrieval is disclosed and cannot be represented as verified current facts", () => {
  const result = buildChatRequest({ messages }, new Date("2026-11-04T12:00:00Z"), { searchFailed: true });
  assert.match(result.messages[0].content, /External web search failed for this request/);
  assert.match(result.messages[0].content, /Tell the user you could not verify the current information/);
  assert.match(result.messages[0].content, /Do not invent recent facts or sources/);
});

test("public sources are deduplicated and unsafe links rejected", () => {
  assert.deepEqual(extractSearchSources([{
    type: "browser_search",
    browser_results: [
      { url: "https://www.nasa.gov/news/", title: "NASA News" },
      { url: "javascript:alert(1)", title: "bad" },
      { url: "https://password:secret@example.com/", title: "bad" },
    ],
    search_results: { results: [{ url: "https://www.nasa.gov/news/", title: "NASA News" }] },
  }]), [{ url: "https://www.nasa.gov/news/", title: "NASA News" }]);
});

test("search is selective, honors the 2024 policy and does not waste searches on clock or coding", () => {
  for (const prompt of ["Hi", "Explain Newton's laws", "Explain binary search", "Implement binary search in Python", "What happened in 1999?", "Search the web about the 1969 moon landing", "What is the current date and time?", "Write Python code to sort a list", "My current code has a bug"]) {
    assert.equal(needsWebSearch(prompt), false, prompt);
  }
  for (const prompt of ["What happened at the 2024 Olympics?", "Latest NASA news", "Who is the president of the USA?", "What is today's weather in Chicago?", "Latest Python version", "What is the current Python version?", "Newest NumPy release", "Search the web for Python numpy examples", "Look up JavaScript promises online", "Check online whether this Python library is maintained", "What is happening in Chicago right now?"]) {
    assert.equal(needsWebSearch(prompt), true, prompt);
  }
  assert.equal(isCodingRequest("Generate Python code using numpy"), true);
  assert.equal(isCodingRequest("Tell me a story"), false);
  assert.match(buildSearchQuery([{role:"user",content:"Weather in Chicago"}, {role:"assistant",content:"Sunny"}, {role:"user",content:"What about tomorrow?"}]), /Weather in Chicago/);
});

test("coding uses Qwen only while ordinary chat retains GPT-OSS fallbacks", () => {
  const ids = [PRIMARY_MODEL, SMALL_MODEL, CODING_FALLBACK];
  assert.deepEqual(chooseModels(ids, false), [PRIMARY_MODEL, SMALL_MODEL]);
  assert.deepEqual(chooseModels(ids, true), [CODING_FALLBACK]);
  assert.deepEqual(chooseModels([...ids,"qwen/example-coder"], true), [CODING_FALLBACK]);
  assert.deepEqual(chooseModels([PRIMARY_MODEL, SMALL_MODEL], true), []);
});

test("an actual 429 switches models once and emits a downgrade notice", async () => {
  const attempts = [], notices = [];
  const result = await openModelStream(["unit-primary","unit-fallback"], async model => {
    attempts.push(model);
    if (model === "unit-primary") throw {status:429};
    return "working-stream";
  }, model => notices.push(model));
  assert.deepEqual(attempts, ["unit-primary","unit-fallback"]);
  assert.deepEqual(notices, ["unit-fallback"]);
  assert.equal(result.model, "unit-fallback");
  assert.equal(result.stream, "working-stream");
});

test("a temporarily unavailable primary model falls back without pretending it was rate-limited", async () => {
  const attempts = [], fallbacks = [], notices = [];
  const result = await openModelStream(
    ["temporary-primary", "temporary-fallback"],
    async model => {
      attempts.push(model);
      if (model === "temporary-primary") throw { status: 503 };
      return "fallback-stream";
    },
    (model) => notices.push(model),
    undefined,
    (failed, next, status) => fallbacks.push({ failed, next, status }),
  );
  assert.deepEqual(attempts, ["temporary-primary", "temporary-fallback"]);
  assert.deepEqual(fallbacks, [{ failed: "temporary-primary", next: "temporary-fallback", status: 503 }]);
  assert.deepEqual(notices, ["temporary-fallback"]);
  assert.deepEqual(result, { model: "temporary-fallback", stream: "fallback-stream" });
});

test("only a model-not-found 404 can trigger model fallback; other client errors stay explicit", async () => {
  let calls = 0;
  const result = await openModelStream(
    ["missing-model", "available-model"],
    async (model) => {
      calls++;
      if (model === "missing-model") throw { status: 404, error: { code: "model_not_found" } };
      return "accepted";
    },
    () => {},
  );
  assert.equal(calls, 2);
  assert.equal(result.model, "available-model");
  await assert.rejects(
    openModelStream(["bad-request-a", "bad-request-b"], async () => { throw { status: 400 }; }, () => {}),
    (error) => error.status === 400,
  );
});

test("service failures are never mislabeled as exhausted model usage", async () => {
  const unavailable = { status: 503 };
  await assert.rejects(
    openModelStream(["unavailable-a", "unavailable-b"], async () => { throw unavailable; }, () => {}),
    (error) => error === unavailable,
  );
  const serviceError = { status: 502 };
  await assert.rejects(
    openModelStream(["mixed-quota", "mixed-service"], async (model) => {
      if (model === "mixed-quota") throw { status: 429 };
      throw serviceError;
    }, () => {}),
    (error) => error === serviceError,
  );
});

test("exhausting both models returns the exact requested usage message", async () => {
  await assert.rejects(openModelStream(["quota-a","quota-b"], async () => {throw {status:429};}, () => {}), {message:USAGE_LIMIT_MESSAGE});
  assert.equal(USAGE_LIMIT_MESSAGE, "You have reached your usage limits, please try again later");
});

test("cached cooldowns cannot alone declare every model exhausted", async () => {
  markRateLimited("cached-primary", "600");
  markRateLimited("cached-fallback", "120");
  try {
    assert.deepEqual(modelsForRequest(["cached-primary", "cached-fallback"]), ["cached-fallback"]);
    const attempts = [];
    const result = await openModelStream(["cached-primary", "cached-fallback"], async (model) => {
      attempts.push(model);
      return "live accepted";
    }, () => {});
    assert.deepEqual(attempts, ["cached-fallback"]);
    assert.equal(result.stream, "live accepted");
    assert.equal(isCoolingDown("cached-fallback"), false);
  } finally {
    clearRateLimit("cached-primary");
    clearRateLimit("cached-fallback");
  }
});

test("request-size rejections report safe counters without poisoning smaller requests", () => {
  const error = {
    status: 429,
    error: { error: { message: "Rate limit reached for PRIVATE_ORG on tokens per minute (TPM): Limit 6,000, Used 0, Requested 8,200. PRIVATE_CREDENTIAL" } },
    headers: new Headers({ "retry-after": "900" }),
  };
  markRateLimited("oversize-request-test", "900");
  const diagnostics = recordRateLimit("oversize-request-test", error);
  assert.equal(diagnostics.metric, "TPM");
  assert.equal(diagnostics.quotaLimit, 6000);
  assert.equal(diagnostics.quotaUsed, 0);
  assert.equal(diagnostics.quotaRequested, 8200);
  assert.equal(diagnostics.requestTooLarge, true);
  assert.equal(isCoolingDown("oversize-request-test"), false);
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE/);
});

test("missing model access is not reported as usage exhaustion", async () => {
  await assert.rejects(openModelStream([], async () => "never", () => {}), /No compatible model/);
});

test("provider wait accepts short explicit windows but never invents a long quota reset", () => {
  assert.equal(shortProviderRetryDelay("14"), 14250);
  assert.equal(shortProviderRetryDelay("60"), 60250);
  assert.equal(shortProviderRetryDelay("61"), undefined);
  assert.equal(shortProviderRetryDelay(null), undefined);
  assert.equal(shortProviderRetryDelay("invalid"), undefined);
  assert.equal(shortProviderRetryDelay("-1"), undefined);
  assert.equal(shortProviderRetryDelay("3600"), undefined);
  const now = Date.parse("2026-11-08T00:00:00Z");
  assert.equal(shortProviderRetryDelay("Sun, 08 Nov 2026 00:00:15 GMT", now), 15250);
});
test("authorization errors are not incorrectly treated as usage limits", async () => {
  let attempts = 0;
  await assert.rejects(openModelStream(["auth-a","auth-b"], async () => {attempts++;throw Object.assign(new Error("Denied"),{status:401});}, () => {}));
  assert.equal(attempts, 1);
});

test("cooldowns honor short retry-after values without an artificial minimum", () => {
  const original = Date.now;
  let clock = 100000;
  Date.now = () => clock;
  try {
    markRateLimited("short-window", "0.5");
    assert.equal(isCoolingDown("short-window"), true);
    clock += 501;
    assert.equal(isCoolingDown("short-window"), false);
    markRateLimited("missing-window");
    clock += 1001;
    assert.equal(isCoolingDown("missing-window"), false);
    markRateLimited("date-window", new Date(clock + 3000).toUTCString());
    clock += 3001;
    assert.equal(isCoolingDown("date-window"), false);
    markRateLimited("daily-token-window", "1147");
    clock += 301000;
    assert.equal(isCoolingDown("daily-token-window"), true);
    clock += 847000;
    assert.equal(isCoolingDown("daily-token-window"), false);
  } finally { Date.now = original; }
});

test("quota diagnostics identify token limits without copying provider bodies", async () => {
  const error = {status:429, headers:new Headers({"retry-after":"0.5","x-ratelimit-remaining-requests":"990"}),
    error:{error:{message:"Rate limit on tokens per minute (TPM). PRIVATE PROMPT"}}};
  const attempts = [];
  await openModelStream(["diagnostic-a","diagnostic-b"], async model => {
    if(model === "diagnostic-a") throw error;
    return "ok";
  }, () => {}, (model, quota) => attempts.push({model,...quota}));
  assert.equal(attempts[0].metric, "TPM");
  assert.equal(attempts[0].remainingRequests, "990");
  assert.equal(JSON.stringify(rateLimitDiagnostics(error)).includes("PRIVATE"), false);
});

test("a failed fallback never claims a lighter model is answering", async () => {
  const notices = [];
  await assert.rejects(openModelStream(["failed-notice-a", "failed-notice-b"],
    async () => { throw {status:429}; }, model => notices.push(model)), {message:USAGE_LIMIT_MESSAGE});
  assert.deepEqual(notices, []);
});

test("a successful fallback is announced only after its stream is accepted", async () => {
  const events = [];
  await openModelStream(["ordered-a", "ordered-b"], async model => {
    events.push(`attempt:${model}`);
    if (model === "ordered-a") throw {status:429};
    events.push("accepted");
    return "stream";
  }, model => events.push(`notice:${model}`));
  assert.deepEqual(events, ["attempt:ordered-a","attempt:ordered-b","accepted","notice:ordered-b"]);
});

test("Qwen coding fallback returns reasoning separately using its supported parsed format", () => {
  const result = buildChatRequest({messages,deepthink:true},new Date(),{model:CODING_FALLBACK,coding:true});
  assert.equal(result.model,CODING_FALLBACK);
  assert.equal(result.reasoning_format,"parsed");
  assert.equal(result.include_reasoning,undefined);
  assert.equal(result.tools,undefined);
  assert.match(result.messages[0].content,/NumPy/);
});

test("only API context is bounded; the newest message is retained and input history unmodified", () => {
  const history = Array.from({length:20},(_,i)=>({role:i%2?"user":"assistant",content:String(i).repeat(2000)}));
  const original = structuredClone(history);
  const bounded = boundedHistory(history,16000);
  assert.ok(bounded.reduce((n,m)=>n+m.content.length,0)<=16000);
  assert.deepEqual(bounded.at(-1),history.at(-1));
  assert.deepEqual(history,original);
});
