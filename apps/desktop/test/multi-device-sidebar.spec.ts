import { test, expect } from '@playwright/test';
test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => console.log('sidebar fixture error', error.message));
  await page.goto('/test/fixtures/multi-device-sidebar.html');
  await expect(page.locator('.project-device')).toHaveCount(4);
});
test('managed devices share project list while empty offline targets and other-device history remain distinct', async ({
  page,
}) => {
  await expect(
    page.locator('.project-group').filter({ has: page.locator('.project-device') }),
  ).toHaveCount(4);
  await expect(page.locator('.project-device')).toHaveText(['本机', '01', '02', '03 · 离线']);
  await page.getByRole('button', { name: '新建会话 · 02 · /work/app', exact: true }).click();
  expect(await page.evaluate(() => (window as any).sidebarFixture.calls)).toContainEqual([
    'remote-create',
    '02',
    '/work/app',
  ]);
  await expect(page.locator('.session-row').filter({ hasText: '确认部署' })).toHaveCount(1);
  await expect(page.locator('.elsewhere-group')).not.toContainText('01');
  await page
    .locator('.session-row')
    .filter({ hasText: '数据统计' })
    .getByRole('button')
    .first()
    .click();
  await expect(page.locator('main')).toContainText('other');
});
test('device search and folded terminal waiting state make cross-project work discoverable', async ({
  page,
}) => {
  await page.getByRole('button', { name: '收起项目 · app · 01', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '展开项目 · app · 01', exact: true }),
  ).toHaveAttribute('data-state', 'approval');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索会话', exact: true }).fill('02');
  await expect(page.locator('.project-device')).toHaveText(['02']);
  await expect(page.locator('.session-row')).toHaveCount(1);
  await expect(page.locator('.session-row')).toContainText('数据统计');
});
test('remote preferences use isolated keys and the existing local path preference still applies', async ({
  page,
}) => {
  await page.evaluate(() =>
    (window as any).sidebarFixture.setPrefs((value: any) => ({
      ...value,
      projectNames: {
        '/work/app': '本机别名',
        'remote:["test-service","01","/work/app"]': '远程别名',
      },
      pinnedProjects: ['remote:["test-service","01","/work/app"]'],
    })),
  );
  await expect(page.locator('.project-group h2').first()).toContainText('远程别名');
  await expect(page.locator('.project-group h2').filter({ hasText: '本机别名' })).toHaveCount(1);
  await expect(page.locator('.project-group h2').filter({ hasText: '远程别名' })).toHaveCount(1);
});

test('searching the displayed local-device label keeps local project sessions visible', async ({
  page,
}) => {
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索会话', exact: true }).fill('本机');
  await expect(page.locator('.session-row')).toHaveCount(1);
  await expect(page.locator('.session-row')).toContainText('开发任务');
});

test('other-device fold count and status exclude SSH projects already shown in the project list', async ({
  page,
}) => {
  const other = page.getByRole('button', { name: '展开其他设备的会话', exact: true });
  await expect(other.locator('small')).toHaveText('1');
  await expect(other).not.toHaveAttribute('data-state', 'approval');
});

test('existing remote folder folds remain compatible when projects move into the unified list', async ({
  page,
}) => {
  await page.evaluate(() =>
    (window as any).sidebarFixture.setPrefs((value: any) => ({
      ...value,
      collapsedElsewhere: ['01\n/work/app'],
    })),
  );
  const folded = page.getByRole('button', { name: '展开项目 · app · 01', exact: true });
  await expect(folded).toBeVisible();
  await folded.click();
  await expect(page.locator('.session-row').filter({ hasText: '确认部署' })).toBeVisible();
});
test('opening another saved project does not reorder the sidebar project list', async ({
  page,
}) => {
  await page.evaluate(() =>
    (window as any).sidebarFixture.setTargets((entries: any[]) =>
      entries.map((entry) =>
        entry.id === '01' ? { ...entry, projects: ['/work/app', '/work/second'] } : entry,
      ),
    ),
  );
  const groups = page
    .locator('.project-group')
    .filter({ has: page.locator('.project-device').filter({ hasText: '01' }) });
  await expect(groups).toHaveCount(2);
  expect(
    await groups
      .locator('h2')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title'))),
  ).toEqual(['01 · /work/app', '01 · /work/second']);
  await page.evaluate(() =>
    (window as any).sidebarFixture.setTargets((entries: any[]) =>
      entries.map((entry) =>
        entry.id === '01' ? { ...entry, projects: ['/work/second', '/work/app'] } : entry,
      ),
    ),
  );
  expect(
    await groups
      .locator('h2')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title'))),
  ).toEqual(['01 · /work/app', '01 · /work/second']);
});
