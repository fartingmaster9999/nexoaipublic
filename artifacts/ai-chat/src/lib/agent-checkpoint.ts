import { isAgentHistory, type AgentToolExchange, type StreamEvent } from './chat-stream.ts';
import { AGENT_BUILD_DEADLINE_MS } from './request-deadlines.ts';
import { MAX_AGENT_DEFERRED_RETRIES } from './agent-retry.ts';
import type { SavedProject } from './project-workspace.ts';
import { trackRecoveryEvent, type CheckpointIssue } from './recovery-analytics.ts';

const PREFIX = 'nexo-agent-continuation:';
const MAX_CHARS = 400_000;
export type AgentCheckpoint = {
  version: 1;
  conversationId: string;
  assistantId: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  deepthink: boolean;
  imageRequired: boolean;
  provider: 'gemini' | 'groq' | null;
  model: string | null;
  task: NonNullable<StreamEvent['agentTask']> | null;
  history: AgentToolExchange[];
  toolCalls: number;
  retries: number;
  startedAt: number;
  waitUntil: number;
  phase: 'ready' | 'waiting' | 'executing' | 'cancelled';
  // No images or unselected project source is captured in this record.
};
export type CheckpointState = { checkpoint: AgentCheckpoint | null; error: string; reason?: CheckpointIssue };
export const agentCheckpointKey = (id: string) => `${PREFIX}${encodeURIComponent(id)}`;
// Local-only keys deduplicate repeated reads; identifiers never reach the tracker.
const reportedIssues = new WeakMap<object, Map<string, CheckpointIssue>>();
function reportIssue(storage: object, id: string, reason: CheckpointIssue) {
  let issues = reportedIssues.get(storage);
  if (!issues) { issues = new Map(); reportedIssues.set(storage, issues); }
  if (issues.get(id) === reason) return;
  if (issues.size >= 100) issues.clear();
  issues.set(id, reason);
  trackRecoveryEvent('agent_checkpoint_rejected', { reason });
}

/** Keep locally completed results authoritative across provider continuations. */
export function extendAgentHistory(previous: AgentToolExchange[], incoming: AgentToolExchange[]): AgentToolExchange[] {
  if (incoming.length < previous.length || previous.some((entry, index) =>
    incoming[index]?.callId !== entry.callId || incoming[index]?.tool !== entry.tool ||
    incoming[index]?.result !== entry.result) ||
    new Set(incoming.map(entry => entry.callId)).size !== incoming.length) {
    throw new Error('The Agent returned an unsafe continuation. Existing workspace files are unchanged.');
  }
  return [...previous, ...incoming.slice(previous.length)];
}

function validate(value: unknown, id: string): AgentCheckpoint {
  if (!value || typeof value !== 'object') throw new Error('invalid');
  const c = value as AgentCheckpoint;
  if (c.version !== 1 || c.conversationId !== id || typeof c.assistantId !== 'string' || !c.assistantId || c.assistantId.length > 100 ||
      !Array.isArray(c.messages) || !c.messages.length || c.messages.length > 20 ||
      c.messages.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 12_000) ||
      c.messages.at(-1)?.role !== 'user' || c.messages.reduce((n, m) => n + m.content.length, 0) > 16_000 ||
      typeof c.deepthink !== 'boolean' || typeof c.imageRequired !== 'boolean' || ![null, 'gemini', 'groq'].includes(c.provider) ||
      !(c.model === null || typeof c.model === 'string' && c.model.length <= 256) ||
      ![null, 'coding', 'planning', 'reasoning', 'fast_worker', 'document', 'synthesis', 'classification', 'multimodal'].includes(c.task) ||
      !isAgentHistory(c.history) || new Set(c.history.map(h => h.callId)).size !== c.history.length ||
      !Number.isInteger(c.toolCalls) || c.toolCalls < 0 || c.toolCalls > 6 ||
      !Number.isInteger(c.retries) || c.retries < 0 || c.retries > MAX_AGENT_DEFERRED_RETRIES ||
      !Number.isFinite(c.startedAt) || c.startedAt <= 0 || c.startedAt > Date.now() + 5_000 ||
      !Number.isFinite(c.waitUntil) || c.waitUntil < 0 || c.waitUntil > c.startedAt + AGENT_BUILD_DEADLINE_MS + 60_250 ||
      !['ready', 'waiting', 'executing', 'cancelled'].includes(c.phase)) throw new Error('invalid');
  return c;
}

export function readAgentCheckpoint(storage: Pick<Storage, 'getItem'>, id: string): CheckpointState {
  let reason: CheckpointIssue = 'storage_unavailable';
  try {
    const raw = storage.getItem(agentCheckpointKey(id));
    if (!raw) {
      reportedIssues.get(storage)?.delete(id);
      return { checkpoint: null, error: '' };
    }
    reason = 'invalid';
    if (raw.length > MAX_CHARS) throw new Error('oversized');
    const checkpoint = validate(JSON.parse(raw), id);
    if (checkpoint.phase !== 'cancelled' && Date.now() - checkpoint.startedAt >= AGENT_BUILD_DEADLINE_MS) {
      reportIssue(storage, id, 'expired');
      return { checkpoint: null, reason: 'expired', error: 'This interrupted Agent build has expired. Saved files are kept; send a new request to continue.' };
    }
    reportedIssues.get(storage)?.delete(id);
    return { checkpoint, error: '' };
  } catch {
    reportIssue(storage, id, reason);
    return { checkpoint: null, reason, error: 'The Agent recovery record is unreadable or from an unsupported version. Saved files and chat history are unchanged.' };
  }
}

export function writeAgentCheckpoint(storage: Pick<Storage, 'setItem'>, checkpoint: AgentCheckpoint): void {
  validate(checkpoint, checkpoint.conversationId);
  const raw = JSON.stringify(checkpoint);
  if (raw.length > MAX_CHARS) throw new Error('Agent recovery data is too large.');
  try { storage.setItem(agentCheckpointKey(checkpoint.conversationId), raw); }
  catch { throw new Error('Your browser could not save Agent recovery data. The build stopped to avoid repeating unsaved work. Free browser storage before continuing.'); }
}

export function deleteAgentCheckpoint(storage: Pick<Storage, 'removeItem'>, id: string): void {
  storage.removeItem(agentCheckpointKey(id));
}

/** Source opt-outs apply to old tool arguments too, not just projectFiles. */
export function privateAgentHistory(history: AgentToolExchange[], project: SavedProject | null): AgentToolExchange[] {
  const selected = new Set(project?.selectedPaths ?? []);
  return history.map(exchange => exchange.tool === 'write_project' ? {
    ...exchange,
    arguments: {
      ...exchange.arguments,
      // Keep the tool contract/entrypoint valid without retaining private source.
      files: exchange.arguments.files?.map(file => ({ path: file.path, content: selected.has(file.path) ? file.content : '' })),
    },
  } : exchange);
}
