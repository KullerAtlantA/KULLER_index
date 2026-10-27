'use strict';
// Хранилище настроек, каталога и текстового индекса: JSON в папке данных пользователя.
//
// Три файла вместо одного:
//   settings.json  — настройки;
//   catalog.json   — записи документов без текста (переписывается при любой правке тегов);
//   index.json     — текстовый слой документов (переписывается только после индексации).
// Раньше текст лежал прямо в записях, поэтому смена одного тега переписывала мегабайты.
//
// Повреждённый файл никогда не затирается молча: он отводится в сторону,
// затем пробуется резервная копия, и только потом берутся значения по умолчанию.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const dir = app.getPath('userData');
const CATALOG = path.join(dir, 'catalog.json');
const SETTINGS = path.join(dir, 'settings.json');
const INDEX = path.join(dir, 'index.json');

const SCHEMA = 2;
const DEFAULT_SETTINGS = { theme: '', roots: [], rules: [], indexText: true, lastZipDir: '', lastMoveDir: '' };
const DEFAULT_CATALOG = { schema: SCHEMA, nextId: 1, docs: [] };
const DEFAULT_INDEX = { schema: SCHEMA, texts: {} };

const notes = [];           // сообщения о восстановлении — интерфейс показывает их в окне «Папки»
const clone = (o) => JSON.parse(JSON.stringify(o));

function quarantine(file) {
  const to = file + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-');
  try {
    fs.renameSync(file, to);
    notes.push('Файл ' + path.basename(file) + ' повреждён и сохранён как ' + path.basename(to) + '.');
  } catch (e) { /* файл уже недоступен — дальше работаем с резервной копией */ }
}

// Читает JSON, не разрушая данные: при повреждении основной файл отводится,
// затем читается .bak. Пустой результат возвращается только если не уцелело ничего.
function readJson(file, fallback) {
  for (const candidate of [file, file + '.bak']) {
    let raw;
    try { raw = fs.readFileSync(candidate, 'utf8'); } catch (e) { continue; }
    try {
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        if (candidate !== file) notes.push('Данные восстановлены из резервной копии ' + path.basename(candidate) + '.');
        return data;
      }
      throw new Error('не объект');
    } catch (e) {
      if (candidate === file) quarantine(file);
    }
  }
  return clone(fallback);
}

// Запись в два шага: сначала временный файл, затем подмена.
// Предыдущая версия сохраняется как .bak — есть к чему вернуться после сбоя питания.
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  } catch (e) { /* без резервной копии запись всё равно должна состояться */ }
  fs.renameSync(tmp, file);
}

let settings = null;
let catalog = null;
let texts = null;
let textsDirty = false;

// Переход со старой схемы: текст переезжает из записей в отдельный индекс.
// Исходный catalog.json остаётся в .bak, данные не теряются.
function migrate(cat, wasSchema) {
  if (wasSchema === SCHEMA) return false;
  const idx = store.texts();
  let moved = 0;
  for (const d of cat.docs) {
    if (typeof d.text === 'string') {
      if (d.text) { idx.texts[d.id] = d.text; moved++; }
      delete d.text;
    }
    d.hasText = !!idx.texts[d.id];
  }
  cat.schema = SCHEMA;
  if (moved) { textsDirty = true; notes.push('Текстовый индекс вынесен в отдельный файл (' + moved + ').'); }
  return true;
}

const store = {
  notes: () => notes.slice(),

  settings() {
    if (!settings) settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS, DEFAULT_SETTINGS) };
    // Раньше папка-источник была просто строкой пути. Теперь это запись с тегами,
    // которые выдаются найденным в ней документам. Старый список поднимается без потерь.
    if (!Array.isArray(settings.roots)) settings.roots = [];
    settings.roots = settings.roots
      .map((r) => (typeof r === 'string' ? { path: r, tags: [] } : r))
      .filter((r) => r && typeof r.path === 'string')
      .map((r) => ({
        path: r.path,
        tags: Array.isArray(r.tags) ? r.tags : [],
        auto: r.auto !== false            // теги по именам папок включены, пока их не отключили
      }));
    // Правила для отдельных подпапок: человек поправил теги в окне добавления.
    // Лежат отдельно от источников, чтобы список наблюдаемых папок не зарастал.
    if (!Array.isArray(settings.rules)) settings.rules = [];
    settings.rules = settings.rules
      .filter((r) => r && typeof r.path === 'string')
      .map((r) => ({ path: r.path, tags: Array.isArray(r.tags) ? r.tags : [] }));
    return settings;
  },
  saveSettings(patch) {
    settings = { ...store.settings(), ...patch };
    writeJson(SETTINGS, settings);
    return settings;
  },

  catalog() {
    if (!catalog) {
      // Версия схемы берётся из прочитанного файла, а не из значений по умолчанию,
      // иначе старый каталог выглядел бы уже обновлённым и текст остался бы в записях.
      const raw = readJson(CATALOG, DEFAULT_CATALOG);
      catalog = { ...DEFAULT_CATALOG, ...raw };
      if (!Array.isArray(catalog.docs)) catalog.docs = [];
      if (migrate(catalog, raw.schema)) { store.saveTexts(); writeJson(CATALOG, catalog); }
    }
    return catalog;
  },
  saveCatalog() {
    writeJson(CATALOG, store.catalog());
    if (textsDirty) store.saveTexts();
    return catalog;
  },

  texts() {
    if (!texts) {
      texts = { ...DEFAULT_INDEX, ...readJson(INDEX, DEFAULT_INDEX) };
      if (!texts.texts || typeof texts.texts !== 'object') texts.texts = {};
    }
    return texts;
  },
  text(id) { return store.texts().texts[id] || ''; },
  setText(id, value) {
    const t = store.texts().texts;
    if (value) t[id] = value; else delete t[id];
    textsDirty = true;
  },
  dropTexts(ids) {
    const t = store.texts().texts;
    ids.forEach((id) => { if (t[id] !== undefined) { delete t[id]; textsDirty = true; } });
  },
  saveTexts() {
    if (!texts) return;
    writeJson(INDEX, texts);
    textsDirty = false;
  },

  nextId() {
    const c = store.catalog();
    const id = c.nextId || 1;
    c.nextId = id + 1;
    return id;
  },
  paths: { dir, CATALOG, SETTINGS, INDEX }
};

module.exports = store;
