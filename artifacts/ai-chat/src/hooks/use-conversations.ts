import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { hasSentUserMessage, loadConversations, parseRecord, RECORD_PREFIX, type Conversation } from '../lib/conversation-storage';

export function useConversations(onError: (message: string) => void) {
  const [initial] = useState(() => {
    try {
      let error = false;
      const items = loadConversations(localStorage, () => { error = true; }).filter(hasSentUserMessage);
      return { items, error };
    }
    catch { return { items: [] as Conversation[], error: true }; }
  });
  const [items, setItems] = useState(initial.items);
  const current = useRef(items);
  const dirty = useRef(new Map<string, Conversation | null>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const failed = useRef(false);
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    try {
      for (const [id, conversation] of dirty.current) {
        localStorage.setItem(RECORD_PREFIX + id, JSON.stringify({ conversation, updatedAt: conversation?.updatedAt ?? Date.now() }));
        dirty.current.delete(id);
      }
      failed.current = false;
    } catch {
      if (!failed.current) onError('Your browser could not save this conversation. Keep this tab open and free some browser storage.');
      failed.current = true;
      console.warn('[nexo:storage]', { operation: 'save', pending: dirty.current.size });
    }
  }, [onError]);
  const update = useCallback((action: SetStateAction<Conversation[]>) => {
    const previous = current.current;
    const next = typeof action === 'function' ? action(previous) : action;
    const old = new Map(previous.map(c => [c.id, c]));
    const ids = new Set(next.map(c => c.id));
    for (const c of next) {
      const before = old.get(c.id);
      if (before === c) continue;
      if (hasSentUserMessage(c)) dirty.current.set(c.id, c);
      else if (before && hasSentUserMessage(before)) dirty.current.set(c.id, null);
    }
    for (const c of previous) if (!ids.has(c.id) && hasSentUserMessage(c)) dirty.current.set(c.id, null);
    current.current = next;
    setItems(next);
    // Fixed cadence rather than debounce: sustained streaming still checkpoints.
    if (!timer.current) timer.current = setTimeout(flush, 500);
  }, [flush]);
  useEffect(() => {
    if (initial.error) onError('Saved history could not be read. The original stored data has not been overwritten.');
    const visibility = () => { if (document.visibilityState === 'hidden') flush(); };
    const sync = (event: StorageEvent) => {
      if (!event.key?.startsWith(RECORD_PREFIX) || !event.newValue) return;
      try {
        const record = parseRecord(event.newValue);
        const id = event.key.slice(RECORD_PREFIX.length);
        if (record.conversation && record.conversation.id !== id) throw new Error('Invalid identity');
        if (dirty.current.has(id)) {
          // Preserve concurrent edits instead of silently replacing either version.
          if (record.conversation) {
            const copy = { ...record.conversation, id: crypto.randomUUID(), title: `${record.conversation.title} (other tab)` };
            update(list => [...list, copy]);
          }
          onError('This conversation changed in another tab. Both versions have been preserved.');
          flush();
          return;
        }
        const next = current.current.filter(c => c.id !== id);
        if (record.conversation) next.push(record.conversation);
        next.sort((a, b) => b.updatedAt - a.updatedAt);
        current.current = next;
        setItems(next);
      } catch {
        console.warn('[nexo:storage]', { operation: 'sync', invalid: true });
      }
    };
    window.addEventListener('storage', sync);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      flush();
      window.removeEventListener('storage', sync);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [flush, initial.error, onError, update]);
  return [items, update, flush] as const;
}
