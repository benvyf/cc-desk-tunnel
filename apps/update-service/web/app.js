import { setupModeration } from './moderation.js';
import { setupPasswordLogin } from './password-login.js';
import { setupNavigation } from './navigation.js';
import { setupEnrollment } from './enrollment.js';
import { setupServerDownload } from './server-download.js';
import { setupFreshNodes } from './fresh-nodes.js';
import { setupDesktopAccess } from './desktop-access.js';
import { setupMonitor } from './monitor.js';
const api = '/cc-updates/admin/api';
const $ = (id) => document.getElementById(id);
let token = '';
let controller = new AbortController();
let pending = false;
let pageRefreshQueued = false;

let downloadExpiry;

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
  clearTimeout(downloadExpiry);
  controller.abort();
  controller = new AbortController();
  token = '';
  pageRefreshQueued = false;
  navigation.clear();
  monitor.clear();

  $('monitor-search').value = '';
  $('monitor-count').textContent = '';
  $('monitor-node-status').replaceChildren();
  $('token').value = '';
  $('dashboard').hidden = true;
  $('logout').hidden = true;
  $('change-password').hidden = true;
  $('login-panel').hidden = false;
  for (const id of ['channels', 'candidates', 'audit', 'monitor-nodes', 'downloads'])
    $(id).replaceChildren();
  moderation.clear();
  passwordLogin.clear();
  enrollment.clear();
  serverDownload.clear();
  freshNodes.clear();
  desktopAccess.clear();
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
function renderDownloads(channels) {
  clearTimeout(downloadExpiry);
  $('downloads').replaceChildren();
  let nextExpiry = Infinity;
  for (const name of ['stable', 'pilot']) {
    const payload = channels.find((c) => c.channel === name)?.payload;
    const card = element('section', undefined, 'card download-card');
    card.append(element('span', name === 'stable' ? '正式版' : '试点版', `badge ${name}`));
    const release = payload?.release;
    const expires = Date.parse(payload?.expiresAt);
    const valid =
      payload?.state === 'published' &&
      Number.isFinite(expires) &&
      expires > Date.now() &&
      Number.isSafeInteger(release?.build) &&
      release.build > 0 &&
      /^\d+\.\d+\.\d+$/.test(release.appVersion) &&
      release.filename === `CC-Desk-Tunnel-Setup-${release.appVersion}-x64.exe`;
    if (!valid) {
      card.append(
        element('h3', name === 'stable' ? '暂无正式版可下载' : '暂无试点版可下载'),
        element(
          'p',
          release && expires <= Date.now()
            ? '发布索引已过期，请由管理员续期后刷新。'
            : '此通道尚未发布可用安装包。',
          'muted',
        ),
      );
    } else {
      nextExpiry = Math.min(nextExpiry, expires);
      card.append(
        element('h3', `v${release.appVersion} · Build ${release.build}`),
        element('p', `Windows x64 · 完整安装包 · ${(release.size / 1048576).toFixed(1)} MB`),
        element('p', `需配套协议 ${release.protocol} 的 CC 服务端。`, 'muted'),
        element('p', release.notes, 'notes'),
      );
      if (name === 'pilot') card.append(element('p', '试点版本，建议先在一台电脑验证。', 'muted'));
      const path = `/cc-updates/v1/artifacts/${release.build}/win32-x64/${release.filename}`;
      const link = element('a', '下载完整安装包', 'download-link');
      link.href = path;
      link.download = release.filename;
      link.addEventListener('click', (event) => {
        if (Date.now() >= expires) {
          event.preventDefault();
          renderDownloads(channels);
          notice('发布索引已过期，请刷新当前发布。', true);
        }
      });
      const copy = element('button', '复制下载链接', 'quiet');
      copy.addEventListener('click', () =>
        action(async () => {
          if (Date.now() >= expires) throw new Error('发布索引已过期，请刷新当前发布。');
          await navigator.clipboard.writeText(new URL(path, location.origin).href);
          notice('下载链接已复制。');
        }),
      );
      const controls = element('div', undefined, 'controls');
      controls.append(link, copy);
      const details = element('details');
      details.append(
        element('summary', '校验与构建信息'),
        element('p', `SHA256 ${release.sha256}\n源码 ${release.sourceCommit}`, 'digest'),
      );
      card.append(controls, details);
    }
    $('downloads').append(card);
  }
  if (Number.isFinite(nextExpiry))
    downloadExpiry = setTimeout(
      () => renderDownloads(channels),
      Math.min(2147483647, Math.max(1, nextExpiry - Date.now())),
    );
}
async function refresh() {
  clearTimeout(downloadExpiry);
  $('downloads').replaceChildren();
  await serverDownload.refresh();
  const data = await request('/status');
  renderDownloads(data.channels);
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
  await monitor.refresh();
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
setInterval(() => {
  if (
    token &&
    navigation.current === 'accounts' &&
    !pending &&
    !document.hidden &&
    !monitor.hasDrafts &&
    $('desktop-access-panel').hidden &&
    !document.activeElement?.closest('#monitor-panel form')
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
const enrollment = setupEnrollment({ request, action, notice, date });
const serverDownload = setupServerDownload({ request, element, notice });
const freshNodes = setupFreshNodes({ request, action, notice, date });
const monitor = setupMonitor({
  request,
  action,
  notice,
  element,
  date,
  manage: (id, tab) => desktopAccess.open(id, tab),
});
const desktopAccess = setupDesktopAccess({ request, action, notice, date, monitor });
const navigation = setupNavigation({
  changed: queuePageRefresh,
  authenticated: () => Boolean(token),
});
