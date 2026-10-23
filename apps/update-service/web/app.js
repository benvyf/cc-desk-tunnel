const api = '/cc-updates/admin/api';
const $ = (id) => document.getElementById(id);
let token = '';
let controller = new AbortController();
let pending = false;
function notice(text, error = false) {
  $('notice').textContent = text;
  $('notice').className = error ? 'error' : '';
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function date(value) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}
function channelName(value) {
  return value === 'pilot' ? '试点通道' : '正式通道';
}
function logout() {
  controller.abort();
  controller = new AbortController();
  token = '';
  $('token').value = '';
  $('dashboard').hidden = true;
  $('logout').hidden = true;
  $('login-panel').hidden = false;
  for (const id of ['channels', 'candidates', 'audit', 'monitor-nodes']) $(id).replaceChildren();
}
async function request(path, options = {}) {
  const response = await fetch(api + path, {
    ...options,
    credentials: 'omit',
    signal: controller.signal,
    headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
  });
  if (!response.ok) {
    if (response.status === 401) logout();
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? '操作失败，请稍后重试。');
  }
  return response.status === 204 ? null : response.json();
}
async function action(work) {
  if (pending) return;
  pending = true;
  document.body.classList.add('pending');
  try {
    await work();
  } catch (error) {
    if (error.name !== 'AbortError') notice(error.message, true);
  } finally {
    pending = false;
    document.body.classList.remove('pending');
  }
}
function releaseDetails(payload) {
  const r = payload.release;
  const block = element('div');
  block.append(element('h3', r ? `v${r.appVersion} · Build ${r.build}` : '已撤回发布'));
  block.append(
    element('p', `Revision ${payload.revision}${r ? ` · 协议 ${r.protocol}` : ''}`, 'muted'),
  );
  const expired = Date.parse(payload.expiresAt) <= Date.now();
  block.append(
    element(
      'p',
      `${expired ? '已过期' : '有效至'} ${date(payload.expiresAt)}`,
      expired ? 'error' : 'muted',
    ),
  );
  if (r) {
    block.append(element('p', r.notes, 'notes'));
    const details = element('details');
    details.append(
      element('summary', '制品信息'),
      element(
        'p',
        `${r.filename}\n${r.size.toLocaleString()} bytes\nSHA256 ${r.sha256}\n源码 ${r.sourceCommit}`,
        'digest',
      ),
    );
    block.append(details);
  }
  return block;
}
async function refresh() {
  const data = await request('/status');
  $('channels').replaceChildren();
  for (const name of ['pilot', 'stable']) {
    const card = element('section', undefined, 'card channel');
    card.append(
      element('span', name.toUpperCase(), `badge ${name}`),
      element('h2', channelName(name)),
    );
    const row = data.channels.find((c) => c.channel === name);
    card.append(row ? releaseDetails(row.payload) : element('p', '尚未发布', 'muted'));
    $('channels').append(card);
  }
  $('candidate-count').textContent = `${data.candidates.length} / 8`;
  $('candidates').replaceChildren();
  if (!data.candidates.length)
    $('candidates').append(element('p', '暂无候选。添加签名索引开始准备发布。', 'empty'));
  for (const candidate of data.candidates) {
    const card = element('section', undefined, 'card candidate');
    card.append(
      element('span', channelName(candidate.payload.channel), 'badge'),
      releaseDetails(candidate.payload),
    );
    const controls = element('div', undefined, 'controls');
    if (candidate.payload.release && candidate.needsArtifact && !candidate.uploaded) {
      const label = element('label', '对应安装包');
      const input = element('input');
      input.type = 'file';
      input.accept = '.exe';
      label.append(input);
      const upload = element('button', '上传并校验');
      upload.className = 'quiet';
      upload.addEventListener('click', () =>
        action(async () => {
          if (!input.files[0]) throw new Error('请先选择对应安装包。');
          if (input.files[0].name !== candidate.payload.release.filename)
            throw new Error('安装包文件名与签名索引不一致。');
          notice('正在上传并校验安装包…');
          await request(`/candidates/${candidate.id}/artifact`, {
            method: 'PUT',
            headers: { 'content-type': 'application/octet-stream' },
            body: input.files[0],
          });
          await refresh();
          notice('安装包校验通过，可以发布。');
        }),
      );
      controls.append(label, upload);
    } else
      controls.append(
        element(
          'p',
          candidate.payload.state === 'empty' ? '此候选将撤回该通道的发布。' : '安装包已就绪。',
          'muted',
        ),
      );
    const activate = element(
      'button',
      candidate.payload.state === 'empty' ? '确认撤回' : '发布到通道',
    );
    activate.disabled =
      Date.parse(candidate.payload.expiresAt) <= Date.now() ||
      (candidate.needsArtifact && !candidate.uploaded);
    activate.addEventListener('click', () =>
      action(async () => {
        await request(`/candidates/${candidate.id}/activate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        await refresh();
        notice('通道已更新。');
      }),
    );
    const remove = element('button', '移除候选', 'quiet');
    remove.addEventListener('click', () =>
      action(async () => {
        await request(`/candidates/${candidate.id}`, { method: 'DELETE' });
        await refresh();
        notice('候选已移除。');
      }),
    );
    controls.append(activate, remove);
    card.append(controls);
    $('candidates').append(card);
  }
  const actions = {
    'candidate-created': '添加候选',
    'artifact-uploaded': '校验安装包',
    published: '发布',
    withdrawn: '撤回',
    'candidate-deleted': '移除候选',
  };
  $('audit').replaceChildren();
  for (const row of data.audit) {
    const tr = element('tr');
    for (const text of [
      date(row.at),
      row.actor,
      actions[row.action] ?? row.action,
      row.channel,
      `${row.build ?? '—'} / ${row.revision}`,
    ])
      tr.append(element('td', text));
    $('audit').append(tr);
  }
  await refreshMonitor();
}
async function refreshMonitor() {
  const data = await request('/monitor');
  const container = $('monitor-nodes');
  container.replaceChildren();
  if (!data.nodes.length) container.append(element('p', '暂无节点上报数据。', 'empty'));
  const quotaNames = {
    five_hour: '5 小时额度',
    seven_day: '每周额度',
    seven_day_opus: 'Opus 每周额度',
    seven_day_sonnet: 'Sonnet 每周额度',
  };
  for (const row of data.nodes) {
    const card = element('article', undefined, 'card');
    card.append(element('h3', row.nodeId));
    if (!row.account) card.append(element('p', '未登录或账号未知', 'muted'));
    else {
      card.append(
        element(
          'p',
          `账号 ${row.account.id.slice(0, 12)} · ${row.account.subscriptionType ?? '未知订阅'}`,
        ),
      );
      const sampledAt = row.rateLimits?.measuredAt ?? row.observedAt;
      const stale = Date.now() - Date.parse(sampledAt) > 15 * 60000;
      card.append(
        element('span', stale ? '数据已过期' : '最近快照', `badge${stale ? ' error' : ''}`),
      );
      if (!row.rateLimits?.available) card.append(element('p', '暂无可用额度数据', 'muted'));
      else
        for (const window of row.rateLimits.windows) {
          const label =
            quotaNames[window.name] ??
            (window.name.startsWith('seven_day:')
              ? `${window.name.slice(10)} 每周额度`
              : window.name);
          card.append(
            element(
              'p',
              `${label}：${window.utilization === null ? '未知' : `${window.utilization}%`}`,
              window.utilization >= 90 ? 'error' : '',
            ),
          );
          if (window.resetsAt)
            card.append(
              element(
                'p',
                Date.parse(window.resetsAt) <= Date.now()
                  ? `重置时间已过，等待新数据（${date(window.resetsAt)}）`
                  : `重置时间：${date(window.resetsAt)}`,
                'muted',
              ),
            );
        }
      if (row.rateLimits?.available && !row.rateLimits.windows.length)
        card.append(element('p', '本次未返回额度窗口', 'muted'));
      if (row.usage) {
        const u = row.usage;
        card.append(
          element(
            'p',
            `最近上报会话累计：输入 ${u.inputTokens.toLocaleString()} / 输出 ${u.outputTokens.toLocaleString()} tokens`,
            'muted',
          ),
        );
        if (u.costUsd !== null)
          card.append(element('p', `API 价格估算 $${u.costUsd.toFixed(4)}（非订阅账单）`, 'muted'));
        card.append(element('p', `用量采集：${date(u.measuredAt)}`, 'muted'));
      }
      card.append(element('p', `数据采集：${date(sampledAt)}`, 'muted'));
    }
    card.append(
      element('p', `节点观察：${date(row.observedAt)}\nVPS 接收：${date(row.receivedAt)}`, 'muted'),
    );
    container.append(card);
  }
}
$('login').addEventListener('submit', (event) => {
  event.preventDefault();
  void action(async () => {
    token = $('token').value;
    $('token').value = '';
    await refresh();
    $('login-panel').hidden = true;
    $('dashboard').hidden = false;
    $('logout').hidden = false;
    notice('');
  });
});
$('create').addEventListener('submit', (event) => {
  event.preventDefault();
  void action(async () => {
    const file = $('index-file').files[0];
    if (!file || file.size > 65536) throw new Error('请选择 64 KiB 以内的签名索引。');
    await request('/candidates', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: file,
    });
    $('create').reset();
    await refresh();
    notice('签名索引已验证，候选已添加。');
  });
});
$('refresh').addEventListener('click', () => action(refresh));
$('monitor-refresh').addEventListener('click', () => action(refreshMonitor));
setInterval(() => {
  if (token && !pending && !document.hidden) void action(refreshMonitor);
}, 30000);
$('logout').addEventListener('click', () => {
  logout();
  notice('已退出。');
});
