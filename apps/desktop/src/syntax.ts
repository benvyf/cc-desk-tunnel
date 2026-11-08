import hljs from 'highlight.js/lib/common';
import powershell from 'highlight.js/lib/languages/powershell';

hljs.registerLanguage('powershell', powershell);

export function syntaxMarkup(text: string, language: string): string {
  if (text.length > 100000 || !hljs.getLanguage(language)) return '';
  return hljs.highlight(text, { language, ignoreIllegals: true }).value;
}
