import { test, expect, type Page } from '@playwright/test';

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const fixture = (
      window as unknown as {
        sideHistoryStopFixture: {
          commands: { type: string; sessionId?: string; runId?: string }[];
          sessionId: string;
          runId: string;
          pending: () => boolean;
        };
      }
    ).sideHistoryStopFixture;
    return {
      commands: fixture.commands,
      sessionId: fixture.sessionId,
      runId: fixture.runId,
      pending: fixture.pending(),
    };
  });
}

for (const trigger of ['stop button', 'double Escape'] as const) {
  test(`SideConversation ${trigger} cancels the active run while cached history is pending`, async ({
    page,
  }) => {
    await page.goto('/test/fixtures/side-history-stop.html');
    const side = page.getByRole('region', { name: '侧边会话', exact: true });
    await expect(side.getByText('已从本机缓存显示的侧边历史', { exact: true })).toBeVisible();
    await expect(side.getByText('同步会话', { exact: true })).toBeVisible();
    await expect(side.getByRole('textbox', { name: '消息', exact: true })).toBeDisabled();
    const stop = side.getByRole('button', { name: '停止运行', exact: true });
    await expect(stop).toBeEnabled();
    expect((await snapshot(page)).pending).toBe(true);
    expect((await snapshot(page)).commands).toHaveLength(0);
    if (trigger === 'stop button') await stop.click();
    else {
      const conversation = side.locator('.conversation');
      await conversation.focus();
      await expect(conversation).toBeFocused();
      await conversation.press('Escape');
      expect((await snapshot(page)).commands).toHaveLength(0);
      await conversation.press('Escape');
    }
    await expect.poll(async () => (await snapshot(page)).commands.length).toBe(1);
    const result = await snapshot(page);
    expect(result.commands).toEqual([
      { type: 'run.cancel', sessionId: result.sessionId, runId: result.runId },
    ]);
    expect(result.pending).toBe(true);
    await expect(side.getByText('同步会话', { exact: true })).toBeVisible();
    await expect(side.getByRole('textbox', { name: '消息', exact: true })).toBeDisabled();
  });
}
