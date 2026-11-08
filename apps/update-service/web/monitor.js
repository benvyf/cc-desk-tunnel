const quotaNames = {
  five_hour: '5 小时额度',
  seven_day: '每周额度',
  seven_day_opus: 'Opus 每周额度',
  seven_day_sonnet: 'Sonnet 每周额度',
};
const stale = (at) => !at || Date.now() - Date.parse(at) > 15 * 60000;
const plan = (account) =>
  ({ max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' })[account?.subscriptionType] ??
  account?.subscriptionType ??
  '套餐未知';
const auth = (value) =>
  ({ oauth_token: 'OAuth 登录', api_key: 'API Key', claudeai: 'Claude 登录' })[value] ??
  value ??
  '登录方式未知';

export function setupMonitor({ request, action, notice, element: el, date, manage }) {
  const $ = (id) => document.getElementById(id);
  const drafts = new Map();
  const expanded = new Set();
  let data, selectedNode;

  function disclosure(key, label, className = '') {
    const details = el('details', undefined, className);
    details.open = expanded.has(key);
    details.append(el('summary', label));
    details.addEventListener('toggle', () => {
      if (details.isConnected) {
        if (details.open) expanded.add(key);
        else expanded.delete(key);
      }
    });
    return details;
  }
  function state(row) {
    if (!row) return { label: '等待首次上报', tone: '', kind: 'waiting' };
    if (stale(row.receivedAt)) return { label: '上报已过期', tone: 'warning', kind: 'attention' };
    return { label: '近期上报', tone: 'good', kind: 'recent' };
  }
  function attention(row) {
    return (
      !row ||
      stale(row.receivedAt) ||
      !row.account ||
      row.quotaStatus?.state === 'error' ||
      row.quotaStatus?.state === 'unavailable' ||
      row.quotaStatus?.state === 'unknown' ||
      !row.rateLimits?.available ||
      stale(row.rateLimits?.measuredAt) ||
      !row.rateLimits.windows.length ||
      row.rateLimits.windows.some((window) => window.utilization === null) ||
      row.rateLimits.windows.some(
        (window) => window.utilization !== null && window.utilization >= 90,
      )
    );
  }
  function quota(row, parent) {
    const rates = row?.rateLimits;
    const heading = el('div', undefined, 'quota-heading');
    const old = stale(rates?.measuredAt);
    heading.append(
      el('h4', '额度使用情况'),
      el(
        'span',
        !rates?.available ? '尚无数据' : old ? '数据已过期' : '最近额度快照',
        `badge${rates?.available && old ? ' warning' : ''}`,
      ),
    );
    parent.append(heading);
    if (rates?.measuredAt)
      parent.append(el('p', `采集于 ${date(rates.measuredAt)}`, 'quota-timestamp'));
    if (!rates?.available || !rates.windows.length) {
      parent.append(
        el(
          'div',
          rates?.available ? '本次未返回额度窗口' : '暂无可用额度数据，等待正常使用时采集。',
          'no-data',
        ),
      );
    } else {
      const list = el('div', undefined, 'quota-list');
      for (const window of rates.windows) {
        const name =
          quotaNames[window.name] ??
          (window.name.startsWith('seven_day:')
            ? `${window.name.slice(10)} 每周额度`
            : window.name);
        const used = window.utilization;
        const tone = used >= 90 ? 'danger' : used >= 75 ? 'warning' : '';
        const item = el('div', undefined, 'quota-row');
        const label = el('div', undefined, 'quota-label');
        label.append(
          el('span', name),
          el('strong', used === null ? '未知' : `已用 ${used}%`, tone),
        );
        item.append(label);
        if (used !== null) {
          const track = el('div', undefined, 'quota-track');
          track.setAttribute('role', 'progressbar');
          track.setAttribute('aria-label', name);
          track.setAttribute('aria-valuenow', String(used));
          track.setAttribute('aria-valuemin', '0');
          track.setAttribute('aria-valuemax', '100');
          const fill = el('div', undefined, `quota-fill ${tone}`);
          fill.style.width = `${Math.max(0, Math.min(100, used))}%`;
          track.append(fill);
          item.append(track);
        }
        const remaining = used === null ? '' : `剩余约 ${Math.round((100 - used) * 10) / 10}%`;
        const reset = window.resetsAt
          ? Date.parse(window.resetsAt) <= Date.now()
            ? '重置时间已过，等待新数据'
            : `${date(window.resetsAt)} 重置`
          : '重置时间未知';
        item.append(el('p', [remaining, reset].filter(Boolean).join(' · '), 'muted'));
        list.append(item);
      }
      parent.append(list);
    }
    const messages = {
      error: '最近额度读取失败，保留最后有效快照。',
      unavailable: '最近读取未提供额度，显示已有快照。',
      unknown: '本次尚未采集额度，已有数值可能为历史快照。',
    };
    if (messages[row?.quotaStatus?.state])
      parent.append(
        el(
          'p',
          messages[row.quotaStatus.state],
          `quota-alert${row.quotaStatus.state === 'error' ? ' error' : ''}`,
        ),
      );
  }
  function sampleDetails(row, key) {
    const details = disclosure(key, '采集详情与会话用量', 'device-details');
    const profile = row.account;
    if (profile) {
      details.append(
        el(
          'p',
          `登录方式：${auth(profile.authMethod)} · API 提供方：${profile.apiProvider ?? '未知'}`,
          'muted',
        ),
      );
      if (profile.subscriptionType === 'max')
        details.append(el('p', 'Max 套餐倍率未由服务端提供。', 'muted'));
    }
    if (row.identity?.measuredAt)
      details.append(el('p', `身份采集：${date(row.identity.measuredAt)}`, 'muted'));
    if (row.rateLimits?.measuredAt)
      details.append(el('p', `额度采集：${date(row.rateLimits.measuredAt)}`, 'muted'));
    details.append(
      el('p', `节点观察：${date(row.observedAt)} · VPS 接收：${date(row.receivedAt)}`, 'muted'),
    );
    if (row.usage) {
      const u = row.usage;
      details.append(
        el(
          'p',
          `最近会话累计：输入 ${u.inputTokens.toLocaleString()} / 输出 ${u.outputTokens.toLocaleString()} tokens；缓存读取 ${u.cacheReadTokens.toLocaleString()} / 写入 ${u.cacheWriteTokens.toLocaleString()}`,
          'muted',
        ),
      );
      details.append(el('p', '会话累计可能跨账号，不作为账号总用量。', 'muted'));
      if (u.costUsd !== null)
        details.append(el('p', `API 价格估算 $${u.costUsd.toFixed(4)}（非订阅账单）`, 'muted'));
      details.append(
        el(
          'p',
          `用量采集：${date(u.measuredAt)} · 会话 ${u.sessionId}${u.runId ? ` · 运行 ${u.runId}` : ''}`,
          'digest',
        ),
      );
    }
    return details;
  }
  function noteEditor(account, key) {
    const details = disclosure(key, account.note ? '编辑账号备注' : '添加账号备注');
    if (drafts.has(account.id)) details.open = true;
    const form = el('form', undefined, 'note-editor');
    const label = el('label', '账号备注');
    const input = el('textarea');
    input.maxLength = 2000;
    input.rows = 2;
    input.value = drafts.get(account.id) ?? account.note;
    input.addEventListener('input', () => drafts.set(account.id, input.value));
    label.append(input);
    const save = el('button', '保存备注', 'quiet');
    save.type = 'submit';
    form.append(label, save);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void action(async () => {
        const submitted = input.value;
        await request(`/monitor/accounts/${account.id}/note`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ note: submitted }),
        });
        if (drafts.get(account.id) === submitted) drafts.delete(account.id);
        await refresh();
        notice('账号备注已保存。');
      });
    });
    details.append(form);
    return details;
  }
  function matches(account, query, nodeId) {
    return JSON.stringify([
      account.id,
      account.accountNumber,
      account.note,
      drafts.get(account.id),
      account.snapshots
        .filter((row) => !nodeId || row.nodeId === nodeId)
        .map((row) => [row.nodeId, row.account]),
    ])
      .toLowerCase()
      .includes(query);
  }
  function accountCard(account, nodeId) {
    const card = el('article', undefined, 'account-record');
    const samples = account.snapshots
      .filter((row) => !nodeId || row.nodeId === nodeId)
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
    const profile = samples.find((row) => row.account?.email)?.account ?? samples[0]?.account;
    card.append(
      el('h3', profile?.email ?? '等待邮箱上报'),
      el(
        'p',
        `${account.accountNumber} · 首次收到 ${date(account.firstSeenAt)} · 最近收到 ${date(account.lastSeenAt)}`,
        'muted',
      ),
    );
    if (account.note) card.append(el('p', account.note, 'note-preview'));
    card.append(noteEditor(account, `note:${nodeId ?? 'all'}:${account.id}`));
    for (const row of samples) {
      const sample = el('section', undefined, 'monitor-sample');
      const current =
        data.nodes.find((node) => node.nodeId === row.nodeId)?.account?.id === account.id;
      sample.append(
        el('h4', row.nodeId),
        el(
          'span',
          current
            ? '最近绑定（非在线状态）'
            : data.configuredNodes.includes(row.nodeId)
              ? '历史绑定'
              : '历史绑定 · 节点已移除',
          'badge',
        ),
      );
      sample.append(
        el(
          'p',
          `套餐：${plan(row.account)} · 组织：${row.account?.organization ?? '未知'}`,
          'muted',
        ),
      );
      quota(row, sample);
      sample.append(sampleDetails(row, `sample:${nodeId ?? 'all'}:${account.id}:${row.nodeId}`));
      card.append(sample);
    }
    return card;
  }
  function renderAccounts() {
    const parent = selectedNode ? $('access-claude') : $('monitor-history-list');
    parent.replaceChildren();
    const query = selectedNode ? '' : $('monitor-search').value.trim().toLowerCase();
    const accounts = data.accounts.filter(
      (account) =>
        (!selectedNode || account.snapshots.some((row) => row.nodeId === selectedNode)) &&
        matches(account, query),
    );
    if (!accounts.length) parent.append(el('p', '暂无账号记录，等待正常使用时上报。', 'empty'));
    for (const account of accounts) parent.append(accountCard(account, selectedNode));
  }
  function deviceCard(nodeId, row) {
    const card = el('article', undefined, 'device-card');
    card.dataset.nodeId = nodeId;
    const status = state(row);
    const header = el('div', undefined, 'device-header');
    const title = el('div', undefined, 'device-title');
    const icon = el('span', '▣', 'device-symbol');
    icon.setAttribute('aria-hidden', 'true');
    const name = el('div');
    name.append(el('h3', nodeId), el('p', 'Ubuntu 工作空间', 'muted'));
    title.append(icon, name);
    header.append(title, el('span', status.label, `status-pill ${status.tone}`));
    card.append(header);
    const body = el('div', undefined, 'device-body');
    if (row?.account) {
      const account = data.accounts.find((account) => account.id === row.account.id);
      const identity = el('div', undefined, 'account-identity');
      const name = el('div');
      name.append(
        el('p', '当前记录的 CLAUDE 账号', 'identity-label'),
        el('h4', row.account.email ?? '等待邮箱上报', 'account-email'),
        el('p', account?.accountNumber ?? row.account.id.slice(0, 12), 'account-number'),
      );
      identity.append(name, el('span', plan(row.account), 'plan-badge'));
      body.append(identity);
      const meta = el('div', undefined, 'identity-meta');
      meta.append(
        el('span', row.account.organization ?? '组织未知'),
        el('span', auth(row.account.authMethod)),
      );
      body.append(meta);
      if (account?.note) body.append(el('p', account.note, 'note-preview'));
      quota(row, body);
      body.append(sampleDetails(row, `device:${nodeId}`));
    } else {
      const empty = el('div', undefined, 'device-empty');
      empty.append(
        el(
          'h4',
          !row
            ? '等待设备首次接入'
            : row.identity?.state === 'signed_out'
              ? '最近确认已退出登录'
              : '暂未识别 Claude 账号',
        ),
      );
      empty.append(
        el(
          'p',
          !row ? '接入后，账号与额度将在这里集中显示。' : '账号信息由设备在正常使用时同步。',
          'muted',
        ),
      );
      body.append(empty);
    }
    card.append(body);
    const footer = el('div', undefined, 'device-footer');
    footer.append(el('p', row ? `最近接收 ${date(row.receivedAt)}` : '尚未收到设备数据', 'muted'));
    const actions = el('div', undefined, 'device-actions');
    for (const [label, tab] of [
      ['查看详情', 'claude'],
      ['连接配置', 'connection'],
      ['登录用户', 'users'],
    ]) {
      const button = el('button', label, 'text-button');
      button.type = 'button';
      button.setAttribute('aria-label', `${label} ${nodeId}`);
      button.onclick = () => void action(() => manage(nodeId, tab));
      actions.append(button);
    }
    footer.append(actions);
    card.append(footer);
    return card;
  }
  function render() {
    if (!data) return;
    const nodes = new Map(data.nodes.map((row) => [row.nodeId, row]));
    const stats = $('monitor-node-status');
    stats.replaceChildren();
    for (const [label, value, detail, tone, symbol] of [
      ['已配置设备', data.configuredNodes.length, '全部受管工作空间', '', '▣'],
      [
        '近期上报',
        data.configuredNodes.filter((id) => state(nodes.get(id)).kind === 'recent').length,
        '15 分钟内收到数据',
        'good',
        '↗',
      ],
      ['已记录账号', data.accounts.length, '含历史切换的账号', '', '◎'],
      [
        '需要关注',
        data.configuredNodes.filter((id) => attention(nodes.get(id))).length,
        '接入、采集或额度需留意',
        'warning',
        '◷',
      ],
    ]) {
      const card = el('div', undefined, `stat-card ${tone}`);
      const title = el('div', undefined, 'stat-title');
      const icon = el('span', symbol, 'stat-symbol');
      icon.setAttribute('aria-hidden', 'true');
      title.append(el('span', label), icon);
      card.append(title, el('p', String(value), 'stat-value'), el('p', detail, 'stat-description'));
      stats.append(card);
    }
    const query = $('monitor-search').value.trim().toLowerCase();
    const filter = $('monitor-filter').value;
    const ids = data.configuredNodes.filter((id) => {
      const row = nodes.get(id);
      const accounts = data.accounts.filter((account) =>
        account.snapshots.some((sample) => sample.nodeId === id),
      );
      const match =
        id.toLowerCase().includes(query) || accounts.some((account) => matches(account, query, id));
      return (
        match &&
        (filter === 'all' || (filter === 'attention' ? attention(row) : state(row).kind === filter))
      );
    });
    $('monitor-count').textContent =
      `${data.configuredNodes.length} 台设备 · 显示 ${ids.length} 台 · 已记录 ${data.accounts.length} 个账号`;
    $('monitor-nodes').replaceChildren(...ids.map((id) => deviceCard(id, nodes.get(id))));
    if (!ids.length)
      $('monitor-nodes').append(
        el(
          'p',
          data.configuredNodes.length
            ? '没有匹配的设备或账号，请调整搜索与筛选条件。'
            : '还没有受管设备，接入后即可查看账号与额度。',
          'empty',
        ),
      );
    $('monitor-history-list').replaceChildren();
    renderAccounts();
  }
  async function refresh() {
    data = await request('/monitor');
    $('monitor-updated').textContent =
      `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    render();
  }
  $('monitor-search').addEventListener('input', render);
  $('monitor-filter').addEventListener('change', render);
  return {
    refresh,
    get hasDrafts() {
      return drafts.size > 0;
    },
    showNode(id) {
      selectedNode = id;
      $('monitor-overview').hidden = true;
      if (data) render();
    },
    closeNode() {
      selectedNode = undefined;
      $('monitor-overview').hidden = false;
      $('access-claude').replaceChildren();
      if (data) render();
    },
    clear() {
      data = undefined;
      selectedNode = undefined;
      drafts.clear();
      expanded.clear();
      $('monitor-search').value = '';
      $('monitor-filter').value = 'all';
      $('monitor-updated').textContent = '';
      $('monitor-count').textContent = '';
      $('monitor-overview').hidden = false;
      $('monitor-history').open = false;
      for (const id of [
        'monitor-nodes',
        'monitor-node-status',
        'monitor-history-list',
        'access-claude',
      ])
        $(id).replaceChildren();
    },
  };
}
