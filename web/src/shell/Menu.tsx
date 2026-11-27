import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { IconButton } from './icons.js';

export type MenuItem =
  | { label: string; onSelect: () => void; danger?: boolean; content?: ReactNode; match?: string }
  | { label: string; choices: Array<{ label: string; on: boolean; onSelect: () => void }> }
  | 'separator';

interface MenuPosition {
  x: number;
  y: number;
  right?: number;
  top?: number;
}

export function Menu(props: { label: string; items: MenuItem[]; at: MenuPosition; onClose: (refocus: boolean) => void; anchor?: RefObject<HTMLElement | null>; search?: string }) {
  const { label, items: all, at, onClose, anchor, search } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const items = q ? all.filter((item) => item !== 'separator' && !('choices' in item) && (item.match ?? item.label).toLowerCase().includes(q)) : all;
  useLayoutEffect(() => {
    const el = ref.current!;
    const { offsetWidth: w, offsetHeight: h } = el;
    const x = at.x + w > innerWidth - 8 && at.right !== undefined ? at.right - w : at.x;
    const y = at.y + h > innerHeight - 8 && at.top !== undefined ? at.top - h - 4 : at.y;
    setPos({ x: Math.max(8, Math.min(x, innerWidth - w - 8)), y: Math.max(8, Math.min(y, innerHeight - h - 8)) });
    (el.querySelector<HTMLElement>('input') ?? el.querySelector<HTMLElement>('button'))?.focus();
  }, [at.x, at.y, at.right, at.top]);
  useEffect(() => {
    const away = (e: Event) => ref.current?.contains(e.target as Node) || anchor?.current?.contains(e.target as Node) || onClose(false);
    const leave = () => onClose(false);
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('resize', leave);
    window.addEventListener('hashchange', leave);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('resize', leave);
      window.removeEventListener('hashchange', leave);
    };
  }, [onClose]);
  const onKeyDown = (e: KeyboardEvent) => {
    const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>('button')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number) => buttons[(to + buttons.length) % buttons.length]?.focus();
    if (e.key === 'Escape' && query) setQuery('');
    else if (e.key === 'Escape') onClose(true);
    else if (e.key === 'Enter' && e.target instanceof HTMLInputElement) buttons[0]?.click();
    else if ((e.key === 'Home' || e.key === 'End') && e.target instanceof HTMLInputElement) return;
    else if (e.key === 'ArrowDown') move(index + 1);
    else if (e.key === 'ArrowUp') move(index < 0 ? -1 : index - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(buttons.length - 1);
    else if (e.key === 'Tab') onClose(false);
    else return;
    if (e.key !== 'Tab') e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div className="menu" role="menu" aria-label={label} ref={ref} style={{ left: pos.x, top: pos.y }} onKeyDown={onKeyDown}>
      {search && (
        <div className="menu-search">
          <input type="search" aria-label={search} placeholder={`${search}…`} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      )}
      {q && items.length === 0 && <p className="menu-empty">Nothing matches</p>}
      {items.map((item, i) =>
        item === 'separator' ? (
          <hr key={`sep-${i}`} />
        ) : 'choices' in item ? (
          <div key={`${i}-${item.label}`} className="menu-choices" role="group" aria-label={item.label}>
            <span>{item.label}</span>
            {item.choices.map((choice) => (
              <button
                key={choice.label}
                type="button"
                role="menuitemradio"
                aria-checked={choice.on}
                title={`${item.label}: ${choice.label}`}
                tabIndex={-1}
                onClick={() => {
                  onClose(true);
                  choice.onSelect();
                }}
              >
                {choice.label}
              </button>
            ))}
          </div>
        ) : (
          <button
            key={`${i}-${item.label}`}
            type="button"
            role="menuitem"
            tabIndex={-1}
            aria-label={item.content ? item.label : undefined}
            title={item.label}
            className={item.danger ? 'danger' : undefined}
            onClick={() => {
              onClose(true);
              item.onSelect();
            }}
          >
            {item.content ?? item.label}
          </button>
        ),
      )}
    </div>
  );
}

export function useMenu(label: string, items: MenuItem[], search?: string) {
  const [at, setAt] = useState<MenuPosition | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = (refocus: boolean) => {
    setAt(null);
    if (refocus) button.current?.focus();
  };
  const fromButton = () => {
    const r = button.current!.getBoundingClientRect();
    setAt({ x: r.left, y: r.bottom + 4, right: r.right, top: r.top });
  };
  return {
    open: at !== null,
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      setAt({ x: e.clientX, y: e.clientY });
    },
    trigger: {
      ref: button,
      type: 'button' as const,
      'aria-haspopup': 'menu' as const,
      'aria-expanded': at !== null,
      onClick: () => (at ? close(false) : fromButton()),
    },
    element: at && <Menu label={label} items={items} at={at} onClose={close} anchor={button} search={search} />,
  };
}

export function MoreButton({ label, tip, menu, className }: { label: string; tip: string; menu: ReturnType<typeof useMenu>; className?: string }) {
  return <IconButton className={`icon-btn${className ? ` ${className}` : ''}`} icon="i-more" label={label} tip={tip} {...menu.trigger} />;
}
