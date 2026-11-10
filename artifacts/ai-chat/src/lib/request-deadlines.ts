export const RESPONSE_DEADLINE_MS = 180_000;
export const AGENT_BUILD_DEADLINE_MS = 600_000;
export const AGENT_REVIEW_DEADLINE_MS = 25_000;

/** Return an idempotent cleanup; cancellation must not leave a timer behind. */
export function startRequestDeadline(controller: AbortController, delayMs: number, message: string): () => void {
  if (controller.signal.aborted) return () => {};
  const cleanup = () => {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', cleanup);
  };
  const timer = setTimeout(() => controller.abort(new Error(message)), delayMs);
  controller.signal.addEventListener('abort', cleanup, { once: true });
  return cleanup;
}
