import { useEffect, useState } from 'react';
import changelog from '../../../CHANGELOG.md?raw';
import { releaseSection, withoutRepositoryLinks } from './notes.ts';
import RichText from './RichText.tsx';
import { Modal } from './ui.tsx';

// What changed in a version, shown where the user decides about an upgrade. This program carries the notes up
// to its own version; those of a newer one are read when the dialog opens. The dialog names no outside site and
// offers no link away from it: notes that cannot be read are said to be unavailable.
export default function ReleaseNotes({
  version,
  onClose,
}: {
  version: string;
  onClose: () => void;
}) {
  const carried = releaseSection(changelog, version);
  const [fetched, setFetched] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (carried) return;
    if (!window.desktop) return setFailed(true);
    let current = true;
    window.desktop.releaseNotes(version).then(
      (text) => current && (text ? setFetched(text) : setFailed(true)),
      () => current && setFailed(true),
    );
    return () => {
      current = false;
    };
  }, [carried, version]);
  const text = (carried ?? fetched) && withoutRepositoryLinks((carried ?? fetched)!);
  return (
    <Modal title={`${version} 的更新内容`} onClose={onClose}>
      <div
        className="release-notes"
        // The window opens no page itself: a link goes to the user's browser.
        onClick={(event) => {
          const link = (event.target as HTMLElement).closest('a');
          if (!link?.href || !window.desktop) return;
          event.preventDefault();
          void window.desktop.openExternal(link.href).catch(() => {});
        }}
      >
        {text ? (
          <RichText text={text} />
        ) : (
          <p className="muted">{failed ? '暂时读不到这一版的更新内容。' : '正在读取…'}</p>
        )}
      </div>
      <div className="setting-actions">
        <button type="button" className="button primary" onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  );
}
