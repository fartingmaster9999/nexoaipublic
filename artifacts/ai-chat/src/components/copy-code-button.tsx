import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyRawCode } from '@/lib/code-clipboard';
import './code-copy.css';

export function CopyCodeButton({ text, label = 'Copy code' }: { text: string; label?: string }) {
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const [error, setError] = useState('');
  const operation = useRef(0);
  useEffect(() => {
    operation.current++;
    setStatus('idle');
    setError('');
    return () => { operation.current++; };
  }, [text]);
  useEffect(() => {
    if (status !== 'copied') return;
    const timer = window.setTimeout(() => setStatus('idle'), 2200);
    return () => window.clearTimeout(timer);
  }, [status]);
  const copy = async () => {
    const id = ++operation.current;
    setStatus('copying');
    setError('');
    try {
      await copyRawCode(text);
      if (operation.current === id) setStatus('copied');
    } catch (failure) {
      if (operation.current !== id) return;
      setStatus('failed');
      setError(failure instanceof Error ? failure.message : 'Copy failed. Select and copy the code manually.');
    }
  };
  return (
    <span className="code-copy-control">
      <button type="button" className="code-copy-button" aria-label={label} disabled={status === 'copying'}
        onClick={() => void copy()} data-testid="button-copy-code">
        {status === 'copied' ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
        {status === 'copied' ? 'Copied' : status === 'copying' ? 'Copying…' : 'Copy code'}
      </button>
      <span className={error ? 'code-copy-error' : 'sr-only'} role="status" aria-live="polite">
        {error || (status === 'copied' ? 'Code copied to clipboard.' : '')}
      </span>
    </span>
  );
}
