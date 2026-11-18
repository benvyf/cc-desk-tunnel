const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { stat } = require('node:fs/promises');
const path = require('node:path');
const { localPath } = require('./file-links.cjs');

// The changes of a project's working tree, for the changes panel: against HEAD, or against where the branch left a
// local branch or remote-tracking ref already on disk. Read only, and from the repository on disk only: one run of
// one fixed script, on this computer or over the SSH connection already open to a Linux device. Nothing here
// fetches, writes the index, runs hooks or reaches a network (docs/architecture.md, "网络边界").

const FILE_LIMIT = 2000;
const SECTION_LIMIT = 2 * 1024 * 1024;
const DIFF_LIMIT = 512 * 1024;
// Each section may reach its limit and the whole still fit.
const OUTPUT_LIMIT = 4 * SECTION_LIMIT + 1024 * 1024;
const TIMEOUT_SECONDS = 15;

// The script. It takes everything it is given as positional parameters, never as text of its own, and runs git
// only through `g`: no pager, no optional locks (status would write the index), no fsmonitor, hooks or network
// protocol, and every filter the repository configures for itself turned off. A diff never runs an external diff
// program or a text conversion. Sections are marked by a line of the caller's nonce, which no output can foresee.
const SCRIPT = String.raw`
set -u
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE \
  GIT_CONFIG GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_EXTERNAL_DIFF \
  GIT_PAGER GIT_SSH GIT_SSH_COMMAND GIT_ASKPASS GIT_PROXY_COMMAND 2>/dev/null
export GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_PAGER=cat LC_ALL=C
set -f
# Each parameter comes with one space before it, which goes: on Windows it has Node quote the parameter (git-changes.cjs).
for a do set -- "$@" "${'$'}{a# }"; shift; done
n=$1; mode=$2
mark() { printf '\n%s %s\n' "$n" "$1"; }
cap() { head -c "$1"; }
mark version; git version
F=
# Every filter any configuration names, included files and per-worktree ones too, is turned off by name.
for name in $(git config --includes --name-only --get-regexp '^filter\..*\.(clean|smudge|process|required)$' 2>/dev/null | sed 's/^filter\.\(.*\)\.[a-z]*$/\1/' | sort -u); do
  case $name in
    *[!A-Za-z0-9._-]*) mark error; echo unsafe_filter; exit 0 ;;
  esac
  F="$F -c filter.$name.clean= -c filter.$name.smudge= -c filter.$name.process= -c filter.$name.required=false"
  mark filtered; echo "$name"
done
g() {
  git --no-pager --no-optional-locks --literal-pathspecs -c core.fsmonitor=false -c core.untrackedCache=false \
    -c core.quotePath=false -c protocol.allow=never -c core.hooksPath=/dev/null -c diff.renameLimit=1000 \
    -c diff.external= -c diff.autoRefreshIndex=false $F "$@"
}
d() { g diff --no-ext-diff --no-textconv --no-color --ignore-submodules=dirty "$@"; }
top=$(g rev-parse --show-toplevel 2>/dev/null) || { mark error; echo not_repository; exit 0; }
cd "$top" || { mark error; echo not_repository; exit 0; }
if [ "$mode" = list ]; then
  mark top; printf '%s\n' "$top"
  mark branch; g symbolic-ref -q --short HEAD
  mark refs; g for-each-ref --count=500 --format='%(refname)' refs/heads refs/remotes
  base=$3
  if [ -n "$base" ]; then
    c=$(g rev-parse --verify --quiet --end-of-options "$base^{commit}") || { mark error; echo bad_ref; exit 0; }
    t=$(g merge-base "$c" HEAD) || { mark error; echo no_merge_base; exit 0; }
  else
    t=$(g rev-parse --verify --quiet HEAD) || t=$(g hash-object -t tree --stdin </dev/null)
  fi
  mark against; printf '%s\n' "$t"
  mark status; g status --porcelain=v2 -z --untracked-files=normal --ignore-submodules=dirty | cap $4
  mark names; d -M -z --name-status "$t" -- | cap $4
  mark numstat; d -M -z --numstat "$t" -- | cap $4
  mark committed; g diff --no-ext-diff --no-textconv --ignore-submodules=dirty -z --name-only "$t" HEAD -- 2>/dev/null | cap $4
else
  t=$3; p=$4; o=$5
  if [ "$6" = untracked ]; then
    mark untracked
    if [ -L "$p" ]; then echo link; readlink -- "$p" | cap 4096
    elif [ -f "$p" ]; then echo file; cap $7 < "$p"
    else echo other; fi
  elif [ -n "$o" ]; then mark diff; d -M -U3 "$t" -- "$o" "$p" | cap $7
  else mark diff; d -M -U3 "$t" -- "$p" | cap $7
  fi
fi
mark end
`;

// A full ref name of a local branch or a remote-tracking ref, and nothing that git could read as anything else.
function validRef(ref) {
  return (
    typeof ref === 'string' &&
    ref.length <= 256 &&
    /^refs\/(heads|remotes)\/[^\0-\x20\x7f~^:?*[\\]+$/.test(ref) &&
    !ref.includes('..') &&
    !ref.includes('@{') &&
    !ref.includes('//') &&
    !ref.endsWith('/') &&
    !ref.endsWith('.lock') &&
    !ref.split('/').some((part) => part.startsWith('.') || part.startsWith('-'))
  );
}
// A path as git lists it: relative to the top of the working tree, inside it.
function validPath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes('\0') &&
    !value.startsWith('/') &&
    !/^[A-Za-z]:/.test(value) &&
    // An untracked folder is listed with a slash at its end.
    !value
      .replace(/\/$/, '')
      .split(/[\\/]/)
      .some((part) => part === '..' || part === '.' || part === '')
  );
}
const validCommit = (value) =>
  typeof value === 'string' && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(value);

// The output's sections, as bytes: a limit is a limit of bytes, and a cut may fall inside a character.
function sections(output, nonce) {
  const buffer = Buffer.isBuffer(output) ? output : Buffer.from(String(output));
  const marker = Buffer.from(`\n${nonce} `);
  const result = {};
  let at = buffer.indexOf(marker);
  while (at >= 0) {
    const start = at + marker.length;
    const end = buffer.indexOf(0x0a, start);
    if (end < 0) break;
    const name = buffer.subarray(start, end).toString('utf8');
    const next = buffer.indexOf(marker, end + 1);
    const body = buffer.subarray(end + 1, next < 0 ? buffer.length : next);
    result[name] = name in result ? Buffer.concat([result[name], Buffer.from('\n'), body]) : body;
    at = next;
  }
  return result;
}
// A section cut at its limit keeps only its whole records: the last, cut short, would be a path that is not there.
function records(body, limit) {
  if (!body) return { text: '', cut: false };
  if (body.length < limit) return { text: body.toString('utf8'), cut: false };
  return { text: body.subarray(0, body.lastIndexOf(0) + 1).toString('utf8'), cut: true };
}
// Text up to a limit of bytes, and whether there was more.
function clip(body, limit) {
  if (body.length <= limit) return { text: body.toString('utf8'), truncated: false };
  return { text: body.subarray(0, limit).toString('utf8').replace(/�+$/, ''), truncated: true };
}
const text = (body) => (body ? body.toString('utf8') : '');

// `git status --porcelain=v2 -z`: the untracked paths, and those in conflict.
// `changed` holds what status found different from HEAD, in the index or the tree, having looked at the content
// of a file whose times alone changed (in memory: nothing is written).
function parseStatus(text) {
  const untracked = [];
  const conflicts = new Set();
  const changed = new Set();
  const records = text.split('\0');
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.startsWith('? ')) untracked.push(record.slice(2));
    else if (record.startsWith('u ')) {
      const path = record.split(' ').slice(10).join(' ');
      conflicts.add(path);
      changed.add(path);
    } else if (record.startsWith('1 ')) changed.add(record.split(' ').slice(8).join(' '));
    else if (record.startsWith('2 ')) {
      changed.add(record.split(' ').slice(9).join(' '));
      index++;
    }
  }
  return { untracked, conflicts, changed };
}
// `git diff -z --name-status`: a status, then one path, or two for a rename or copy.
function parseNames(text) {
  const files = [];
  const fields = text.split('\0');
  for (let index = 0; index + 1 < fields.length;) {
    const code = fields[index++];
    if (!code) continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = fields[index++];
      const filePath = fields[index++];
      if (filePath === undefined) break;
      files.push({ path: filePath, oldPath, status: letter === 'R' ? 'R' : 'A' });
    } else {
      const filePath = fields[index++];
      files.push({ path: filePath, status: letter === 'A' ? 'A' : letter === 'D' ? 'D' : 'M' });
    }
  }
  return files;
}
// `git diff -z --numstat`: added and deleted lines, `-` for both in a binary file; a rename names both paths after.
function parseNumstat(text) {
  const counts = new Map();
  const fields = text.split('\0');
  for (let index = 0; index < fields.length;) {
    const head = fields[index++];
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
    if (!match) continue;
    let filePath = match[3];
    if (filePath === '') {
      index++;
      filePath = fields[index++];
    }
    counts.set(
      filePath,
      match[1] === '-' ? { binary: true } : { added: Number(match[1]), deleted: Number(match[2]) },
    );
  }
  return counts;
}

function changes(parts, base) {
  const status = records(parts.status, SECTION_LIMIT);
  const names = records(parts.names, SECTION_LIMIT);
  const numstat = records(parts.numstat, SECTION_LIMIT);
  const { untracked, conflicts, changed } = parseStatus(status.text);
  const counts = parseNumstat(numstat.text);
  const committedRecords = records(parts.committed, SECTION_LIMIT);
  const committed = new Set(committedRecords.text.split('\0'));
  const committedCut = committedRecords.cut;
  // The diff does not refresh the index (it would write it), so a file whose times alone changed is listed as
  // modified with nothing changed. Such a one is left out unless status or the commits since the base say otherwise.
  const touchedOnly = (file) =>
    !status.cut &&
    !numstat.cut &&
    !committedCut &&
    file.status === 'M' &&
    !file.binary &&
    !file.added &&
    !file.deleted &&
    !changed.has(file.path) &&
    !committed.has(file.path);
  const files = parseNames(names.text)
    .map((file) => ({
      ...file,
      ...counts.get(file.path),
      ...(conflicts.has(file.path) ? { conflict: true } : {}),
    }))
    .filter((file) => !touchedOnly(file));
  const listed = new Set(files.map((file) => file.path));
  for (const filePath of untracked)
    if (!listed.has(filePath)) files.push({ path: filePath, status: 'U' });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const refs = text(parts.refs).split('\n').filter(validRef);
  const truncated = files.length > FILE_LIMIT || status.cut || names.cut || numstat.cut;
  const shown = files.slice(0, FILE_LIMIT);
  return {
    top: text(parts.top).trim(),
    branch: text(parts.branch).trim() || null,
    refs: {
      local: refs.filter((ref) => ref.startsWith('refs/heads/')),
      remote: refs.filter((ref) => ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')),
    },
    base: base || null,
    against: text(parts.against).trim(),
    files: shown,
    summary: {
      files: files.length,
      added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
      deleted: files.reduce((sum, file) => sum + (file.deleted ?? 0), 0),
      untracked: files.filter((file) => file.status === 'U').length,
    },
    truncated,
    filtered: text(parts.filtered).split('\n').filter(Boolean),
  };
}

const errors = {
  not_repository: '项目不在 Git 仓库中。',
  bad_ref: '找不到所选的对比分支。',
  no_merge_base: '所选分支与当前分支没有共同的历史。',
  unsafe_filter: '仓库配置了名称异常的过滤器，为安全起见不读取改动。',
};
// Git before 2.24 knows no --end-of-options; such a git is named for what it is, not taken for a missing repository.
function oldGit(parts) {
  const match = /git version (\d+)\.(\d+)/.exec(text(parts.version));
  return !!match && (Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 24));
}
function failure(parts) {
  if (oldGit(parts))
    return Object.assign(new Error('Git 版本过旧，读取改动需要 Git 2.24 或更新版本。'), {
      code: 'old_git',
    });
  const code = text(parts.error).trim();
  if (!code) return null;
  if (code === 'not_repository' && !text(parts.version).trim())
    return Object.assign(new Error('未找到 git 命令，无法读取改动。'), { code: 'no_git' });
  return Object.assign(new Error(errors[code] ?? '读取 Git 改动失败。'), { code });
}

// The single quote of a POSIX shell, for the command a remote shell is given.
const quoted = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

function createGitChanges({
  findShell,
  ssh,
  // For tests: another script, and a shorter time allowed.
  script = SCRIPT,
  timeoutSeconds = TIMEOUT_SECONDS,
  platform = process.platform,
  killTree,
} = {}) {
  // The latest list of each project, from which alone a file's diff may be asked.
  const listed = new Map();
  const running = new Map();

  async function local(root, args) {
    if (typeof root !== 'string' || !localPath(root, path.isAbsolute))
      throw new Error('请选择本机项目的绝对路径。');
    const directory = path.resolve(root);
    if (!(await stat(directory).catch(() => null))?.isDirectory())
      throw new Error('项目目录不存在。');
    const shell = platform === 'win32' ? await findShell() : '/bin/sh';
    if (!shell) throw new Error('未找到 Git for Windows，无法读取改动。');
    // MSYS would convert what looks like a path; and it expands a parameter Windows left unquoted, such as
    // src/[id]/page.tsx, as a pattern. Each carries a leading space, which has Node quote it (see SCRIPT).
    const env = { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' };
    return new Promise((resolve, reject) => {
      let done = false;
      const chunks = [];
      let size = 0;
      const finish = (error, output) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(output);
      };
      // Its own process group elsewhere, so that all of it can be ended at once; Windows ends the tree by taskkill.
      const child = spawn(shell, ['-c', script, 'cc-git', ...args.map((value) => ` ${value}`)], {
        cwd: directory,
        env,
        windowsHide: true,
        detached: platform !== 'win32',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const end = () => {
        if (!child.pid) return;
        if (platform === 'win32') killTree?.(child.pid);
        else
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
      };
      // Past the time allowed, the whole tree goes, and the answer does not wait for it: a shell killed alone would
      // leave its git behind, holding the output open.
      const timer = setTimeout(() => {
        end();
        finish(new Error('读取 Git 改动超时。'));
      }, timeoutSeconds * 1000);
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > OUTPUT_LIMIT) {
          end();
          finish(new Error('读取 Git 改动失败：输出过大。'));
        } else chunks.push(chunk);
      });
      child.once('error', () => finish(new Error('读取 Git 改动失败。')));
      child.once('close', () => finish(null, Buffer.concat(chunks)));
    });
  }
  async function remote(targetId, root, args) {
    if (typeof root !== 'string' || !root.startsWith('/') || root.includes('\0'))
      throw new Error('请选择 Linux 项目的绝对路径。');
    const command = [
      `cd -- ${quoted(root)} &&`,
      `timeout -k 2 ${TIMEOUT_SECONDS} sh -c ${quoted(SCRIPT)} cc-git`,
      // With the same leading space as here (SCRIPT takes one off), so a name that starts with a space keeps it.
      ...args.map((value) => quoted(` ${value}`)),
    ].join(' ');
    return ssh(targetId, command, { limit: OUTPUT_LIMIT });
  }
  async function execute({ root, targetId }, args) {
    const nonce = `@@cc-git-${randomBytes(12).toString('hex')}@@`;
    const output = await (targetId
      ? remote(targetId, root, [nonce, ...args])
      : local(root, [nonce, ...args]));
    const parts = sections(output, nonce);
    const error = failure(parts);
    if (error) throw error;
    if (!('end' in parts)) throw new Error('读取 Git 改动失败：输出不完整或过大。');
    return parts;
  }
  const key = ({ root, targetId }) => `${targetId ?? ''}\0${root}`;

  return {
    async list(input) {
      const base = input?.base ?? '';
      if (base && !validRef(base)) throw new Error('只能与本地分支或已有的远程跟踪分支对比。');
      if (input?.targetId !== undefined && typeof input.targetId !== 'string')
        throw new Error('设备无效。');
      // A newer question for the same project makes the older answer moot.
      const id = key(input);
      const turn = (running.get(id) ?? 0) + 1;
      running.set(id, turn);
      const parts = await execute(input, ['list', base, String(SECTION_LIMIT)]);
      const result = changes(parts, base);
      if (running.get(id) === turn)
        listed.set(id, {
          against: result.against,
          files: new Map(result.files.map((file) => [file.path, file])),
        });
      return result;
    },
    async fileDiff(input) {
      const latest = listed.get(key(input ?? {}));
      const file = latest?.files.get(input?.path);
      if (!latest || !file || latest.against !== input?.against || !validCommit(input.against))
        throw new Error('改动列表已过期，请刷新。');
      if (!validPath(file.path) || (file.oldPath && !validPath(file.oldPath)))
        throw new Error('文件路径无效。');
      const parts = await execute(input, [
        'file',
        file.status === 'U' ? '' : latest.against,
        file.path,
        file.oldPath ?? '',
        file.status === 'U' ? 'untracked' : 'tracked',
        String(DIFF_LIMIT + 1),
      ]);
      if ('untracked' in parts) {
        const body = parts.untracked;
        const line = body.indexOf(0x0a);
        const kind = body.subarray(0, line).toString('utf8');
        const content = body.subarray(line + 1);
        if (kind === 'link') return { kind: 'link', target: content.toString('utf8').trim() };
        if (kind !== 'file') return { kind: 'other' };
        if (content.subarray(0, 8000).includes(0)) return { kind: 'binary' };
        return { kind: 'new', ...clip(content, DIFF_LIMIT) };
      }
      const diff = parts.diff ?? Buffer.alloc(0);
      const head = diff.subarray(0, 64 * 1024).toString('utf8');
      if (/^Binary files /m.test(head) || /^GIT binary patch/m.test(head))
        return { kind: 'binary' };
      return { kind: 'diff', ...clip(diff, DIFF_LIMIT) };
    },
  };
}

module.exports = {
  SCRIPT,
  FILE_LIMIT,
  DIFF_LIMIT,
  createGitChanges,
  validRef,
  validPath,
  parseStatus,
  parseNames,
  parseNumstat,
  changes,
  sections,
};
