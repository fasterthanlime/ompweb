'use client';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { swipeCommits, type ThreadNavigationItem } from '@/lib/thread-navigation';

export function ThreadPager({ activeKey, items, onSelect, onWarm, children }: {
  activeKey: string | null;
  items: ThreadNavigationItem[];
  onSelect: (item: ThreadNavigationItem) => void;
  onWarm: (item: ThreadNavigationItem, signal: AbortSignal) => void;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const current = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const [preview, setPreview] = useState<{ item: ThreadNavigationItem; direction: number } | null>(null);
  const [pending, setPending] = useState<ThreadNavigationItem | null>(null);
  const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const callbacks = useRef({ items, activeKey, onSelect, onWarm, reduced });
  useLayoutEffect(() => { callbacks.current = { items, activeKey, onSelect, onWarm, reduced }; });

  useEffect(() => {
    const index = items.findIndex(item => item.key === activeKey);
    if (index < 0) return;
    const controller = new AbortController();
    const idle = setTimeout(() => {
      for (const item of [items[index - 1], items[index + 1]]) if (item) onWarm(item, controller.signal);
    }, 400);
    return () => { clearTimeout(idle); controller.abort(); };
  }, [activeKey, items, onWarm]);

  useLayoutEffect(() => {
    root.current?.style.setProperty('--thread-drag', '0px');
    root.current?.classList.remove('is-settling', 'is-dragging');
    setPreview(null);
    busy.current = false;
    clearTimeout(timer.current);
    setPending(value => value && value.key !== activeKey ? null : value);
  }, [activeKey]); // A sidebar selection also cancels an in-progress swipe.

  useEffect(() => {
    if (!pending || pending.key !== activeKey || !current.current) return;
    const check = () => {
      if (current.current?.querySelector('[data-thread-ready="true"], [role="alert"]')) setPending(null);
    };
    const observer = new MutationObserver(check);
    observer.observe(current.current, { attributes: true, childList: true, subtree: true });
    check();
    return () => observer.disconnect();
  }, [activeKey, pending]);

  useEffect(() => {
    const node = root.current;
    if (!node) return;
    let gesture: { key: string | null; x: number; y: number; at: number; width: number; distance: number; locked: boolean; previous?: ThreadNavigationItem; next?: ThreadNavigationItem } | undefined;
    let suppressClick = false;
    const reset = () => {
      gesture = undefined;
      node.style.setProperty('--thread-drag', '0px');
      node.classList.remove('is-settling', 'is-dragging');
      setPreview(null);
      busy.current = false;
    };
    const start = (event: TouchEvent) => {
      if (busy.current || event.touches.length !== 1) return;
      suppressClick = false;
      const target = event.target instanceof Element ? event.target : null;
      const composer = target?.closest('[data-thread-swipe]');
      if (!composer || composer.getAttribute('data-thread-swipe-disabled') === 'true'
        || target?.closest('textarea,input,button,a,[contenteditable="true"],[role="slider"]')
        || window.getSelection()?.toString()) return;
      const touch = event.touches[0];
      if (touch.clientX < 28) return; // Preserve the workspace drawer's edge gesture.
      for (let el = target; el && el !== composer; el = el.parentElement) {
        if (el.scrollWidth > el.clientWidth + 2 && ['auto', 'scroll'].includes(getComputedStyle(el).overflowX)) return;
      }
      const state = callbacks.current;
      const index = state.items.findIndex(item => item.key === state.activeKey);
      if (index < 0) return;
      gesture = { key: state.activeKey, x: touch.clientX, y: touch.clientY, at: performance.now(), width: node.clientWidth, distance: 0, locked: false, previous: state.items[index - 1], next: state.items[index + 1] };
      suppressClick = false;
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      if (gesture.key !== callbacks.current.activeKey) { reset(); return; }
      if (event.touches.length !== 1) { reset(); return; }
      const dx = event.touches[0].clientX - gesture.x;
      const dy = event.touches[0].clientY - gesture.y;
      if (!gesture.locked) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
        if (Math.abs(dx) < Math.abs(dy) * 1.4) { gesture = undefined; return; }
        gesture.locked = true;
        node.classList.add('is-dragging');
      }
      event.preventDefault();
      suppressClick = true;
      gesture.distance = dx;
      const item = dx < 0 ? gesture.next : gesture.previous;
      setPreview(item ? { item, direction: dx < 0 ? 1 : -1 } : null);
      const drag = item ? Math.max(-gesture.width, Math.min(gesture.width, dx)) : dx * 0.18;
      node.style.setProperty('--thread-drag', `${callbacks.current.reduced ? 0 : drag}px`);
    };
    const end = () => {
      if (gesture && gesture.key !== callbacks.current.activeKey) { reset(); return; }
      if (!gesture?.locked) { gesture = undefined; return; }
      const { distance, width, at, previous, next } = gesture;
      gesture = undefined;
      const target = distance < 0 ? next : previous;
      const commit = target && swipeCommits(distance, performance.now() - at, width);
      busy.current = true;
      node.classList.add('is-settling');
      node.style.setProperty('--thread-drag', `${commit && !callbacks.current.reduced ? (distance < 0 ? -width : width) : 0}px`);
      timer.current = setTimeout(() => {
        if (commit && target) { setPending(target); callbacks.current.onSelect(target); }
        else reset();
      }, callbacks.current.reduced ? 0 : 200);
    };
    const cancel = () => { clearTimeout(timer.current); reset(); };
    const click = (event: MouseEvent) => { if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false; } };
    node.addEventListener('touchstart', start, { passive: true });
    node.addEventListener('touchmove', move, { passive: false });
    node.addEventListener('touchend', end);
    node.addEventListener('touchcancel', cancel);
    node.addEventListener('click', click, true);
    window.addEventListener('resize', cancel);
    return () => {
      clearTimeout(timer.current);
      node.removeEventListener('touchstart', start);
      node.removeEventListener('touchmove', move);
      node.removeEventListener('touchend', end);
      node.removeEventListener('touchcancel', cancel);
      node.removeEventListener('click', click, true);
      window.removeEventListener('resize', cancel);
    };
  }, []);

  return <div ref={root} className="thread-pager">
    <div ref={current} className="thread-pager-current">{children}</div>
    {preview && <div className="thread-pager-neighbor" style={{ left: `${preview.direction * 100}%` }} aria-hidden="true"><ThreadPlaceholder title={preview.item.title} /></div>}
    {pending && <div className="thread-pager-loading" role="status"><ThreadPlaceholder title={pending.title} /></div>}
  </div>;
}

function ThreadPlaceholder({ title }: { title: string }) {
  return <div className="thread-placeholder"><strong>{title}</strong><span>Opening thread…</span><div className="thread-placeholder-lines"><i/><i/><i/></div><div className="thread-placeholder-composer"/></div>;
}
