import { test, expect } from '@playwright/test';
test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => console.log('sidebar fixture error', error.message));
  await page.goto('/test/fixtures/multi-device-sidebar.html');
  await expect(page.locator('.project-device')).toHaveCount(3);
});
test('managed devices share project list while empty offline targets and other-device history remain distinct', async ({
  page,
}) => {
  await expect(
    page.locator('.project-group').filter({ has: page.locator('.project-device') }),
  ).toHaveCount(3);
  await expect(page.locator('.project-device')).toHaveText(['01', '02', '03 · 离线']);
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

test('searching the local-device keyword keeps local project sessions visible', async ({
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

test('folded long device keeps offline badge and count on one line in a narrow sidebar', async ({
  page,
}) => {
  await page.goto('/test/fixtures/multi-device-sidebar.html?longDevice=1');
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('.shell')!.style.setProperty('--sidebar-width', '240px');
    (window as any).sidebarFixture.setPrefs((prefs: any) => ({
      ...prefs,
      elsewhereOpen: true,
      collapsedElsewhere: ['unknown'],
    }));
  });
  const row = page.locator('.device-heading').filter({ hasText: 'DESKTOP-DCT' });
  await expect(row.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  await expect(row.locator('.heading-toggle small')).toHaveText('4');
  const badge = row.locator('.device-state');
  await expect(badge).toHaveText('离线');
  const folded = await badge.boundingBox();
  await row.getByRole('button').click();
  const expanded = await badge.boundingBox();
  expect(folded!.height).toBeLessThanOrEqual(expanded!.height + 1);
  expect(folded!.height).toBeLessThan(24);
  expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await row.getByRole('button').click();
    await expect(row.locator('.device-state')).toBeVisible();
    await page.screenshot({
      path: `.local/screenshots/sidebar-offline-${theme}.png`,
      animations: 'disabled',
    });
    await row.getByRole('button').click();
  }
});

test('removed project groups persist and do not hide pinned sessions or another device with the same path', async ({
  page,
}) => {
  await page.evaluate(() =>
    (window as any).sidebarFixture.setPrefs((prefs: any) => ({
      ...prefs,
      hiddenProjects: ['/work/app', 'remote:["test-service","01","/work/app"]'],
      pinnedSessions: ['local-session', 'wait'],
    })),
  );
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    await expect(page.locator('.project-device')).toHaveText(['02', '03 · 离线']);
    await expect(page.locator('.session-row').filter({ hasText: '开发任务' })).toHaveCount(1);
    await expect(page.locator('.session-row').filter({ hasText: '确认部署' })).toHaveCount(1);
    await expect(page.locator('.project-group')).toHaveCount(2);
  }
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索会话', exact: true }).fill('01');
  await expect(page.locator('.session-row')).toHaveCount(1);
  await expect(page.locator('.session-row')).toContainText('确认部署');
  await expect(page.locator('.project-group')).toHaveCount(0);
});

test('sessions from removed local and remote groups share newest-first Recents order', async ({
  page,
}) => {
  await page.evaluate(() => {
    const f = (window as any).sidebarFixture;
    f.sessions.find((session: any) => session.id === 'wait').updatedAt = '2026-11-05T12:00:00Z';
    f.setPrefs((prefs: any) => ({
      ...prefs,
      hiddenProjects: ['/work/app', 'remote:["test-service","01","/work/app"]'],
    }));
  });
  await expect(page.locator('.session-list > .session-row strong')).toHaveText([
    '确认部署',
    '开发任务',
  ]);
});
