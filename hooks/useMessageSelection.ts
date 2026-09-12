"use client";
import { useCallback, useEffect, useId, useRef, useSyncExternalStore } from "react";
let selected: string | null = null;
const listeners = new Set<() => void>();
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function select(id: string | null) { if (selected === id) return; selected = id; for (const listener of listeners) listener(); }
export function useMessageSelection() {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const active = useSyncExternalStore(subscribe, () => selected === id, () => false);
  const setActive = useCallback((open: boolean) => { if (open) select(id); else if (selected === id) select(null); }, [id]);
  useEffect(() => () => { if (selected === id) select(null); }, [id]);
  useEffect(() => {
    if (!active) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!rootRef.current?.contains(target) && !target.closest(".message-reaction-positioner")) setActive(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setActive(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [active, setActive]);
  return { active, setActive, rootRef };
}
