import type { ButtonHTMLAttributes, Ref } from 'react';
import type { Sign } from '../model/index.js';

export type IconId =
  | 'i-plus'
  | 'i-search'
  | 'i-home'
  | 'i-chev'
  | 'i-chev-r'
  | 'i-more'
  | 'i-panel'
  | 'i-side'
  | 'i-term'
  | 'i-check'
  | 'i-copy'
  | 'i-x'
  | 'i-capture'
  | 'i-review'
  | 'i-ops'
  | 'i-branch'
  | 'i-send'
  | 'i-menu'
  | 'i-chats'
  | 'i-server'
  | 'i-file'
  | 'i-wait'
  | 'i-root'
  | 'i-gear'
  | 'i-history'
  | 'i-agent'
  | 'i-external'
  | 'i-sync'
  | 'i-diagram'
  | 'i-full'
  | 'i-unfull'
  | 'i-palette'
  | 'i-flag'
  | 'i-bell'
  | 'i-bell-off';

export type SignShape = 's-go' | 's-needs' | 's-yield' | 's-stop' | 's-queued' | 's-rest';

export const SIGNS: Record<Sign, { shape: SignShape; label: string }> = {
  needs: { shape: 's-needs', label: 'Needs you' },
  running: { shape: 's-go', label: 'Running' },
  stopped: { shape: 's-stop', label: 'Stopped' },
  done: { shape: 's-rest', label: 'Done' },
  idle: { shape: 's-rest', label: 'Idle' },
};

export function Sprite() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <symbol id="s-go" viewBox="0 0 12 12">
        <circle cx="6" cy="6" r="5" fill="var(--green-ink)" />
      </symbol>
      <symbol id="s-needs" viewBox="0 0 12 12">
        <path d="M6 .6 11.4 6 6 11.4.6 6Z" fill="var(--amber)" stroke="var(--amber-ink)" strokeWidth="1" />
      </symbol>
      <symbol id="s-yield" viewBox="0 0 12 12">
        <path d="M1 1.6h10L6 10.8Z" fill="none" stroke="var(--ink)" strokeWidth="1.5" strokeLinejoin="round" />
      </symbol>
      <symbol id="s-stop" viewBox="0 0 12 12">
        <path d="M3.9.8h4.2l3.1 3.1v4.2l-3.1 3.1H3.9L.8 8.1V3.9Z" fill="var(--red)" />
      </symbol>
      <symbol id="s-queued" viewBox="0 0 12 12">
        <circle cx="6" cy="6" r="4.4" fill="none" stroke="var(--muted)" strokeWidth="1.5" />
      </symbol>
      <symbol id="s-rest" viewBox="0 0 12 12">
        <rect x="1.5" y="5.2" width="9" height="1.6" rx=".8" fill="var(--muted)" />
      </symbol>
      <symbol id="i-plus" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M8 3v10M3 8h10" />
      </symbol>
      <symbol id="i-search" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <circle cx="7" cy="7" r="4.3" />
        <path d="m10.3 10.3 3.2 3.2" />
      </symbol>
      <symbol id="i-home" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
        <path d="M2.5 7.2 8 2.5l5.5 4.7V13.5h-4v-4h-3v4h-4Z" />
      </symbol>
      <symbol id="i-chev" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="m2.5 3.8 2.5 2.5 2.5-2.5" />
      </symbol>
      <symbol id="i-chev-r" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="m3.8 2.5 2.5 2.5-2.5 2.5" />
      </symbol>
      <symbol id="i-more" viewBox="0 0 16 16" fill="currentColor">
        <circle cx="3.5" cy="8" r="1.3" />
        <circle cx="8" cy="8" r="1.3" />
        <circle cx="12.5" cy="8" r="1.3" />
      </symbol>
      <symbol id="i-panel" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
        <path d="M10 2.5v11" />
      </symbol>
      <symbol id="i-side" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
        <path d="M6 2.5v11" />
      </symbol>
      <symbol id="i-term" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="m3 4.5 3 3-3 3M8 11.5h5" />
      </symbol>
      <symbol id="i-check" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="m2 5.2 2 2 4-4.4" />
      </symbol>
      <symbol id="i-copy" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
        <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
      </symbol>
      <symbol id="i-x" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="m4 4 8 8M12 4l-8 8" />
      </symbol>
      <symbol id="i-capture" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 13h3l7-7-3-3-7 7Z" />
        <path d="m9 4 3 3" />
      </symbol>
      <symbol id="i-review" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <path d="M8 2.5a5.5 5.5 0 1 0 5.5 5.5" />
        <path d="M8 5v3l2 1.5" />
        <path d="M13.5 2.5v3h-3" />
      </symbol>
      <symbol id="i-ops" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <path d="M2.5 11a5.5 5.5 0 1 1 11 0" />
        <path d="m8 11 2.6-3.4" />
      </symbol>
      <symbol id="i-branch" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <circle cx="4.5" cy="3.5" r="1.5" />
        <circle cx="4.5" cy="12.5" r="1.5" />
        <circle cx="11.5" cy="5.5" r="1.5" />
        <path d="M4.5 5v6M11.5 7c0 3-7 2-7 4" />
      </symbol>
      <symbol id="i-root" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
        <path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11Z" />
      </symbol>
      <symbol id="i-send" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2" />
      </symbol>
      <symbol id="i-menu" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
      </symbol>
      <symbol id="i-chats" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
        <path d="M2.5 3h11v7.5H7l-3 2.5v-2.5H2.5Z" />
      </symbol>
      <symbol id="i-server" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <rect x="2.5" y="2.5" width="11" height="4.5" rx="1" />
        <rect x="2.5" y="9" width="11" height="4.5" rx="1" />
      </symbol>
      <symbol id="i-file" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
        <path d="M4 2h5.5L12.5 5v9H4Z" />
        <path d="M9.5 2v3h3" />
      </symbol>
      <symbol id="i-wait" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <circle cx="8" cy="8" r="5.5" />
        <path d="M8 5v3.2l2 1.3" />
      </symbol>
      <symbol id="i-gear" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="8" r="2.2" />
        <path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2" />
      </symbol>
      <symbol id="i-history" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8" />
        <path d="M2.4 2.4v2.4h2.4" />
        <path d="M8 5.2v3l2 1.3" />
      </symbol>
      <symbol id="i-agent" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="5" width="10" height="8" rx="2" />
        <path d="M8 5V2.8" />
        <circle cx="8" cy="2.3" r="0.6" fill="currentColor" />
        <path d="M6 8.6v.8M10 8.6v.8M6.3 11h3.4" />
      </symbol>
      <symbol id="i-external" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12.5 9v4.5h-10v-10H7" />
        <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5" />
      </symbol>
      <symbol id="i-sync" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M13.2 6.4A5.4 5.4 0 0 0 3.3 5.2" />
        <path d="M2.8 9.6a5.4 5.4 0 0 0 9.9 1.2" />
        <path d="M13.4 2.6v3.8H9.6" />
        <path d="M2.6 13.4V9.6h3.8" />
      </symbol>
      <symbol id="i-diagram" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
        <path d="M8 1.6 14.4 8 8 14.4 1.6 8Z" />
      </symbol>
      <symbol id="i-full" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />
      </symbol>
      <symbol id="i-unfull" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5" />
      </symbol>
      <symbol id="i-palette" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 1.8a6.2 6.2 0 1 0 0 12.4c1 0 1.4-.7 1.1-1.5-.4-1 .2-1.9 1.3-1.9h1.4a2.4 2.4 0 0 0 2.4-2.4C14.2 4.6 11.4 1.8 8 1.8Z" />
        <circle cx="5" cy="7" r=".8" />
        <circle cx="7.6" cy="4.6" r=".8" />
        <circle cx="10.6" cy="5.6" r=".8" />
      </symbol>
      <symbol id="i-flag" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 9V1.3M2.5 1.5h5L6.3 3.6l1.2 2.1h-5" />
      </symbol>
      <symbol id="i-bell" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1.2 1.2H2.8Z" />
        <path d="M6.6 14a1.5 1.5 0 0 0 2.8 0" />
      </symbol>
      <symbol id="i-bell-off" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1.2 1.2H2.8Z" />
        <path d="M6.6 14a1.5 1.5 0 0 0 2.8 0" />
        <path d="M2 2l12 12" />
      </symbol>
    </svg>
  );
}

export function Icon({ id, className }: { id: IconId; className?: string }) {
  return (
    <svg className={className} aria-hidden="true" focusable="false">
      <use href={`#${id}`} />
    </svg>
  );
}

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'title'> & {
  label: string;
  tip?: string;
  icon?: IconId;
  ref?: Ref<HTMLButtonElement>;
};

export function IconButton({ label, tip, icon, className = 'icon-btn', type = 'button', children, ...rest }: IconButtonProps) {
  return (
    <button type={type} className={className} aria-label={label} title={tip ?? label} {...rest}>
      {icon && <Icon id={icon} />}
      {children}
    </button>
  );
}

export function SignMark({ sign, className, label }: { sign: Sign; className?: string; label?: string | false }) {
  const { shape, label: name } = SIGNS[sign];
  const text = label === false ? undefined : (label ?? name);
  return (
    <svg
      className={`sign${className ? ` ${className}` : ''}`}
      focusable="false"
      {...(text ? { role: 'img', 'aria-label': text } : { 'aria-hidden': true })}
    >
      <use href={`#${shape}`} />
    </svg>
  );
}

export function ShapeMark({ shape, className }: { shape: SignShape; className?: string }) {
  return (
    <svg className={`sign${className ? ` ${className}` : ''}`} aria-hidden="true" focusable="false">
      <use href={`#${shape}`} />
    </svg>
  );
}
