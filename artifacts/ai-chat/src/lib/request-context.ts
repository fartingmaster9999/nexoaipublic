type Message = { role: 'user' | 'assistant'; content: string };

/** Send a contiguous suffix of complete turns, never metadata or clipped answers. */
export function prepareRequestMessages(messages: Message[], maxChars = 16000, maxMessages = 20): Message[] {
  const latest = messages.at(-1);
  if (!latest || latest.role !== 'user' || !latest.content.trim()) throw new Error('Please enter a message.');
  if (latest.content.length > 12000) throw new Error('Your message is too long. Please keep it under 12,000 characters.');
  const result: Message[] = [{ role: latest.role, content: latest.content }];
  let chars = latest.content.length;
  let end = messages.length - 1;
  while (end > 0) {
    let start = end - 1;
    while (start > 0 && messages[start]?.role !== 'user') start--;
    const turn = messages.slice(start, end);
    const size = turn.reduce((n, m) => n + m.content.length, 0);
    if (turn[0]?.role !== 'user' || turn.some(m => m.content.length > 12000) ||
        chars + size > maxChars || result.length + turn.length > maxMessages) break;
    result.unshift(...turn.map(m => ({ role: m.role, content: m.content })));
    chars += size;
    end = start;
  }
  return result;
}
