import { needsYou } from '../model/index.js';
import type { State } from '../state.js';
import { Icon } from './icons.js';
import { nextNeedsHref, useShell } from './Layout.js';
import type { Route } from './routes.js';

export function PhoneTabs({ state, route, sideOpen, paletteOpen }: { state: State; route: Route; sideOpen: boolean; paletteOpen: boolean }) {
  const shell = useShell();
  const tab = paletteOpen ? 'more' : sideOpen || route.page === 'topic' || route.page === 'diagram' || route.page === 'new' ? 'chats' : route.page === 'home' ? 'home' : 'more';
  const needs = needsYou(state).length;
  const needsHref = nextNeedsHref(state);
  return (
    <nav className="bottom-tabs" aria-label="Tabs">
      <a href="#/" aria-current={tab === 'home' ? 'page' : undefined}>
        <Icon id="i-home" />
        <span>Home</span>
      </a>
      <button type="button" aria-current={tab === 'chats' ? 'page' : undefined} aria-expanded={sideOpen} onClick={shell.openSide}>
        <Icon id="i-chats" />
        <span>Chats</span>
      </button>
      {needs > 0 && needsHref && (
        <a href={needsHref} aria-label={`${needs} waiting on you, open the oldest`}>
          <span className="needs-pill">{needs}</span>
          <span>Needs you</span>
        </a>
      )}
      <button type="button" aria-current={tab === 'more' ? 'page' : undefined} aria-haspopup="dialog" onClick={shell.openPalette}>
        <Icon id="i-more" />
        <span>More</span>
      </button>
    </nav>
  );
}
