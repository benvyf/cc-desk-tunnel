import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { _electron, expect } from '@playwright/test';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '../../../packages/protocol/src/index.ts';
import { splitQuoteMessage } from '../src/quotes.ts';

test(
  'real desktop quote chats keep independent streams and never send local preview content',
  {
    skip: process.platform !== 'win32' || process.env.CC_QUOTE_ELECTRON_TEST !== '1',
    timeout: 120_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-quote-electron-'));
    const project = join(root, '项目');
    await mkdir(project);
    const html = join(project, 'index.html');
    const secret = 'LOCAL_PREVIEW_SECRET_NEVER_MODEL_INPUT';
    await writeFile(html, `<!doctype html><h1>${secret}</h1>`);
    const server = createServer((_, response) => response.end('fixture'));
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const sockets = new WebSocketServer({ server, path: '/ws' });
    const url = `ws://127.0.0.1:${server.address().port}/ws`;
    const calls = [],
      sessions = [],
      records = new Map();
    const connectionId = randomUUID(),
      createdAt = new Date().toISOString();
    const parentRunId = randomUUID();
    let connection;
    const add = (sessionId, payload, runId = parentRunId) => {
      const history = records.get(sessionId) ?? [];
      const event = { sessionId, runId, sequence: history.length + 1, createdAt, payload };
      history.push(event);
      records.set(sessionId, history);
      return event;
    };
    const emit = (sessionId, payload, runId) =>
      connection.send(
        JSON.stringify({ type: 'session.event', event: add(sessionId, payload, runId) }),
      );
    sockets.on('connection', (socket) => {
      connection = socket;
      const send = (value) => socket.send(JSON.stringify(value));
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        calls.push(message);
        const reply = (sessionId = message.sessionId) =>
          send({ type: 'response', requestId: message.requestId, ok: true, sessionId });
        if (message.type === 'device') return;
        if (message.type === 'auth') {
          send({
            type: 'ready',
            protocolVersion: PROTOCOL_VERSION,
            version: '0.3.7',
            connectionId,
            adapter: 'claude-code',
            sideConversations: true,
            sessions,
          });
          return;
        }
        if (message.type === 'session.subscribe') {
          const session = sessions.find((item) => item.id === message.sessionId);
          const events = records.get(session.id) ?? [];
          send({
            type: 'session.snapshot',
            requestId: message.requestId,
            session,
            mode: 'replace',
            firstSequence: events[0]?.sequence ?? 0,
            lastSequence: events.at(-1)?.sequence ?? 0,
            hasEarlier: false,
            events,
          });
        }
        if (message.type === 'session.side.create') {
          const parent = sessions.find((item) => item.id === message.sessionId);
          const child = {
            ...parent,
            id: randomUUID(),
            title: message.title,
            activeRun: null,
            sideConversation: {
              parentSessionId: parent.id,
              throughSequence: records.get(parent.id).length,
              createdAt,
            },
          };
          sessions.push(child);
          records.set(child.id, []);
          send({ type: 'session.updated', session: child });
          reply(child.id);
          return;
        }
        if (message.type === 'message.send') {
          const session = sessions.find((item) => item.id === message.sessionId);
          const runId = randomUUID();
          session.activeRun = { id: runId, status: 'running', connectionId };
          send({ type: 'session.updated', session });
          emit(
            session.id,
            {
              type: 'message.user',
              messageId: message.requestId,
              text: message.text,
              scenario: 'chat',
            },
            runId,
          );
          emit(
            session.id,
            {
              type: 'text.delta',
              messageId: randomUUID(),
              text: session.sideConversation ? '侧边独立输出' : '主会话独立输出',
            },
            runId,
          );
        }
        if (message.type === 'run.cancel') {
          const session = sessions.find((item) => item.id === message.sessionId);
          const runId = session.activeRun.id;
          session.activeRun = null;
          emit(session.id, { type: 'run.status', status: 'cancelled', connectionId }, runId);
          send({ type: 'session.updated', session });
        }
        if (message.requestId) reply();
      });
    });
    const wrapper = join(root, 'entry.cjs');
    await writeFile(
      wrapper,
      `
      const {app,net,ipcMain}=require('electron');
      app.commandLine.appendSwitch('no-proxy-server');
      app.setPath('userData',${JSON.stringify(join(root, 'profile'))});
      app.setPath('sessionData',${JSON.stringify(join(root, 'profile'))});
      net.fetch=async(url)=>{
        if(url.endsWith('/login'))return Response.json({email:'fixture@example.invalid',token:'fixture',workspaces:[{id:'fixture',name:'fixture'}]});
        if(url.endsWith('/workspaces'))return Response.json({workspaces:[{id:'fixture',name:'fixture'}]});
        if(url.endsWith('/connect'))return Response.json({url:'wss://fixture.invalid/ws',fingerprint:'',token:'ccs_'+'x'.repeat(43)});
        throw Error('External network request forbidden in quote fixture');
      };
      require(${JSON.stringify(resolve('apps/desktop/electron/main.cjs'))});
      ipcMain.removeHandler('proxy:connect');
      ipcMain.handle('proxy:connect',()=>({url:${JSON.stringify(url)}}));
    `,
    );
    let app, page;
    const errors = [];
    const launch = () =>
      _electron.launch({
        executablePath: resolve('node_modules/electron/dist/electron.exe'),
        args: [wrapper, '--smoke-test'],
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE'),
        ),
      });
    try {
      app = await launch();
      page = await app.firstWindow();
      page.on('pageerror', (error) => errors.push(error.message));
      const device = await page.evaluate(() => window.desktop.device());
      const parent = {
        id: randomUUID(),
        title: '引用集成测试',
        autoTitle: false,
        projectPath: project,
        device,
        permissionMode: 'auto',
        model: 'sonnet',
        effort: 'medium',
        createdAt,
        updatedAt: createdAt,
        activeRun: null,
      };
      sessions.push(parent);
      const answer = `引用测试回答。\n\n[页面](${html.replaceAll('\\', '/')})`;
      add(parent.id, {
        type: 'message.user',
        messageId: randomUUID(),
        text: '说明引用',
        scenario: 'chat',
      });
      add(parent.id, { type: 'text.delta', messageId: randomUUID(), text: answer });
      add(parent.id, { type: 'run.status', status: 'completed', connectionId });
      await page.getByLabel('邮箱', { exact: true }).fill('fixture@example.invalid');
      await page.getByLabel('密码', { exact: true }).fill('fixture-password');
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.locator('.session-select').filter({ hasText: parent.title }).click();
      const main = page.locator('.workspace');
      await expect(main.locator('.message.assistant')).toContainText('引用测试回答');
      await main.getByRole('button', { name: '引用回答', exact: true }).first().click();
      assert.equal(calls.filter((call) => call.type === 'message.send').length, 0);
      await main.getByRole('textbox', { name: '消息', exact: true }).fill('主会话问题');
      await main.getByRole('button', { name: '发送消息', exact: true }).click();
      await expect(main).toContainText('主会话独立输出');
      const first = calls.find((call) => call.type === 'message.send');
      assert.equal(first.sessionId, parent.id);
      assert.equal(splitQuoteMessage(first.text).text, '主会话问题');
      const mainRun = parent.activeRun.id;
      await main.getByRole('textbox', { name: '消息', exact: true }).fill('未发送主草稿');
      await main.getByRole('button', { name: '在侧边聊天中提问', exact: true }).first().click();
      const side = page.getByRole('region', { name: '侧边会话', exact: true });
      await expect(side).toBeVisible();
      assert.equal(sessions.length, 2);
      assert.equal(calls.filter((call) => call.type === 'message.send').length, 1);
      await expect(side.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
      await side.getByRole('textbox', { name: '消息', exact: true }).fill('侧边问题');
      await side.getByRole('button', { name: '发送消息', exact: true }).click();
      await expect(side).toContainText('侧边独立输出');
      const child = sessions[1];
      const sent = calls.filter((call) => call.type === 'message.send');
      assert.equal(sent[1].sessionId, child.id);
      assert.equal(splitQuoteMessage(sent[1].text).text, '侧边问题');
      emit(
        parent.id,
        { type: 'text.delta', messageId: randomUUID(), text: '主流继续标记' },
        mainRun,
      );
      emit(
        child.id,
        { type: 'text.delta', messageId: randomUUID(), text: '侧流继续标记' },
        child.activeRun.id,
      );
      await expect(main).toContainText('主流继续标记');
      await expect(side).toContainText('侧流继续标记');
      await expect(main).not.toContainText('侧流继续标记');
      await expect(side).not.toContainText('主流继续标记');
      const sideInput = side.getByRole('textbox', { name: '消息', exact: true });
      await sideInput.focus();
      await sideInput.press('Escape');
      assert.notEqual(child.activeRun, null, 'one Escape never cancels the answer');
      await sideInput.press('Escape');
      await expect.poll(() => child.activeRun).toBe(null);
      assert.equal(parent.activeRun.id, mainRun);
      assert.deepEqual(
        calls.filter((call) => call.type === 'run.cancel').map((call) => call.sessionId),
        [child.id],
      );
      await expect(main.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(
        '未发送主草稿',
      );

      // Opening and reading a preview must remain a client action, even with quote sessions present.
      await main.getByRole('link', { name: '页面', exact: true }).first().click();
      const nativeValue = (expression) =>
        app.evaluate(async ({ BrowserWindow }, expression) => {
          const view = BrowserWindow.getAllWindows()
            .flatMap((window) => window.contentView.children)
            .find(
              (view) =>
                view.getVisible() &&
                view.webContents?.getURL().includes('.localhost:') &&
                !view.webContents.isLoading(),
            );
          return view ? view.webContents.executeJavaScript(expression) : null;
        }, expression);
      await expect
        .poll(() => nativeValue('document.querySelector("h1")?.textContent'))
        .toBe(secret);
      assert.equal(
        await nativeValue('typeof window.desktop+":"+typeof require'),
        'undefined:undefined',
      );
      assert.equal(calls.filter((call) => call.type === 'message.send').length, 2);
      assert(calls.every((call) => !JSON.stringify(call).includes(secret)));
      await page.getByRole('tab', { name: child.title, exact: true }).click();
      await expect(side).toContainText('侧流继续标记');
      await expect(main.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(
        '未发送主草稿',
      );
      await page.getByRole('button', { name: '分栏预览', exact: true }).click();
      await expect(side).toBeVisible();
      await expect
        .poll(() => nativeValue('document.querySelector("h1")?.textContent'))
        .toBe(secret);
      // A live native webpage and the independent chat remain usable in the same preview workspace.
      await side.getByRole('textbox', { name: '消息', exact: true }).fill('未发送侧草稿');
      await side.getByRole('button', { name: '引用回答', exact: true }).first().click();
      await expect(side.locator('.composer-input')).toContainText('1 条引用');
      await expect
        .poll(() =>
          page.evaluate(async (id) => {
            const saved = await window.desktop.loadDrafts();
            return saved[id]?.quotes?.length;
          }, child.id),
        )
        .toBe(1);
      assert.equal(calls.filter((call) => call.type === 'message.send').length, 2);
      assert(calls.every((call) => !JSON.stringify(call).includes(secret)));
      await app.close();
      app = await launch();
      page = await app.firstWindow();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.getByLabel('邮箱', { exact: true }).fill('fixture@example.invalid');
      await page.getByLabel('密码', { exact: true }).fill('fixture-password');
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.locator('.session-select').filter({ hasText: parent.title }).click();
      await expect(page.getByRole('tab', { name: child.title, exact: true })).toBeVisible();
      const restoredSide = page.getByRole('region', { name: '侧边会话', exact: true });
      await expect(restoredSide.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(
        '未发送侧草稿',
      );
      await expect(restoredSide.locator('.composer-input')).toContainText('1 条引用');
      await expect(
        page.locator('.workspace').getByRole('textbox', { name: '消息', exact: true }),
      ).toHaveValue('未发送主草稿');
      // Restoring a quote tab, its local draft and history must never resume a model turn.
      assert.equal(calls.filter((call) => call.type === 'message.send').length, 2);
      assert.deepEqual(errors, []);
    } catch (error) {
      console.log(
        'quote fixture command types',
        calls.map((call) => call.type),
      );
      if (page && !page.isClosed())
        console.log((await page.locator('body').innerText()).slice(-5000));
      throw error;
    } finally {
      if (app) await app.close();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise((done) => sockets.close(done));
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await rm(root, { recursive: true, force: true });
    }
  },
);
