import type { AgentChatInput, AgentProjectFile, AgentToolExchange } from "@workspace/api-zod";

export function isAppliedProject(exchange: AgentToolExchange): boolean {
  return exchange.tool === "write_project" &&
    !exchange.result.startsWith("Project update was not applied;");
}

/** Reconstruct source exactly; never shorten a file or mutate saved history. */
export function currentAgentFiles(input: AgentChatInput): AgentProjectFile[] {
  const files = new Map<string, AgentProjectFile>();
  for (const exchange of input.agentHistory ?? []) {
    if (isAppliedProject(exchange) && "files" in exchange.arguments) {
      for (const file of exchange.arguments.files ?? []) files.set(file.path, { ...file });
    }
  }
  for (const file of input.projectFiles ?? []) files.set(file.path, { ...file });
  return [...files.values()];
}

/**
 * Request-only recovery for HTTP 413. Keep the latest complete tool exchange
 * per tool/runtime and a complete current file snapshot instead of old versions.
 */
export function compactAgentContext(input: AgentChatInput): AgentChatInput {
  const history = input.agentHistory ?? [];
  const latest = new Map<string, number>();
  let applied = -1;
  history.forEach((exchange, index) => {
    const key = exchange.tool === "run_code"
      ? `${exchange.tool}:${exchange.arguments.language}` : exchange.tool;
    latest.set(key, index);
    if (isAppliedProject(exchange)) applied = index;
  });
  const retained = new Set(latest.values());
  // Preserve the last applied update as well as a later rejected update.
  if (applied >= 0) retained.add(applied);
  return {
    ...input,
    messages: input.messages.slice(-1),
    projectFiles: currentAgentFiles(input),
    agentHistory: history.filter((_, index) => retained.has(index)),
  };
}
