import test from "node:test";
import assert from "node:assert/strict";
import { compactAgentContext } from "../src/lib/agent-request-context.ts";
import { buildGroqAgentRequest } from "../src/lib/groq-agent.ts";

function project(callId, files, result = "HTML preview loaded without runtime errors.") {
  return { tool: "write_project", callId, thoughtSignature: "groq-agent-v1",
    arguments: { entrypoint: "index.html", files }, result };
}
const page = { path: "index.html", content: "<h1>Latest working page</h1>" };
const style = { path: "styles.css", content: "body { color: navy; }\n" };

test("request compaction preserves current files and complete latest results without mutating saved input", () => {
  const input = {
    messages: [
      { role: "user", content: "An older request" },
      { role: "assistant", content: "An older answer" },
      { role: "user", content: "Add a functional filter; keep every existing feature." },
    ],
    projectFiles: [page, style],
    agentHistory: [
      project("initial", [{ path: "index.html", content: "OLD SOURCE" }, style], "Old runtime result"),
      project("latest", [page], "Latest runtime output and Gemma findings must remain intact."),
    ],
  };
  const before = JSON.stringify(input);
  const compacted = compactAgentContext(input);
  assert.deepEqual(compacted.projectFiles, [page, style]);
  assert.deepEqual(compacted.messages, [input.messages.at(-1)]);
  assert.deepEqual(compacted.agentHistory, [input.agentHistory.at(-1)]);
  const request = buildGroqAgentRequest(input, new Date(), true, undefined, undefined, "Optional planning brief", true);
  const serialized = JSON.stringify(request);
  assert.equal(serialized.includes("OLD SOURCE"), false);
  assert.equal(serialized.includes("Optional planning brief"), false);
  assert.equal(serialized.split("Latest working page").length - 1, 1);
  assert.equal(serialized.split("color: navy").length - 1, 1);
  assert.match(serialized, /Latest runtime output and Gemma findings must remain intact/);
  assert.equal(JSON.stringify(input), before);
});

test("normal requests deduplicate selected files across every applied update, not just the last one", () => {
  const request = buildGroqAgentRequest({
    messages: [{ role: "user", content: "Finish this website" }],
    projectFiles: [page, style],
    agentHistory: [project("initial", [page, style]), project("changed", [page])],
  });
  const user = request.messages.find((message) => message.role === "user");
  assert.equal(user.content, "Finish this website");
});

test("compaction retains rejected update evidence without applying rejected source to the snapshot", () => {
  const good = project("good", [page, style]);
  const failed = project("rejected", [{ path: "index.html", content: "BROKEN" }],
    "Project update was not applied; the existing files and preview were preserved.");
  const compacted = compactAgentContext({
    messages: [{ role: "user", content: "Repair the update" }],
    agentHistory: [good, failed],
  });
  assert.deepEqual(compacted.projectFiles, [page, style]);
  assert.deepEqual(compacted.agentHistory, [good, failed]);
});

test("compaction keeps the latest complete execution per language and latest search result", () => {
  const run = (id, language) => ({
    tool: "run_code", callId: id, thoughtSignature: "groq-agent-v1",
    arguments: { language, code: id }, result: `output ${id}`,
  });
  const history = [run("old-js", "javascript"), run("python", "python"), run("new-js", "javascript"), {
    tool: "web_search", callId: "search", thoughtSignature: "groq-agent-v1",
    arguments: { query: "specific changing fact" }, result: "Relevant search findings",
  }];
  const compacted = compactAgentContext({
    messages: [{ role: "user", content: "Finish" }], agentHistory: history,
  });
  assert.deepEqual(compacted.agentHistory, history.slice(1));
});
