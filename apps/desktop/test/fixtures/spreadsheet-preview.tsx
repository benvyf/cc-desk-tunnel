import { createRoot } from 'react-dom/client';
import PreviewSidebar from '../../src/PreviewSidebar.tsx';
import { usePreviewWorkspace, type PreviewFile } from '../../src/preview.ts';
import '../../src/style.css';

window.desktop = {
  preview: {
    read: async ({ path }: { path: string }) => {
      const format = path.split('.').at(-1)!;
      const data = (window as any).spreadsheetFixtures[format];
      return { path, kind: 'spreadsheet', format, data } as PreviewFile;
    },
    onState: () => () => {},
    hide: async () => {},
    release: async () => {},
  },
} as unknown as NonNullable<Window['desktop']>;
function Fixture() {
  const board = usePreviewWorkspace('spreadsheet-fixture', 'session', 'main', 'session');
  return (
    <main style={{ display: 'flex', height: '100vh', minWidth: 0 }}>
      <div>
        {['xlsx', 'xls', 'csv', 'tsv', 'bad'].map((extension) => (
          <button key={extension} onClick={() => board.openFile(`C:\\成果\\表格.${extension}`)}>
            打开 {extension}
          </button>
        ))}
      </div>
      {board.expanded && <PreviewSidebar workspace={board} />}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
