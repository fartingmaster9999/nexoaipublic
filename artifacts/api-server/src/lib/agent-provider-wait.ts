import { shortProviderRetryDelay } from "./model-routing";

export const MAX_AGENT_PROVIDER_WAITS = 3;
export const MAX_AGENT_DEFERRED_RETRIES = 3;
const MAX_TOTAL_WAIT_MS = 90_000;
const RESPONSE_HEADROOM_MS = 20_000;

export type AgentProviderWaitState = { count: number; totalMs: number };
type ProviderQuota = { requestTooLarge: boolean; metric: string; retryAfter: string | null };

/** Continue in a fresh hosted request, not an unbounded server-side sleep. */
export function agentProviderDeferDelay(quota: ProviderQuota, used: number): number | undefined {
  if (quota.requestTooLarge || !/^(TPM|ITPM|OTPM|RPM)$/.test(quota.metric) ||
      used >= MAX_AGENT_DEFERRED_RETRIES) return undefined;
  return shortProviderRetryDelay(quota.retryAfter);
}

/** Only retry windows that can still leave time for a useful response. */
export function agentProviderRetryDelay(
  quota: ProviderQuota,
  state: AgentProviderWaitState,
  remainingMs: number,
): number | undefined {
  if (quota.requestTooLarge || /^(TPD|RPD)$/.test(quota.metric) ||
      state.count >= MAX_AGENT_PROVIDER_WAITS) return undefined;
  const delay = shortProviderRetryDelay(quota.retryAfter);
  if (delay === undefined || state.totalMs + delay > MAX_TOTAL_WAIT_MS ||
      delay + RESPONSE_HEADROOM_MS > remainingMs) return undefined;
  return delay;
}
