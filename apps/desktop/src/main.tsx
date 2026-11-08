import React from 'react';
import ReactDOM from 'react-dom/client';
import WebGate from './WebGate.tsx';
import { App } from './App.tsx';
import InstallerCleanupDialog from './InstallerCleanupDialog.tsx';
import { getPrefs, onPrefs } from './prefs.ts';
import './style.css';

// For what the stylesheet lays out differently by system: the window buttons' side of the title bar.
document.documentElement.dataset.platform = window.desktop?.platform ?? 'browser';
// The colours and the faces chosen in the settings, set before the page first draws.
const showAppearance = () => {
  const { theme, replyFont, fontSizes } = getPrefs();
  if (document.documentElement.dataset.theme !== theme)
    document.documentElement.dataset.theme = theme;
  if (document.documentElement.dataset.replyFont !== replyFont)
    document.documentElement.dataset.replyFont = replyFont;
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
    {window.desktop && <InstallerCleanupDialog />}
  </React.StrictMode>,
);
