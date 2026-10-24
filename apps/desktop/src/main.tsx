import React from 'react';
import ReactDOM from 'react-dom/client';
import WebGate from './WebGate.tsx';
import { App } from './App.tsx';
import { getPrefs, onPrefs } from './prefs.ts';
import './style.css';

// For what the stylesheet lays out differently by system: the window buttons' side of the title bar.
document.documentElement.dataset.platform = window.desktop?.platform ?? 'browser';
// The colours chosen in the settings, set before the page first draws.
const showAppearance = () => {
  const { theme, fontSizes } = getPrefs();
  if (document.documentElement.dataset.theme !== theme)
    document.documentElement.dataset.theme = theme;
  for (const [key, value] of Object.entries(fontSizes)) {
    const property = `--${key}-font-size`;
    if (document.documentElement.style.getPropertyValue(property) !== `${value}px`)
      document.documentElement.style.setProperty(property, `${value}px`);
  }
};
showAppearance();
onPrefs(showAppearance);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {!window.desktop && !import.meta.env.DEV ? <WebGate /> : <App />}
  </React.StrictMode>,
);
