'use strict';
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, nativeTheme, shell } = require('electron');
const store = require('./store');
const history = require('./history');
const catalog = require('./catalog');
const ops = require('./ops');

const SPLASH_MS = 1700;
let splash = null;
let win = null;

// Тем две: тёмная и светлая. Настройка Windows спрашивается ровно один раз —
// при самом первом запуске, чтобы не встречать человека чужой темой.
function applyTheme(theme) {
  const t = theme === 'dark' || theme === 'light' ? theme : null;
  nativeTheme.themeSource = t || 'system';
  return t || (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
}

function currentTheme() {
  let t = store.settings().theme;
  if (t !== 'dark' && t !== 'light') {
    t = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    store.saveSettings({ theme: t });
  }
  return { source: t, resolved: applyTheme(t) };
}

function createSplash() {
  const dark = nativeTheme.shouldUseDarkColors;
  splash = new BrowserWindow({
    width: 520, height: 300, frame: false, resizable: false, movable: false,
    center: true, show: false, transparent: false, alwaysOnTop: true, skipTaskbar: true,
    backgroundColor: dark ? '#0d0d0e' : '#f2f1ed'
  });
  splash.loadFile(path.join(__dirname, '..', 'renderer', 'splash.html'), {
    query: { theme: currentTheme().resolved }
  });
  splash.once('ready-to-show', () => splash && splash.show());
}

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 900, minHeight: 600, show: false,
    title: 'KULLER INDEX',
    icon: path.join(__dirname, '..', 'renderer', 'logo.png'),   // для запуска из исходников; в сборке иконку даёт .exe
    backgroundColor: dark ? '#0d0d0e' : '#f2f1ed',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Главное окно показывается только когда заставка отработала и интерфейс готов.
  const ready = new Promise((r) => ipcMain.once('ui:ready', r));
  const waited = new Promise((r) => setTimeout(r, SPLASH_MS));
  Promise.all([ready, waited]).then(() => {
    if (splash) { splash.destroy(); splash = null; }
    if (win) { win.show(); win.focus(); }
  });
}


const docsByIds = (ids) => catalog.byIds(ids);
const plural = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'документа' : 'документов');
const snapTags = (ids) => { const m = {}; catalog.byIds(ids).forEach((d) => { m[d.id] = [...d.tags]; }); return m; };
const wrap = (fn) => async (_e, ...args) => {
  try { return { ok: true, data: await fn(...args) }; }
  catch (err) { return { ok: false, error: err.message || String(err) }; }
};

function registerIpc() {
  ipcMain.handle('settings:get', wrap(async () => ({ ...store.settings(), theme: currentTheme() })));
  ipcMain.handle('settings:set', wrap(async (patch) => {
    const s = store.saveSettings(patch || {});
    if (patch && patch.theme) applyTheme(patch.theme);
    return { ...s, theme: currentTheme() };
  }));

  const progress = (p) => { if (win && !win.isDestroyed()) win.webContents.send('scan:progress', p); };

  ipcMain.handle('catalog:list', wrap(async () => store.catalog().docs));
  ipcMain.handle('catalog:scan', wrap(async () => catalog.scan(progress)));
  ipcMain.handle('catalog:cancel', wrap(async () => { catalog.cancel(); return true; }));
  ipcMain.handle('catalog:add', wrap(async (files, tagsByFile) => catalog.addFiles(files, tagsByFile)));
  // Приём файлов и папок одним путём: из диалога и из перетаскивания.
  ipcMain.handle('catalog:folderPlan', wrap(async (dir) => catalog.folderPlan(dir)));
  ipcMain.handle('catalog:addPaths', wrap(async (paths, tagsByFile, opts) => {
    const beforeIds = new Set(store.catalog().docs.map((d) => d.id));
    const beforeRoots = store.settings().roots.map((r) => r.path);
    const beforeRules = store.settings().rules.map((r) => r.path);
    const res = await catalog.addPaths(paths, tagsByFile, progress, opts || {});
    const addedIds = store.catalog().docs.filter((d) => !beforeIds.has(d.id)).map((d) => d.id);
    const newRoots = store.settings().roots.filter((r) => !beforeRoots.includes(r.path)).map((r) => r.path);
    const newRules = store.settings().rules.filter((r) => !beforeRules.includes(r.path)).map((r) => r.path);
    if (addedIds.length || newRoots.length) {
      let cut = null;
      history.push({
        label: `добавление (${addedIds.length} ${plural(addedIds.length)})`,
        undo: async () => {
          cut = catalog.cutRecords(addedIds);
          const s = store.settings();
          store.saveSettings({
            roots: s.roots.filter((r) => !newRoots.includes(r.path)),
            rules: s.rules.filter((r) => !newRules.includes(r.path))
          });
          return cut.names.length;
        },
        redo: async () => {
          if (cut) catalog.restoreRecords(cut);
          return catalog.addPaths(paths, tagsByFile, progress, opts || {});
        }
      });
    }
    return res;
  }));
  ipcMain.handle('catalog:classify', wrap(async (paths) => {
    const fs = require('fs').promises;
    const files = [], dirs = [], bad = [];
    for (const p of paths) {
      try { const s = await fs.stat(p); (s.isDirectory() ? dirs : files).push(p); }
      catch (e) { bad.push(p); }
    }
    return { files, dirs, bad };
  }));
  ipcMain.handle('catalog:removeRoot', wrap(async (root) => catalog.removeRoot(root)));
  ipcMain.handle('catalog:rootTags', wrap(async (root, tags) => catalog.setRootTags(root, tags)));
  // Поиск по тексту идёт там, где лежит текст: интерфейс получает только совпадения.
  ipcMain.handle('catalog:search', wrap(async (q) => catalog.search(q)));
  ipcMain.handle('catalog:text', wrap(async (id) => catalog.textOf(id).slice(0, 1200)));
  // Ниже действия, которые меняют картотеку. Каждое кладёт в историю,
  // как его откатить и как повторить, — на этом держатся стрелки и Ctrl+Z.
  ipcMain.handle('catalog:removeRecords', wrap(async (ids) => {
    const cut = catalog.cutRecords(ids);
    history.push({
      label: `удаление записей (${cut.names.length})`,
      undo: async () => catalog.restoreRecords(cut),
      redo: async () => catalog.removeRecords(ids)
    });
    return cut.names;
  }));
  ipcMain.handle('catalog:tags', wrap(async (ids, mode, tags) => {
    const before = snapTags(ids);
    const rows = catalog.updateTags(ids, mode, tags);
    const after = snapTags(ids);
    history.push({
      label: `теги у ${ids.length} ${plural(ids.length)}`,
      undo: async () => catalog.setTagsExact(before),
      redo: async () => catalog.setTagsExact(after)
    });
    return rows;
  }));
  ipcMain.handle('catalog:party', wrap(async (ids, party) => {
    const before = {};
    catalog.byIds(ids).forEach((d) => { before[d.id] = d.party; });
    catalog.setParty(ids, party);
    history.push({
      label: 'контрагент у ' + ids.length + ' ' + plural(ids.length),
      undo: async () => catalog.setPartyExact(before),
      redo: async () => catalog.setParty(ids, party)
    });
  }));

  ipcMain.handle('history:state', wrap(async () => history.state()));
  ipcMain.handle('history:undo', wrap(async () => history.undo()));
  ipcMain.handle('history:redo', wrap(async () => history.redo()));

  ipcMain.handle('file:open', wrap(async (id) => ops.openFile(docsByIds([id])[0])));
  ipcMain.handle('file:reveal', wrap(async (id) => ops.revealFile(docsByIds([id])[0])));
  ipcMain.handle('file:rename', wrap(async (id, name) => {
    const doc = docsByIds([id])[0];
    const was = doc.name;
    const r = await ops.renameDoc(doc, name);
    history.push({
      label: `переименование «${was}»`,
      undo: async () => ops.renameDoc(docsByIds([id])[0], was),
      redo: async () => ops.renameDoc(docsByIds([id])[0], name)
    });
    return r;
  }));

  // Открыть наблюдаемую папку в проводнике. Путь принимается только из списка источников:
  // произвольный путь из интерфейса здесь открыть нельзя.
  ipcMain.handle('op:openDir', wrap(async (dir) => {
    const norm = (s) => path.normalize(String(s || '')).toLowerCase();
    const known = store.settings().roots.some((r) => norm(r.path) === norm(dir));
    if (!known) throw new Error('эта папка не в списке наблюдаемых');
    const err = await shell.openPath(path.normalize(dir));
    if (err) throw new Error(err);
    return true;
  }));
  ipcMain.handle('op:printers', wrap(async () => ops.listPrinters()));
  ipcMain.handle('op:print', wrap(async (ids, options) => ops.printDocs(docsByIds(ids), options)));
  ipcMain.handle('op:trash', wrap(async (ids) => {
    const rows = await ops.trashDocs(docsByIds(ids));
    const gone = rows.filter((r) => r.status === 'ok').map((r) => r.id);
    if (gone.length) catalog.removeRecords(gone);
    // Возврат из Корзины Windows программе недоступен, поэтому шаг помечен неотменяемым:
    // стрелка будет неактивна и скажет почему, вместо кнопки, которая ничего не делает.
    if (gone.length) history.push({
      label: `удаление в Корзину (${gone.length})`,
      why: 'удаление в Корзину отменяется из самой Корзины Windows'
    });
    return rows;
  }));
  ipcMain.handle('op:move', wrap(async (ids, dest) => {
    const from = {};
    catalog.byIds(ids).forEach((d) => { from[d.id] = d.dir; });
    const rows = await ops.moveDocs(docsByIds(ids), dest);
    const moved = rows.filter((r) => r.status === 'ok').map((r) => r.id);
    store.saveSettings({ lastMoveDir: dest });
    if (moved.length) history.push({
      label: `перемещение ${moved.length} ${plural(moved.length)}`,
      // Назад файлы едут по тем же правилам: занятое имя или пропавший файл — честный отказ.
      undo: async () => {
        const back = [];
        const byDir = new Map();
        moved.forEach((id) => {
          const d = from[id];
          if (!byDir.has(d)) byDir.set(d, []);
          byDir.get(d).push(id);
        });
        for (const [dir, list] of byDir) back.push(...await ops.moveDocs(docsByIds(list), dir));
        return back;
      },
      redo: async () => ops.moveDocs(docsByIds(moved), dest)
    });
    return rows;
  }));
  ipcMain.handle('op:zip', wrap(async (ids, dir, name) => ops.makeZip(docsByIds(ids), dir, name)));
  ipcMain.handle('op:mail', wrap(async (payload) => ops.sendMail(payload)));

  ipcMain.handle('dialog:folder', wrap(async (title) => {
    const r = await dialog.showOpenDialog(win, {
      title: title || 'Выберите папку', properties: ['openDirectory', 'createDirectory']
    });
    return r.canceled ? null : r.filePaths[0];
  }));
  // Несколько папок за один раз. openDirectory и openFile в Windows не совмещаются,
  // поэтому для файлов и папок остаются отдельные диалоги, а перетаскивание принимает и то и другое.
  ipcMain.handle('dialog:folders', wrap(async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Папки с документами', properties: ['openDirectory', 'multiSelections', 'createDirectory']
    });
    return r.canceled ? [] : r.filePaths;
  }));
  ipcMain.handle('dialog:files', wrap(async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Выберите документы', properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Документы', extensions: ['pdf', 'doc', 'docx', 'rtf', 'odt', 'xls', 'xlsx', 'csv', 'txt', 'md'] },
        { name: 'Сканы и изображения', extensions: ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'bmp'] },
        { name: 'Все файлы', extensions: ['*'] }
      ]
    });
    return r.canceled ? [] : r.filePaths;
  }));
  ipcMain.handle('app:info', wrap(async () => ({
    version: app.getVersion(),
    dataDir: store.paths.dir,
    platform: process.platform,
    notes: store.notes(),
    docs: store.catalog().docs.length,
    pdfIndex: (() => { try { require.resolve('pdf-parse'); return true; } catch (e) { return false; } })(),
    docxIndex: (() => { try { require.resolve('mammoth'); return true; } catch (e) { return false; } })()
  })));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    applyTheme(store.settings().theme);
    registerIpc();
    createSplash();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('before-quit', () => { try { store.saveTexts(); } catch (e) {} });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
