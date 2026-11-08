import type { Root } from 'mdast';
import { createContext } from 'react';
import { isWindowsPath } from '@cc-desk-tunnel/protocol';
import { linkTarget } from './links.ts';
import type { Place } from './links.ts';
import type { Turn } from './transcript.ts';

export const FileMentionPaths = createContext<string[]>([]);

// Targets belong to this turn, even when a later turn writes a file with the same name.
export function producedFiles(turn: Turn): string[] {
  const paths = new Set<string>();
  for (const step of turn.steps) {
    if (step.kind !== 'work') continue;
    for (const item of step.items) {
      if (
        item.kind !== 'tool' ||
        item.state !== 'completed' ||
        !['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(item.name)
      )
        continue;
      try {
        const input = JSON.parse(item.input);
        const path = input?.file_path ?? input?.notebook_path;
        if (typeof path === 'string' && path.trim()) paths.add(path);
      } catch {
        // Partial or legacy tool arguments cannot identify a file.
      }
    }
  }
  return [...paths];
}

export function fileMentionCandidates(
  value: string,
  paths: string[],
  directory: string | undefined,
  place: Place | null,
): string[] {
  if (
    !place?.here ||
    !/\.[\p{L}\d]{1,12}(?::\d+(?::\d+)?)?$/u.test(value) ||
    /[\r\n\0]/.test(value)
  )
    return [];
  const key = (path: string) =>
    isWindowsPath(place.projectPath) ? path.replaceAll('/', '\\').toLowerCase() : path;
  const matches = new Map<string, string>();
  for (const path of paths) {
    const target = linkTarget(path, place);
    if (target?.kind !== 'path') continue;
    if (key(path) === key(value) || key(path.split(/[\\/]/).at(-1)!) === key(value))
      matches.set(key(target.path), target.path);
  }
  if (matches.size) return matches.size === 1 ? [...matches.values()] : [];
  // Command-generated documents may have no Write event. An explicit path, or a filename following
  // an explicit directory in this answer, is a candidate only; the renderer checks that it exists.
  const explicit = /^(?:[a-z]:[\\/]|\/|\.{1,2}[\\/])/i.test(value);
  const candidate = explicit
    ? value
    : directory && !/[\\/:]/.test(value)
      ? `${directory}${value}`
      : null;
  const target = candidate && linkTarget(candidate, place);
  return target && target.kind === 'path' ? [target.path] : [];
}

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hProperties?: Record<string, unknown> };
};

// Run on Markdown nodes so fences, ordinary prose and existing links never gain nested links.
export function remarkFileMentions({ paths, place }: { paths: string[]; place: Place | null }) {
  return (tree: Root) => {
    let directory: string | undefined;
    function visit(node: MarkdownNode) {
      if (node.type === 'link' || node.type === 'linkReference') return;
      if (node.type === 'inlineCode' && node.value) {
        const value = node.value;
        if (/^(?:[a-z]:[\\/]|\/|\.{1,2}[\\/]).*[\\/]$/i.test(value)) directory = value;
        const candidates = fileMentionCandidates(value, paths, directory, place);
        if (candidates.length)
          node.data = {
            ...node.data,
            hProperties: {
              ...node.data?.hProperties,
              'data-file-path': candidates[0],
            },
          };
      }
      node.children?.forEach(visit);
    }
    visit(tree);
  };
}
