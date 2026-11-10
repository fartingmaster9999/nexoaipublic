import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { clampWorkspaceWidth, workspaceBounds, WORKSPACE_WIDTH_KEY } from '@/lib/workspace-size';

function getBounds() {
  return workspaceBounds(window.innerWidth, document.getElementById('history-sidebar')?.getBoundingClientRect().width ?? 0);
}
export function useWorkspaceSize() {
  const [preferred, setPreferred] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(WORKSPACE_WIDTH_KEY));
      if (Number.isFinite(saved) && saved >= 320) return saved;
    } catch { /* Width preferences are optional; code drafts are handled separately. */ }
    return Math.min(680, Math.max(380, window.innerWidth * .42));
  });
  const [bounds, setBounds] = useState(getBounds);
  const width = clampWorkspaceWidth(preferred, bounds);
  const latestPreferred = useRef(preferred);
  latestPreferred.current = preferred;
  const drag = useRef<{ x: number; width: number } | null>(null);
  const stop = () => { drag.current = null; document.body.classList.remove('is-resizing'); };

  useEffect(() => {
    const update = () => setBounds(getBounds());
    const persist = () => {
      try { localStorage.setItem(WORKSPACE_WIDTH_KEY, String(latestPreferred.current)); } catch { /* Optional preference. */ }
    };
    const observer = new ResizeObserver(update);
    const sidebar = document.getElementById('history-sidebar');
    if (sidebar) observer.observe(sidebar);
    window.addEventListener('resize', update);
    window.addEventListener('pagehide', persist);
    return () => {
      persist();
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('pagehide', persist);
      stop();
    };
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { localStorage.setItem(WORKSPACE_WIDTH_KEY, String(preferred)); } catch { /* Optional preference. */ }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [preferred]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || window.innerWidth < 768) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width };
    document.body.classList.add('is-resizing');
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current) setPreferred(clampWorkspaceWidth(drag.current.width + drag.current.x - event.clientX, getBounds()));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16;
    let next: number;
    if (event.key === 'ArrowLeft') next = width + step;
    else if (event.key === 'ArrowRight') next = width - step;
    else if (event.key === 'Home') next = bounds.min;
    else if (event.key === 'End') next = bounds.max;
    else return;
    event.preventDefault();
    setPreferred(clampWorkspaceWidth(next, getBounds()));
  };
  return { width, bounds, separatorProps: { onPointerDown, onPointerMove, onPointerUp: stop, onPointerCancel: stop, onLostPointerCapture: stop, onKeyDown } };
}
