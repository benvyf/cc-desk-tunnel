import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
test('device configuration, existing monitor tab and personal user editing', async ({ page }) => {
  const html = await readFile('apps/update-service/web/index.html', 'utf8');
  const css = await readFile('apps/update-service/web/style.css', 'utf8');
  const source = await readFile('apps/update-service/web/desktop-access.js', 'utf8');
  await page.setContent(
    html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, ''),
  );
  await page.addStyleTag({ content: css });
  await page.addScriptTag({
    content: source.replace(
      'export function setupDesktopAccess',
      'window.setupDesktopAccess = function',
    ),
  });
  await page.evaluate(() => {
    const w = window as unknown as {
      setupDesktopAccess: Function;
      controller: { open: (id: string) => Promise<void> };
    };
    document.getElementById('login-panel')!.hidden = true;
    document.getElementById('dashboard')!.hidden = false;
    document.getElementById('monitor-panel')!.hidden = false;
    document.getElementById('monitor-nodes')!.textContent = '已有 Claude 账号记录';
    const data = {
      nodes: [
        {
          id: 'ubuntu-cc',
          name: 'Ubuntu',
          url: 'wss://fixture.example/ws',
          fingerprint: '',
          credentialSaved: true,
        },
      ],
      users: [] as object[],
    };
    w.controller = w.setupDesktopAccess({
      date: (x: number) => String(x),
      notice: () => {},
      action: async (fn: () => Promise<void>) => fn(),
      request: async (path: string, options?: { body: string }) => {
        if (options) {
          const input = JSON.parse(options.body);
          if (path.includes('/users'))
            data.users = [{ ...input, id: 'test-user', lastLogin: null }];
          else Object.assign(data.nodes[0]!, input);
        }
        return data;
      },
    });
    return w.controller.open('ubuntu-cc');
  });
  await expect(page.getByLabel('工作空间名称')).toHaveValue('Ubuntu');
  await page.getByRole('tab', { name: 'Claude 账号' }).click();
  await expect(page.getByText('已有 Claude 账号记录')).toBeVisible();
  await page.getByRole('tab', { name: '登录用户' }).click();
  await page.getByRole('button', { name: '添加用户' }).click();
  await page.getByLabel('邮箱', { exact: true }).fill('me@example.com');
  await page.getByLabel('密码', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: '保存用户', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'me@example.com' })).toBeVisible();
  await page.getByRole('button', { name: '编辑 / 重置密码' }).click();
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue('');
  await page.getByLabel('启用此用户').uncheck();
  await page.getByRole('button', { name: '保存用户', exact: true }).click();
  await expect(page.getByRole('cell', { name: '已停用' })).toBeVisible();
  await page.getByRole('button', { name: '编辑 / 重置密码' }).click();
  await page.getByLabel('密码', { exact: true }).fill('unsaved-private-password');
  await page.getByRole('button', { name: '返回账号监控' }).click();
  await expect(page.getByText('已有 Claude 账号记录')).toBeVisible();
  await expect(page.locator('#access-user-password')).toHaveValue('');
});
