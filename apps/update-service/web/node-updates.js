export function setupNodeUpdates({ request, action, notice }) {
  const $ = (id) => document.getElementById(id);
  let nodeId, data, timer, grant, confirmation;
  let generation = 0,
    refreshSequence = 0,
    submitting = false;
  const post = (path, body) =>
    request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const labels = {
    queued: '等待设备接收',
    running: '正在更新',
    waiting: '等待空闲或设备继续上报',
    succeeded: '更新成功',
    failed: '更新未完成',
    'maintenance-required': '需要宿主机修复',
  };
  const terminal = (w) => w && ['succeeded', 'failed', 'maintenance-required'].includes(w.state);
  const maintenance = (w) => w?.maintenanceRequired || w?.state === 'maintenance-required';
  const sameComponent = (a, b) =>
    a === b ||
    (!!a && !!b && a.version === b.version && a.build === b.build && a.sha256 === b.sha256);
  const sameTarget = (a, b) =>
    !!a && !!b && sameComponent(a.agent, b.agent) && sameComponent(a.app, b.app);
  const legacy = () =>
    data?.registration === 'legacy' ||
    (data?.workflow?.legacy && data.workflow.adoptionPhase !== 'adopted');
  const currentApp = () => data?.app?.current ?? data?.app;
  const olderAgent = (t) => data?.agent?.version > t?.agent?.version;
  const incompatibleBridge = (t) => legacy() && (!t?.app || currentApp()?.build > t.app.build);
  const publishedTarget = (t) =>
    sameComponent(t?.agent, data?.target?.agent) &&
    (!t?.app || sameComponent(t.app, data?.target?.app));
  function selectedTarget() {
    if (!data?.target?.agent) return null;
    const w = data.workflow;
    // Keep a retry's exact target while it remains published. A retired target
    // requires explicit confirmation of a new workflow at the current publication.
    if (data.retry && !maintenance(w) && publishedTarget(w.target)) return w.target;
    return {
      agent: data.target.agent,
      app:
        legacy() ||
        (data.target.app && (!currentApp()?.build || currentApp().build < data.target.app.build))
          ? data.target.app
          : null,
    };
  }
  const retryConfirmation = () =>
    data?.retry &&
    (maintenance(data.workflow) || sameTarget(data.workflow.target, selectedTarget()));
  const newTargetConfirmation = () =>
    data?.workflow?.state === 'failed' &&
    !maintenance(data.workflow) &&
    !sameTarget(data.workflow.target, selectedTarget());
  function targetText(t) {
    return t
      ? `Agent ${t.agent?.version ?? '不可用'} · SHA256 ${t.agent?.sha256 ?? '—'}\n${t.app ? `应用 Build ${t.app.build} · SHA256 ${t.app.sha256}` : '应用保持当前版本'}`
      : '暂无有效的已签名 Agent 发布';
  }
  function componentText(result, includeDigest = true) {
    if (!result) return '尚无应用结果';
    return `作业 ${result.id} · 应用 Build ${result.build}\n${labels[result.state] ?? result.state} · ${result.updatedAt ?? '尚无更新时间'}${includeDigest && result.sha256 ? `\nSHA256 ${result.sha256}` : ''}\n${result.progress ?? ''}`;
  }
  function historyText(h) {
    return `流程 ${h.id}\n${labels[h.state] ?? h.state} / ${h.stage}\n创建 ${h.createdAt ?? '—'} · 更新 ${h.updatedAt ?? '—'}${h.retryOf ? `\n继续自流程 ${h.retryOf}` : ''}\n${targetText(h.target)}\n${componentText(h.appResult)}`;
  }
  function canInstall() {
    const t = selectedTarget(),
      w = data?.workflow;
    if (
      !data?.enrolled ||
      !data.online ||
      !['ready', 'legacy'].includes(data.registration) ||
      !t ||
      submitting
    )
      return false;
    if (w && !terminal(w)) return false;
    if (olderAgent(t)) return false;
    if (incompatibleBridge(t)) return false;
    if (maintenance(w) && !data.retry) return false;
    if (data.retry) return publishedTarget(t);
    if (w && sameTarget(w.target, t)) return false;
    return !!t.app || !data.agent || t.agent.version > data.agent.version;
  }
  function render() {
    const registration = {
      ready: '已接入 · 注册就绪',
      initializing: '已接入 · 平台初始化中',
      legacy: '旧版已接入 · 更新将自动迁移，无需重新接入',
      unenrolled: '尚未接入宿主机更新通道',
    };
    $('node-update-channel').textContent =
      `${registration[data.registration] ?? data.registration} · ${data.online ? '在线' : '离线，等待设备连接'}${data.app?.phase ? ` · 应用 ${data.app.phase}` : ''}`;
    const app = currentApp();
    $('node-update-current').textContent =
      `当前 Agent ${data.agent?.version ?? '旧版／尚未上报'} · 应用 ${app?.build ? `Build ${app.build}${app.appVersion ? ` / v${app.appVersion}` : ''}${app.protocol ? ` / 协议 ${app.protocol}` : ''}` : '尚未上报'}`;
    $('node-update-target').textContent = `本次选择的目标：\n${targetText(selectedTarget())}`;
    $('node-update-install').disabled = !canInstall();
    $('node-update-install').textContent = retryConfirmation()
      ? maintenance(data.workflow)
        ? '修复后确认继续此设备'
        : '明确重试此设备'
      : newTargetConfirmation()
        ? '确认此设备的新发布目标'
        : '更新此设备';
    // An enrolled or legacy machine uses its existing channel, never reenrollment.
    const enroll = !data.enrolled && data.registration === 'unenrolled';
    $('node-update-enroll').hidden = !enroll;
    $('node-update-enroll').disabled = !enroll || submitting;
    const w = data.workflow;
    $('node-update-job').textContent = w
      ? `${labels[w.state] ?? w.state} · ${w.state} / ${w.stage} · ${w.id}${data.adoption ? ` · 旧版迁移 ${data.adoption.phase}` : ''}${maintenance(w) ? '。先修复宿主机；需要新鲜的修复证明及明确重试，历史故障不会清除。' : ''}`
      : '尚未提交更新流程；由你选择此设备的更新时间。';
    if (olderAgent(selectedTarget()))
      $('node-update-job').textContent +=
        '。当前发布的 Agent 版本低于本机；需要包含兼容 Agent 版本的发布目录，不能降级。';
    else if (incompatibleBridge(selectedTarget()))
      $('node-update-job').textContent +=
        '。需要兼容的桥接发布：旧版设备不能降级应用，请等待不低于本机版本的已签名桥接目标。';
    else if (newTargetConfirmation())
      $('node-update-job').textContent +=
        '。可明确确认当前发布目标并建立新流程，原故障记录会保留。';
    $('node-update-progress').textContent = (w?.steps ?? [])
      .slice(-100)
      .map((s) => `${s.at ?? ''} · ${s.stage} / ${s.state}\n${s.message ?? ''}\n${s.log ?? ''}`)
      .join('\n\n');
    $('node-update-app-result').textContent = componentText(w?.appResult);
    $('node-update-history').textContent =
      (data.history ?? []).map(historyText).join('\n\n') || '暂无历史流程';
  }
  async function refresh(epoch = generation) {
    if (!nodeId || epoch !== generation) return;
    clearTimeout(timer);
    const id = nodeId,
      sequence = ++refreshSequence;
    const active = () => epoch === generation && sequence === refreshSequence && id === nodeId;
    try {
      const next = await request(`/host-workflows/${id}`);
      if (!active()) return;
      data = next;
      render();
      $('node-update-error').textContent = '';
      $('node-update-legacy-progress').textContent = '';
      if (legacy()) {
        try {
          const old = await request(`/host-updates/${id}`);
          if (!active()) return;
          $('node-update-legacy-progress').textContent = old.job
            ? componentText(old.job, false)
            : '尚无旧版组件作业';
        } catch (error) {
          if (active())
            $('node-update-legacy-progress').textContent = `旧版组件进度读取失败：${error.message}`;
        }
      }
    } catch (error) {
      if (active() && error.name !== 'AbortError') {
        data = undefined;
        $('node-update-install').disabled = true;
        $('node-update-error').textContent = error.message;
      }
    } finally {
      if (active()) timer = setTimeout(() => void refresh(epoch), 5000);
    }
  }
  function cancelConfirmation() {
    confirmation = undefined;
    $('node-update-confirmation').hidden = true;
    $('node-update-confirm').onclick = () => {};
  }
  function clear() {
    generation++;
    refreshSequence++;
    clearTimeout(timer);
    nodeId = data = grant = undefined;
    submitting = false;
    cancelConfirmation();
    $('node-update-panel').hidden = true;
    $('node-update-command').value = '';
    $('node-update-enrollment').hidden = true;
    for (const id of [
      'progress',
      'app-result',
      'history',
      'legacy-progress',
      'error',
      'current',
      'target',
      'job',
      'confirm-text',
    ])
      $('node-update-' + id).textContent = '';
    $('node-update-channel').textContent = '正在读取宿主机更新通道';
    $('node-update-install').disabled = true;
    $('node-update-enroll').disabled = true;
    $('node-update-enroll').hidden = true;
  }
  // Catch errors inside the generation boundary so logout / switching devices
  // cannot surface a stale response or recreate a cleared command.
  function deviceAction(fn) {
    const epoch = generation,
      id = nodeId;
    return action(async () => {
      if (epoch !== generation || id !== nodeId || !id) return;
      try {
        await fn(epoch, id);
      } catch (error) {
        if (epoch === generation && error.name !== 'AbortError')
          $('node-update-error').textContent = error.message;
      }
    });
  }
  $('node-update-close').onclick = clear;
  $('node-update-refresh').onclick = () => void refresh();
  $('node-update-enroll').onclick = () => {
    if ($('node-update-enroll').disabled || $('node-update-enroll').hidden) return;
    void deviceAction(async (epoch, id) => {
      const next = await post(`/host-updates/${id}/enrollment`, {});
      if (epoch !== generation) return;
      grant = next;
      $('node-update-command').value = grant.command;
      $('node-update-enrollment').hidden = false;
      notice('仅在此设备执行一次 HostEnroll 接入命令；接入不会自动更新。');
    });
  };
  $('node-update-copy').onclick = () =>
    void deviceAction(async () => {
      if (!grant || Date.parse(grant.expiresAt) <= Date.now())
        throw new Error('接入命令已过期，请重新生成。');
      await navigator.clipboard.writeText(grant.command);
    });
  $('node-update-install').onclick = () => {
    if (!canInstall()) return;
    const snapshot = {
      epoch: generation,
      id: nodeId,
      body: structuredClone({
        confirmed: true,
        ...selectedTarget(),
        ...(retryConfirmation() ? { retryOf: data.workflow.id } : {}),
      }),
    };
    confirmation = snapshot;
    $('node-update-confirm-text').textContent =
      `确认只更新设备 ${snapshot.id}？\n${targetText(snapshot.body)}${snapshot.body.retryOf ? `\n明确继续历史流程 ${snapshot.body.retryOf}；保留原故障记录。` : newTargetConfirmation() ? `\n按当前发布目标建立新流程；保留原故障记录 ${data.workflow.id}。` : ''}\n内部步骤将自动执行：Agent、预检、依赖、准备、维护切换和验证。请结束运行及等待审批的任务并关闭原生终端；准备完成后会断开空闲客户端，服务会短暂中断。旧版设备将通过完整流程自动迁移，无需重新接入。`;
    $('node-update-confirmation').hidden = false;
    $('node-update-confirm').onclick = () => {
      if (
        confirmation !== snapshot ||
        snapshot.epoch !== generation ||
        snapshot.id !== nodeId ||
        !canInstall()
      )
        return;
      void deviceAction(async (epoch) => {
        submitting = true;
        render();
        $('node-update-confirm').disabled = true;
        try {
          await post(`/host-workflows/${snapshot.id}`, snapshot.body);
          if (epoch !== generation) return;
          cancelConfirmation();
          notice(`已提交设备 ${snapshot.id} 的更新流程；请等待明确结果。`);
        } finally {
          if (epoch === generation) {
            submitting = false;
            $('node-update-confirm').disabled = false;
            await refresh(epoch);
          }
        }
      });
    };
    $('node-update-confirm').focus();
  };
  $('node-update-cancel').onclick = () => {
    cancelConfirmation();
    $('node-update-install').focus();
  };
  $('node-update-confirmation').addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !submitting) {
      event.preventDefault();
      cancelConfirmation();
      $('node-update-install').focus();
    }
  });
  return {
    async open(id) {
      clear();
      nodeId = id;
      const epoch = generation;
      $('node-update-heading').textContent = `${id} · 设备更新`;
      $('node-update-panel').hidden = false;
      $('node-update-confirm').disabled = false;
      await refresh(epoch);
      if (epoch === generation)
        $('node-update-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    clear,
  };
}
