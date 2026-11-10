import test from "node:test";
import assert from "node:assert/strict";
import {
  agentGenerationModelIds,
  agentSecurityModelIds,
  availableModels,
  classifyAgentTask,
  CODING_FALLBACK,
  GEMINI_AGENT_FALLBACK_MODEL,
  GEMINI_AGENT_PRIMARY_MODEL,
  LLAMA_CLASSIFIER_MODEL,
  LLAMA_SYNTHESIS_MODEL,
  PRIMARY_MODEL,
  PROMPT_GUARD_MODEL,
  routeGeminiAgentTask,
  routeAgentTask,
  SAFEGUARD_MODEL,
  SMALL_MODEL,
} from "../src/lib/model-routing.ts";

test("Agent classifies work into task capabilities before selecting a model", () => {
  assert.equal(classifyAgentTask({ messages: [{ role: "user", content: "Build and debug a Python script." }] }), "coding");
  assert.equal(classifyAgentTask({ messages: [{ role: "user", content: "Make a long-term strategy and plan." }] }), "planning");
  assert.equal(classifyAgentTask({ messages: [{ role: "user", content: "Summarize this in one sentence." }] }), "classification");
  assert.equal(classifyAgentTask({ messages: [{ role: "user", content: "Compare these research findings." }] }), "synthesis");
  assert.equal(classifyAgentTask({ messages: [{ role: "user", content: "Explain how rainbows form." }] }), "reasoning");
  assert.equal(classifyAgentTask({ messages: [{ role: "user", content: "Explain this." }], image: {} }), "multimodal");
});

test("Agent chooses only catalog-listed task models and identifies compatible fallbacks", () => {
  const ids = [PRIMARY_MODEL, SMALL_MODEL, CODING_FALLBACK];
  assert.deepEqual(routeAgentTask("planning", ids).models, [PRIMARY_MODEL, SMALL_MODEL, CODING_FALLBACK]);
  assert.equal(routeAgentTask("planning", ids).fallback, false);
  assert.deepEqual(routeAgentTask("coding", ids).models, [CODING_FALLBACK]);
  assert.equal(routeAgentTask("coding", ids).fallback, false);
  assert.deepEqual(routeAgentTask("coding", [PRIMARY_MODEL, SMALL_MODEL]).models, []);
  assert.equal(classifyAgentTask({ messages: [{ role: "user", content: "Make me a task list app" }] }), "coding");
  assert.equal(classifyAgentTask({ messages: [{ role: "user", content: "Make a website for my club" }] }), "coding");
  assert.equal(classifyAgentTask({ messages: [{ role: "user", content: "Write a React component" }] }), "coding");
  assert.equal(classifyAgentTask({ messages: [
    { role: "user", content: "Build a task list app" },
    { role: "assistant", content: "The preview is ready." },
    { role: "user", content: "Add a filter to show only unfinished tasks" },
  ] }), "coding");
  assert.equal(classifyAgentTask({ messages: [{ role: "user", content: "Finish checking it" }],
    agentHistory: [{ tool: "write_project" }],
  }), "coding");
  assert.equal(classifyAgentTask({ messages: [{ role: "user", content: "Create\n a task list app" }] }), "coding");

  const onlyQwen = routeAgentTask("classification", [CODING_FALLBACK]);
  assert.deepEqual(onlyQwen.models, [CODING_FALLBACK]);
  assert.equal(onlyQwen.fallback, true);
  assert.equal(onlyQwen.preferredLabel, "Llama 3.1 8B");

  const fastFallback = routeAgentTask("fast_worker", [SMALL_MODEL]);
  assert.deepEqual(fastFallback.models, [SMALL_MODEL]);
  assert.equal(fastFallback.fallback, true);
  assert.deepEqual(routeAgentTask("multimodal", ids).models, []);
});

test("Gemini specialist routes require exact live-catalog IDs and fall back explicitly", () => {
  const fast = routeGeminiAgentTask("fast_worker", [
    "gemini-3.1-flash-lite",
    GEMINI_AGENT_PRIMARY_MODEL,
  ]);
  assert.deepEqual(fast.models, ["gemini-3.1-flash-lite", GEMINI_AGENT_PRIMARY_MODEL]);
  assert.equal(fast.fallback, true);

  const document = routeGeminiAgentTask("document", [
    "gemma-4-31b-it",
    GEMINI_AGENT_PRIMARY_MODEL,
  ]);
  assert.deepEqual(document.models, ["gemma-4-31b-it", GEMINI_AGENT_PRIMARY_MODEL]);
  assert.equal(document.fallback, true);

  const multimodal = routeGeminiAgentTask("multimodal", [
    "gemma-4-31b-it",
    GEMINI_AGENT_FALLBACK_MODEL,
  ]);
  assert.deepEqual(multimodal.models, ["gemma-4-31b-it"]);
  assert.equal(routeGeminiAgentTask("fast_worker", []).unavailable, true);
});

test("Agent filters provider catalogs by context and output capacity", () => {
  const generation = agentGenerationModelIds([
    { id: PRIMARY_MODEL, context_window: 131072, max_completion_tokens: 65536 },
    { id: LLAMA_CLASSIFIER_MODEL, context_window: 4096, max_completion_tokens: 4096 },
    { id: LLAMA_SYNTHESIS_MODEL, context_window: 131072, max_completion_tokens: 8192 },
    { id: PROMPT_GUARD_MODEL, context_window: 512, max_completion_tokens: 512 },
  ]);
  assert.deepEqual(generation, [PRIMARY_MODEL, LLAMA_SYNTHESIS_MODEL]);
  assert.deepEqual(agentSecurityModelIds([
    { id: PROMPT_GUARD_MODEL, context_window: 512, max_completion_tokens: 512 },
    { id: SAFEGUARD_MODEL, context_window: 131072, max_completion_tokens: 512 },
  ]), [PROMPT_GUARD_MODEL, SAFEGUARD_MODEL]);
});

test("Failed provider discovery never invents supported model IDs", async () => {
  const ids = await availableModels({ models: { list: async () => { throw new Error("catalog unavailable"); } } });
  assert.deepEqual(ids, []);
});
