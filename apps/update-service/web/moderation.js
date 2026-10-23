const $ = (id) => document.getElementById(id);
export function setupModeration({ request, action, notice, element, date }) {
  let config;
  const labels = {
    allow: '通过',
    keyword_block: '关键词拦截',
    jev_block: 'JEV 拦截',
    error: '审核失败，未放行',
  };
  function show(moderation) {
    $('updates-panel').hidden = moderation;
    $('moderation-panel').hidden = !moderation;
    $('show-updates').setAttribute('aria-pressed', String(!moderation));
    $('show-moderation').setAttribute('aria-pressed', String(moderation));
  }
  function renderConfig(value) {
    config = value;
    $('moderation-mode').value = value.mode;
    $('moderation-keywords').value = value.keywords.join('\n');
    $('jev-url').value = value.baseUrl;
    $('jev-model').value = value.model;
    $('jev-timeout').value = value.timeoutMs;
    $('moderation-retention').value = value.retentionDays;
    $('jev-key').value = '';
    $('jev-remove-key').checked = false;
    $('jev-key-status').textContent = value.apiKeyConfigured
      ? '已保存 API 密钥（不回显）'
      : '尚未配置 API 密钥';
    $('moderation-thresholds').replaceChildren();
    for (const [category, score] of Object.entries(value.thresholds)) {
      const label = element('label', category);
      const input = element('input');
      input.type = 'number';
      input.min = '0';
      input.max = '1';
      input.step = '0.01';
      input.required = true;
      input.value = score;
      input.dataset.category = category;
      label.append(input);
      $('moderation-thresholds').append(label);
    }
  }
  async function refreshEvents() {
    const events = await request('/moderation/events');
    $('moderation-events').replaceChildren();
    for (const event of events) {
      const row = element('tr');
      const detail = event.detail;
      for (const value of [
        date(event.at),
        `${event.actor}\n${event.id}`,
        `${event.kind === 'admin.preview' ? '文本试算' : '配置更新'} / ${event.revision}`,
        event.kind === 'admin.preview'
          ? `${labels[detail.action] ?? detail.action}${detail.error ? ` · ${detail.error}` : ''}${detail.matchedKeyword ? ` · ${detail.matchedKeyword}` : ''}${detail.categories?.length ? ` · ${detail.categories.join(', ')}` : ''}`
          : `策略：${detail.mode}${detail.keyChanged ? ' · 密钥变更' : ''}`,
      ])
        row.append(element('td', value));
      const details = element('details');
      details.append(
        element('summary', '详情'),
        element('pre', JSON.stringify(detail, null, 2), 'preview-result'),
      );
      row.lastChild.append(details);
      $('moderation-events').append(row);
    }
  }
  async function refresh() {
    renderConfig(await request('/moderation/config'));
    await refreshEvents();
  }
  $('show-updates').addEventListener('click', () => show(false));
  $('show-moderation').addEventListener('click', () =>
    action(async () => {
      await refresh();
      show(true);
      notice('');
    }),
  );
  $('moderation-refresh').addEventListener('click', () => action(refresh));
  $('moderation-config').addEventListener('submit', (event) => {
    event.preventDefault();
    void action(async () => {
      if (!config) throw new Error('请先刷新审核配置。');
      const data = {
        revision: config.revision,
        mode: $('moderation-mode').value,
        keywords: $('moderation-keywords')
          .value.split('\n')
          .map((word) => word.trim())
          .filter(Boolean),
        baseUrl: $('jev-url').value,
        model: $('jev-model').value,
        apiKey: $('jev-remove-key').checked ? '' : $('jev-key').value || null,
        timeoutMs: Number($('jev-timeout').value),
        retentionDays: Number($('moderation-retention').value),
        thresholds: Object.fromEntries(
          [...$('moderation-thresholds').querySelectorAll('input')].map((input) => [
            input.dataset.category,
            Number(input.value),
          ]),
        ),
      };
      $('jev-key').value = '';
      renderConfig(
        await request('/moderation/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(data),
        }),
      );
      await refreshEvents();
      notice('审核配置已保存；CC 节点尚未接入强制检查。');
    });
  });
  $('moderation-preview').addEventListener('submit', (event) => {
    event.preventDefault();
    void action(async () => {
      $('moderation-result').textContent = '';
      const result = await request('/moderation/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: $('moderation-text').value }),
      });
      $('moderation-result').textContent =
        `${labels[result.action]}\n${JSON.stringify(result, null, 2)}`;
      await refreshEvents();
    });
  });
  return {
    clear() {
      config = undefined;
      show(false);
      $('moderation-config').reset();
      $('moderation-preview').reset();
      for (const id of [
        'moderation-events',
        'moderation-result',
        'moderation-thresholds',
        'jev-key-status',
      ])
        $(id).replaceChildren();
    },
  };
}
