import type { Declined, Link } from './links.ts';
import type { MenuItem } from './ui.tsx';

// What a click on a link does, and what its menu offers. `tell` shows a short message to the user.
type Tell = (text: string) => void;

export async function followLink(link: Link, tell: Tell) {
  try {
    if (link.kind === 'web') {
      if (window.desktop) await window.desktop.openLink(link.url);
      else window.open(link.url, '_blank', 'noopener,noreferrer');
    } else if (link.kind === 'elsewhere') tell(`${link.reason}右键可复制路径。`);
    else {
      const { line, column } = link;
      const said = await window.desktop!.actOnPath('open', link.path, { line, column });
      if (said) tell(said);
    }
  } catch {
    tell('没能打开这个链接。');
  }
}

// A path the preview declined (preview.ts `follow`) is shown in the file manager: a folder opens there, and a
// file is shown in its folder — a click never hands a file to the system to open, as that may run it; the
// menu still offers the ways to open it (linkMenu).
export async function openDeclined(
  link: Extract<Link, { kind: 'path' }>,
  declined: Declined,
  tell: Tell,
) {
  const folder = declined.kind === 'directory' && !declined.runs;
  try {
    const said = await window.desktop!.actOnPath(folder ? 'open' : 'reveal', link.path);
    if (said) tell(said);
    else if (declined.runs) tell('它会运行程序，不直接打开，已在文件夹中显示。');
    else if (!folder) tell('此类型无法在预览中查看，已在文件夹中显示；右键可选择打开方式。');
  } catch {
    tell('没能打开这个链接。');
  }
}

export const fileManager = () =>
  ({ win32: '资源管理器', darwin: '访达', linux: '文件管理器' })[
    window.desktop?.platform ?? 'win32'
  ];

// `guard` stands before opening a web link: it may ask first (see `useLinkDoubt`).
export async function linkMenu(
  link: Link,
  tell: Tell,
  copy: (text: string) => void,
  guard: (go: () => void) => void = (go) => go(),
  // `kind`: what the path is on this computer, where the desktop said so.
): Promise<{ heading?: string; items: MenuItem[]; kind?: 'file' | 'directory' | 'missing' }> {
  if (link.kind === 'web')
    return {
      items: [
        { label: '打开链接', run: () => guard(() => void followLink(link, tell)) },
        { label: '复制链接地址', run: () => copy(link.url) },
      ],
    };
  const copyPath: MenuItem = { label: '复制路径', run: () => copy(link.path) };
  if (link.kind === 'elsewhere') return { heading: link.reason, items: [copyPath] };
  const desktop = window.desktop!;
  const info = await desktop.inspectPath(link.path);
  const act = (action: Parameters<typeof desktop.actOnPath>[0], editor?: string) => () =>
    void desktop
      .actOnPath(action, link.path, { line: link.line, column: link.column, editor })
      .then(
        (said) => said && tell(said),
        () => tell('操作失败，请重试。'),
      );
  const reveal: MenuItem = { label: `在${fileManager()}中显示`, run: act('reveal') };
  if (info.kind === 'missing')
    return { heading: '本机找不到这个路径', items: [copyPath], kind: 'missing' };
  if (info.kind === 'directory')
    return {
      kind: 'directory',
      heading: info.runs ? '它会运行程序，不直接打开' : undefined,
      items: [...(info.runs ? [] : [{ label: '打开文件夹', run: act('open') }]), reveal, copyPath],
    };
  const at = link.line ? `（第 ${link.line} 行）` : '';
  // "打开" goes to the editor when there is a line to go to, so the default application is then a choice of its own.
  const items: MenuItem[] = [
    ...(info.runs ? [] : [{ label: '打开', run: act('open') }]),
    ...info.editors.map((editor) => ({
      label: `在 ${editor.name} 中打开${at}`,
      run: act('editor', editor.scheme),
    })),
    ...(!info.runs && link.line && info.editors.length
      ? [{ label: '在默认应用中打开', run: act('default') }]
      : []),
    ...(!info.runs && info.openWith ? [{ label: '打开方式…', run: act('with') }] : []),
  ];
  return {
    kind: 'file',
    heading: info.runs ? '它会运行程序，不直接打开' : undefined,
    items: [
      ...items,
      { ...reveal, separated: items.length > 0 },
      copyPath,
      { label: '复制文件内容', run: act('content') },
      { label: '另存为…', run: act('save') },
    ],
  };
}
