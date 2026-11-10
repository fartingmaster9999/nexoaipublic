import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 420;
const W_KEY = 'nexo-sidebar-width';
const O_KEY = 'nexo-sidebar-open';
const clamp = (n: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(n)));
export const isMobile = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;

export function useSidebar() {
  const [width, setWidth] = useState(() => { const n = Number(localStorage.getItem(W_KEY)); return n ? clamp(n) : 260; });
  const [open, setOpen] = useState(() => !isMobile() && localStorage.getItem(O_KEY) !== '0');
  const drag = useRef<{ x: number; w: number } | null>(null);

  useEffect(() => { try { localStorage.setItem(W_KEY, String(width)); } catch { /* ignore */ } }, [width]);
  useEffect(() => { if (!isMobile()) try { localStorage.setItem(O_KEY, open ? '1' : '0'); } catch { /* ignore */ } }, [open]);

  const onPointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    drag.current = { x: e.clientX, w: width };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add('is-resizing');
  }, [width]);
  const onPointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) setWidth(clamp(drag.current.w + e.clientX - drag.current.x));
  }, []);
  const onPointerUp = useCallback(() => { drag.current = null; document.body.classList.remove('is-resizing'); }, []);
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === 'ArrowLeft') setWidth((w) => clamp(w - step));
    else if (e.key === 'ArrowRight') setWidth((w) => clamp(w + step));
    else if (e.key === 'Home') setWidth(SIDEBAR_MIN);
    else if (e.key === 'End') setWidth(SIDEBAR_MAX);
    else return;
    e.preventDefault();
  }, []);

  return { width, open, setOpen, separatorProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onKeyDown } };
}
