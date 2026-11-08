import { createRoot } from 'react-dom/client';
import { MessageAttachments } from '../../src/AttachmentTiles.tsx';
import { splitAttachmentMessage } from '../../src/attachments.ts';

// A sent question's attachments as the desktop app shows them: its thumbnails come from the stub below. The whole
// picture (local-image://) cannot load in a browser, so opening one falls back to the thumbnail.
export function mount() {
  window.desktop = {
    attachmentPreview: async () =>
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
  } as unknown as NonNullable<Window['desktop']>;
  const count = Number(new URL(location.href).searchParams.get('pictures') ?? 2);
  const text = [
    '看看这些',
    ...Array.from({ length: count }, (_, index) => `"C:\\照片\\图${index + 1}.png"`),
    '"C:\\资料\\配置指南.md"',
  ].join('\n');
  const root = document.createElement('main');
  root.style.cssText = 'width:600px;margin:24px auto';
  root.innerHTML = '<div class="message user"><div class="message-content"></div></div>';
  document.body.replaceChildren(root);
  createRoot(root.querySelector('.message-content')!).render(
    <MessageAttachments items={splitAttachmentMessage(text).files} />,
  );
}
