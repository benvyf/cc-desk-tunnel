import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, type Session, type EventPayload } from '@cc-desk-tunnel/protocol';

// A desktop window with a preview, and one finished turn in a project on this computer: Claude edited a file,
// read part of another, edited a file on the service, and replied with links to a folder and an archive.
// Only this fake desktop bridge is installed; no Electron IPC, filesystem, server or model is used.
const address = 'ws://127.0.0.1:18921/ws';
const project = 'D:\\工作\\工具';
const source = Array.from({ length: 80 }, (_, index) =>
  index === 41 ? '  return 2;' : index === 40 ? 'function main() {' : `// 第 ${index + 1} 行`,
).join('\r\n');

async function open(page: Page) {
  await page.addInitScript(
    ({ source }) => {
      const noop = async () => {};
      const listener = () => () => {};
      const calls = ((window as any).toolPathCalls = {
        reads: [] as string[],
        acts: [] as [string, string][],
        inspected: [] as string[],
      });
      (window as any).desktop = {
        dev: true,
        platform: 'win32',
        version: async () => '0.0.1',
        boot: { connection: '', shared: { connections: [], busy: [] } },
        device: async () => ({ id: 'tool-path-device', name: 'Tool path fixture' }),
        loadLogin: async () => null,
        saveLogin: noop,
        disconnectProxy: noop,
        connectProxy: async () => ({ url: 'ws://127.0.0.1:18921/ws' }),
        workspaceRoots: async () => [],
        foldersExist: async (folders: string[]) => folders.map(() => true),
        setBusy: noop,
        saveShared: noop,
        onSharedChanged: listener,
        onNotifyClicked: listener,
        onUpdateProgress: listener,
        onSchedulesChanged: listener,
        loadSchedules: async () => ({ path: '', text: '' }),
        notify: noop,
        gitBranch: async () => null,
        copyText: noop,
        openLink: noop,
        inspectPath: async (path: string) => {
          calls.inspected.push(path);
          return {
            kind: /\\(?:src|dist)$/.test(path) ? 'directory' : 'file',
            runs: false,
            editors: [],
            openWith: true,
          };
        },
        actOnPath: async (action: string, path: string) => {
          calls.acts.push([action, path]);
          return '';
        },
        preview: {
          list: async () => [],
          read: async ({ path }: { path: string }) => {
            calls.reads.push(path);
            return { path, kind: 'text', text: source };
          },
          watch: noop,
          unwatch: noop,
          onChanged: listener,
          onState: listener,
          releaseFile: noop,
          release: noop,
          bounds: noop,
          hide: noop,
        },
      };
    },
    { source },
  );
  const now = new Date().toISOString(),
    connectionId = randomUUID(),
    runId = randomUUID();
  const session: Session = {
    id: randomUUID(),
    title: '工具路径',
    autoTitle: false,
    projectPath: project,
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  const tool = (toolId: string, name: string, input: unknown): EventPayload[] => [
    { type: 'tool.requested', toolId, name, input: JSON.stringify(input), target: 'Windows' },
    { type: 'tool.result', toolId, status: 'completed', output: 'ok', exitCode: null },
  ];
  const payloads: EventPayload[] = [
    { type: 'message.user', messageId: randomUUID(), text: '改一下', scenario: 'chat' },
    ...tool('edit', 'Edit', {
      file_path: `${project}\\src\\main.ts`,
      old_string: 'function main() {\n  return 1;',
      new_string: 'function main() {\n  return 2;',
    }),
    ...tool('read', 'Read', { file_path: `${project}\\notes.txt`, offset: 30, limit: 10 }),
    ...tool('server', 'Edit', {
      file_path: '/data/state/server.ts',
      old_string: 'a',
      new_string: 'b',
    }),
    {
      type: 'text.delta',
      messageId: randomUUID(),
      text: '改好了，见 [源码目录](src) 和 [打包文件](build.zip)。',
    },
    { type: 'run.status', status: 'completed', connectionId },
  ];
  const events = payloads.map((payload, index) => ({
    sessionId: session.id,
    runId,
    sequence: index + 1,
    createdAt: now,
    payload,
  }));
  await page.routeWebSocket(address, (route) => {
    const reply = (value: unknown) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth') {
        reply({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId,
          adapter: 'claude-code',
          sessions: [session],
        });
        return;
      }
      if (message.type === 'session.subscribe')
        reply({
          type: 'session.snapshot',
          requestId: message.requestId,
          session,
          mode: 'replace',
          firstSequence: 1,
          lastSequence: events.length,
          hasEarlier: false,
          events,
        });
      reply({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill(address);
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('tool-path-fixture-token-with-enough-characters');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page
    .locator('.session-row')
    .filter({ hasText: session.title })
    .locator('.session-select')
    .click();
  await expect(page.locator('.workspace .message.assistant')).toContainText('改好了');
}
const calls = (page: Page) =>
  page.evaluate(
    () =>
      (window as any).toolPathCalls as {
        reads: string[];
        acts: [string, string][];
        inspected: string[];
      },
  );
// A tool's card, opened.
async function card(page: Page, text: string) {
  const tool = page.locator('details.tool').filter({ hasText: text });
  // The turn's steps are folded under how long it took, and its edits and reads under what they did.
  if (!(await tool.isVisible()))
    for (const fold of ['3 步', '编辑了 2 个文件，读取了 1 个文件'])
      await page.getByText(fold, { exact: false }).first().click();
  if (!(await tool.evaluate((element: HTMLDetailsElement) => element.open)))
    await tool.locator('> summary').click();
  return tool;
}
const highlight = (page: Page, line: number) =>
  page.locator(`.preview-code-highlight[data-line="${line}"]`);

test('a tool card path opens its file in the preview, where the edit or the read is', async ({
  page,
}) => {
  await open(page);
  const edit = await card(page, 'main.ts');
  const path = edit.locator('.tool-input-path a');
  await expect(path).toHaveText(`${project}\\src\\main.ts`);
  await expect(path).toHaveAttribute('title', '在预览中打开');
  // The path is still the card's searchable text.
  await expect(edit.locator('.tool-input-path[data-search-content]')).toContainText('main.ts');
  // The edit's line is not in its call: the changed line is found in the file (whose lines end in \r\n).
  await path.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: /main\.ts/ })).toBeVisible();
  await expect(highlight(page, 42)).toBeVisible();
  expect(new Set((await calls(page)).reads)).toEqual(new Set([`${project}\\src\\main.ts`]));
  // A read goes to the line it started from.
  const read = await card(page, 'notes.txt');
  await read.locator('.tool-input-path a').click();
  await expect(page.getByRole('tab', { name: /notes\.txt/ })).toBeVisible();
  await expect(highlight(page, 30)).toBeVisible();
  expect((await calls(page)).acts).toEqual([]);
});

test('a tool card path that is not on this computer is not opened here', async ({ page }) => {
  await open(page);
  const server = await card(page, 'server.ts');
  const path = server.locator('.tool-input-path a');
  await expect(path).toHaveClass(/link-elsewhere/);
  await path.click();
  // It says why, as a reply's link to such a path does, and nothing on this computer is read or opened.
  await expect(page.getByRole('tooltip')).toContainText('服务端上的路径');
  const seen = await calls(page);
  expect(seen.reads).toEqual([]);
  expect(seen.acts).toEqual([]);
  expect(seen.inspected).toEqual([]);
});

test('a link to a folder opens it in the file manager, and one to an archive opens by the system', async ({
  page,
}) => {
  await open(page);
  const answer = page.locator('.workspace .message.assistant');
  await answer.getByRole('link', { name: '源码目录', exact: true }).click();
  await expect.poll(async () => (await calls(page)).acts).toEqual([['open', `${project}\\src`]]);
  await answer.getByRole('link', { name: '打包文件', exact: true }).click();
  await expect
    .poll(async () => (await calls(page)).acts)
    .toEqual([
      ['open', `${project}\\src`],
      ['open', `${project}\\build.zip`],
    ]);
  // Neither became a preview tab that could only say it is no file it can show.
  expect((await calls(page)).reads).toEqual([]);
  await expect(
    page.locator('.preview-tab, [role="tab"]').filter({ hasText: /src|build\.zip/ }),
  ).toHaveCount(0);
});
