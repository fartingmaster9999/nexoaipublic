import type Groq from "groq-sdk";
import { isCodingRequest } from "./chat-policy";

export const PRIMARY_MODEL = "openai/gpt-oss-120b";
export const SMALL_MODEL = "openai/gpt-oss-20b";
export const CODING_FALLBACK = "qwen/qwen3.8-27b";
export const PROMPT_GUARD_MODEL = "meta-llama/llama-prompt-guard-2-86m";
export const SAFEGUARD_MODEL = "openai/gpt-oss-safeguard-20b";
export const LLAMA_CLASSIFIER_MODEL = "meta-llama/llama-3.1-8b-instant";
export const LLAMA_SYNTHESIS_MODEL = "meta-llama/llama-3.3-70b-versatile";
export const GEMINI_AGENT_PRIMARY_MODEL = "gemini-3.8-flash";
export const GEMINI_AGENT_FALLBACK_MODEL = "gemini-3.6-flash";
export const USAGE_LIMIT_MESSAGE = "You have reached your usage limits, please try again later";
export const DOWNGRADE_MESSAGE = "The main model could not complete this reply. A compatible model is answering—you can keep chatting.";

export const AGENT_TASKS = [
  "coding",
  "planning",
  "reasoning",
  "fast_worker",
  "document",
  "synthesis",
  "classification",
  "multimodal",
] as const;
export type AgentTask = typeof AGENT_TASKS[number];

export type ProviderModel = {
  id: string;
  active?: boolean;
  context_window?: number;
  max_completion_tokens?: number;
  owned_by?: string;
};

const agentGenerationModels = new Set([
  PRIMARY_MODEL, SMALL_MODEL, CODING_FALLBACK, LLAMA_CLASSIFIER_MODEL, LLAMA_SYNTHESIS_MODEL,
]);

export function agentGenerationModelIds(models: ProviderModel[]): string[] {
  return models
    .filter((model) => agentGenerationModels.has(model.id) &&
      model.context_window !== undefined && model.context_window >= 8192 &&
      model.max_completion_tokens !== undefined && model.max_completion_tokens >= 8192)
    .map((model) => model.id);
}

export function agentSecurityModelIds(models: ProviderModel[]): string[] {
  return models.filter((model) => {
    if (model.id === PROMPT_GUARD_MODEL) {
      return model.context_window !== undefined && model.context_window >= 512 &&
        model.max_completion_tokens !== undefined && model.max_completion_tokens >= 8;
    }
    if (model.id === SAFEGUARD_MODEL) {
      return model.context_window !== undefined && model.context_window >= 8192 &&
        model.max_completion_tokens !== undefined && model.max_completion_tokens >= 512;
    }
    return false;
  }).map((model) => model.id);
}

export type AgentModelRoute = {
  task: AgentTask;
  models: string[];
  preferredModel?: string;
  preferredLabel: string;
  fallback: boolean;
  unavailable: boolean;
};

const geminiPreferredModels: Partial<Record<AgentTask, { models: string[]; label: string }>> = {
  fast_worker: {
    models: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", GEMINI_AGENT_PRIMARY_MODEL],
    label: "Gemini 3.5 Flash-Lite",
  },
  document: {
    models: ["gemma-4-26b-a4b-it", "gemma-4-31b-it", GEMINI_AGENT_PRIMARY_MODEL],
    label: "Gemma 4 26B A4B",
  },
  multimodal: {
    models: ["gemma-4-31b-it", GEMINI_AGENT_PRIMARY_MODEL],
    label: "Gemma 4 31B",
  },
};

const preferredModels: Record<AgentTask, { model?: string; label: string; models: string[] }> = {
  coding: {
    model: CODING_FALLBACK,
    label: "Qwen3.8 27B",
    models: [CODING_FALLBACK],
  },
  planning: {
    model: PRIMARY_MODEL,
    label: "GPT-OSS 120B",
    models: [PRIMARY_MODEL, SMALL_MODEL, CODING_FALLBACK],
  },
  reasoning: {
    model: SMALL_MODEL,
    label: "GPT-OSS 20B",
    models: [SMALL_MODEL, PRIMARY_MODEL, CODING_FALLBACK],
  },
  fast_worker: {
    label: "Gemini 3.1/3.5 Flash-Lite",
    models: [SMALL_MODEL, PRIMARY_MODEL, CODING_FALLBACK],
  },
  document: {
    label: "Gemma 4 specialist",
    models: [SMALL_MODEL, PRIMARY_MODEL, CODING_FALLBACK],
  },
  synthesis: {
    model: LLAMA_SYNTHESIS_MODEL,
    label: "Llama 3.3 70B",
    models: [LLAMA_SYNTHESIS_MODEL, PRIMARY_MODEL, SMALL_MODEL, CODING_FALLBACK],
  },
  classification: {
    model: LLAMA_CLASSIFIER_MODEL,
    label: "Llama 3.1 8B",
    models: [LLAMA_CLASSIFIER_MODEL, SMALL_MODEL, PRIMARY_MODEL, CODING_FALLBACK],
  },
  multimodal: {
    label: "Gemma 4 multimodal specialist",
    models: [],
  },
};

const catalogs = new Map<string, { models: ProviderModel[]; expires: number }>();
const catalogRequests = new Map<string, Promise<ProviderModel[]>>();
const cooldowns = new Map<string, number>();

export async function availableModelCatalog(client: Groq, scope = "default"): Promise<ProviderModel[]> {
  const cached = catalogs.get(scope);
  if (cached && cached.expires > Date.now()) return cached.models;
  const pending = catalogRequests.get(scope);
  if (pending) return pending;
  const request = (async () => {
    try {
      const result = await client.models.list({ timeout: 5000, maxRetries: 0 });
      const models = result.data
        .filter((model) => typeof model.id === "string" && model.id.length > 0)
        .map((model) => model as ProviderModel)
        .filter((model) => model.active !== false);
      catalogs.set(scope, { models, expires: Date.now() + 600000 });
      return models;
    } catch {
      // A previously observed catalog may be used briefly during provider discovery outages.
      // Never invent models that the configured account has not returned.
      const models = catalogs.get(scope)?.models ?? [];
      catalogs.set(scope, { models, expires: Date.now() + 30000 });
      return models;
    }
  })();
  catalogRequests.set(scope, request);
  try { return await request; } finally {
    if (catalogRequests.get(scope) === request) catalogRequests.delete(scope);
  }
}

export async function availableModels(client: Groq, scope = "default"): Promise<string[]> {
  return (await availableModelCatalog(client, scope)).map((model) => model.id);
}

export function classifyAgentTask(input: {
  messages: Array<{ role: string; content: string }>;
  deepthink?: boolean;
  image?: unknown;
  projectFiles?: unknown[];
  agentHistory?: Array<{ tool: string }>;
}): AgentTask {
  if (input.image) return "multimodal";
  const prompt = input.messages.at(-1)?.content.toLowerCase() ?? "";
  const recentCodingIntent = input.messages.filter((message) => message.role === "user").slice(-6)
    .some((message) => isCodingRequest(message.content));
  if (input.projectFiles?.length || recentCodingIntent ||
      input.agentHistory?.some((exchange) => exchange.tool === "write_project") ||
      /\b(bug|build|implement|test|refactor|run)\b/i.test(prompt)) {
    return "coding";
  }
  if (/\b(document|pdf|report|spreadsheet|contract|attachment|file)\b/i.test(prompt)) return "document";
  if (/\b(classify|categorize|label|brief|short summary|one sentence)\b/i.test(prompt)) return "classification";
  if (/\b(synthesize|compare|research|multiple sources|literature review|comprehensive synthesis)\b/i.test(prompt)) return "synthesis";
  if (/\b(plan|planning|roadmap|strategy|complex|tradeoffs|deep analysis)\b/i.test(prompt)) return "planning";
  if (input.deepthink) return "planning";
  if (/\b(quickly|quick answer|fast|in one line)\b/i.test(prompt)) return "fast_worker";
  return "reasoning";
}

export function routeAgentTask(task: AgentTask, ids: string[]): AgentModelRoute {
  const preferred = preferredModels[task];
  const available = new Set(ids);
  const models = preferred.models.filter((model) => available.has(model));
  const preferredAvailable = preferred.model ? available.has(preferred.model) : false;
  return {
    task,
    models,
    ...(preferred.model ? { preferredModel: preferred.model } : {}),
    preferredLabel: preferred.label,
    fallback: !preferredAvailable,
    unavailable: models.length === 0,
  };
}

export function routeGeminiAgentTask(task: AgentTask, ids: string[]): AgentModelRoute {
  const preferred = geminiPreferredModels[task] ?? {
    models: [GEMINI_AGENT_PRIMARY_MODEL, GEMINI_AGENT_FALLBACK_MODEL],
    label: "Gemini Agent model",
  };
  const available = new Set(ids);
  const models = preferred.models.filter((model) => available.has(model));
  return {
    task,
    models,
    preferredModel: preferred.models[0],
    preferredLabel: preferred.label,
    fallback: !available.has(preferred.models[0]!),
    unavailable: models.length === 0,
  };
}

export function isAgentTask(value: unknown): value is AgentTask {
  return typeof value === "string" && (AGENT_TASKS as readonly string[]).includes(value);
}

export function agentTaskLabel(task: AgentTask): string {
  const labels: Record<AgentTask, string> = {
    coding: "Coding and debugging",
    planning: "Complex planning",
    reasoning: "General reasoning",
    fast_worker: "Fast worker",
    document: "Document specialist",
    synthesis: "Research synthesis",
    classification: "Lightweight classification",
    multimodal: "Image and multimodal analysis",
  };
  return labels[task];
}

export function modelLabel(model: string): string {
  const labels: Record<string, string> = {
    [PRIMARY_MODEL]: "GPT-OSS 120B",
    [SMALL_MODEL]: "GPT-OSS 20B",
    [CODING_FALLBACK]: "Qwen3.8 27B",
    [PROMPT_GUARD_MODEL]: "Prompt Guard 2",
    [SAFEGUARD_MODEL]: "GPT-OSS Safeguard 20B",
    [LLAMA_CLASSIFIER_MODEL]: "Llama 3.1 8B",
    [LLAMA_SYNTHESIS_MODEL]: "Llama 3.3 70B",
    "gemini-3.5-flash-lite": "Gemini 3.5 Flash-Lite",
    "gemini-3.1-flash-lite": "Gemini 3.1 Flash-Lite",
    "gemma-4-31b-it": "Gemma 4 31B",
    "gemma-4-26b-a4b-it": "Gemma 4 26B A4B",
    [GEMINI_AGENT_PRIMARY_MODEL]: "Gemini 3.8 Flash",
    [GEMINI_AGENT_FALLBACK_MODEL]: "Gemini 3.6 Flash",
  };
  return labels[model] ?? model;
}

export function chooseModels(ids: string[], coding: boolean): string[] {
  return (coding ? [CODING_FALLBACK] : [PRIMARY_MODEL, SMALL_MODEL]).filter((id) => ids.includes(id));
}

function scopedModel(scope: string, model: string): string {
  return `${scope}\u0000${model}`;
}

export function isCoolingDown(model: string, scope = "default"): boolean {
  return (cooldowns.get(scopedModel(scope, model)) ?? 0) > Date.now();
}

/**
 * Cooldowns are a routing hint, not proof that a new request will be rejected.
 * If every candidate is cached, recheck just the earliest one, once per request.
 */
export function modelsForRequest(models: string[], scope = "default"): string[] {
  const ready = models.filter((model) => !isCoolingDown(model, scope));
  if (ready.length || !models.length) return ready;
  return [[...models].sort((a, b) =>
    (cooldowns.get(scopedModel(scope, a)) ?? 0) - (cooldowns.get(scopedModel(scope, b)) ?? 0),
  )[0]!];
}

export function clearRateLimit(model: string, scope = "default"): void {
  cooldowns.delete(scopedModel(scope, model));
}

/** Honor only explicit, short retry windows; never guess a daily quota reset. */
export function shortProviderRetryDelay(retryAfter: string | null, now = Date.now()): number | undefined {
  if (!retryAfter?.trim()) return undefined;
  const seconds = Number(retryAfter);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
  return Number.isFinite(delay) && delay >= 0 && delay <= 60_000 ? Math.ceil(delay) + 250 : undefined;
}

export function markRateLimited(model: string, retryAfter?: string | null, scope = "default"): void {
  const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN;
  const dateDelay = retryAfter && !Number.isFinite(seconds)
    ? (Date.parse(retryAfter) - Date.now()) / 1000 : NaN;
  const delay = Number.isFinite(seconds) ? seconds : Number.isFinite(dateDelay) ? dateDelay : 1;
  // Honor short provider retry windows instead of inventing a 15–60 second lockout.
  cooldowns.set(scopedModel(scope, model), Date.now() + Math.min(86400, Math.max(0, delay)) * 1000);
}

/** Only allowlisted quota metadata; never log upstream bodies, prompts or credentials. */
export function rateLimitDiagnostics(error: unknown) {
  const candidate = error as { headers?: Headers; error?: { error?: { message?: string }; message?: string } };
  const raw = candidate?.error?.error?.message ?? candidate?.error?.message;
  const message = typeof raw === "string" ? raw.slice(0, 4000) : "";
  const metric = /\b(TPM|TPD|RPM|RPD|ITPM|OTPM)\b/i.exec(message)?.[1]?.toUpperCase();
  const counter = (name: string): number | null => {
    const text = new RegExp(`\\b${name}\\s*:?\\s*([\\d,]+(?:\\.\\d+)?)`, "i").exec(message)?.[1];
    const value = text ? Number(text.replace(/,/g, "")) : NaN;
    return Number.isFinite(value) && value >= 0 && value <= 1e12 ? value : null;
  };
  const quotaLimit = counter("Limit");
  const quotaUsed = counter("Used");
  const quotaRequested = counter("Requested");
  const requestTooLarge = /request too large/i.test(message) ||
    (metric !== undefined && /^(?:TPM|TPD|ITPM|OTPM)$/.test(metric) &&
      quotaLimit !== null && quotaRequested !== null && quotaRequested > quotaLimit);
  // Some streamed Groq errors have no Retry-After header. Parse only the
  // provider's explicit duration, never forward its raw error text.
  const durationSeconds = (value: string | null): number | undefined => {
    if (!value || !/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(value)) return undefined;
    let seconds = 0;
    for (const part of value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
      seconds += Number(part[1]) * ({ ms: 0.001, s: 1, m: 60, h: 3600 }[part[2]!] ?? 0);
    }
    return Number.isFinite(seconds) && seconds <= 86400 ? seconds : undefined;
  };
  const bodyDelay = durationSeconds(/\btry again in\s+((?:\d+(?:\.\d+)?(?:ms|s|m|h))+)/i.exec(message)?.[1]?.toLowerCase() ?? null);
  const resetTokens = candidate?.headers?.get?.("x-ratelimit-reset-tokens") ?? null;
  const tokenDelay = metric && /^(?:TPM|ITPM|OTPM)$/.test(metric)
    ? durationSeconds(resetTokens) : undefined;
  const headerDelay = candidate?.headers?.get?.("retry-after") ?? null;
  const retryAfter = headerDelay ?? (bodyDelay !== undefined ? String(bodyDelay)
    : tokenDelay !== undefined ? String(tokenDelay) : null);
  return {
    metric: metric ?? "unknown",
    quotaLimit,
    quotaUsed,
    quotaRequested,
    requestTooLarge,
    retryAfter,
    remainingRequests: candidate?.headers?.get?.("x-ratelimit-remaining-requests") ?? null,
    remainingTokens: candidate?.headers?.get?.("x-ratelimit-remaining-tokens") ?? null,
    tokenLimit: candidate?.headers?.get?.("x-ratelimit-limit-tokens") ?? null,
    resetTokens,
  };
}

export function codingRateLimitMessage(error: unknown): string {
  const quota = rateLimitDiagnostics(error);
  const labels: Record<string, string> = {
    TPM: "tokens per minute", TPD: "tokens per day", ITPM: "input tokens per minute",
    OTPM: "output tokens per minute", RPM: "requests per minute", RPD: "requests per day",
  };
  const metric = labels[quota.metric];
  const counters = [
    quota.quotaLimit !== null ? `limit ${quota.quotaLimit}` : "",
    quota.quotaUsed !== null ? `used ${quota.quotaUsed}` : "",
    quota.quotaRequested !== null ? `requested ${quota.quotaRequested}` : "",
  ].filter(Boolean).join(", ");
  const detail = metric ? `Groq reported ${metric}${counters ? ` (${counters})` : ""}.`
    : "Groq did not identify the quota in its response; this does not prove your daily requests are exhausted.";
  const delay = quota.retryAfter !== null ? Number(quota.retryAfter) : NaN;
  const nextStep = quota.requestTooLarge
    ? "This request exceeds the reported allowance; waiting alone may not help. Try a smaller project change."
    : Number.isFinite(delay) && delay >= 0 && delay <= 86400
      ? `Retry after at least ${Math.max(1, Math.ceil(delay))} seconds.`
      : "Retry after the provider window.";
  return `Qwen rejected this coding request with HTTP 429. ${detail} ${nextStep} This rejection did not change any existing workspace files. Nexo has not switched your code to GPT-OSS.`;
}

export function recordRateLimit(model: string, error: unknown, scope = "default") {
  const diagnostics = rateLimitDiagnostics(error);
  // A request that cannot fit is not evidence that a smaller request must wait.
  if (!diagnostics.requestTooLarge) markRateLimited(model, diagnostics.retryAfter, scope);
  else clearRateLimit(model, scope);
  return diagnostics;
}

const outputBudgets = new Map<string, { tokens: number; expires: number }>();

/** Learn only from an explicit provider output-token allowance, never from request counts. */
export function reduceOutputBudget(model: string, error: unknown, scope = "default"): number | undefined {
  const quota = rateLimitDiagnostics(error);
  if (quota.metric !== "OTPM" || !quota.requestTooLarge || quota.quotaLimit === null) return undefined;
  const tokens = Math.min(8192, Math.floor(quota.quotaLimit * 0.85));
  if (tokens < 256 || tokens >= outputTokenBudget(model, 8193, scope)) return undefined;
  outputBudgets.set(scopedModel(scope, model), { tokens, expires: Date.now() + 300_000 });
  return tokens;
}

export function outputTokenBudget(model: string, requested: number, scope = "default"): number {
  const key = scopedModel(scope, model);
  const budget = outputBudgets.get(key);
  if (!budget || budget.expires <= Date.now()) {
    outputBudgets.delete(key);
    return requested;
  }
  return Math.min(requested, budget.tokens);
}

export function outputBudgetInstruction(model: string, scope = "default"): string {
  const budget = outputTokenBudget(model, 8193, scope);
  return budget < 8193
    ? `The provider reported a small output-token allowance. Fit the ENTIRE response, including tool JSON, within ${budget} tokens. For a new browser app, prefer one compact, complete index.html with inline CSS and JavaScript, real working interactions, and no external dependencies. Preserve the user's existing features when editing; do not replace their project with a stub to fit. If a complete correct change cannot fit, explain the limitation briefly instead of emitting truncated code.`
    : "";
}

export class UsageLimitError extends Error {
  constructor() { super(USAGE_LIMIT_MESSAGE); }
}

export function shouldTryCompatibleModel(status: number | undefined, code?: string): boolean {
  return status === 429 || status === 408 || (status === 404 && code === "model_not_found") ||
    (status !== undefined && status >= 500 && status <= 599);
}

function providerErrorCode(error: unknown): string | undefined {
  const body = (error as { error?: unknown } | null)?.error;
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const code = (body as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** Retry compatible alternatives after model-specific and transient provider failures. */
export async function openModelStream<T>(
  models: string[],
  create: (model: string) => Promise<T>,
  onDowngrade: (model: string) => void,
  onRateLimit?: (model: string, diagnostics: ReturnType<typeof rateLimitDiagnostics>) => void,
  onModelFallback?: (failedModel: string, nextModel: string, status: number) => void,
  scope = "default",
): Promise<{ model: string; stream: T }> {
  if (!models.length) throw new Error("No compatible model is available for this request.");
  const candidates = modelsForRequest(models, scope);
  const budgetRetries = new Set<string>();
  let allCandidatesRateLimited = true;
  let lastError: unknown;
  for (let index = 0; index < candidates.length; index++) {
    const model = candidates[index]!;
    try {
      const stream = await create(model);
      clearRateLimit(model, scope);
      // A fallback notice describes a confirmed usable stream, not a failed attempt.
      if (model !== models[0]) onDowngrade(model);
      return { model, stream };
    }
    catch (error) {
      lastError = error;
      const candidate = error as { status?: number; headers?: Headers };
      const status = candidate.status;
      if (status === 429) {
        const diagnostics = recordRateLimit(model, error, scope);
        if (diagnostics.requestTooLarge) allCandidatesRateLimited = false;
        onRateLimit?.(model, diagnostics);
        if (!budgetRetries.has(model) && reduceOutputBudget(model, error, scope) !== undefined) {
          budgetRetries.add(model);
          index--; // Retry the same model once with its verified, smaller output allowance.
          continue;
        }
      } else {
        allCandidatesRateLimited = false;
        if (!shouldTryCompatibleModel(status, providerErrorCode(error))) throw error;
      }
      const nextModel = candidates[index + 1];
      if (nextModel && status !== undefined) onModelFallback?.(model, nextModel, status);
    }
  }
  if (allCandidatesRateLimited) throw new UsageLimitError();
  throw lastError ?? new Error("No compatible model could complete this request.");
}
