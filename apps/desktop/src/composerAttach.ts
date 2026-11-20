// A path from the workspace tree (PreviewTree.tsx) goes into the message box as an attachment: dragged onto the
// box, which reads `pathMime`, or chosen from a row's menu, which asks the session's own box by this event. The
// box answers at once (the event is dispatched synchronously) with what came of it, which the tree tells.
export const pathMime = 'application/x-cc-space-path';
const event = 'cc-space:attach-path';
// 'busy': the box takes nothing now (no connection, a run it does not own, …); 'ssh': an SSH project's box takes
// no files; 'none': no box answered.
export type AttachResult = 'added' | 'duplicate' | 'busy' | 'ssh' | 'none';
type Detail = { path: string; result?: AttachResult };

export function attachToComposer(path: string): AttachResult {
  const detail: Detail = { path };
  window.dispatchEvent(new CustomEvent<Detail>(event, { detail }));
  return detail.result ?? 'none';
}

export function onAttachToComposer(listener: (path: string) => AttachResult) {
  const handle = (e: Event) => {
    const detail = (e as CustomEvent<Detail>).detail;
    detail.result = listener(detail.path);
  };
  window.addEventListener(event, handle);
  return () => window.removeEventListener(event, handle);
}

export const attachWords: Record<AttachResult, string> = {
  added: '已添加到输入框',
  duplicate: '输入框里已有这个路径',
  busy: '现在不能添加到输入框',
  ssh: 'SSH 项目暂不支持文件附件',
  none: '现在不能添加到输入框',
};
