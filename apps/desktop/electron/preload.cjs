const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  terminalWindow: {
    appearance: (theme) => ipcRenderer.invoke('terminal-window:appearance', theme),
    focus: () => ipcRenderer.invoke('terminal-window:focus'),
    control: (action) => ipcRenderer.invoke('terminal-window:control', action),
    setActive: (active) => ipcRenderer.invoke('terminal-window:active', active),
    finishClose: (allowed) => ipcRenderer.invoke('terminal-window:finish-close', allowed),
    onState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('terminal-window:state', listener);
      return () => ipcRenderer.removeListener('terminal-window:state', listener);
    },
    onRequestClose: (callback) => {
      const listener = () => callback();
      ipcRenderer.on('terminal-window:request-close', listener);
      return () => ipcRenderer.removeListener('terminal-window:request-close', listener);
    },
    onClosed: (callback) => {
      const listener = () => callback();
      ipcRenderer.on('terminal-window:closed', listener);
      return () => ipcRenderer.removeListener('terminal-window:closed', listener);
    },
  },
  dev: process.argv.includes('--cc-desk-tunnel-dev'),
  platform: process.platform,
  // Read once, before the page draws: see `boot` in main.cjs.
  boot: ipcRenderer.sendSync('boot'),
  saveShared: (key, value) => ipcRenderer.invoke('shared:save', key, value),
  onSharedChanged: (callback) => {
    const listener = (_event, key, value) => callback(key, value);
    ipcRenderer.on('shared:changed', listener);
    return () => ipcRenderer.removeListener('shared:changed', listener);
  },
  setBusy: (runs) => ipcRenderer.invoke('busy:set', runs),
  connections: () => ipcRenderer.invoke('connections:list'),
  createConnection: (name) => ipcRenderer.invoke('connections:create', name),
  openConnection: (id) => ipcRenderer.invoke('connections:open', id),
  renameConnection: (id, name) => ipcRenderer.invoke('connections:rename', id, name),
  removeConnection: (id) => ipcRenderer.invoke('connections:remove', id),
  chooseProject: () => ipcRenderer.invoke('project:choose'),
  asOnDisk: (path) => ipcRenderer.invoke('project:spelling', path),
  foldersExist: (folders) => ipcRenderer.invoke('folders:exist', folders),
  chooseFiles: () => ipcRenderer.invoke('files:choose'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  saveTerminalFile: (name, data, encoding) =>
    ipcRenderer.invoke('terminal-file:save', name, data, encoding),
  saveFile: (name, text) => ipcRenderer.invoke('file:save', name, text),
  saveImage: (type, bytes) => ipcRenderer.invoke('image:save', type, bytes),
  attachmentPreview: (path) => ipcRenderer.invoke('attachment:preview', path),
  openFolder: (directory) => ipcRenderer.invoke('folder:open', directory),
  openLogs: () => ipcRenderer.invoke('log:open'),
  openDevTools: () => ipcRenderer.invoke('devtools:open'),
  gitBranch: (directory) => ipcRenderer.invoke('git:branch', directory),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  openWeb: (url) => ipcRenderer.invoke('web:open', url),
  openLink: (url) => ipcRenderer.invoke('link:open', url),
  inspectPath: (path) => ipcRenderer.invoke('path:inspect', path),
  actOnPath: (action, path, options) => ipcRenderer.invoke('path:act', action, path, options),
  workspaceRoots: () => ipcRenderer.invoke('workspace:roots'),
  chooseWorkspace: (reset) => ipcRenderer.invoke('workspace:choose', reset),
  createWorkspace: () => ipcRenderer.invoke('workspace:create'),
  removeWorkspace: (directory) => ipcRenderer.invoke('workspace:remove', directory),
  loadLogin: () => ipcRenderer.invoke('login:load'),
  access: {
    load: () => ipcRenderer.invoke('access:load'),
    login: (input) => ipcRenderer.invoke('access:login', input),
    ticket: (nodeId) => ipcRenderer.invoke('access:ticket', nodeId),
    logout: () => ipcRenderer.invoke('access:logout'),
    onExpired: (callback) => {
      const listener = (_event, message) => callback(message);
      ipcRenderer.on('access:expired', listener);
      return () => ipcRenderer.removeListener('access:expired', listener);
    },
  },
  saveLogin: (login) => ipcRenderer.invoke('login:save', login),
  loadDrafts: () => ipcRenderer.invoke('drafts:load'),
  saveDrafts: (drafts) => ipcRenderer.invoke('drafts:save', drafts),
  loadSchedules: (initial) => ipcRenderer.invoke('schedules:load', initial),
  saveSchedules: (text) => ipcRenderer.invoke('schedules:save', text),
  onSchedulesChanged: (callback) => {
    const listener = (_event, text) => callback(text);
    ipcRenderer.on('schedules:changed', listener);
    return () => ipcRenderer.removeListener('schedules:changed', listener);
  },
  windowSettings: () => ipcRenderer.invoke('window:settings'),
  setWindowSettings: (values) => ipcRenderer.invoke('window:settings:set', values),
  notify: (notice) => ipcRenderer.invoke('notify:show', notice),
  onNotifyClicked: (callback) => {
    const listener = (_event, sessionId) => callback(sessionId);
    ipcRenderer.on('notify:clicked', listener);
    return () => ipcRenderer.removeListener('notify:clicked', listener);
  },
  zoom: (direction) =>
    webFrame.setZoomLevel(direction ? webFrame.getZoomLevel() + Math.sign(direction) * 0.5 : 0),
  quit: (all) => ipcRenderer.invoke('app:quit', all),
  version: () => ipcRenderer.invoke('app:version'),
  managedServer: {
    check: (connection) => ipcRenderer.invoke('managed-server:check', connection),
    install: (confirmation) => ipcRenderer.invoke('managed-server:install', confirmation),
    status: (connection) => ipcRenderer.invoke('managed-server:status', connection),
    cancel: () => ipcRenderer.invoke('managed-server:cancel'),
    openManager: () => ipcRenderer.invoke('managed-server:manager'),
  },
  managedUpdate: {
    state: () => ipcRenderer.invoke('managed-update:state'),
    check: () => ipcRenderer.invoke('managed-update:check'),
    download: () => ipcRenderer.invoke('managed-update:download'),
    install: () => ipcRenderer.invoke('managed-update:install'),
    cancel: () => ipcRenderer.invoke('managed-update:cancel'),
    activity: (value) => ipcRenderer.invoke('managed-update:activity', value),
    subscribe: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('managed-update:changed', listener);
      return () => ipcRenderer.removeListener('managed-update:changed', listener);
    },
  },
  releaseNotes: (version) => ipcRenderer.invoke('release:notes', version),
  device: () => ipcRenderer.invoke('device:get'),
  installUpdate: (version) => ipcRenderer.invoke('update:install', version),
  onUpdateProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('update:progress', listener);
    return () => ipcRenderer.removeListener('update:progress', listener);
  },
  upgradeService: (config) => ipcRenderer.invoke('service:upgrade', config),
  onServiceUpgrade: (callback) => {
    const listener = (_event, update) => callback(update);
    ipcRenderer.on('service:upgrade-progress', listener);
    return () => ipcRenderer.removeListener('service:upgrade-progress', listener);
  },
  connectProxy: (config) => ipcRenderer.invoke('proxy:connect', config),
  disconnectProxy: () => ipcRenderer.invoke('proxy:disconnect'),
  onProxyClosed: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('proxy:closed', listener);
    return () => ipcRenderer.removeListener('proxy:closed', listener);
  },
});
