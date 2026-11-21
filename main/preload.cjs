const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('ploink', {
  getState: invoke('state:get'),
  saveProject: invoke('project:save'),
  deleteProject: invoke('project:delete'),
  reorderProjects: invoke('project:reorder'),
  detectProject: invoke('project:detect'),
  addProjectPath: invoke('project:addPath'),
  pickFolder: invoke('dialog:pickFolder'),
  pickIcon: invoke('dialog:pickIcon'),
  fetchIcon: invoke('icon:fetch'),
  deploy: invoke('deploy:start'),
  runAction: invoke('action:start'),
  trust: invoke('run:trust'),
  addMcpClient: invoke('mcp:addClient'),
  removeMcpClient: invoke('mcp:removeClient'),
  cancel: invoke('deploy:cancel'),
  approve: invoke('deploy:approve'),
  deny: invoke('deploy:deny'),
  getRun: invoke('run:get'),
  getHistory: invoke('history:get'),
  getActivity: invoke('activity:get'),
  getUsage: invoke('usage:get'),
  refreshUsage: invoke('usage:refresh'),
  openUsage: invoke('usage:open'),
  connectClaude: invoke('usage:connectClaude'),
  disconnectClaude: invoke('usage:disconnectClaude'),
  saveSettings: invoke('settings:save'),
  hide: invoke('app:hide'),
  copy: invoke('app:copy'),
  reveal: invoke('app:reveal'),
  openUrl: invoke('app:openUrl'),
  pauseShortcut: invoke('app:pauseShortcut'),
  // launch bar
  barInteractive: invoke('bar:interactive'),
  barHold: invoke('bar:hold'),
  barRelease: invoke('bar:release'),
  barLayout: invoke('bar:layout'),
  barMenu: invoke('bar:menu'),
  openConsole: invoke('bar:console'),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },
  on: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on('ploink:event', handler);
    return () => ipcRenderer.removeListener('ploink:event', handler);
  },
});
