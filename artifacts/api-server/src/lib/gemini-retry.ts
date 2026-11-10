const RETRY_AFTER_LIMIT_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - Date.now());
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("Gemini request was aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function waitForGeminiRetry(
  signal: AbortSignal,
  delayMs = DEFAULT_RETRY_DELAY_MS + Math.random() * 250,
): Promise<void> {
  return waitForRetry(delayMs, signal);
}

/**
 * Retry one transient Gemini 408, 429, 5xx, or pre-response transport failure.
 * Do not retry client errors or wait longer than ten seconds for a provider hint.
 */
export async function requestGeminiWithRetry(
  request: () => Promise<Response>,
  signal: AbortSignal,
): Promise<Response> {
  let firstResponse: Response;
  try {
    firstResponse = await request();
  } catch (error) {
    if (signal.aborted) throw error;
    await waitForRetry(DEFAULT_RETRY_DELAY_MS + Math.random() * 250, signal);
    return request();
  }

  const transientStatus = firstResponse.status === 408 ||
    firstResponse.status === 429 ||
    firstResponse.status >= 500;
  if (!transientStatus || signal.aborted) return firstResponse;

  const hintedDelay = retryAfterMs(firstResponse.headers.get("retry-after"));
  if (hintedDelay !== undefined && hintedDelay > RETRY_AFTER_LIMIT_MS) return firstResponse;
  await firstResponse.body?.cancel().catch(() => {});
  await waitForGeminiRetry(signal, hintedDelay ?? DEFAULT_RETRY_DELAY_MS + Math.random() * 250);
  return request();
}
