const $ = (id) => document.getElementById(id);
export function setupModeration({ request, action, notice, element, date }) {
  let config;
  const categoryLabels = {
    harassment: '辱骂与骚扰',
    'harassment/threatening': '人身威胁',
    hate: '群体仇恨',
    'hate/threatening': '群体暴力威胁',
    illicit: '违法执行帮助',
    'illicit/violent': '暴力犯罪帮助',
    'self-harm': '鼓励自残',
    'self-harm/intent': '自残意图',
    'self-harm/instructions': '自残方法',
    sexual: '露骨色情',
    'sexual/minors': '未成年人性化',
    violence: '暴力伤害',
    'violence/graphic': '血腥细节',
    'policy/political-harm': '政治与公共安全危害',
    'policy/violence-extremism': '恐怖、极端与危险行为',
    'policy/sexual-vulgar': '色情与低俗诱导',
    'policy/crime': '违法犯罪、诈骗与赌博',
    'policy/abuse-privacy': '欺凌、恶劣诱导与隐私侵犯',
    'policy/jailbreak-extraction': '破甲、越权与内部提示窃取',
    'policy/model-distillation': '模型蒸馏、复刻与训练取数',
  };
  const labels = {
    allow: '通过',
    keyword_block: '关键词拦截',
    jev_block: 'JEV 拦截',
    error: '审核失败，未放行',
  };
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
      const label = element('label', `${categoryLabels[category] ?? category} (${category})`);
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
        `${event.kind === 'node.review' ? '节点审核' : event.kind === 'admin.preview' ? '文本试算' : event.kind === 'config.migrated' ? '规则升级' : '配置更新'} / ${event.revision}`,
        event.kind === 'admin.preview' || event.kind === 'node.review'
          ? `${labels[detail.action] ?? detail.action}${detail.error ? ` · ${detail.error}` : ''}${detail.matchedKeyword ? ` · ${detail.matchedKeyword}` : ''}${detail.categories?.length ? ` · ${detail.categories.join(', ')}` : ''}`
          : event.kind === 'config.migrated'
            ? `规则：${detail.rulesVersion}`
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
  async function refreshUsage() {
    const usage = await request('/moderation/usage');
    const n = (value) => Number(value).toLocaleString('zh-CN');
    $('jev-usage').textContent =
      `统计起始：${date(usage.startedAt)}。已请求 ${n(usage.requests)} 次，失败 ${n(usage.errorRequests)} 次；已报告输入 ${n(usage.inputTokens)} Token，输出 ${n(usage.outputTokens)} Token，合计 ${n(usage.totalTokens)} Token。未取得用量 ${n(usage.unreportedRequests)} 次。`;
  }
  async function refresh() {
    renderConfig(await request('/moderation/config'));
    await refreshEvents();
    await refreshUsage();
  }
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
      await refreshUsage();
      notice('审核配置已保存；仅对已部署门禁的节点生效。');
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
      await refreshUsage();
    });
  });
  return {
    refresh,
    clear() {
      config = undefined;
      $('moderation-config').reset();
      $('moderation-preview').reset();
      for (const id of [
        'moderation-events',
        'moderation-result',
        'moderation-thresholds',
        'jev-key-status',
        'jev-usage',
      ])
        $(id).replaceChildren();
    },
  };
}
