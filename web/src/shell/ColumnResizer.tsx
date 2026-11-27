import { useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';

export function ColumnResizer(props: { variable: string; storageKey: string; side: 'start' | 'end'; min: number; max: number; label: string; className: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const host = () => ref.current!.parentElement!;
  const current = () => parseFloat(getComputedStyle(host()).getPropertyValue(props.variable));
  const clamp = (width: number) => Math.round(Math.min(Math.max(width, props.min), props.max));
  const apply = (width: number) => {
    host().style.setProperty(props.variable, `${width}px`);
    ref.current!.setAttribute('aria-valuenow', String(width));
  };

  useLayoutEffect(() => {
    const saved = Number(localStorage.getItem(props.storageKey));
    if (saved) apply(clamp(saved));
    else ref.current!.setAttribute('aria-valuenow', String(current()));
  }, []);

  const drag = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const from = e.clientX;
    const start = current();
    let width = start;
    let frame = 0;
    document.documentElement.classList.add('col-resizing');
    const move = (ev: globalThis.PointerEvent) => {
      const dx = ev.clientX - from;
      width = clamp(start + (props.side === 'start' ? dx : -dx));
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          apply(width);
        });
      }
    };
    const up = () => {
      cancelAnimationFrame(frame);
      if (width !== start) {
        apply(width);
        localStorage.setItem(props.storageKey, String(width));
      }
      document.documentElement.classList.remove('col-resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const grow = (e.key === 'ArrowRight') === (props.side === 'start');
    const width = clamp(current() + (grow ? 16 : -16));
    apply(width);
    localStorage.setItem(props.storageKey, String(width));
  };

  const reset = () => {
    host().style.removeProperty(props.variable);
    localStorage.removeItem(props.storageKey);
    ref.current!.setAttribute('aria-valuenow', String(current()));
  };

  return (
    <div
      ref={ref}
      className={`col-resizer ${props.className}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      title="Drag to resize, double-click to reset"
      tabIndex={0}
      onPointerDown={drag}
      onKeyDown={key}
      onDoubleClick={reset}
    />
  );
}
