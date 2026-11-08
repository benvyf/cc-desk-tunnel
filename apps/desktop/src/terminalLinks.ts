import type { ILinkProvider, Terminal } from '@xterm/xterm';

// Map UTF-16 offsets back to buffer cells; wide characters occupy two cells and
// combining characters can occupy no extra cells. Wrapped rows form one line.
export function terminalLinks(
  terminal: Terminal,
  activate: (target: string) => void,
): ILinkProvider {
  return {
    provideLinks(row, callback) {
      const buffer = terminal.buffer.active;
      let start = row - 1,
        end = start;
      while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
      while (end + 1 < buffer.length && buffer.getLine(end + 1)?.isWrapped) end++;
      let text = '';
      const cells: { x: number; y: number }[] = [];
      const ends: { x: number; y: number }[] = [];
      for (let y = start; y <= end; y++) {
        const line = buffer.getLine(y)!;
        for (let x = 0; x < line.length; x++) {
          const cell = line.getCell(x)!;
          if (!cell.getWidth()) continue;
          if (y < end && x === line.length - 1 && !cell.getChars()) continue;
          const chars = cell.getChars() || ' ';
          for (let i = 0; i < chars.length; i++) {
            cells.push({ x: x + 1, y: y + 1 });
            ends.push({ x: x + cell.getWidth(), y: y + 1 });
          }
          text += chars;
        }
      }
      const pattern =
        /(?<![\p{L}\p{N}_.\/\\:~\-])(?:["']((?:https?:\/\/|file:\/\/|[a-z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|~\/)[^"'\r\n]+)["']|https?:\/\/[^\s<>"']+|file:\/\/[^\s<>"']+|(?:[a-z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|~\/)[^\s<>"'|]+)/giu;
      const links = Array.from(text.matchAll(pattern), (match) => {
        const target = match[1] ?? match[0].replace(/[.,;，。；]+$/, '');
        const offset = match.index! + (match[1] ? 1 : 0);
        return {
          text: target,
          range: { start: cells[offset], end: ends[offset + target.length - 1] },
          activate: () => activate(target),
        };
      }).filter(
        (link) =>
          link.range.start &&
          link.range.end &&
          link.range.start.y <= row &&
          link.range.end.y >= row,
      );
      callback(links);
    },
  };
}

export function terminalTarget(raw: string): { kind: 'web' | 'path' | 'unknown'; value: string } {
  if (/^https?:\/\//i.test(raw)) return { kind: 'web', value: raw };
  if (/^file:/i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.hostname && url.hostname !== 'localhost') return { kind: 'unknown', value: raw };
      raw = decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, '$1');
    } catch {
      return { kind: 'unknown', value: raw };
    }
  }
  return { kind: /^(?:[a-z]:[\\/]|\/|\\\\)/i.test(raw) ? 'path' : 'unknown', value: raw };
}
