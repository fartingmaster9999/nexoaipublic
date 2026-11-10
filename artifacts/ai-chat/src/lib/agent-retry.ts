export const MAX_AGENT_DEFERRED_RETRIES = 3;

/** A reload must honor the remaining provider window, not restart it. */
export async function waitForAgentWindow(signal: AbortSignal, waitUntil: number): Promise<void> {
  const remaining = Math.max(0, waitUntil - Date.now());
  if (remaining > 60_250) throw new Error('The saved Agent wait is invalid.');
  if (remaining) await waitForAgentRetry(signal, Math.max(250, remaining));
  else signal.throwIfAborted();
}

/** Keep the build cancellable while no hosted API request is open. */
export function waitForAgentRetry(signal: AbortSignal, delayMs: number): Promise<void> {
  signal.throwIfAborted();
  if (!Number.isInteger(delayMs) || delayMs < 250 || delayMs > 60_250) {
    return Promise.reject(new Error('The Agent returned an invalid retry delay.'));
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason ?? new DOMException('Stopped by you', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
