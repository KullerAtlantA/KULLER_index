'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  ready: () => ipcRenderer.send('ui:ready'),
  info: () => call('app:info'),

  settings: {
    get: () => call('settings:get'),
    set: (patch) => call('settings:set', patch)
  },

  catalog: {
    list: () => call('catalog:list'),
    scan: () => call('catalog:scan'),
    cancel: () => call('catalog:cancel'),
    add: (files, tagsByFile) => call('catalog:add', files, tagsByFile),
    addPaths: (paths, tagsByFile, opts) => call('catalog:addPaths', paths, tagsByFile, opts),
    classify: (paths) => call('catalog:classify', paths),
    folderPlan: (dir) => call('catalog:folderPlan', dir),
    removeRoot: (root) => call('catalog:removeRoot', root),
    rootTags: (root, tags) => call('catalog:rootTags', root, tags),
    search: (q) => call('catalog:search', q),
    text: (id) => call('catalog:text', id),
    removeRecords: (ids) => call('catalog:removeRecords', ids),
    tags: (ids, mode, tags) => call('catalog:tags', ids, mode, tags),
    party: (ids, party) => call('catalog:party', ids, party)
  },

  file: {
    open: (id) => call('file:open', id),
    reveal: (id) => call('file:reveal', id),
    rename: (id, name) => call('file:rename', id, name)
  },

  op: {
    printers: () => call('op:printers'),
    openDir: (dir) => call('op:openDir', dir),
    print: (ids, options) => call('op:print', ids, options),
    trash: (ids) => call('op:trash', ids),
    move: (ids, dest) => call('op:move', ids, dest),
    zip: (ids, dir, name) => call('op:zip', ids, dir, name),
    mail: (payload) => call('op:mail', payload)
  },

  history: {
    state: () => call('history:state'),
    undo: () => call('history:undo'),
    redo: () => call('history:redo')
  },

  dialog: {
    folder: (title) => call('dialog:folder', title),
    folders: () => call('dialog:folders'),
    files: () => call('dialog:files')
  },

  // Путь перетащенного файла в Electron берётся только так.
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch (e) { return file.path || ''; }
  },

  onTheme: (cb) => ipcRenderer.on('theme:changed', (_e, t) => cb(t)),
  onScanProgress: (cb) => ipcRenderer.on('scan:progress', (_e, p) => cb(p))
});
