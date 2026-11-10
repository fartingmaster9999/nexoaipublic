import Groq from 'groq-sdk';
import type { Response } from 'express';

export const CHAT_DEADLINE_MS = 150000;
export const PROVIDER_IDLE_MS = 45000;

/** Create a request-scoped client. Keys are supplied in headers and never cached or logged. */
export function getChatClient(apiKey: string): Groq {
  if (!apiKey) throw new Error('A Groq API key is required');
  return new Groq({
    apiKey, baseURL: 'https://api.groq.com',
    timeout: 60000, maxRetries: 0,
  });
}

/** Backpressure is awaited, never buffered indefinitely for a slow/disconnected browser. */
export async function writeChatEvent(res: Response, event: object, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (res.destroyed || res.writableEnded) throw new Error('Client disconnected');
  if (res.write(`data: ${JSON.stringify(event)}\n\n`)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      res.off('drain', ready);
      res.off('close', closed);
      signal.removeEventListener('abort', aborted);
    };
    const ready = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new Error('Client disconnected')); };
    const aborted = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(closed, 15000);
    res.once('drain', ready);
    res.once('close', closed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
