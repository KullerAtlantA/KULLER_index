'use strict';
// Каталог: запись документа и её связь с оригиналом на диске.
// Запись хранит путь, метаданные и теги. Текст документа лежит в отдельном индексе (store),
// файл живёт сам по себе и приложением не перемещается без прямой команды.
//
// Весь ввод-вывод асинхронный: обход папок и чтение файлов не блокируют главный процесс,
// поэтому интерфейс отвечает и во время сканирования.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const store = require('./store');

const EXT_KIND = {
  '.pdf': 'pdf',
  '.doc': 'docx', '.docx': 'docx', '.rtf': 'docx', '.odt': 'docx',
  '.xls': 'xlsx', '.xlsx': 'xlsx', '.csv': 'xlsx', '.ods': 'xlsx',
  '.jpg': 'скан', '.jpeg': 'скан', '.png': 'скан', '.tif': 'скан', '.tiff': 'скан', '.bmp': 'скан',
  '.txt': 'docx', '.md': 'docx'
};
const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information', '.git', 'appdata', 'windows']);
const MAX_DEPTH = 12;
const MAX_INDEX_BYTES = 25 * 1024 * 1024;
const MAX_TEXT = 200000;
const EXTRACT_PARALLEL = 3;   // одновременных извлечений текста: диск и память не захлёбываются
const PROGRESS_MS = 120;      // не чаще, чем успевает перерисоваться интерфейс

const kindOf = (file) => EXT_KIND[path.extname(file).toLowerCase()] || null;

let cancelled = false;
const cancel = () => { cancelled = true; };

function human(bytes) {
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1048576) return Math.round(bytes / 1024) + ' КБ';
  return (bytes / 1048576).toFixed(1).replace('.', ',') + ' МБ';
}

// Текстовый слой. pdf-parse и mammoth необязательны: без них индексируется только простой текст.
async function extractText(file) {
  try {
    const ext = path.extname(file).toLowerCase();
    const st = await fsp.stat(file);
    if (st.size > MAX_INDEX_BYTES) return '';
    if (ext === '.txt' || ext === '.md' || ext === '.csv') {
      const buf = await fsp.readFile(file);
      return buf.toString('utf8', 0, Math.min(buf.length, MAX_TEXT * 3)).slice(0, MAX_TEXT);
    }
    if (ext === '.pdf') {
      let pdf;
      try { pdf = require('pdf-parse'); } catch (e) { return ''; }
      const data = await pdf(await fsp.readFile(file));
      return String(data.text || '').slice(0, MAX_TEXT);
    }
    if (ext === '.docx') {
      let mammoth;
      try { mammoth = require('mammoth'); } catch (e) { return ''; }
      const res = await mammoth.extractRawText({ path: file });
      return String(res.value || '').slice(0, MAX_TEXT);
    }
  } catch (e) { /* нечитаемый или повреждённый документ — запись остаётся, текста нет */ }
  return '';
}

async function statRecord(file) {
  const s = await fsp.stat(file);
  return { size: s.size, sizeText: human(s.size), mtime: s.mtime.toISOString().slice(0, 10) };
}

function makeRecord(file, st, extra = {}) {
  return {
    id: store.nextId(),
    name: path.basename(file),
    dir: path.dirname(file),
    kind: kindOf(file) || 'docx',
    date: st.mtime,
    size: st.size,
    sizeText: st.sizeText,
    party: extra.party || '',
    tags: Array.isArray(extra.tags) ? [...new Set(extra.tags)] : [],
    hasText: false,
    missing: false,
    addedAt: new Date().toISOString()
  };
}

const fullPath = (d) => path.join(d.dir, d.name);
const key = (file) => path.normalize(file).toLowerCase();

// Папка-источник: путь плюс теги, которые получают найденные в ней документы.
// Строка на входе — это старый формат настроек, поднимаем его без тегов.
const asRoots = (list) => (list || [])
  .map((r) => (typeof r === 'string' ? { path: r, tags: [] } : r))
  .filter((r) => r && r.path)
  .map((r) => ({ path: r.path, tags: Array.isArray(r.tags) ? r.tags : [] }));

// Имена папок, которые не несут смысла и тегами не становятся.
// Исключение: если человек сам завёл тег с таким именем, он считается настоящим.
const JUNK = new Set(['новая папка', 'новая папка (2)', 'документы', 'документ', 'файлы', 'папка',
  'сканы', 'скан', 'tmp', 'temp', 'загрузки', 'downloads', 'new folder', 'docs', 'files']);

// Словарь уже используемых тегов: папка «РОМАШКА» даст существующий тег «Ромашка»,
// а не третий его вариант. Строится один раз на операцию.
function tagIndex() {
  const m = new Map();
  const add = (t) => { const k = String(t).toLowerCase(); if (t && !m.has(k)) m.set(k, t); };
  for (const d of store.catalog().docs) (d.tags || []).forEach(add);
  const s = store.settings();
  for (const r of s.roots) (r.tags || []).forEach(add);
  for (const r of s.rules) (r.tags || []).forEach(add);
  return m;
}

// Имена папок от источника (включительно) до папки, где лежит файл.
function segments(file, rootPath) {
  const rel = path.relative(rootPath, path.dirname(file));
  const parts = rel && !rel.startsWith('..') ? rel.split(path.sep).filter(Boolean) : [];
  const head = path.basename(rootPath);
  return head ? [head, ...parts] : parts;      // корень диска имени не даёт
}

// Приводим имя папки к тегу: совпало с существующим — берём его написание,
// мусорное имя отбрасываем, если такого тега у вас нет.
function nameToTag(name, known) {
  const k = String(name).trim().toLowerCase();
  if (!k) return null;
  if (known && known.has(k)) return known.get(k);
  if (JUNK.has(k)) return null;
  return String(name).trim();
}

// Теги файла: правило самой глубокой подходящей папки.
// У правила есть свои теги и, если включены, теги по именам папок пути.
function tagsFor(file, roots, known) {
  const k = key(file);
  let best = null;
  for (const r of roots) {
    const rk = key(r.path);
    if (k === rk || k.startsWith(rk + path.sep)) {
      if (!best || key(best.path).length < rk.length) best = r;
    }
  }
  if (!best) return [];
  const out = [...(best.tags || [])];
  if (best.auto !== false) {
    for (const seg of segments(file, best.path)) {
      const t = nameToTag(seg, known);
      if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
    }
  }
  return out;
}

// Все правила разом: источники плюс поправленные вручную подпапки.
const allRules = () => {
  const s = store.settings();
  return [...asRoots(s.roots), ...s.rules.map((r) => ({ path: r.path, tags: r.tags, auto: false }))];
};

// Индекс путей строится один раз на операцию: раньше каждый файл искался перебором
// всего каталога, то есть сканирование росло квадратично.
function pathIndex() {
  const m = new Map();
  for (const d of store.catalog().docs) m.set(key(fullPath(d)), d);
  return m;
}

// Обход дерева без блокировки процесса. Недоступная папка пропускается, а не рушит обход.
async function walk(root, out, depth = 0) {
  if (cancelled) return;
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    if (cancelled) return;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (depth >= MAX_DEPTH || SKIP_DIRS.has(e.name.toLowerCase()) || e.name.startsWith('.')) continue;
      await walk(full, out, depth + 1);
    } else if (e.isFile() && kindOf(e.name)) {
      out.push(full);
    }
  }
}

// Очередь с ограниченным параллелизмом: задачи идут по порядку, одновременно — не больше limit.
async function pool(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !cancelled) {
      const i = next++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

// Сканирование: новые файлы заводятся как записи, у существующих обновляются размер и дата,
// пропавшие помечаются (записи и теги сохраняются). Текст перечитывается только у изменившихся.
async function scan(onProgress, opts = {}) {
  cancelled = false;
  const settings = store.settings();
  const roots = asRoots(opts.roots && opts.roots.length ? opts.roots : settings.roots);
  const indexText = settings.indexText;
  const cat = store.catalog();

  const found = [];
  for (const r of roots) {
    if (cancelled) break;
    if (onProgress) onProgress({ phase: 'walk', done: found.length, total: 0, file: r.path });
    await walk(r.path, found);
  }

  const byPath = pathIndex();
  const rules = allRules();
  const known = tagIndex();
  const stats = { total: found.length, added: 0, updated: 0, indexed: 0, missing: 0, failed: 0, cancelled: false };
  const toIndex = [];
  let last = 0;

  for (let i = 0; i < found.length; i++) {
    if (cancelled) break;
    const file = found[i];
    const now = Date.now();
    if (onProgress && (now - last > PROGRESS_MS || i === found.length - 1)) {
      last = now;
      onProgress({ phase: 'read', done: i + 1, total: found.length, file });
    }
    try {
      const st = await statRecord(file);
      const existing = byPath.get(key(file));
      if (existing) {
        existing.missing = false;
        if (existing.date !== st.mtime || existing.size !== st.size) {
          Object.assign(existing, { date: st.mtime, size: st.size, sizeText: st.sizeText });
          if (indexText) toIndex.push({ doc: existing, file });
          stats.updated++;
        }
      } else {
        // Теги папки выдаются только новым записям: у уже заведённого документа
        // теги принадлежат пользователю, и правило их не переписывает.
        const rec = makeRecord(file, st, { tags: tagsFor(file, rules, known) });
        cat.docs.push(rec);
        byPath.set(key(file), rec);
        if (indexText) toIndex.push({ doc: rec, file });
        stats.added++;
      }
    } catch (e) {
      stats.failed++;   // исчез между обходом и чтением, либо нет прав — остальные файлы обрабатываются
    }
    if (i % 1000 === 999) store.saveCatalog();   // длинное сканирование переживает аварийное завершение
  }

  if (toIndex.length) {
    let done = 0;
    await pool(toIndex, EXTRACT_PARALLEL, async ({ doc, file }) => {
      const text = await extractText(file);
      store.setText(doc.id, text);
      doc.hasText = !!text;
      stats.indexed++;
      done++;
      const now = Date.now();
      if (onProgress && now - last > PROGRESS_MS) {
        last = now;
        onProgress({ phase: 'index', done, total: toIndex.length, file });
      }
    });
  }

  // Пропавшие файлы только помечаются. Запись, теги и контрагент остаются:
  // документ мог уехать на съёмный диск или в другую папку.
  const alive = new Set(found.map(key));
  for (const d of cat.docs) {
    const p = key(fullPath(d));
    if (!roots.some((r) => p.startsWith(key(r.path)))) continue;
    d.missing = !alive.has(p);
    if (d.missing) stats.missing++;
  }

  stats.cancelled = cancelled;
  store.saveCatalog();
  store.saveTexts();
  return stats;
}

// Разбор папки перед добавлением: какие подпапки внутри, сколько в каждой документов
// и какие теги они получат по умолчанию. Нужен окну с деревом подпапок.
async function folderPlan(rootPath, limit = 300) {
  cancelled = false;
  const known = tagIndex();
  const counts = new Map();                 // папка → сколько документов лежит прямо в ней
  const files = [];
  await walk(rootPath, files);
  for (const f of files) {
    const d = path.dirname(f);
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  const dirs = [...counts.keys()].sort((a, b) => a.localeCompare(b, 'ru'));
  const truncated = dirs.length > limit;
  const plan = dirs.slice(0, limit).map((d) => {
    const sample = path.join(d, 'x');       // достаточно, чтобы вычислить имена папок пути
    const tags = [];
    for (const seg of segments(sample, rootPath)) {
      const t = nameToTag(seg, known);
      if (t && !tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
    }
    return { path: d, rel: path.relative(rootPath, d) || '.', count: counts.get(d), tags };
  });
  return { root: rootPath, dirs: plan, folders: dirs.length, total: files.length, truncated };
}

// Приём путей из диалога и перетаскивания: файлы попадают в картотеку как есть,
// папки становятся источниками и сканируются целиком.
async function addPaths(paths, tagsByFile, onProgress, opts = {}) {
  const files = [];
  const dirs = [];
  const rows = [];
  for (const p of paths) {
    try {
      const st = await fsp.stat(p);
      if (st.isDirectory()) dirs.push(path.normalize(p));
      else if (st.isFile()) files.push(p);
      else rows.push({ name: path.basename(p), status: 'err', message: 'не файл и не папка' });
    } catch (e) {
      rows.push({ name: path.basename(p), status: 'err', message: 'путь недоступен' });
    }
  }

  // Папки регистрируются первыми: тогда файл, добавленный той же командой из этой папки,
  // получит и свои теги, и теги её правила.
  let scanStats = null;
  let picked = [];
  if (dirs.length) {
    const settings = store.settings();
    const roots = settings.roots.slice();
    for (const d of dirs) {
      const tags = [...new Set((tagsByFile && tagsByFile[d]) || [])];
      const same = roots.find((r) => key(r.path) === key(d));
      if (same) {
        // Папка уже под наблюдением: теги из этого добавления дополняют её правило.
        const before = same.tags.length;
        tags.forEach((t) => { if (!same.tags.includes(t)) same.tags.push(t); });
        picked.push(same);
        rows.push({ name: d, status: 'skip', message: same.tags.length > before ? 'уже под наблюдением, теги папки дополнены' : 'уже под наблюдением, пересканирована' });
        continue;
      }
      const parent = roots.find((r) => key(d).startsWith(key(r.path) + path.sep));
      const root = { path: d, tags };
      roots.push(root);
      picked.push(root);
      rows.push({
        name: d, status: 'ok',
        message: (parent ? 'папка добавлена внутри уже наблюдаемой' : 'папка добавлена в картотеку')
          + (tags.length ? ' · теги: ' + tags.join(', ') : '')
      });
    }
    // Поправленные вручную подпапки: их теги уже содержат весь путь, поэтому
    // имена папок к ним не добавляются — что видно в окне, то и применится.
    const rules = store.settings().rules.slice();
    for (const r of (opts.rules || [])) {
      if (!r || !r.path) continue;
      const i = rules.findIndex((x) => key(x.path) === key(r.path));
      const entry = { path: path.normalize(r.path), tags: [...new Set(r.tags || [])] };
      if (i >= 0) rules[i] = entry; else rules.push(entry);
    }
    store.saveSettings({ roots, rules });
  }

  if (files.length) rows.push(...await addFiles(files, tagsByFile));
  if (picked.length) scanStats = await scan(onProgress, { roots: picked });
  return { rows, scan: scanStats };
}

// Добавление конкретных файлов. Дубликаты не создаются: повторный файл только дополняет теги.
async function addFiles(files, tagsByFile) {
  const cat = store.catalog();
  const { indexText } = store.settings();
  const byPath = pathIndex();
  const result = [];
  const fresh = [];

  for (const file of files) {
    try {
      const st = await fsp.stat(file);
      if (!st.isFile()) { result.push({ name: path.basename(file), status: 'err', message: 'это не файл' }); continue; }
      const already = byPath.get(key(file));
      if (already) {
        const add = (tagsByFile && tagsByFile[file]) || [];
        add.forEach((t) => { if (!already.tags.includes(t)) already.tags.push(t); });
        result.push({ name: path.basename(file), status: 'skip', message: add.length ? 'уже в картотеке, теги дополнены' : 'уже в картотеке' });
        continue;
      }
      // Свои теги плюс теги папки, если файл лежит под наблюдаемой: правило действует и здесь.
      const own = (tagsByFile && tagsByFile[file]) || [];
      const rec = makeRecord(file, await statRecord(file), { tags: [...own, ...tagsFor(file, allRules(), tagIndex())] });
      cat.docs.push(rec);
      byPath.set(key(file), rec);
      fresh.push({ doc: rec, file });
      result.push({ name: rec.name, status: 'ok', message: 'добавлен', id: rec.id });
    } catch (e) {
      result.push({ name: path.basename(file), status: 'err', message: e.code === 'ENOENT' ? 'файл не найден' : e.message });
    }
  }

  if (indexText && fresh.length) {
    await pool(fresh, EXTRACT_PARALLEL, async ({ doc, file }) => {
      const text = await extractText(file);
      store.setText(doc.id, text);
      doc.hasText = !!text;
    });
  }
  store.saveCatalog();
  store.saveTexts();
  return result;
}

function removeRecords(ids) {
  const cat = store.catalog();
  const set = new Set(ids);
  const removed = cat.docs.filter((d) => set.has(d.id)).map((d) => d.name);
  cat.docs = cat.docs.filter((d) => !set.has(d.id));
  store.dropTexts(ids);
  store.saveCatalog();
  return removed;
}

// Удаление источника из списка сканирования. Записи и файлы не трогаются:
// документы остаются в картотеке, просто за папкой больше не следим.
function removeRoot(root) {
  const settings = store.settings();
  const roots = settings.roots.filter((r) => key(r.path) !== key(root));
  store.saveSettings({ roots });
  return roots;
}

// Правка тегов папки отдельно от добавления: применится к тому, что найдётся дальше.
function setRootTags(root, tags) {
  const settings = store.settings();
  const roots = settings.roots.map((r) => (key(r.path) === key(root) ? { path: r.path, tags: [...new Set(tags)] } : r));
  store.saveSettings({ roots });
  return roots;
}

// Для отмены: запись забирается вместе со своим текстом, чтобы её можно было вернуть целиком.
function cutRecords(ids) {
  const docs = byIds(ids).map((d) => ({ ...d, tags: [...d.tags] }));
  const texts = {};
  ids.forEach((id) => { const t = store.text(id); if (t) texts[id] = t; });
  const names = removeRecords(ids);
  return { docs, texts, names };
}

function restoreRecords(payload) {
  const cat = store.catalog();
  const have = new Set(cat.docs.map((d) => d.id));
  (payload.docs || []).forEach((d) => { if (!have.has(d.id)) cat.docs.push({ ...d, tags: [...(d.tags || [])] }); });
  Object.entries(payload.texts || {}).forEach(([id, t]) => store.setText(+id, t));
  store.saveCatalog();
  store.saveTexts();
  return (payload.docs || []).length;
}

// Точная расстановка тегов по документам — тем, что был до изменения.
function setTagsExact(map) {
  const cat = store.catalog();
  for (const d of cat.docs) {
    const t = map[d.id];
    if (t) d.tags = [...new Set(t)];
  }
  store.saveCatalog();
}

function setPartyExact(map) {
  for (const d of store.catalog().docs) if (map[d.id] !== undefined) d.party = map[d.id];
  store.saveCatalog();
}

function byIds(ids) {
  const set = new Set(ids);
  return store.catalog().docs.filter((d) => set.has(d.id));
}

function updateTags(ids, mode, tags) {
  const docs = byIds(ids);
  const rows = docs.map((d) => {
    const before = d.tags.slice();
    if (mode === 'add') tags.forEach((t) => { if (!d.tags.includes(t)) d.tags.push(t); });
    else if (mode === 'remove') d.tags = d.tags.filter((t) => !tags.includes(t));
    else d.tags = [...new Set(tags)];
    const changed = before.length !== d.tags.length || before.some((t) => !d.tags.includes(t));
    return { name: d.name, status: changed ? 'ok' : 'skip', message: changed ? (d.tags.join(', ') || 'теги сняты') : 'без изменений' };
  });
  store.saveCatalog();
  return rows;
}

function setParty(ids, party) {
  byIds(ids).forEach((d) => { d.party = party; });
  store.saveCatalog();
}

// Поиск по тексту выполняется там, где текст лежит, — в главном процессе.
// Интерфейсу уходят только совпавшие id и короткий фрагмент вокруг совпадения.
function search(query, ids) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const texts = store.texts().texts;
  const limit = ids ? new Set(ids) : null;
  const hits = [];
  for (const d of store.catalog().docs) {
    if (limit && !limit.has(d.id)) continue;
    const t = texts[d.id];
    if (!t) continue;
    const i = t.toLowerCase().indexOf(q);
    if (i < 0) continue;
    const s = Math.max(0, i - 40);
    hits.push({ id: d.id, pre: (s ? '…' : '') + t.slice(s, i), hit: t.substr(i, q.length), post: t.slice(i + q.length, i + q.length + 70) + '…' });
  }
  return hits;
}

const textOf = (id) => store.text(id);

module.exports = {
  scan, cancel, folderPlan, addPaths, addFiles, removeRecords, removeRoot, setRootTags, byIds, updateTags, setParty,
  search, textOf, fullPath, human,
  cutRecords, restoreRecords, setTagsExact, setPartyExact
};
