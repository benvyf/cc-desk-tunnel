import { test, expect } from '@playwright/test';
test.beforeEach(async ({ page }) => {
  await page.goto('/test/fixtures/local-history.html');
  await page.getByRole('button', { name: '查看本地记录' }).waitFor();
});
test('IndexedDB survives restart, retains missing server records, and isolates accounts and servers', async ({
  page,
}) => {
  const key = await page.evaluate(async () => {
    const f = (window as any).historyFixture;
    const row = await f.store.save(f.scope, f.page([10, 20, 30]));
    await f.store.complete(f.scope.owner, row.key, 30);
    await f.store.save(f.scope, f.page([10, 20, 30]));
    const again = await f.store.current(f.scope, f.session.id);
    if (again.count !== 3) throw Error('duplicate events');
    if ((await f.store.list('other-user')).length) throw Error('account leak');
    if (await f.store.current({ ...f.scope, server: 'other-server' }, f.session.id))
      throw Error('server leak');
    try {
      await f.store.page('other-user', row.key);
      throw Error('must reject foreign owner');
    } catch (e) {
      if (!(e as Error).message.includes('当前账号')) throw e;
    }
    return row.key;
  });
  await page.reload();
  await page.getByRole('button', { name: '查看本地记录' }).click();
  await expect(page.getByRole('button', { name: /本地持久会话/ })).toBeVisible();
  await page.getByRole('button', { name: /本地持久会话/ }).click();
  await expect(page.getByText('离线聊天 30', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      async (k) =>
        (window as any).historyFixture.store
          .page('a'.repeat(64), k)
          .then((v: any) => v.events.map((e: any) => e.sequence)),
      key,
    ),
  ).toEqual([10, 20, 30]);
});
test('server rollback preserves the old generation instead of mixing conflicting event cursors', async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const f = (window as any).historyFixture;
      const old = await f.store.save(f.scope, f.page([10, 20]));
      await f.store.complete(f.scope.owner, old.key, 20);
      const changed = f.page([10, 20]);
      changed.events[1] = f.event(20, '服务端新分支');
      const current = await f.store.save(f.scope, changed);
      return {
        count: (await f.store.list(f.scope.owner)).length,
        oldText: (await f.store.page(f.scope.owner, old.key)).events[1].payload.text,
        newText: (await f.store.page(f.scope.owner, current.key)).events[1].payload.text,
      };
    }),
  ).toEqual({ count: 2, oldText: '离线聊天 20', newText: '服务端新分支' });
});
test('JSONL export/import preserves content and attachments, rejects truncation without erasing existing archives', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const f = (window as any).historyFixture;
    const row = await f.store.save(f.scope, f.page([10, 20]));
    await f.store.complete(f.scope.owner, row.key, 20);
    await f.store.attachment(
      f.scope.owner,
      row.key,
      'D:\\fixture\\picture.png',
      'data:image/png;base64,aGVsbG8=',
    );
    await f.store.checkedAttachments(f.scope.owner, row.key, 20);
    const blob = await f.store.export(f.scope.owner, row.key);
    const imported = await f.store.import(f.scope.owner, blob);
    const before = (await f.store.list(f.scope.owner)).length;
    let rejected = false;
    try {
      await f.store.import(
        f.scope.owner,
        new Blob([(await blob.text()).split('\n').slice(0, -2).join('\n')]),
      );
    } catch {
      rejected = true;
    }
    return {
      same: (await f.store.page(f.scope.owner, imported.key)).events.length,
      attachment: await f.store.attachment(f.scope.owner, imported.key, 'D:\\fixture\\picture.png'),
      before,
      after: (await f.store.list(f.scope.owner)).length,
      rejected,
      originalKey: (await f.store.current(f.scope, f.session.id)).key === row.key,
    };
  });
  expect(result).toEqual({
    same: 2,
    attachment: 'data:image/png;base64,aGVsbG8=',
    before: 2,
    after: 2,
    rejected: true,
    originalKey: true,
  });
});
test('complete background sync backfills all pages using only archive requests; failures never claim completion', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const f = (window as any).historyFixture;
    const synced = await f.sync([
      f.page([30, 40], 'replace', true),
      f.page([10, 20], 'prepend', false),
    ]);
    const record = await f.store.current(f.scope, f.session.id);
    const failed = await f.sync([], true);
    return {
      calls: synced.calls,
      through: record.through,
      count: record.count,
      complete: record.complete,
      error: failed.status[0].error,
    };
  });
  expect(result.calls).toEqual(['session.archive', 'session.archive']);
  expect(result.through).toBe(40);
  expect(result.count).toBe(4);
  expect(result.complete).toBe(true);
  expect(result.error).toContain('同步未完成');
});
test('rollback verification happens before a new tail or early UI page can contaminate the old backup', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const f = (window as any).historyFixture;
    const old = await f.store.save(f.scope, f.page([10, 20]));
    await f.store.complete(f.scope.owner, old.key, 20);
    const anchor = f.page([10, 20]);
    anchor.events[1] = f.event(20, '新分支');
    const tail = f.page([50, 60], 'replace', true);
    const prefix = f.page([10, 20, 30, 40], 'prepend');
    prefix.events[1] = f.event(20, '新分支');
    const synced = await f.sync([anchor, tail, prefix], false, tail);
    const current = await f.store.current(f.scope, f.session.id);
    return {
      old: (await f.store.page(f.scope.owner, old.key)).events.map((e: any) => e.sequence),
      oldText: (await f.store.page(f.scope.owner, old.key)).events[1].payload.text,
      newCount: current.count,
      complete: current.complete,
      count: (await f.store.list(f.scope.owner)).length,
      calls: synced.calls,
    };
  });
  expect(result).toEqual({
    old: [10, 20],
    oldText: '离线聊天 20',
    newCount: 6,
    complete: true,
    count: 2,
    calls: ['session.archive', 'session.archive', 'session.archive'],
  });
});
test('verified existing prefixes use incremental pages, and quota failures stay incomplete', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const f = (window as any).historyFixture;
    const row = await f.store.save(f.scope, f.page([10, 20]));
    await f.store.complete(f.scope.owner, row.key, 20);
    const synced = await f.sync([f.page([10, 20]), f.page([30], 'append')]);
    const original = f.store.save;
    f.store.save = async () => {
      throw new DOMException('fixture quota', 'QuotaExceededError');
    };
    const failed = await f.sync([f.page([10, 20, 30]), f.page([40], 'append')]);
    f.store.save = original;
    const current = await f.store.current(f.scope, f.session.id);
    return {
      count: current.count,
      through: current.through,
      calls: synced.calls,
      error: failed.status[0].error,
    };
  });
  expect(result.count).toBe(3);
  expect(result.through).toBe(30);
  expect(result.calls).toEqual(['session.archive', 'session.archive']);
  expect(result.error).toContain('fixture quota');
});
test('offline viewer is read-only and never reads live attachment paths or sends requests', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const f = (window as any).historyFixture;
    const p = f.page([10]);
    p.events[0] = f.event(10, '查看图片\n"D:\\fixture\\picture.png"');
    const row = await f.store.save(f.scope, p);
    await f.store.complete(f.scope.owner, row.key, 10);
    await f.store.attachment(
      f.scope.owner,
      row.key,
      'D:\\fixture\\picture.png',
      'missing:源文件已删除',
    );
    f.client.request = () => {
      throw Error('Archive must not send commands');
    };
  });
  await page.getByRole('button', { name: '查看本地记录' }).click();
  await page.getByRole('button', { name: /本地持久会话/ }).click();
  await expect(page.getByText('查看图片', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).historyFixture.previewReads())).toBe(0);
  await expect(page.getByRole('button', { name: '发送', exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('local-history-offline.png') });
});

test('server deletion during synchronization keeps the local backup and does not become a fatal sync error', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const f = (window as any).historyFixture;
    const row = await f.store.save(f.scope, f.page([10, 20]));
    await f.store.complete(f.scope.owner, row.key, 20);
    const state = await f.sync([], 'gone');
    return {
      count: (await f.store.list(f.scope.owner)).length,
      key: (await f.store.current(f.scope, f.session.id)).key,
      error: state.status[0].error,
    };
  });
  expect(result.count).toBe(1);
  expect(result.key).toBeTruthy();
  expect(result.error).toBe('');
});

test('archive export uses a native save picker when present and preserves cancellation feedback', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const f = (window as any).historyFixture;
    const record = await f.store.save(f.scope, f.page([10, 20]));
    await f.store.complete(f.scope.owner, record.key, 20);
    (window as any).exportCalls = [];
    (window as any).cancelExport = false;
    Object.assign(window.desktop!, {
      saveFile: async (name: string, text: string) => {
        (window as any).exportCalls.push({ name, text });
        return !(window as any).cancelExport;
      },
    });
  });
  await page.getByRole('button', { name: '查看本地记录' }).click();
  await page.getByRole('button', { name: /本地持久会话/ }).click();
  await page.getByRole('button', { name: '导出归档', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '归档已保存' })).toBeVisible();
  const exported = await page.evaluate(() => (window as any).exportCalls[0]);
  expect(exported.name).toMatch(/\.jsonl$/);
  expect(JSON.parse(exported.text.trim().split('\n').at(-1)).count).toBe(2);
  await page.evaluate(() => ((window as any).cancelExport = true));
  await page.getByRole('button', { name: '导出归档', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已取消导出' })).toHaveText(
    '已取消导出。',
  );
});
