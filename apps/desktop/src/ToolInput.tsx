import type { ReactNode } from 'react';
import { diffLines } from './lineDiff.ts';
import type { Line } from './lineDiff.ts';

// What a tool call was given, in the shape its tool reads (spec §5.8): a command with what it is for, a change
// to a file as a diff, a path with the part read, a search with where it looks. Only a tool this does not know,
// or input that is not an object, is shown as its fields, indented. The raw input stays what "copy" copies
// where nothing better is shown.

type Fields = Record<string, unknown>;
const parse = (input: string): Fields | null => {
  try {
    const value = JSON.parse(input);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const diffText = (lines: Line[]) => lines.map((line) => `${line.kind}${line.text}`).join('\n');

function Diff({ lines }: { lines: Line[] }) {
  return (
    <pre className="tool-diff-view" data-search-content>
      {lines.map((line, index) => (
        <span
          key={index}
          className={line.kind === '+' ? 'added' : line.kind === '-' ? 'removed' : undefined}
        >
          <i aria-hidden="true">{line.kind === ' ' ? ' ' : line.kind === '-' ? '−' : '+'}</i>
          {line.text || ' '}
        </span>
      ))}
    </pre>
  );
}

const Path = ({ value, note }: { value: string; note?: string }) => (
  <p className="tool-input-path" data-search-content>
    <span>{value}</span>
    {note && <small>{note}</small>}
  </p>
);
const Meta = ({ items }: { items: (string | false | undefined)[] }) => {
  const shown = items.filter(Boolean);
  return shown.length ? <p className="tool-input-meta">{shown.join(' · ')}</p> : null;
};

export type ToolInputView = {
  // The small heading over it: what kind of thing was given.
  label: string;
  body: ReactNode;
  // What its copy button copies.
  copy: string;
};

export function toolInput(name: string, input: string): ToolInputView {
  const fields = parse(input);
  const fallback = (): ToolInputView => {
    const shown = fields ? JSON.stringify(fields, null, 2) : input;
    return {
      label: '输入',
      body: (
        <pre className="tool-input-json" data-search-content>
          {shown}
        </pre>
      ),
      copy: shown,
    };
  };
  if (!fields) return fallback();
  switch (name) {
    case 'Bash':
    case 'PowerShell': {
      const command = text(fields.command);
      if (!command) break;
      const timeout = number(fields.timeout);
      return {
        label: '命令',
        body: (
          <>
            {text(fields.description) && (
              <p className="tool-input-note">{text(fields.description)}</p>
            )}
            <pre className="tool-command" data-search-content>
              {command}
            </pre>
            <Meta
              items={[
                fields.run_in_background === true && '在后台运行',
                timeout !== undefined && `超时 ${Math.round(timeout / 1000)} 秒`,
              ]}
            />
          </>
        ),
        copy: command,
      };
    }
    case 'Edit':
    case 'MultiEdit': {
      const path = text(fields.file_path);
      const edits = (
        name === 'MultiEdit' && Array.isArray(fields.edits) ? fields.edits : [fields]
      ) as Fields[];
      if (!path || !edits.every((edit) => typeof edit?.new_string === 'string')) break;
      const diffs = edits.map((edit) => diffLines(text(edit.old_string), text(edit.new_string)));
      return {
        label: '修改',
        body: (
          <>
            <Path
              value={path}
              note={
                edits.length > 1
                  ? `${edits.length} 处修改`
                  : fields.replace_all === true
                    ? '全部替换'
                    : undefined
              }
            />
            {diffs.map((lines, index) => (
              <Diff key={index} lines={lines} />
            ))}
          </>
        ),
        copy: diffs.map(diffText).join('\n\n'),
      };
    }
    case 'Write': {
      const path = text(fields.file_path);
      if (!path || typeof fields.content !== 'string') break;
      const lines = diffLines('', fields.content);
      return {
        label: '写入',
        body: (
          <>
            <Path value={path} note={`${lines.length} 行`} />
            <Diff lines={lines} />
          </>
        ),
        copy: fields.content,
      };
    }
    case 'NotebookEdit': {
      const path = text(fields.notebook_path);
      if (!path) break;
      return {
        label: '修改',
        body: (
          <>
            <Path
              value={path}
              note={[
                text(fields.cell_id) && `单元格 ${text(fields.cell_id)}`,
                fields.edit_mode === 'delete'
                  ? '删除单元格'
                  : fields.edit_mode === 'insert'
                    ? '插入单元格'
                    : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            />
            {typeof fields.new_source === 'string' && (
              <Diff lines={diffLines('', fields.new_source)} />
            )}
          </>
        ),
        copy: text(fields.new_source) || path,
      };
    }
    case 'Read': {
      const path = text(fields.file_path);
      if (!path) break;
      const offset = number(fields.offset);
      const limit = number(fields.limit);
      const range =
        offset !== undefined && limit !== undefined
          ? `第 ${offset}–${offset + limit - 1} 行`
          : offset !== undefined
            ? `从第 ${offset} 行起`
            : limit !== undefined
              ? `前 ${limit} 行`
              : text(fields.pages)
                ? `第 ${text(fields.pages)} 页`
                : undefined;
      return { label: '文件', body: <Path value={path} note={range} />, copy: path };
    }
    case 'Grep':
    case 'Glob': {
      const pattern = text(fields.pattern);
      if (!pattern) break;
      const context = number(fields['-C']) ?? number(fields.context);
      return {
        label: '搜索',
        body: (
          <>
            <pre className="tool-command" data-search-content>
              {pattern}
            </pre>
            <Meta
              items={[
                text(fields.path) && `位置 ${text(fields.path)}`,
                text(fields.glob) && `文件 ${text(fields.glob)}`,
                text(fields.type) && `类型 ${text(fields.type)}`,
                fields['-i'] === true && '忽略大小写',
                fields.multiline === true && '跨行',
                context !== undefined && `上下文 ${context} 行`,
                fields.output_mode === 'content'
                  ? '显示匹配行'
                  : fields.output_mode === 'count'
                    ? '只计数'
                    : undefined,
              ]}
            />
          </>
        ),
        copy: pattern,
      };
    }
    case 'WebFetch':
    case 'WebSearch': {
      const target = text(fields.url) || text(fields.query);
      if (!target) break;
      return {
        label: name === 'WebFetch' ? '网址' : '搜索',
        body: (
          <>
            <Path value={target} />
            {text(fields.prompt) && <p className="tool-input-note">{text(fields.prompt)}</p>}
            <Meta
              items={[
                Array.isArray(fields.allowed_domains) &&
                  `只看 ${(fields.allowed_domains as unknown[]).map(text).join('、')}`,
                Array.isArray(fields.blocked_domains) &&
                  `排除 ${(fields.blocked_domains as unknown[]).map(text).join('、')}`,
              ]}
            />
          </>
        ),
        copy: target,
      };
    }
    case 'Agent':
    case 'Task': {
      const prompt = text(fields.prompt);
      if (!prompt) break;
      return {
        label: '子任务',
        body: (
          <>
            <p className="tool-input-note">
              <strong>{text(fields.description)}</strong>
              {text(fields.subagent_type) && <small>{text(fields.subagent_type)}</small>}
            </p>
            <pre className="tool-input-prose" data-search-content>
              {prompt}
            </pre>
          </>
        ),
        copy: prompt,
      };
    }
    case 'TodoWrite': {
      if (!Array.isArray(fields.todos)) break;
      const todos = fields.todos as Fields[];
      const mark = (status: unknown) =>
        status === 'completed' ? '✓' : status === 'in_progress' ? '›' : '○';
      return {
        label: '待办',
        body: (
          <ul className="tool-input-todos" data-search-content>
            {todos.map((todo, index) => (
              <li key={index} data-status={text(todo.status)}>
                <i aria-hidden="true">{mark(todo.status)}</i>
                {text(todo.content)}
              </li>
            ))}
          </ul>
        ),
        copy: todos.map((todo) => `${mark(todo.status)} ${text(todo.content)}`).join('\n'),
      };
    }
  }
  return fallback();
}

// What the approval asks, in words, over the call it is about (spec §5.8).
export function approvalQuestion(name: string) {
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return '允许运行这条命令？';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return '允许修改这个文件？';
    case 'Write':
      return '允许写入这个文件？';
    case 'Read':
      return '允许读取这个文件？';
    case 'Grep':
    case 'Glob':
      return '允许搜索这些文件？';
    case 'WebFetch':
      return '允许打开这个网址？';
    case 'WebSearch':
      return '允许搜索网页？';
    case 'Agent':
    case 'Task':
      return '允许启动这个子任务？';
    default:
      return `允许使用 ${name}？`;
  }
}
