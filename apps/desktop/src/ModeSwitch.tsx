import { MessagesSquare, SquareTerminal } from './icons.tsx';

export type WorkspaceMode = 'chat' | 'coding';
export default function ModeSwitch({
  mode,
  change,
}: {
  mode: WorkspaceMode;
  change: (mode: WorkspaceMode) => void;
}) {
  return (
    <div className="mode-switch" role="tablist" aria-label="工作模式">
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'chat'}
        onClick={() => change('chat')}
      >
        <MessagesSquare /> Chat
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'coding'}
        onClick={() => change('coding')}
      >
        <SquareTerminal /> Coding
      </button>
    </div>
  );
}
