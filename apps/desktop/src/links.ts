import { createContext } from 'react';
import { isWindowsPath } from '@cc-desk-tunnel/protocol';

// Where the links of a conversation lead from: the session's project folder, whether this window can open what
// is in it (a desktop window on the computer the project is on), and whether it is a browser.
export type Place = { projectPath: string; here: boolean; browser: boolean };
export const LinkPlace = createContext<Place | null>(null);

export type Link =
  | { kind: 'web'; url: string }
  | { kind: 'path'; path: string; line?: number; column?: number }
  // A path this window cannot open; it can still be copied.
  | { kind: 'elsewhere'; path: string; reason: string };

// A line, and a column, at the end of a path: a.ts:12, a.ts:12:3, a.ts#L12, a.ts#L12C3, a.ts#L12-L20.
const position = /(?:#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?|:(\d+)(?::(\d+))?(?:-\d+)?)$/;

function decoded(text: string) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// file:///C:/a%20b/c.md is C:\a b\c.md; file://host/share is a path on another computer's share.
function fromFileUrl(written: string) {
  try {
    const url = new URL(written);
    const path = decoded(url.pathname);
    if (url.host && url.host !== 'localhost') return `\\\\${url.host}${path.replaceAll('/', '\\')}`;
    return /^\/[a-z]:\//i.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

// A path written relative to the project folder, as replies about a project often are.
function joined(base: string, relative: string) {
  const windows = isWindowsPath(base);
  const parts = base.split(windows ? /[\\/]/ : '/').filter((part, index) => !index || part);
  for (const part of relative.split(/[\\/]/)) {
    if (part === '..' && parts.length > 1) parts.pop();
    else if (part && part !== '.' && part !== '..') parts.push(part);
  }
  return parts.join(windows ? '\\' : '/') || '/';
}

// What a link in a reply leads to, as written in its Markdown (which may have percent-encoded it). A web address
// opens anywhere. A path is on the computer the session's project is on, unless it is plainly of another system:
// a reply may name a file on the service, where Claude Code runs, which is no file of the user's.
// The host a link's text names, when the text reads as a web address: https://a.b/c, www.a.b, a.b/c, or a bare
// a.com among the common endings. Text in words names none, and neither does a file name: README.md, main.rs.
const commonEndings = new Set(
  'com net org io cn dev ai app co gov edu me info xyz top cc tv uk de jp hk tw'.split(' '),
);
function namedHost(text: string) {
  const written = text.trim().replace(/[.,;:!?。，；：！？)）\]】」』>]+$/u, '');
  if (!written || /\s/.test(written)) return null;
  const domain = /^((?:[\p{L}\p{N}-]+\.)+([\p{L}]{2,}))(?::\d+)?(\/.*)?$/u.exec(written);
  if (
    !/^https?:\/\//i.test(written) &&
    !(
      domain &&
      (/^www\./i.test(written) || domain[3] || commonEndings.has(domain[2]!.toLowerCase()))
    )
  )
    return null;
  try {
    return new URL(/^https?:\/\//i.test(written) ? written : `https://${written}`).hostname;
  } catch {
    return null;
  }
}
const bareHost = (host: string) => host.toLowerCase().replace(/^www\./, '');

// Why a click on a web link is asked about before the browser opens, or null when it is not: its text reads as
// another address than the one it leads to, the address it leads to spells its host in look-alike letters
// (punycode, xn--), or it carries a user name before the host (https://bank.com@evil.example). A link in words
// opens at once: the card over it shows where. (After upstream 19720842, which asks on every click.)
export function linkDoubt(text: string, url: string): string | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return '这个地址无法识别。';
  }
  if (!/^https?:$/.test(target.protocol)) return null;
  if (target.username || target.password)
    return '地址里在网站名前带有用户名，实际打开的网站可能和看上去的不同。';
  if (target.hostname.split('.').some((label) => label.startsWith('xn--')))
    return '地址里的网站名用了特殊字符，可能是模仿其他网站的名字。';
  const named = namedHost(text);
  if (named && bareHost(named) !== bareHost(target.hostname))
    return '链接显示的地址和实际打开的地址不同。';
  return null;
}

export function linkTarget(href: string, place: Place | null): Link | null {
  const written = href.trim();
  if (/^(?:https?|mailto):/i.test(written)) {
    try {
      return { kind: 'web', url: new URL(written).href };
    } catch {
      return null;
    }
  }
  if (!place || !written || written.startsWith('#')) return null;
  const found = position.exec(written);
  const bare = found ? written.slice(0, found.index) : written;
  let path = /^file:/i.test(bare) ? fromFileUrl(bare) : decoded(bare);
  // Another kind of address; a drive letter is one letter.
  if (!path || /^[a-z][a-z\d+.-]+:/i.test(path)) return null;
  const elsewhere = (reason: string): Link => ({ kind: 'elsewhere', path: path!, reason });
  if (/^[\\/]{2}/.test(path)) return elsewhere('这是网络共享上的路径，不直接打开。');
  if (/^[~\\]/.test(path)) return elsewhere('这个路径不完整，没法确定在哪里。');
  const windows = isWindowsPath(place.projectPath);
  if (/^[a-z]:\//i.test(path) && windows) path = path.replaceAll('/', '\\');
  if (!isWindowsPath(path) && !path.startsWith('/')) path = joined(place.projectPath, path);
  if (isWindowsPath(path) !== windows)
    return elsewhere(
      windows
        ? '这是服务端上的路径，本机没有这个文件。'
        : '这是 Windows 上的路径，不在这个会话的电脑上。',
    );
  if (!place.here)
    return elsewhere(
      place.browser ? '在浏览器里打不开电脑上的文件。' : '这个会话的项目在另一台电脑上。',
    );
  const [line, column] = [found?.[1] ?? found?.[3], found?.[2] ?? found?.[4]].map(
    (value) => Number(value) || undefined,
  );
  return { kind: 'path', path, line, column };
}

// A picture on this computer reaches the page by an address the desktop serves (see file-links.cjs).
export const isPicture = (path: string) => /\.(?:png|jpe?g|gif|webp|bmp|avif|ico|svg)$/i.test(path);
export const localPicture = (path: string) => `local-image://file/${encodeURIComponent(path)}`;
