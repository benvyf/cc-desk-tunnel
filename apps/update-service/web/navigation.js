const base = '/cc-updates/admin/';
const pages = {
  accounts: { panel: 'monitor-panel', label: '账号监控' },
  updates: { panel: 'updates-panel', label: '客户端更新' },
  moderation: { panel: 'moderation-panel', label: '内容审核' },
};

export function setupNavigation({ changed, authenticated }) {
  const readPage = () => {
    const page = location.pathname.slice(base.length);
    return Object.hasOwn(pages, page) ? page : 'accounts';
  };
  let current = readPage();
  function show() {
    document.body.classList.add('authenticated');
    document.getElementById('primary-navigation').hidden = false;
    for (const [name, page] of Object.entries(pages)) {
      document.getElementById(page.panel).hidden = name !== current;
      const link = document.getElementById('show-' + name);
      if (name === current) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    document.title = `${pages[current].label} · CC 管理中心`;
  }
  for (const name of Object.keys(pages)) {
    document.getElementById('show-' + name).addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      event.preventDefault();
      if (current === name) return;
      current = name;
      history.pushState(null, '', base + name);
      show();
      window.scrollTo({ top: 0, behavior: 'instant' });
      changed();
    });
  }
  window.addEventListener('popstate', () => {
    current = readPage();
    if (authenticated()) {
      show();
      changed();
    }
  });
  return {
    get current() {
      return current;
    },
    activate() {
      current = readPage();
      history.replaceState(null, '', base + current);
      show();
    },
    clear() {
      document.body.classList.remove('authenticated');
      document.getElementById('primary-navigation').hidden = true;
      for (const page of Object.values(pages)) document.getElementById(page.panel).hidden = true;
      document.title = 'CC 管理中心';
    },
  };
}
