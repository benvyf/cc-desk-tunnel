import type { Root } from 'mdast';
import { createContext } from 'react';
import { isWindowsPath, pathKey } from '@cc-desk-tunnel/protocol';
import { linkTarget } from './links.ts';
import type { Place } from './links.ts';
import type { Turn } from './transcript.ts';

export const FileMentionPaths = createContext<string[]>([]);
const explicitPath = /^(?:[a-z]:[\\/]|\/|\.{1,2}[\\/])/i;
const location = /(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/;
const fileExtension = /\.[\p{L}\d]{1,12}$/u;

// Tool arguments and inline code are filesystem spelling, not URL destinations.
function rawPath(value: string, place: Place | null) {
  const target = linkTarget(encodeURIComponent(value), place);
  return target?.kind === 'path' ? target : null;
}

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
  if (!place?.here || !value || /[\r\n\0]/.test(value)) return [];
  const windows = isWindowsPath(place.projectPath);
  const key = (path: string) => (windows ? path.replaceAll('/', '\\').toLowerCase() : path);
  function resolve(written: string): string[] {
    // A directory explicitly named in this answer disambiguates bare filenames, including command outputs.
    if (
      directory &&
      !/[\\/:]/.test(written) &&
      (fileExtension.test(written) ||
        paths.some((path) => key(path.split(/[\\/]/).at(-1)!) === key(written)))
    ) {
      const separator = windows ? '\\' : '/';
      const target = rawPath(`${directory.replace(/[\\/]$/, '')}${separator}${written}`, place);
      return target ? [target.path] : [];
    }
    const authored = rawPath(written, place);
    const matches = new Map<string, string>();
    for (const path of paths) {
      const target = rawPath(path, place);
      if (!target) continue;
      if (
        key(target.path) === key(authored?.path ?? '') ||
        key(path.split(/[\\/]/).at(-1)!) === key(written)
      )
        matches.set(key(target.path), target.path);
    }
    if (matches.size) return matches.size === 1 ? [...matches.values()] : [];
    return explicitPath.test(written) && fileExtension.test(written) && authored
      ? [authored.path]
      : [];
  }
  const literal = resolve(value);
  return literal.length || !location.test(value) ? literal : resolve(value.replace(location, ''));
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
    let directoryUsed = false;
    function visit(node: MarkdownNode, inList = false) {
      if (node.type === 'link' || node.type === 'linkReference') return;
      const boundary = ['heading', 'blockquote', 'thematicBreak', 'code'].includes(node.type);
      if (boundary) directory = undefined;
      const inheritedDirectory = directory;
      if (node.type === 'inlineCode' && node.value) {
        const value = node.value;
        const candidates = fileMentionCandidates(value, paths, directory, place);
        if (directory && candidates.length && !explicitPath.test(value)) directoryUsed = true;
        if (candidates.length) {
          const path = candidates[0];
          const literal =
            rawPath(value, place)?.path === path ||
            paths.some((recorded) => recorded.split(/[\\/]/).at(-1) === value);
          const suffix = literal ? '' : (location.exec(value)?.[0] ?? '');
          const fallback = fileMentionCandidates(value, paths, undefined, place)[0];
          const checkDirectory =
            directory && !/[\\/]$/.test(directory) && fallback && fallback !== path
              ? rawPath(directory, place)?.path
              : undefined;
          node.data = {
            ...node.data,
            hProperties: {
              ...node.data?.hProperties,
              'data-file-path': path,
              'data-file-href': encodeURIComponent(path) + suffix,
              ...(checkDirectory
                ? {
                    'data-file-directory': checkDirectory,
                    'data-file-fallback': fallback,
                    'data-file-fallback-href': encodeURIComponent(fallback!) + suffix,
                  }
                : {}),
            },
          };
        }
        // A missing final separator is valid directory spelling too. Its child must exist before
        // becoming clickable; an actual file used here cannot have such a child.
        const recorded = paths.some((path) => {
          const target = rawPath(path, place);
          return (
            target && candidates.some((candidate) => pathKey(candidate) === pathKey(target.path))
          );
        });
        if (explicitPath.test(value) && !location.test(value) && !recorded) {
          directory = value;
          directoryUsed = false;
        }
      }
      node.children?.forEach((child) => visit(child, inList || node.type === 'list'));
      if (
        boundary ||
        (node.type === 'list' && !inList) ||
        (node.type === 'paragraph' &&
          !inList &&
          (directory === inheritedDirectory || directoryUsed))
      ) {
        directory = undefined;
        directoryUsed = false;
      }
    }
    visit(tree);
  };
}
