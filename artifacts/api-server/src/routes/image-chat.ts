import { Router, type IRouter } from "express";
import { StreamImageChatBody } from "@workspace/api-zod";
import { isValidTimeZone } from "../lib/chat-request";
import { requestGeminiWithRetry } from "../lib/gemini-retry";
import {
  buildGeminiImageRequest, GeminiImageApiError, GeminiSseDecoder, GEMINI_IMAGE_MODEL,
  geminiImageErrorMessage, requestGeminiImageStream, visibleGeminiText,
} from "../lib/gemini-image";
import { CHAT_DEADLINE_MS, PROVIDER_IDLE_MS, writeChatEvent } from "../lib/chat-runtime";

type ImageChatRouterOptions = {
  getApiKey?: () => string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export function createImageChatRouter({
  getApiKey = () => undefined,
  fetchImpl = fetch,
  now = () => new Date(),
}: ImageChatRouterOptions = {}): IRouter {
  const router: IRouter = Router();

  router.post("/chat/image", async (req, res): Promise<void> => {
  const parsed = StreamImageChatBody.safeParse(req.body);
  if (!parsed.success || parsed.data.messages.at(-1)?.role !== "user") {
    res.status(400).json({ error: "Please provide a valid prompt and supported image." });
    return;
  }
  const suppliedApiKey = getApiKey() ?? req.get("X-Gemini-Api-Key")?.trim();
  const apiKey = suppliedApiKey && suppliedApiKey.length >= 8 && suppliedApiKey.length <= 512 ? suppliedApiKey : undefined;
  if (!apiKey) {
    res.status(401).json({ error: "Add your Gemini API key in Settings to analyze images." });
    return;
  }
  if (parsed.data.timeZone !== undefined && !isValidTimeZone(parsed.data.timeZone)) {
    res.status(400).json({ error: "The provided timezone is invalid." });
    return;
  }
  let request: ReturnType<typeof buildGeminiImageRequest>;
  try {
    request = buildGeminiImageRequest(parsed.data, now());
  } catch {
    res.status(400).json({ error: "The image data is invalid. Choose a JPEG, PNG, or WebP image under 3 MB." });
    return;
  }

  const controller = new AbortController();
  const startedAt = Date.now();
  let timedOut = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Gemini image request deadline exceeded"));
  }, CHAT_DEADLINE_MS);
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Gemini image stream stalled"));
    }, PROVIDER_IDLE_MS);
  };
  const abortOnDisconnect = () => {
    if (!res.writableEnded) controller.abort(new Error("Client disconnected"));
  };
  res.on("close", abortOnDisconnect);
  const emit = (event: object) => writeChatEvent(res, event, controller.signal);

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
    await emit({ model: GEMINI_IMAGE_MODEL });
    await emit({ activity: { id: "image-analysis", label: "Analyzing the attached image", kind: "thinking", status: "running" } });
    resetIdle();

    const upstream = await requestGeminiWithRetry(
      () => requestGeminiImageStream(apiKey, request, controller.signal, fetchImpl),
      controller.signal,
    );
    if (!upstream.ok) {
      req.log.warn({ provider: "gemini", model: GEMINI_IMAGE_MODEL, status: upstream.status }, "Gemini image request rejected");
      await upstream.body?.cancel().catch(() => {});
      throw new GeminiImageApiError(upstream.status);
    }
    if (!upstream.body) throw new Error("Gemini returned an empty response stream");

    const decoder = new GeminiSseDecoder();
    const reader = upstream.body.getReader();
    let answerChars = 0;
    let hasAnswer = false;
    try {
      while (true) {
        controller.signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        resetIdle();
        for (const item of decoder.push(value)) {
          const text = visibleGeminiText(item);
          if (!text) continue;
          const remaining = 100_000 - answerChars;
          if (remaining <= 0) throw new Error("Gemini response exceeded the output limit");
          const visible = text.slice(0, remaining);
          answerChars += visible.length;
          hasAnswer ||= visible.length > 0;
          if (visible) await emit({ content: visible });
          if (visible.length < text.length) throw new Error("Gemini response exceeded the output limit");
        }
      }
      for (const item of decoder.push()) {
        const text = visibleGeminiText(item);
        if (!text) continue;
        const remaining = 100_000 - answerChars;
        if (remaining <= 0) throw new Error("Gemini response exceeded the output limit");
        const visible = text.slice(0, remaining);
        answerChars += visible.length;
        hasAnswer ||= visible.length > 0;
        if (visible) await emit({ content: visible });
        if (visible.length < text.length) throw new Error("Gemini response exceeded the output limit");
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }

    if (!hasAnswer) throw new Error("Gemini returned no visible answer");
    await emit({ activity: { id: "image-analysis", label: "Image analysis complete", kind: "thinking", status: "complete" } });
    await emit({ done: true });
    res.end();
    req.log.info({ event: "gemini.image.completed", model: GEMINI_IMAGE_MODEL, durationMs: Date.now() - startedAt }, "Gemini image response completed");
  } catch (error) {
    if (res.destroyed || res.writableEnded || (controller.signal.aborted && !timedOut)) return;
    const status = error instanceof GeminiImageApiError ? error.status : undefined;
    req.log.error({ event: "gemini.image.failed", model: GEMINI_IMAGE_MODEL, status, timedOut, durationMs: Date.now() - startedAt }, "Gemini image response failed");
    const message = timedOut
      ? "Image analysis timed out. Your prompt is kept; please try again."
      : error instanceof GeminiImageApiError
        ? geminiImageErrorMessage(error.status)
        : "The image response could not be completed. Your prompt is kept; please try again.";
    const signal = AbortSignal.timeout(5000);
    try {
      await writeChatEvent(res, { activity: { id: "image-analysis", label: "Image analysis interrupted", kind: "thinking", status: "error" } }, signal);
      await writeChatEvent(res, { error: message }, signal);
      res.end();
    } catch {
      res.destroy();
    }
  } finally {
    clearTimeout(deadline);
    clearTimeout(idle);
    controller.abort();
    if (heartbeat) clearInterval(heartbeat);
    res.off("close", abortOnDisconnect);
    if (!res.writableEnded && !res.destroyed) res.end();
  }
  });
  return router;
}

export default createImageChatRouter();
