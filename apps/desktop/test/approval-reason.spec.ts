import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';

// A call Claude Code's own safety check asks about: the approval dock says so and why, in Claude Code's words, and
// marks a session that bypasses permissions, where nothing else is asked. A service before Build 33 sends neither,
// and the dock is as it was (upstream 85785f72, 13effeb7).
const cases = [
  { name: 'bypassing, a safety check', mode: 'bypassPermissions', why: { safetyCheck: true } },
  { name: 'a plain ask with a reason', mode: 'default', why: {} },
  { name: 'an older service', mode: 'default', why: null },
] as const;
const reason = 'Dangerous rm operation on statically-unresolvable target: /tmp/pcx/sa/*';
for (const [index, item] of cases.entries()) {
  test(`the approval dock tells why it asks: ${item.name}`, async ({ page }) => {
    const url = `ws://127.0.0.1:${18930 + index}/ws`;
    const now = new Date().toISOString();
    const connectionId = randomUUID();
    const runId = randomUUID();
    const approvalId = randomUUID();
    const session = {
      id: randomUUID(),
      title: '安全检查',
      autoTitle: false,
      projectPath: 'D:\\工作\\安全检查',
      permissionMode: item.mode,
      model: null,
      effort: null,
      createdAt: now,
      updatedAt: now,
      activeRun: { id: runId, status: 'awaiting_approval', connectionId, waiting: 'approval' },
    } as Session;
    let sequence = 0;
    const event = (payload: unknown) => ({
      sessionId: session.id,
      runId,
      sequence: ++sequence,
      createdAt: now,
      payload,
    });
    const events = [
      event({ type: 'message.user', messageId: randomUUID(), text: '清理一下', scenario: 'chat' }),
      event({ type: 'run.status', status: 'running', connectionId }),
      event({
        type: 'tool.requested',
        toolId: 't1',
        name: 'Bash',
        input: JSON.stringify({ command: 'cd /tmp/pcx/sa && rm -f *' }, null, 2),
        target: 'Linux',
      }),
      event({
        type: 'approval.requested',
        approvalId,
        toolId: 't1',
        ...(item.why ? { reason, ...item.why } : {}),
      }),
      event({ type: 'run.status', status: 'awaiting_approval', connectionId, waiting: 'approval' }),
    ];
    await page.routeWebSocket(url, (route) => {
      const reply = (value: unknown) => route.send(JSON.stringify(value));
      route.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === 'device') return;
        if (!message.requestId && message.type.startsWith('terminal.')) return;
        if (message.type === 'auth') {
          reply({
            type: 'ready',
            protocolVersion: PROTOCOL_VERSION,
            version: '0.3.10',
            connectionId,
            adapter: 'claude-code',
            sessions: [session],
          });
          return;
        }
        if (message.type === 'session.subscribe') {
          reply({
            type: 'session.snapshot',
            requestId: message.requestId,
            session,
            mode: 'replace',
            firstSequence: 1,
            lastSequence: sequence,
            hasEarlier: false,
            events,
          });
          return;
        }
        if (message.requestId) reply({ type: 'response', requestId: message.requestId, ok: true });
      });
    });
    await page.goto('/');
    const localMode = page.getByRole('button', { name: '本地模拟', exact: true });
    if (await localMode.isVisible()) await localMode.click();
    await page.getByLabel('服务地址', { exact: true }).fill(url);
    await page
      .getByLabel('服务凭据', { exact: true })
      .fill('test-only-view-token-with-enough-length');
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await expect(page.locator('.connection-status')).toContainText('已连接');
    const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
    if (await expand.isVisible()) await expand.click();
    await page.locator('.session-select').filter({ hasText: session.title }).click();
    const dock = page.getByRole('region', { name: '需要你的许可' });
    await expect(dock.getByRole('button', { name: '允许', exact: true })).toBeVisible();
    const note = dock.getByRole('note');
    if (!item.why) {
      await expect(note).toHaveCount(0);
      return;
    }
    await expect(note).toContainText(reason);
    if (item.mode === 'bypassPermissions') {
      await expect(note).toContainText('Claude Code 安全拦截');
      await expect(note).toContainText('绕过权限时也会询问');
    } else await expect(note).not.toContainText('安全拦截');
  });
}
