import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/overpass/wght.css';
import '@fontsource-variable/overpass-mono/wght.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/legacy.css';
import { App } from './App.js';

if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent<{ type?: string; url?: string }>) => {
    if (event.data?.type === 'open' && event.data.url) location.hash = new URL(event.data.url).hash;
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
