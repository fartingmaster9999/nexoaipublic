import test from "node:test";
import assert from "node:assert/strict";
import { agentBuildPolicy } from "../src/lib/agent-build-policy.ts";
import { buildGroqAgentRequest } from "../src/lib/groq-agent.ts";
import { formatInteractionResult } from "../../ai-chat/src/lib/preview-interactions.ts";

const input = (content, extras = {}) => ({ messages: [{ role: "user", content }], ...extras });
const run = (result) => ({
  tool: "write_project", callId: "build", thoughtSignature: "groq-agent-v1",
  arguments: { entrypoint: "index.html", files: [{ path: "index.html", content: "<h1>App</h1>" }] },
  result,
});

test("explicit app requests require action rather than a Markdown implementation", () => {
  for (const prompt of ["Build a task list app", "Create a website for my cafe", "Could you make a calculator app?"]) {
    assert.equal(agentBuildPolicy(input(prompt)).requireTool, true);
    assert.equal(buildGroqAgentRequest(input(prompt)).tool_choice, "required");
  }
});

test("discussion and explanations do not trigger automatic code execution", () => {
  for (const prompt of ["How do I build an app?", "Explain this program", "Plan a website"]) {
    assert.equal(agentBuildPolicy(input(prompt)).requireTool, false);
  }
});

test("editing shared project source requires applying the change", () => {
  assert.equal(agentBuildPolicy(input("Add a dark mode", {
    projectFiles: [{ path: "index.html", content: "<h1>Hello</h1>" }],
  })).requireTool, true);
});

test("execution failures require repair, but a later successful run ends the repair requirement", () => {
  const failed = run("Nexo execution status: failed.\nRuntime diagnostics: script error");
  assert.equal(agentBuildPolicy(input("Build an app", { agentHistory: [failed] })).requireTool, true);
  assert.equal(agentBuildPolicy(input("Build an app", { agentHistory: [
    failed, { ...run("Nexo execution status: completed."), callId: "repair" },
  ] })).requireTool, false);
});

test("old failed-run results and rejected project updates still trigger repairs", () => {
  for (const result of ["Execution error: SyntaxError", "Project update was not applied; invalid asset."]) {
    assert.equal(agentBuildPolicy(input("Build a website", { agentHistory: [run(result)] })).failed, true);
  }
});

test("budget exhaustion disables tools even when the implementation is unfinished", () => {
  const request = buildGroqAgentRequest(input("Create a website"), new Date(), false);
  assert.equal(request.tool_choice, "none");
  assert.equal(request.tools, undefined);
});

test("a failed local interaction forces a focused Qwen repair with no additional permissions", () => {
  const outcome = formatInteractionResult({ status: "complete", steps: [
    { step: 1, action: "click", reason: "ok" },
    { step: 2, action: "assertText", reason: "mismatch" },
  ] });
  const failedInput = input("Build a counter app", {
    agentHistory: [run(`Nexo execution status: failed.\n${outcome}`)],
  });
  assert.equal(agentBuildPolicy(failedInput).requireTool, true);
  const request = buildGroqAgentRequest(failedInput);
  assert.equal(request.tool_choice, "required");
  const context = JSON.stringify(request.messages);
  assert.match(context, /Step 2 assertText: assertion did not match/);
  assert.match(context, /Repair the observed defect/);
  assert.match(context, /nexo-interaction-checks/);
  assert.match(context, /no network, cookies, credentials, storage access, arbitrary JavaScript/i);
  assert.match(request.model, /qwen/i);
});
