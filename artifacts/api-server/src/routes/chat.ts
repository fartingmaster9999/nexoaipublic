import { Router, type IRouter } from "express";
import Groq from "groq-sdk";
import { StreamChatBody } from "@workspace/api-zod";
import { buildChatRequest, isValidTimeZone } from "../lib/chat-request";
import { buildSearchQuery, isCodingRequest, needsWebSearch } from "../lib/chat-policy";
import { searchWeb } from "../lib/web-search";
import { getChatClient, writeChatEvent, CHAT_DEADLINE_MS, PROVIDER_IDLE_MS } from "../lib/chat-runtime";
import { providerKeyScope } from "../lib/provider-key-scope";
import {
  availableModels, chooseModels, openModelStream, PRIMARY_MODEL, SMALL_MODEL,
  UsageLimitError, USAGE_LIMIT_MESSAGE, DOWNGRADE_MESSAGE, markRateLimited, rateLimitDiagnostics,
} from "../lib/model-routing";

const router: IRouter = Router();

router.post("/chat", async (req, res): Promise<void> => {
  const parsed = StreamChatBody.safeParse(req.body);
  if (!parsed.success || parsed.data.messages.at(-1)?.role !== "user") {
    res.status(400).json({ error: "Please provide a valid conversation ending with your message." });
    return;
  }
  const groqApiKey = req.get("X-Groq-Api-Key")?.trim();
  if (!groqApiKey || groqApiKey.length < 8 || groqApiKey.length > 512) {
    res.status(401).json({ error: "Add a valid Groq API key in Settings to use Nexo AI." });
    return;
  }
  if (parsed.data.timeZone !== undefined && !isValidTimeZone(parsed.data.timeZone)) {
    res.status(400).json({ error: "The provided timezone is invalid." });
    return;
  }
  const client = getChatClient(groqApiKey);
  const groqScope = providerKeyScope("groq", groqApiKey);
  const controller = new AbortController();
  const startedAt = Date.now();
  let timedOut = false;
  const timeout = () => { timedOut = true; controller.abort(new Error('Chat deadline exceeded')); };
  const deadline = setTimeout(timeout, CHAT_DEADLINE_MS);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const abortOnDisconnect = () => { if (!res.writableEnded) controller.abort(); };
  res.on("close", abortOnDisconnect);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let activeModel = PRIMARY_MODEL;
  const emit = (event: object) => writeChatEvent(res, event, controller.signal);
  const activity = (id: string, label: string, kind = "info", status = "complete") =>
    emit({ activity: { id, label, kind, status } });

  try {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("X-Request-Id", String(req.id));
    res.flushHeaders();
    heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded && res.writableLength === 0) res.write(": keepalive\n\n");
    }, 10000);

    const lastPrompt = parsed.data.messages.at(-1)!.content;
    const coding = isCodingRequest(lastPrompt);
    let webContext: string | undefined;
    let searchFailed = false;
    if (needsWebSearch(lastPrompt)) {
      await activity("search", "Searching the web and reading public pages…", "search", "running");
      try {
        const result = await searchWeb(buildSearchQuery(parsed.data.messages));
        if (controller.signal.aborted) return;
        webContext = result.context;
        await emit({ sources: result.sources });
        await activity("search", `${result.cached ? "Reused recent" : "Found"} ${result.sources.length} public sources${result.provider === "public-scraper" ? " with the direct scraper" : ""}`, "search");
      } catch {
        if (controller.signal.aborted) return;
        req.log.warn({ service: "web-search" }, "External sources could not be retrieved");
        searchFailed = true;
        await activity("search", "Web search unavailable; current facts could not be verified", "search", "error");
      }
    }
    if (controller.signal.aborted) return;
    await activity("generating", parsed.data.deepthink ? "Thinking… Deepthink is working" : "Preparing a focused answer", "thinking", "running");

    const ids = coding ? await availableModels(client, groqScope) : [PRIMARY_MODEL, SMALL_MODEL];
    const candidates = chooseModels(ids, coding);
    controller.signal.throwIfAborted();
  let fallbackModel: string | undefined;
    const now = new Date();
    const request = buildChatRequest(parsed.data, now, { webContext, searchFailed, coding, providerScope: groqScope });
    const { model, stream } = await openModelStream(
      candidates,
      (candidate) => client.chat.completions.create(
        candidate === PRIMARY_MODEL || candidate === SMALL_MODEL
          ? { ...request, model: candidate }
          : buildChatRequest(parsed.data, now, { model: candidate, webContext, searchFailed, coding, providerScope: groqScope }),
        { signal: controller.signal },
      ),
      (fallback) => { fallbackModel = fallback; },
      (limitedModel, quota) => req.log.warn(
        { provider: "groq", model: limitedModel, ...quota },
        "Groq rate limit triggered model fallback",
      ),
      (failedModel, nextModel, status) => {
        activeModel = nextModel;
        req.log.warn(
          { event: "chat.model.fallback", provider: "groq", model: failedModel, fallbackModel: nextModel, status },
          "Chat model failed; trying a compatible Groq model",
        );
      },
      groqScope,
    );
    activeModel = model;
    if (fallbackModel) await emit({ notice: { id: "model-downgrade", message: DOWNGRADE_MESSAGE, model: fallbackModel } });
    await emit({ provider: "groq", model, reasoningEffort: parsed.data.deepthink ? "high" : "medium" });
    req.log.info({ event: "chat.stream.started", model, deepthink: parsed.data.deepthink, inputChars: request.messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0), latencyMs: Date.now() - startedAt }, "Chat stream opened");
    idle = setTimeout(timeout, PROVIDER_IDLE_MS);
    let hasContent = false;
    let finishReason: string | null = null;
    for await (const chunk of stream) {
      clearTimeout(idle);
      idle = setTimeout(timeout, PROVIDER_IDLE_MS);
      const choice = chunk.choices[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const reasoning = choice?.delta?.reasoning;
      if (typeof reasoning === "string" && reasoning.length > 0) await emit({ reasoning });
      const content = choice?.delta?.content;
      if (typeof content === "string" && content.length > 0) {
        hasContent = true;
        await emit({ content });
      }
    }
    if (!hasContent) throw new Error("Empty completion");
    await activity("generating", "…done thinking.", "thinking");
    await emit(finishReason === "length"
      ? { error: "The response reached its length limit. Ask Nexo AI to continue." }
      : { done: true });
    res.end();
    req.log.info({ event: "chat.stream.completed", model, durationMs: Date.now() - startedAt, finishReason }, "Chat stream completed");
  } catch (error) {
    if (res.destroyed || res.writableEnded || (controller.signal.aborted && !timedOut)) return;
    const status = error instanceof Groq.APIError ? error.status : undefined;
    req.log.error({ event: "chat.stream.failed", provider: "groq", model: activeModel, status, timedOut, durationMs: Date.now() - startedAt }, "Chat request failed");
    if (status === 429) {
      markRateLimited(activeModel, error instanceof Groq.APIError ? error.headers?.get("retry-after") : undefined, groqScope);
      req.log.warn({ provider: "groq", model: activeModel, ...rateLimitDiagnostics(error) }, "Groq stream rate limited");
    }
    const message = timedOut || error instanceof Groq.APIConnectionTimeoutError ? "The response timed out. Your partial answer is kept; please try again."
      : status === 429 || error instanceof UsageLimitError ? USAGE_LIMIT_MESSAGE
      : status === 401 || status === 403 ? "Groq could not authorize this request. Check your Groq API key in Settings."
        : "The response could not be completed. Please try again.";
    // The provider's signal may already be aborted; finish the browser stream separately.
    try {
      const signal = AbortSignal.timeout(5000);
      await writeChatEvent(res, { activity: { id: "generating", label: "Response interrupted", kind: "thinking", status: "error" } }, signal);
      await writeChatEvent(res, { error: message }, signal);
      res.end();
    } catch { res.destroy(); }
  } finally {
    clearTimeout(deadline);
    clearTimeout(idle);
    controller.abort();
    if (heartbeat) clearInterval(heartbeat);
    res.off("close", abortOnDisconnect);
    if (!res.writableEnded && !res.destroyed) res.end();
  }
});

export default router;
