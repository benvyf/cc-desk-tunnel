import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { diffLines } from './lineDiff.ts';
import { LinkPlace, linkTarget } from './links.ts';
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

// Whether the path of a file on a card opens when clicked: where the conversation shows files in its preview
// (Conversation.tsx). Elsewhere — a browser, a session on another computer, the approval dock — it is only text.
export const ToolPaths = createContext(false);

// Where in its file a card's path leads: a line, or text to look for there — an edit's, as its call does not say
// on which line it is. The longest text looked for is cut short, which still finds where it starts.
type At = { line?: number; find?: string[] };
const longestFind = 2000;

// A file's path is written as a reply's link is, so a click on it goes the way a reply's does (Conversation.tsx):
// the session's project decides whether it is on this computer, and the preview shows it.
function Path({ value, note, at }: { value: string; note?: string; at?: At }) {
  const place = useContext(LinkPlace);
  const linked = useContext(ToolPaths);
  // Encoded, so nothing in the path itself reads as a line (a.ts:12) or a web address.
  const href = encodeURIComponent(value) + (at?.line ? `:${at.line}` : '');
  const link = at && linked && place ? linkTarget(href, place) : null;
  return (
    <p className="tool-input-path" data-search-content>
      {link ? (
        <a
          href={href}
          data-link={href}
          data-find={at?.find?.length ? JSON.stringify(at.find) : undefined}
          className={link.kind === 'elsewhere' ? 'link-elsewhere' : undefined}
          title={link.kind === 'path' ? '在预览中打开' : undefined}
        >
          {value}
        </a>
      ) : (
        <span>{value}</span>
      )}
      {note && <small>{note}</small>}
    </p>
  );
}
// What to look for to find an edit in its file, the likeliest first: the new text from its first changed line
// (the lines before it are the old text's too), the whole new text, then the old text, for an edit not made
// yet; then the first line of each, should the file have changed since. A short first line ("}") would be found
// anywhere, so it is not looked for.
function editFind(before: string, after: string, lines: Line[]): string[] {
  const unchanged = lines.findIndex((line) => line.kind !== ' ');
  const changed = after
    .split('\n')
    .slice(unchanged < 0 ? 0 : unchanged)
    .join('\n');
  const first = (value: string) => {
    const line =
      value
        .split('\n')
        .find((part) => part.trim())
        ?.trim() ?? '';
    return line.length >= 8 ? line : '';
  };
  const found = [changed, after, before, first(changed), first(before)]
    .filter((value) => value.trim())
    .map((value) => value.slice(0, longestFind));
  return [...new Set(found)];
}
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
              at={{
                find: editFind(text(edits[0]!.old_string), text(edits[0]!.new_string), diffs[0]!),
              }}
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
            <Path value={path} note={`${lines.length} 行`} at={{ line: 1 }} />
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
              at={{}}
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
      return {
        label: '文件',
        body: <Path value={path} note={range} at={{ line: offset }} />,
        copy: path,
      };
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
    // What Claude asked, with the choices it offered; the answers are in the call's result below.
    case 'AskUserQuestion': {
      if (!Array.isArray(fields.questions)) break;
      const questions = (fields.questions as Fields[]).filter((item) => text(item?.question));
      if (!questions.length) break;
      const choices = (item: Fields) =>
        (Array.isArray(item.options) ? (item.options as Fields[]) : [])
          .map((option) => text(option?.label))
          .filter(Boolean);
      return {
        label: '提问',
        body: (
          <ul className="tool-input-questions" data-search-content>
            {questions.map((item, index) => (
              <li key={index}>
                <strong>{text(item.question)}</strong>
                {choices(item).length > 0 && <small>{choices(item).join(' · ')}</small>}
              </li>
            ))}
          </ul>
        ),
        copy: questions
          .map((item) => `${text(item.question)}\n${choices(item).join(' / ')}`)
          .join('\n\n'),
      };
    }
    case 'ExitPlanMode': {
      const plan = text(fields.plan);
      if (!plan) break;
      return {
        label: '计划',
        body: (
          <pre className="tool-input-prose" data-search-content>
            {plan}
          </pre>
        ),
        copy: plan,
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
    case 'ExitPlanMode':
      return '按这个计划开始执行？';
    default:
      return `允许使用 ${name}？`;
  }
}
