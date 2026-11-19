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

// The hosts a link's text names: every web address in it, https://a.b/c or //a.b, and every bare one, www.a.b,
// a.b/c, or a.com (a.com?x, a.com#y) among the common endings, also where Chinese runs on without a space
// (访问example.com). Words name none, and neither do a file name (README.md, main.rs), code (console.info()) or a
// product's name (ASP.NET, Socket.IO). Format characters (zero-width, bidirectional) are dropped first.
const commonEndings = new Set(
  'com net org io cn dev ai gov edu cc tv uk de jp hk tw xyz'.split(' '),
);
const products = new Set([
  'asp.net',
  'vb.net',
  'ado.net',
  'socket.io',
  'java.net',
  'java.io',
  'system.net',
]);
const invisible = /\p{Cf}/gu;
// An address with its scheme (or a protocol-relative one) runs to the next space, path and query included, so
// nothing after its host is read again as a site of its own; its host is the ASCII run after "//", which ends at
// punctuation such as 、》” that follows it in Chinese text.
const withScheme = /(?:https?:)?\/\/([a-z0-9.\-:[\]%@]*)\S*/giu;
// Not inside a longer name, a path, or an address (after "@"); "//" is read above.
const bare = /(?<![a-z0-9.@_-])(?<![^/]\/)((?:[a-z0-9-]+\.)+([a-z]{2,}))(?::\d+)?([/?#][^\s]*)?/giu;
function namedHosts(text: string) {
  const plain = text.replace(invisible, '');
  const hosts: { host: string; word: string; ending: string; hidden?: boolean }[] = [];
  const rest = plain.replace(withScheme, (_found, authority: string) => {
    // A user name before the host shows one site and names another: http://bank.com:80@evil.com.
    if (authority.includes('@')) hosts.push({ host: '', word: '', ending: '', hidden: true });
    else
      try {
        hosts.push({
          // A sentence's full stop or colon after the address is not its host's.
          host: new URL(`https://${authority.replace(/[.:]+$/, '')}`).hostname,
          word: '',
          ending: '',
        });
      } catch {}
    return ' ';
  });
  for (const [found, name, ending, after = ''] of rest.matchAll(bare)) {
    const lower = name!.toLowerCase();
    if (
      !/^www\./.test(lower) &&
      !after.startsWith('/') &&
      !commonEndings.has(ending!.toLowerCase())
    )
      continue;
    if (!after && products.has(lower)) continue;
    try {
      hosts.push({
        host: new URL(`https://${name}`).hostname,
        word: found,
        ending: ending!.toLowerCase(),
      });
    } catch {}
  }
  return hosts;
}
const bareHost = (host: string) => host.toLowerCase().replace(/^www\./, '');
// The file a link's address ends in, which a word of its text may name: README.org, main.cc. Only for endings files
// have as often as sites: a word ending in .com or .cn that the path repeats is still another site.
const fileEndings = new Set(['cc', 'org', 'dev', 'ai', 'io']);
function fileOf(url: URL) {
  const last = url.pathname.split('/').pop() ?? '';
  try {
    return decodeURIComponent(last).toLowerCase();
  } catch {
    return last.toLowerCase();
  }
}

// Why a click on a web link is asked about before it is followed, or null when it is not: its text reads as
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
  const site = bareHost(target.hostname),
    file = fileOf(target);
  const named = namedHosts(text).filter(
    ({ word, ending }) => !(word && fileEndings.has(ending) && word.toLowerCase() === file),
  );
  if (named.some(({ hidden }) => hidden))
    return '链接显示的地址带有用户名，实际打开的网站可能和看上去的不同。';
  // A text that names the site it leads to shows where it goes, whatever else it names.
  if (named.some(({ host }) => bareHost(host) === site)) return null;
  if (named.length) return '链接显示的地址和实际打开的地址不同。';
  return null;
}

// What a link in a reply leads to, as written in its Markdown (which may have percent-encoded it). A web address
// opens anywhere. A path is on the computer the session's project is on, unless it is plainly of another system:
// a reply may name a file on the service, where Claude Code runs, which is no file of the user's.
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
