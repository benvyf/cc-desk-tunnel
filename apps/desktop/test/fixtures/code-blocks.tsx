import { createRoot } from 'react-dom/client';
import RichText from '../../src/RichText.tsx';
import { CopyButton } from '../../src/copy.tsx';

export function mount() {
  const host = document.createElement('main');
  host.className = 'message-content';
  host.style.cssText = 'width:min(672px,calc(100% - 32px));margin:24px auto';
  document.body.replaceChildren(host);
  const root = createRoot(host);
  const renderCodeFixture = (text: string, streaming = false) =>
    root.render(<RichText text={text} streaming={streaming} />);
  Object.assign(window, {
    renderCodeFixture,
    renderCopyFixture: () => root.render(<CopyButton text="shared clipboard text" />),
    unmountCodeFixture: () => root.unmount(),
  });
  renderCodeFixture(
    '```typescript\n// Claude Design System - Grapheme Reveal\nconst animation = "90ms cubic-bezier(.215, .61, .355, 1) both _grapheme-reveal_1plog_1";\n```',
  );
}
