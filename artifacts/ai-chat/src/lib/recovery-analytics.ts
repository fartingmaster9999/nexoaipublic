// Only fixed, content-free recovery dimensions belong in analytics.
type Phase = 'ready' | 'waiting' | 'executing' | 'cancelled' | 'unavailable';
export type CheckpointIssue = 'invalid' | 'expired' | 'storage_unavailable';
type RecoveryEvents = {
  agent_recovery_notice_shown: { phase: Phase; image_required: boolean };
  agent_recovery_resume: { phase: Phase; image_required: boolean };
  agent_recovery_dismiss: { outcome: 'dismissed' | 'storage_failed' };
  agent_recovery_cancel: { location: 'stop' | 'new_chat' | 'home' | 'delete'; resumed: boolean };
  agent_checkpoint_rejected: { reason: CheckpointIssue };
  agent_recovery_resume_blocked: { reason: CheckpointIssue | 'missing' | 'cancelled' | 'newer_messages' | 'image_required' };
  agent_recovery_result: { outcome: 'completed' | 'failed' | 'cancelled'; reason: 'completed' | 'request_failed' | 'empty_response' | 'cancelled' };
};

declare global {
  interface Window {
    umami?: {
      track(name: string, data?: Record<string, string | number | boolean>): unknown;
    };
  }
}

/** No script/configuration is installed here: Publishing injects the tracker. */
export function trackRecoveryEvent<E extends keyof RecoveryEvents>(name: E, data: RecoveryEvents[E]): void {
  if (typeof window === 'undefined') return;
  try {
    // Handle both synchronous throws and asynchronous tracker failures.
    void Promise.resolve(window.umami?.track(name, data)).catch(() => {});
  } catch {
    // Analytics must never affect saving, resuming, or stopping a build.
  }
}
