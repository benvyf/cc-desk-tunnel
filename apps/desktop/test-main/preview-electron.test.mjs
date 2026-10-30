import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { _electron, expect } from '@playwright/test';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '../../../packages/protocol/src/index.ts';

test(
  'the real desktop previews local files and websites without a model connection or privileged webpage bridge',
  {
    skip: process.platform !== 'win32' || process.env.CC_PREVIEW_ELECTRON_TEST !== '1',
    timeout: 240_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-preview-electron-'));
    const project = join(root, '项目');
    await mkdir(project);
    await mkdir(join(project, 'assets'));
    const html = join(project, 'index.html'),
      markdown = join(project, '说明.md');
    const picture = join(project, 'pixel.png');
    const future = join(project, 'future.md'),
      outsideText = join(root, 'outside.md');
    await writeFile(outsideText, '# 项目外文档');
    await writeFile(
      picture,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        'base64',
      ),
    );
    await writeFile(
      html,
      '<link rel="stylesheet" href="/assets/style.css"><h1 id="heading">HTML 预览</h1><button onclick="document.querySelector(\'#heading\').textContent=\'交互正常\'">交互</button><a href="next.html">下个文件</a><a id="outside" href="outside/secret.html">越界链接</a><script src="./assets/app.js"></script>',
    );
    await mkdir(join(root, 'outside'));
    await writeFile(join(root, 'outside/secret.html'), '<h1>PRIVATE OUTSIDE</h1>');
    await symlink(join(root, 'outside'), join(project, 'outside'), 'junction');
    await writeFile(join(project, 'next.html'), '<h1>第二个文件</h1>');
    await writeFile(join(project, 'assets/style.css'), 'h1{color:rgb(12, 34, 56)}');
    await writeFile(join(project, 'assets/app.js'), 'document.body.dataset.loaded="yes"');
    await writeFile(markdown, '# 项目说明\n\n本机 Markdown 预览。');
    let probeRequests = 0;
    const server = createServer((request, response) => {
      if (request.url?.startsWith('/probe')) probeRequests++;
      response.setHeader('X-Frame-Options', 'DENY');
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<title>本机网站</title><h1>本机网站</h1><a href="/second">第二页</a>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const site = `http://127.0.0.1:${server.address().port}/`;
    const { previewPdf } = await import('./fixtures/preview-pdf.ts');
    const pdfPath = join(project, 'report.pdf');
    await writeFile(pdfPath, previewPdf());
    await copyFile(
      resolve('apps/desktop/test-main/fixtures/office/sample.doc'),
      join(project, 'report.doc'),
    );
    await writeFile(
      join(project, 'assets/app.js'),
      `document.body.dataset.loaded='yes';fetch('${site}probe').catch(()=>{});const image=new Image();image.src='${site}probe-image';try{new WebSocket('${site.replace('http:', 'ws:')}probe-socket');}catch{}`,
    );
    const sockets = new WebSocketServer({ server, path: '/ws' });
    const wrapper = join(root, 'entry.cjs');
    await writeFile(
      wrapper,
      `
    const {app,net,ipcMain,dialog}=require('electron');
    app.commandLine.appendSwitch('no-proxy-server');
    global.fixtureCalls=[];global.fixtureWatches=[];
    const workspaceModule=require(${JSON.stringify(resolve('apps/desktop/electron/preview-workspace.cjs'))});
    const createWorkspace=workspaceModule.createPreviewWorkspace;
    workspaceModule.createPreviewWorkspace=()=>{
      const controller=createWorkspace(),watch=controller.watch.bind(controller);
      controller.watch=async(input,callback)=>{await watch(input,callback);global.fixtureWatches.push(input);};
      return controller;
    };
    app.setPath('userData',${JSON.stringify(join(root, 'profile'))});
    app.setPath('sessionData',${JSON.stringify(join(root, 'profile'))});
    net.fetch=async(url)=>{
      global.fixtureCalls.push(url);
      if(url.endsWith('/login'))return Response.json({email:'fixture@example.invalid',token:'fixture',workspaces:[{id:'fixture',name:'fixture'}]});
      if(url.endsWith('/workspaces'))return Response.json({workspaces:[{id:'fixture',name:'fixture'}]});
      if(url.endsWith('/connect'))return Response.json({url:'wss://fixture.invalid/ws',fingerprint:'',token:'ccs_'+'x'.repeat(43)});
      throw Error('External network request forbidden in fixture');
    };
    dialog.showOpenDialog=async(owner)=>{global.fixturePickerOwner=owner.webContents.getURL();return {canceled:false,filePaths:[global.fixturePickedPath||${JSON.stringify(markdown)}]};};
    require(${JSON.stringify(resolve('apps/desktop/electron/main.cjs'))});
    ipcMain.removeHandler('proxy:connect');ipcMain.handle('proxy:connect',()=>{global.fixtureCalls.push('proxy');return {url:${JSON.stringify(site.replace('http:', 'ws:') + 'ws')}};});
  `,
    );
    let app;
    let debugPage;
    const commands = [];
    let stderr = '';
    try {
      app = await _electron.launch({
        executablePath: resolve('node_modules/electron/dist/electron.exe'),
        args: [wrapper, '--smoke-test'],
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE'),
        ),
      });
      app.process().stderr.on('data', (data) => {
        stderr += data.toString();
      });
      const page = await app.firstWindow();
      debugPage = page;
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const device = await page.evaluate(() => window.desktop.device());
      await page.evaluate(() => {
        window.fixtureStates = [];
        window.desktop.preview.onState((state) => window.fixtureStates.push(state));
      });
      const now = new Date().toISOString();
      const session = {
        id: randomUUID(),
        title: '预览测试',
        autoTitle: false,
        projectPath: project,
        device,
        permissionMode: 'auto',
        model: null,
        effort: null,
        createdAt: now,
        updatedAt: now,
        activeRun: null,
      };
      const secondSession = { ...session, id: randomUUID(), title: '另一会话' };
      const connectionId = randomUUID(),
        runId = randomUUID();
      const terminalId = randomUUID();
      const events = [
        {
          sessionId: session.id,
          runId,
          sequence: 1,
          createdAt: now,
          payload: {
            type: 'text.delta',
            messageId: randomUUID(),
            text: `[页面](${html.replaceAll('\\', '/')}) [说明](${markdown.replaceAll('\\', '/')}) [图片](${picture.replaceAll('\\', '/')}) [网站](${site}) [待生成文档](${future.replaceAll('\\', '/')})`,
          },
        },
      ];
      sockets.on('connection', (socket) => {
        const send = (value) => socket.send(JSON.stringify(value));
        socket.on('message', (raw) => {
          const message = JSON.parse(String(raw));
          commands.push(message.type);
          if (message.type === 'auth')
            return send({
              type: 'ready',
              protocolVersion: PROTOCOL_VERSION,
              version: '0.3.7',
              connectionId,
              adapter: 'claude-code',
              terminalWorkspace: { version: 1, minRows: 1 },
              sessions: [session, secondSession],
            });
          if (message.type === 'session.subscribe')
            send({
              type: 'session.snapshot',
              requestId: message.requestId,
              session: message.sessionId === session.id ? session : secondSession,
              mode: 'replace',
              firstSequence: 1,
              lastSequence: 1,
              hasEarlier: false,
              events: events.map((event) => ({ ...event, sessionId: message.sessionId })),
            });
          if (message.type === 'terminal.open')
            send({ type: 'terminal.opened', sessionId: session.id, terminalId });
          if (message.type === 'terminal.close')
            send({
              type: 'terminal.closed',
              sessionId: session.id,
              terminalId,
              exitCode: 0,
              reason: 'user_close',
            });
          if (message.requestId) send({ type: 'response', requestId: message.requestId, ok: true });
        });
      });
      await page.getByLabel('邮箱', { exact: true }).fill('fixture@example.invalid');
      await page.getByLabel('密码', { exact: true }).fill('fixture-password');
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page
        .locator('.session-select')
        .filter({ hasText: '预览测试' })
        .click({ timeout: 8000 });
      await page.getByRole('link', { name: '页面', exact: true }).click();
      await expect(page.getByRole('complementary', { name: '文件与网站预览' })).toBeVisible();
      async function nativeValue(expression) {
        return app.evaluate(async ({ BrowserWindow }, expression) => {
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
      }
      await expect.poll(() => nativeValue('document.body?.dataset.loaded')).toBe('yes');
      assert.equal(
        await nativeValue('typeof window.desktop+":"+typeof require'),
        'undefined:undefined',
      );
      assert.equal(
        await nativeValue('getComputedStyle(document.querySelector("h1")).color'),
        'rgb(12, 34, 56)',
      );
      await nativeValue('document.querySelector("button").click()');
      assert.equal(await nativeValue('document.querySelector("h1").textContent'), '交互正常');
      const divider = page.getByRole('separator', { name: '调整预览宽度' });
      const box = await divider.boundingBox();
      await page.mouse.move(box.x + 1, box.y + 150);
      await page.mouse.down();
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].contentView.children.every(
              (view) => !view.getVisible(),
            ),
          ),
        )
        .toBe(true);
      await page.mouse.move(box.x - 39, box.y + 150);
      await page.mouse.up();
      await expect(divider).toHaveAttribute('aria-valuenow', '480');
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].contentView.children.some((view) => view.getVisible()),
          ),
        )
        .toBe(true);
      await app.evaluate(async ({ webContents }) => {
        const view = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().includes('.localhost:'));
        await view.executeJavaScript('document.querySelector("#outside").click()', true);
      });
      await expect(page.locator('.preview-error')).toContainText('工作区');
      await expect(page.getByRole('tab', { name: 'secret.html', exact: true })).toHaveCount(0);
      await app.evaluate(async ({ webContents }) => {
        const view = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().includes('.localhost:'));
        await view.executeJavaScript('document.querySelector("a").click()', true);
      });
      await expect(page.getByRole('tab', { name: 'next.html', exact: true })).toBeVisible();
      await expect
        .poll(() => nativeValue('document.querySelector("h1")?.textContent'))
        .toBe('第二个文件');
      await page.getByRole('button', { name: '关闭预览 next.html', exact: true }).click();
      await expect.poll(() => nativeValue('document.body?.dataset.loaded')).toBe('yes');
      await page.getByRole('button', { name: '源码', exact: true }).click();
      await expect(page.locator('.preview-code')).toContainText('<h1');
      await page.getByRole('button', { name: '预览', exact: true }).click();
      await expect.poll(() => nativeValue('document.body?.dataset.loaded')).toBe('yes');
      await page.getByRole('button', { name: '打开本机文件', exact: true }).click();
      await expect(page.locator('.preview-document h1')).toHaveText('项目说明');
      // The tree and watchers use only trusted client IPC, never model requests.
      await page.getByRole('button', { name: '工作区目录', exact: true }).click();
      await expect(page.getByRole('treeitem', { name: 'report.pdf', exact: true })).toBeVisible();
      await writeFile(markdown, '# 项目说明\n\n自动刷新标记');
      await expect(page.locator('.preview-markdown')).toContainText('自动刷新标记');
      await page.getByRole('treeitem', { name: 'report.pdf', exact: true }).click();
      await expect(page.locator('.preview-pdf canvas')).toBeVisible();
      await expect(page.getByLabel('PDF 页码')).toHaveValue('1');
      await page.getByRole('button', { name: '关闭预览 report.pdf', exact: true }).click();
      await page.getByRole('treeitem', { name: 'report.doc', exact: true }).click();
      await expect(page.locator('.preview-pdf canvas')).toBeVisible({ timeout: 30000 });
      await expect(page.getByLabel('PDF 页码')).toHaveValue('1');
      await page.getByRole('button', { name: '关闭预览 report.doc', exact: true }).click();

      await page.getByRole('button', { name: '工作区目录', exact: true }).click();
      assert.equal(probeRequests, 0, 'static preview must not contact a separate loopback origin');
      await page.getByRole('link', { name: '待生成文档', exact: true }).click();
      await expect
        .poll(() =>
          app.evaluate(
            (_, path) => global.fixtureWatches.some((input) => input.path === path),
            future,
          ),
        )
        .toBe(true);
      await writeFile(future, '# 自动恢复的文档');
      await expect(page.locator('.preview-markdown h1')).toHaveText('自动恢复的文档');
      await writeFile(future, '# 新建后仍会自动刷新');
      await expect(page.locator('.preview-markdown h1')).toHaveText('新建后仍会自动刷新');
      await page.getByRole('button', { name: '关闭预览 future.md', exact: true }).click();
      await app.evaluate((_, path) => {
        global.fixturePickedPath = path;
      }, outsideText);
      await page.getByRole('button', { name: '打开本机文件', exact: true }).click();
      await expect(page.locator('.preview-markdown h1')).toHaveText('项目外文档');
      await expect
        .poll(() =>
          app.evaluate(
            (_, path) => global.fixtureWatches.some((input) => input.path === path),
            outsideText,
          ),
        )
        .toBe(true);
      await writeFile(outsideText, '# 项目外文件已刷新');
      await expect(page.locator('.preview-markdown h1')).toHaveText('项目外文件已刷新');
      await page.getByRole('button', { name: '关闭预览 outside.md', exact: true }).click();
      await app.evaluate(() => {
        global.fixturePickedPath = null;
      });

      assert.equal(await page.getByRole('tab', { name: '说明.md', exact: true }).count(), 1);
      await page.getByRole('link', { name: '说明', exact: true }).click();
      assert.equal(await page.getByRole('tab', { name: '说明.md', exact: true }).count(), 1);
      await expect
        .poll(() =>
          app.evaluate(({ webContents }) =>
            webContents.getAllWebContents().some((view) => view.getURL().includes('.localhost:')),
          ),
        )
        .toBe(false);
      await page.getByRole('link', { name: '图片', exact: true }).click();
      await expect
        .poll(() => page.locator('.preview-image').evaluate((image) => image.naturalWidth))
        .toBe(1);
      await page
        .locator('.preview-image-tools')
        .getByRole('button', { name: '放大', exact: true })
        .click();
      await expect(page.locator('.preview-image-tools')).toContainText('125%');
      await page.getByRole('button', { name: '关闭预览 pixel.png', exact: true }).click();
      await page.getByRole('link', { name: '网站', exact: true }).click();
      await expect
        .poll(() =>
          app.evaluate(async ({ webContents }, site) => {
            const view = webContents
              .getAllWebContents()
              .find((contents) => contents.getURL() === site);
            return view
              ? view.executeJavaScript('document.querySelector("h1")?.textContent')
              : null;
          }, site),
        )
        .toBe('本机网站');
      // This website denies iframe embedding; an independent WebContentsView must still display it.
      await app.evaluate(async ({ webContents }, site) => {
        const view = webContents.getAllWebContents().find((c) => c.getURL() === site);
        await view.executeJavaScript('document.querySelector("a").click()', true);
      }, site);
      await expect(page.getByLabel('预览地址')).toHaveValue(site + 'second');
      await expect(page.getByRole('button', { name: '预览后退', exact: true })).toBeEnabled({
        timeout: 2000,
      });
      await page.getByRole('button', { name: '预览后退', exact: true }).click();
      await expect(page.getByLabel('预览地址')).toHaveValue(site);
      await page.getByLabel('预览地址').fill(site + 'typed');
      await page.getByLabel('预览地址').press('Enter');
      await expect(page.getByLabel('预览地址')).toHaveValue(site + 'typed');
      await page.getByRole('tab', { name: '说明.md', exact: true }).click();
      await page.getByRole('tab', { name: site.replace(/^https?:\/\//, ''), exact: true }).click();
      await expect(page.getByLabel('预览地址')).toHaveValue(site + 'typed');
      await page.getByLabel('预览地址').fill(site + 'not-submitted');
      await page.getByRole('button', { name: '刷新预览', exact: true }).focus();
      await expect(page.getByLabel('预览地址')).toHaveValue(site + 'typed');
      await page.getByLabel('预览地址').fill(site);
      await page.getByLabel('预览地址').press('Enter');
      await expect(page.getByLabel('预览地址')).toHaveValue(site);
      await page.getByRole('button', { name: '分栏预览', exact: true }).click();
      await expect(page.locator('.preview-pane')).toHaveCount(2);
      await page.getByRole('tab', { name: 'index.html', exact: true }).click();
      await expect
        .poll(() =>
          app.evaluate(
            ({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()[0].contentView.children.filter((v) => v.getVisible())
                .length,
          ),
        )
        .toBe(2);
      await page
        .locator('.preview-pane')
        .filter({ has: page.getByLabel('预览地址') })
        .getByRole('button', { name: '浮动预览', exact: true })
        .click();
      await expect(page.locator('.preview-pane-floating')).toHaveCount(1);
      await page.getByRole('button', { name: '放大预览', exact: true }).click();
      await expect
        .poll(() =>
          app.evaluate(
            ({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()[0].contentView.children.filter((v) => v.getVisible())
                .length,
          ),
        )
        .toBeGreaterThanOrEqual(1);
      await page.getByRole('button', { name: '还原预览', exact: true }).click();

      await page.getByRole('button', { name: '停靠预览', exact: true }).click();
      await expect(page.locator('.preview-pane')).toHaveCount(1);
      await page.getByRole('button', { name: '收起预览', exact: true }).click();
      await expect(page.getByRole('complementary', { name: '文件与网站预览' })).toHaveCount(0);
      await page.getByRole('button', { name: '打开预览侧栏', exact: true }).click();
      await expect(page.getByLabel('预览地址')).toHaveValue(site);
      await page.getByRole('separator', { name: '调整预览宽度' }).focus();
      await page.keyboard.press('ArrowLeft');
      await expect(page.getByRole('separator', { name: '调整预览宽度' })).toHaveAttribute(
        'aria-valuenow',
        '500',
      );
      await page.getByRole('button', { name: '收起预览', exact: true }).click();
      await page.getByRole('button', { name: '打开预览侧栏', exact: true }).click();
      await expect(page.getByRole('separator', { name: '调整预览宽度' })).toHaveAttribute(
        'aria-valuenow',
        '500',
      );
      await page.locator('.session-select').filter({ hasText: '另一会话' }).click();
      await expect(page.getByRole('complementary', { name: '文件与网站预览' })).toHaveCount(0);
      await page.getByRole('link', { name: '说明', exact: true }).click();
      await expect(page.getByRole('tablist', { name: '预览标签' }).getByRole('tab')).toHaveCount(1);
      await page.locator('.session-select').filter({ hasText: '预览测试' }).click();
      await expect(page.getByRole('tablist', { name: '预览标签' }).getByRole('tab')).toHaveCount(3);
      await page.getByRole('button', { name: '打开本机网站', exact: true }).click();
      await expect(page.getByRole('dialog', { name: '打开本机网站' })).toBeVisible();
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].contentView.children.every(
              (child) => !child.getVisible(),
            ),
          ),
        )
        .toBe(true);
      await page.getByRole('dialog').getByLabel('网站地址').fill('https://example.invalid');
      await page.getByRole('button', { name: '打开预览', exact: true }).click();
      await expect(page.getByRole('dialog').getByRole('alert')).toContainText('localhost');
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByRole('tab', { name: '说明.md', exact: true }).click();
      await expect(page.locator('.preview-document h1')).toHaveText('项目说明');
      await mkdir(resolve('.local/screenshots'), { recursive: true });
      for (const [width, font, theme] of [
        [1240, 14, 'light'],
        [1240, 14, 'dark'],
        [390, 20, 'dark'],
      ]) {
        await app.evaluate(
          ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 850),
          width,
        );
        await page.evaluate(
          ({ font, theme }) => {
            document.documentElement.style.fontSize = `${font}px`;
            document.documentElement.dataset.theme = theme;
          },
          { font, theme },
        );
        await expect(page.getByRole('complementary', { name: '文件与网站预览' })).toBeVisible();
        const geometry = await page.locator('.preview-sidebar').evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, width: innerWidth };
        });
        assert(
          geometry.left >= 0 && geometry.right <= geometry.width + 1,
          JSON.stringify(geometry),
        );
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        const screenshot = await app.evaluate(async ({ BrowserWindow }) =>
          (await BrowserWindow.getAllWindows()[0].capturePage(undefined, { stayHidden: true }))
            .toPNG()
            .toString('base64'),
        );
        await writeFile(
          resolve(`.local/screenshots/preview-sidebar-${theme}-${width}.png`),
          Buffer.from(screenshot, 'base64'),
        );
      }
      await page
        .getByRole('button', { name: `关闭预览 ${site.replace(/^https?:\/\//, '')}`, exact: true })
        .click();
      await expect
        .poll(() =>
          app.evaluate(
            ({ webContents }, site) =>
              webContents.getAllWebContents().some((c) => c.getURL().startsWith(site)),
            site,
          ),
        )
        .toBe(false);
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1240, 850),
      );
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '14px';
      });
      const popupPromise = app.waitForEvent('window', {
        predicate: (popup) => popup.url() === 'about:blank',
      });
      await page.getByRole('button', { name: '终端', exact: true }).click();
      const popup = await popupPromise;
      await popup.getByRole('button', { name: '预览', exact: true }).click();
      await expect
        .poll(async () => (await popup.locator('.preview-heading-actions').boundingBox())?.y ?? 0)
        .toBeGreaterThanOrEqual(36);
      await popup.getByRole('button', { name: '打开本机文件', exact: true }).click();
      await expect(popup.locator('.preview-document h1')).toHaveText('项目说明');
      assert.equal(await app.evaluate(() => global.fixturePickerOwner), 'about:blank');
      await popup.getByRole('button', { name: '打开本机网站', exact: true }).first().click();
      await popup.getByRole('dialog').getByLabel('网站地址').fill(site);
      await popup.getByRole('button', { name: '打开预览', exact: true }).click();
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }, site) => {
            const terminal = BrowserWindow.getAllWindows().find(
              (window) => window.webContents.getURL() === 'about:blank',
            );
            return terminal?.contentView.children.some(
              (view) => view.webContents?.getURL() === site && view.getVisible(),
            );
          }, site),
        )
        .toBe(true);
      await popup.getByRole('button', { name: '收起预览', exact: true }).click();
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) => {
            const terminal = BrowserWindow.getAllWindows().find(
              (window) => window.webContents.getURL() === 'about:blank',
            );
            return terminal?.contentView.children.every((view) => !view.getVisible());
          }),
        )
        .toBe(true);
      await page.getByRole('button', { name: '关闭全部终端', exact: true }).click();
      await popup.getByRole('button', { name: '结束终端', exact: true }).click();
      await expect
        .poll(() =>
          app.evaluate(
            ({ webContents }, site) =>
              webContents.getAllWebContents().some((view) => view.getURL().startsWith(site)),
            site,
          ),
        )
        .toBe(false);
      await page.getByRole('link', { name: '网站', exact: true }).click();
      await page.evaluate(() => {
        window.open = () => null;
      });
      await page.getByRole('button', { name: '终端', exact: true }).click();
      const inline = page.locator('.terminal-preview-layout');
      await inline.getByRole('button', { name: '预览', exact: true }).click();
      await inline.getByRole('button', { name: '打开本机网站', exact: true }).first().click();
      await inline.getByRole('dialog').getByLabel('网站地址').fill(site);
      await inline.getByRole('button', { name: '打开预览', exact: true }).click();
      await expect
        .poll(() =>
          app.evaluate(
            ({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()[0].contentView.children.filter((view) =>
                view.getVisible(),
              ).length,
          ),
        )
        .toBe(2);
      await inline.getByRole('button', { name: '放大预览', exact: true }).click();
      await expect
        .poll(() =>
          app.evaluate(
            ({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()[0].contentView.children.filter((view) =>
                view.getVisible(),
              ).length,
          ),
        )
        .toBe(1);
      await inline.getByRole('button', { name: '还原预览', exact: true }).click();
      await expect
        .poll(() =>
          app.evaluate(
            ({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()[0].contentView.children.filter((view) =>
                view.getVisible(),
              ).length,
          ),
        )
        .toBe(2);
      await inline.getByRole('button', { name: '收起预览', exact: true }).click();
      await expect
        .poll(() =>
          app.evaluate(
            ({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()[0].contentView.children.filter((view) =>
                view.getVisible(),
              ).length,
          ),
        )
        .toBe(1);
      await page.locator('.terminal-tabs-header .terminal-tab .icon-button').click();
      await inline.getByRole('button', { name: '结束终端', exact: true }).click();
      await expect(inline).toHaveCount(0);
      await page
        .locator('.shell > .preview-sidebar')
        .getByRole('button', { name: `关闭预览 ${site.replace(/^https?:\/\//, '')}`, exact: true })
        .click();
      assert(!commands.includes('message.send'));
      await page.getByRole('link', { name: '页面', exact: true }).click();
      await expect.poll(() => nativeValue('document.body?.dataset.loaded')).toBe('yes');
      for (const socket of sockets.clients)
        socket.send(JSON.stringify({ type: 'session.deleted', sessionId: session.id }));
      await expect
        .poll(() =>
          app.evaluate(({ webContents }) =>
            webContents.getAllWebContents().some((view) => view.getURL().includes('.localhost:')),
          ),
        )
        .toBe(false);
      await page.locator('.session-select').filter({ hasText: '另一会话' }).click();
      await page.getByRole('link', { name: '页面', exact: true }).click();
      await expect.poll(() => nativeValue('document.body?.dataset.loaded')).toBe('yes');
      await page.reload();
      await expect(page.getByRole('heading', { name: '登录 CC SPACE', exact: true })).toBeVisible();
      await expect
        .poll(() =>
          app.evaluate(({ webContents }) =>
            webContents.getAllWebContents().some((view) => view.getURL().includes('.localhost:')),
          ),
        )
        .toBe(false);

      // Reopen the same profile in a fresh process, then restore the session layout.
      await app.close();
      app = await _electron.launch({
        executablePath: resolve('node_modules/electron/dist/electron.exe'),
        args: [wrapper, '--smoke-test'],
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE'),
        ),
      });
      const reopened = await app.firstWindow();
      debugPage = reopened;
      await reopened.getByLabel('邮箱', { exact: true }).fill('fixture@example.invalid');
      await reopened.getByLabel('密码', { exact: true }).fill('fixture-password');
      await reopened.getByRole('button', { name: '登录', exact: true }).click();
      await reopened.locator('.session-select').filter({ hasText: '另一会话' }).click();
      await expect(reopened.getByRole('tab', { name: 'index.html', exact: true })).toBeVisible();
      await expect(reopened.getByRole('button', { name: '加载此预览', exact: true })).toBeVisible();
      assert.equal(
        await app.evaluate(({ webContents }) =>
          webContents.getAllWebContents().some((c) => c.getURL().includes('.localhost:')),
        ),
        false,
      );
      await reopened.getByRole('button', { name: '加载此预览', exact: true }).click();
      await expect.poll(() => nativeValue('document.body?.dataset.loaded')).toBe('yes');
      assert(!commands.includes('message.send'));
      assert.deepEqual(errors, []);
    } catch (error) {
      console.log('commands', commands);
      console.log('electron stderr', stderr.slice(-2500));
      if (app)
        console.log(
          'preview bodies',
          await app
            .evaluate(async ({ webContents }) =>
              Promise.all(
                webContents
                  .getAllWebContents()
                  .filter((view) => view.getURL().includes('.localhost:'))
                  .map(async (view) => ({
                    url: view.getURL(),
                    body: await view
                      .executeJavaScript('document.body?.innerText')
                      .catch(() => 'unavailable'),
                  })),
              ),
            )
            .catch(() => []),
        );
      if (app)
        console.log(
          'view history',
          JSON.stringify(
            await app
              .evaluate(({ webContents }) =>
                webContents.getAllWebContents().map((c) => ({
                  type: c.getType(),
                  url: c.getURL(),
                  history: c.navigationHistory
                    .getAllEntries()
                    .map((entry) => ({ url: entry.url, title: entry.title })),
                  index: c.navigationHistory.getActiveIndex(),
                  back: c.navigationHistory.canGoBack(),
                })),
              )
              .catch(() => []),
          ),
        );
      if (app) console.log(await app.evaluate(() => global.fixtureCalls).catch(() => []));
      if (debugPage && !debugPage.isClosed()) {
        console.log(
          'preview states',
          await debugPage.evaluate(() => window.fixtureStates.slice(-8)),
        );
        console.log((await debugPage.locator('body').innerText()).slice(0, 1800));
      }
      throw error;
    } finally {
      if (app) await app.close();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise((resolve) => sockets.close(resolve));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  },
);
