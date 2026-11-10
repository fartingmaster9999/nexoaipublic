import test from "node:test";
import assert from "node:assert/strict";
import {
  PROMPT_GUARD_MODEL,
  SAFEGUARD_MODEL,
} from "../src/lib/model-routing.ts";
import { reviewAgentTool, screenPromptInjection } from "../src/lib/agent-security.ts";

function mockGroq(contents) {
  const requests = [];
  return {
    requests,
    client: {
      chat: {
        completions: {
          create: async (request) => {
            requests.push(request);
            const content = contents[requests.length - 1];
            return { choices: [{ message: { content } }] };
          },
        },
      },
    },
  };
}

test("Prompt Guard scans bounded chunks and returns only a risk signal", async () => {
  const { client, requests } = mockGroq(["0.02", "0.98"]);
  const signal = await screenPromptInjection(
    client,
    [PROMPT_GUARD_MODEL],
    "a".repeat(1600),
    new AbortController().signal,
  );
  assert.equal(signal, "flagged");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => request.messages.length), [1, 1]);
  assert.ok(requests.every((request) => request.messages[0].role === "user"));
  assert.equal(requests[0].messages[0].content.length, 1500);
  assert.equal(requests[1].messages[0].content.length, 100);
});

test("Missing or malformed Prompt Guard results are not treated as a verdict", async () => {
  const { client, requests } = mockGroq(["not-a-score"]);
  assert.equal(await screenPromptInjection(client, [], "hello", new AbortController().signal), "unavailable");
  assert.equal(requests.length, 0);
  assert.equal(await screenPromptInjection(client, [PROMPT_GUARD_MODEL], "hello", new AbortController().signal), "unknown");
});

test("GPT-OSS Safeguard reviews bounded tool intent and reports a non-authoritative signal", async () => {
  const { client, requests } = mockGroq(['{"violation":1,"category":"boundary-bypass"}']);
  const signal = await reviewAgentTool(
    client,
    [SAFEGUARD_MODEL],
    "Please build a small browser example.",
    "run_code",
    { language: "javascript", code: "console.log('ok')" },
    new AbortController().signal,
  );
  assert.equal(signal, "flagged");
  assert.equal(requests.length, 1);
  assert.match(requests[0].messages[0].content, /signal only/);
  assert.match(requests[0].messages[1].content, /run_code/);
  assert.equal(requests[0].reasoning_effort, "low");
});

test("Safeguard failures remain visible as unavailable signals without bypassing tool validation", async () => {
  const client = {
    chat: { completions: { create: async () => { throw new Error("provider failure"); } } },
  };
  assert.equal(await reviewAgentTool(
    client,
    [SAFEGUARD_MODEL],
    "Search public release notes.",
    "web_search",
    { query: "release notes" },
    new AbortController().signal,
  ), "unavailable");
});
