import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Composer from '../../src/Composer.tsx';
import { useDrafts } from '../../src/drafts.ts';
import { attachmentMessage } from '../../src/attachments.ts';
import type { Session } from '@cc-desk-tunnel/protocol';

export function mount() {
  const root = document.createElement('main');
  root.style.cssText = 'padding:24px;max-width:760px;margin:auto';
  document.body.replaceChildren(root);
  window.desktop = {
    gitBranch: async () => null,
    chooseFiles: async () =>
      new URL(location.href).searchParams.has('reference')
        ? ['schema.json', 'style.css', 'document-3.ts', 'document-4.ts'].map(
            (name) => `C:\\资料\\${name}`,
          )
        : root.dataset.more === 'true'
          ? Array.from({ length: 8 }, (_, index) => `C:\\资料\\更多文件-${index}.pdf`)
          : ['C:\\资料\\schema.json', 'C:\\照片\\风景.png'],
    pathForFile: () => '',
    saveImage: async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
      if (root.dataset.fail === 'true') throw new Error('磁盘空间不足');
      return 'C:\\照片\\截图.png';
    },
    attachmentPreview: async () =>
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
    loadDrafts: async () => {
      const saved = JSON.parse(localStorage.getItem('attachment-test-drafts') ?? '{}');
      const delay = Number(new URL(location.href).searchParams.get('loadDelay'));
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      return saved;
    },
    saveDrafts: async (value: unknown) => {
      localStorage.setItem('attachment-test-drafts', JSON.stringify(value));
    },
  } as unknown as NonNullable<Window['desktop']>;
  function Demo() {
    const [id, setId] = useState('one');
    const [drafts, setDraft, attachments, setAttachments] = useDrafts();
    return (
      <>
        <button onClick={() => setId(id === 'one' ? 'two' : 'one')}>切换会话</button>
        <button
          onClick={() => {
            root.dataset.fail = 'true';
          }}
        >
          模拟失败
        </button>
        <output aria-label="当前会话">{id}</output>
        <button
          onClick={() => {
            root.dataset.more = 'true';
          }}
        >
          更多附件
        </button>
        <Composer
          session={{ id, projectPath: 'C:\\项目', permissionMode: 'default' } as Session}
          draft={drafts[id] ?? ''}
          setDraft={(text) => setDraft(id, text)}
          attachments={attachments[id] ?? []}
          setAttachments={setAttachments}
          projectName="附件测试"
          native={false}
          connected
          busy={false}
          refreshing={false}
          canRefreshModels
          ownsRun
          inputDisabled={false}
          controlsDisabled={false}
          slashOpen={false}
          setSlashOpen={() => {}}
          canCompact={false}
          scenario="chat"
          setScenario={() => {}}
          capabilities={null}
          nativeSession={null}
          metrics={null}
          openAccount={() => {}}
          send={(text) => {
            root.dataset.sent = text ?? attachmentMessage(drafts[id] ?? '', attachments[id] ?? []);
          }}
          compact={() => {}}
          refresh={() => {}}
          configure={async () => {}}
          stop={() => {}}
        />
      </>
    );
  }
  createRoot(root).render(<Demo />);
}
