import { setupModeration } from './moderation.js';
import { setupPasswordLogin } from './password-login.js';
import { setupNavigation } from './navigation.js';
const api = '/cc-updates/admin/api';
const $ = (id) => document.getElementById(id);
let token = '';
let controller = new AbortController();
let pending = false;
let pageRefreshQueued = false;
let monitorData;
const monitorDrafts = new Map();
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
  pageRefreshQueued = false;
  navigation.clear();
  monitorData = undefined;
  monitorDrafts.clear();
  $('monitor-search').value = '';
  $('monitor-count').textContent = '';
  $('monitor-node-status').replaceChildren();
  $('token').value = '';
  $('dashboard').hidden = true;
  $('logout').hidden = true;
  $('change-password').hidden = true;
  $('login-panel').hidden = false;
  for (const id of ['channels', 'candidates', 'audit', 'monitor-nodes']) $(id).replaceChildren();
  moderation.clear();
  passwordLogin.clear();
}
async function request(path, options = {}) {
  const response = await fetch(api + path, {
    ...options,
    credentials: 'omit',
    signal: controller.signal,
    headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
  });
  if (!response.ok) {
    if (response.status === 401) {
      logout();
      throw new Error('登录已失效或管理令牌不正确，请重新登录。');
    }
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? `操作失败（HTTP ${response.status}），请稍后重试。`);
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
    if (pageRefreshQueued && token) {
      pageRefreshQueued = false;
      void action(loadCurrentPage);
    }
  }
}
function queuePageRefresh() {
  notice('');
  if (!token) return;
  if (pending) pageRefreshQueued = true;
  else void action(loadCurrentPage);
}
async function loadCurrentPage() {
  if (navigation.current === 'accounts') await refreshMonitor();
  else if (navigation.current === 'updates') await refresh();
  else await moderation.refresh();
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
}
async function refreshMonitor() {
  monitorData = await request('/monitor');
  renderMonitor();
}
function renderMonitor() {
  const data = monitorData;
  if (!data) return;
  const container = $('monitor-nodes');
  container.replaceChildren();
  const nodes = new Map(data.nodes.map((row) => [row.nodeId, row]));
  $('monitor-node-status').replaceChildren();
  for (const nodeId of data.configuredNodes) {
    const row = nodes.get(nodeId);
    const state = !row
      ? '等待首次上报'
      : row.account
        ? `最近账号 ${row.account.email ?? row.account.id.slice(0, 12)}`
        : row.identity?.state === 'signed_out'
          ? '最近确认已退出登录'
          : '最近身份未知（不能据此认定未登录）';
    $('monitor-node-status').append(
      element('p', `${nodeId}：${state}${row ? ` · 最近接收 ${date(row.receivedAt)}` : ''}`),
    );
  }
  if (!data.configuredNodes.length)
    $('monitor-node-status').append(element('p', '未配置上报节点。'));
  const query = $('monitor-search').value.trim().toLowerCase();
  const accounts = data.accounts.filter((account) =>
    JSON.stringify([
      account.id,
      account.note,
      account.snapshots.map((row) => [row.nodeId, row.account]),
    ])
      .toLowerCase()
      .includes(query),
  );
  $('monitor-count').textContent =
    `已记录 ${data.accounts.length} 个账号 · 显示 ${accounts.length} 个 · 已配置 ${data.configuredNodes.length} 个节点`;
  if (!accounts.length)
    container.append(
      element('p', query ? '没有匹配的账号。' : '暂无已识别账号；等待正常使用时上报。', 'empty'),
    );
  const quotaNames = {
    five_hour: '5 小时额度',
    seven_day: '每周额度',
    seven_day_opus: 'Opus 每周额度',
    seven_day_sonnet: 'Sonnet 每周额度',
  };
  for (const account of accounts) {
    const card = element('article', undefined, 'card');
    const latest = [...account.snapshots].sort((a, b) => b.observedAt.localeCompare(a.observedAt));
    const identity = latest.find((row) => row.account?.email)?.account ?? latest[0]?.account;
    card.append(
      element('h3', identity?.email ?? `历史账号 ${account.id.slice(0, 12)}（等待邮箱上报）`),
    );
    card.append(
      element(
        'p',
        `首次收到 ${date(account.firstSeenAt)} · 最近收到 ${date(account.lastSeenAt)}`,
        'muted',
      ),
    );
    const editor = element('form');
    const label = element('label', '账号备注');
    const input = element('textarea');
    input.maxLength = 2000;
    input.value = monitorDrafts.get(account.id) ?? account.note;
    input.addEventListener('input', () => monitorDrafts.set(account.id, input.value));
    label.append(input);
    const save = element('button', '保存备注', 'quiet');
    save.type = 'submit';
    editor.append(label, save);
    editor.addEventListener('submit', (event) => {
      event.preventDefault();
      void action(async () => {
        const submitted = input.value;
        await request(`/monitor/accounts/${account.id}/note`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ note: submitted }),
        });
        if (monitorDrafts.get(account.id) === submitted) monitorDrafts.delete(account.id);
        await refreshMonitor();
        notice('账号备注已保存。');
      });
    });
    card.append(editor);
    for (const row of latest) {
      const sample = element('section', undefined, 'monitor-sample');
      const current = nodes.get(row.nodeId)?.account?.id === account.id;
      const configured = data.configuredNodes.includes(row.nodeId);
      sample.append(element('h4', row.nodeId));
      sample.append(
        element(
          'span',
          current ? '最近绑定（非在线状态）' : configured ? '历史绑定' : '历史绑定 · 节点已移除',
          'badge',
        ),
      );
      const profile = row.account;
      const plan =
        profile.subscriptionType === 'max'
          ? 'Max（倍率未知）'
          : (profile.subscriptionType ?? '未知');
      sample.append(element('p', `套餐：${plan} · 组织：${profile.organization ?? '未知'}`));
      sample.append(
        element(
          'p',
          `登录方式：${profile.authMethod ?? '未知'} · API 提供方：${profile.apiProvider ?? '未知'}`,
          'muted',
        ),
      );
      if (row.identity)
        sample.append(element('p', `身份记录：${date(row.identity.measuredAt)}`, 'muted'));
      const status = row.quotaStatus;
      if (status && status.state !== 'ok') {
        const descriptions = {
          error: '最近额度读取失败，保留最后有效快照',
          unavailable: '最近读取未提供额度，保留最后有效快照',
          unknown: '本次尚未采集额度，以下可能为历史快照',
        };
        sample.append(
          element(
            'p',
            `${descriptions[status.state]}${status.measuredAt ? `（${date(status.measuredAt)}）` : ''}`,
            status.state === 'error' ? 'error' : 'muted',
          ),
        );
      }
      const sampledAt = row.rateLimits?.measuredAt;
      const stale = !sampledAt || Date.now() - Date.parse(sampledAt) > 15 * 60000;
      sample.append(
        element(
          'span',
          !row.rateLimits?.available ? '暂无可用额度' : stale ? '数据已过期' : '最近额度快照',
          `badge${stale ? ' error' : ''}`,
        ),
      );
      if (!row.rateLimits?.available) sample.append(element('p', '暂无可用额度数据', 'muted'));
      else
        for (const window of row.rateLimits.windows) {
          const label =
            quotaNames[window.name] ??
            (window.name.startsWith('seven_day:')
              ? `${window.name.slice(10)} 每周额度`
              : window.name);
          sample.append(
            element(
              'p',
              `${label}：${window.utilization === null ? '未知' : `已用 ${window.utilization}% · 剩余约 ${Math.round((100 - window.utilization) * 10) / 10}%`}`,
              window.utilization !== null && window.utilization >= 90 ? 'error' : '',
            ),
          );
          if (window.resetsAt)
            sample.append(
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
        sample.append(element('p', '本次未返回额度窗口', 'muted'));
      if (row.usage) {
        const u = row.usage;
        sample.append(
          element(
            'p',
            `最近会话累计：输入 ${u.inputTokens.toLocaleString()} / 输出 ${u.outputTokens.toLocaleString()} tokens；缓存读取 ${u.cacheReadTokens.toLocaleString()} / 写入 ${u.cacheWriteTokens.toLocaleString()}`,
            'muted',
          ),
        );
        sample.append(element('p', '会话累计可能跨账号，不作为账号总用量。', 'muted'));
        if (u.costUsd !== null)
          sample.append(
            element('p', `API 价格估算 $${u.costUsd.toFixed(4)}（非订阅账单）`, 'muted'),
          );
        sample.append(
          element(
            'p',
            `用量采集：${date(u.measuredAt)} · 会话 ${u.sessionId}${u.runId ? ` · 运行 ${u.runId}` : ''}`,
            'digest',
          ),
        );
      }
      if (sampledAt) sample.append(element('p', `额度采集：${date(sampledAt)}`, 'muted'));
      sample.append(
        element(
          'p',
          `节点观察：${date(row.observedAt)} · VPS 接收：${date(row.receivedAt)}`,
          'muted',
        ),
      );
      card.append(sample);
    }
    container.append(card);
  }
}
async function login(sessionToken) {
  token = sessionToken;
  navigation.activate();
  $('login-panel').hidden = true;
  $('dashboard').hidden = false;
  $('logout').hidden = false;
  $('change-password').hidden = false;
  notice('');
  await loadCurrentPage();
}
$('login').addEventListener('submit', (event) => {
  event.preventDefault();
  void action(async () => {
    const value = $('token').value.trim();
    $('token').value = '';
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(value))
      throw new Error(
        '管理令牌格式不正确：只能包含英文字母、数字、下划线或短横线。也可以直接使用密码登录。',
      );
    await login(value);
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
$('monitor-search').addEventListener('input', renderMonitor);
setInterval(() => {
  if (
    token &&
    navigation.current === 'accounts' &&
    !pending &&
    !document.hidden &&
    !monitorDrafts.size &&
    !document.activeElement?.closest('#monitor-nodes form')
  )
    void action(refreshMonitor);
}, 30000);
$('logout').addEventListener('click', () => {
  if (token)
    void fetch(api + '/auth/logout', {
      method: 'POST',
      credentials: 'omit',
      keepalive: true,
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => {});
  logout();
  notice('已退出。');
});
const moderation = setupModeration({ request, action, notice, element, date });
const passwordLogin = setupPasswordLogin({ action, notice, login, request });
const navigation = setupNavigation({
  changed: queuePageRefresh,
  authenticated: () => Boolean(token),
});
