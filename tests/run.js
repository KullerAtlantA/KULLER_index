'use strict';
// Проверки главного процесса без Electron: модуль electron подменяется заглушкой,
// каждый сценарий работает в собственной временной папке данных и на собственном дереве файлов.
//
//   npm test
//
// Печать, Корзина, ZIP и письмо здесь не проверяются: они опираются на Windows и Electron,
// их нужно проверять вручную на рабочей машине.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let DATA = '';
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => DATA }, shell: {} };
  return origLoad.apply(this, arguments);
};

let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { passed++; results.push('  ok   ' + name); }
  else { failed++; results.push('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

function freshModules(label) {
  DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kuller-data-' + label + '-'));
  for (const k of Object.keys(require.cache)) if (k.includes(path.join('src', 'main'))) delete require.cache[k];
  return {
    store: require('../src/main/store'),
    catalog: require('../src/main/catalog')
  };
}

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kuller-docs-'));
  const deep = path.join(root, 'Договоры 2024', 'ООО «Ромашка»');
  fs.mkdirSync(deep, { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'мусор'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Пустая папка'), { recursive: true });
  fs.writeFileSync(path.join(root, 'акт сверки.txt'), 'Акт сверки взаиморасчётов за сентябрь', 'utf8');
  fs.writeFileSync(path.join(deep, 'договор №17.md'), 'Договор поставки номер 17 от 3 марта', 'utf8');
  fs.writeFileSync(path.join(deep, 'скан.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(root, 'заметка.unknown'), 'не наш формат', 'utf8');
  fs.writeFileSync(path.join(root, 'node_modules', 'мусор', 'readme.txt'), 'пропустить', 'utf8');
  return { root, deep };
}

(async function run() {
  /* 1. Сканирование папки, вложенность, кириллица и пробелы в пути, исключения */
  {
    const { store, catalog } = freshModules('scan');
    const { root, deep } = tree();
    store.saveSettings({ roots: [root], indexText: true });
    const r1 = await catalog.scan();
    check('папка просканирована: найдены только поддерживаемые форматы', r1.total === 3, 'total=' + r1.total);
    check('вложенная папка с кириллицей и пробелами обойдена',
      store.catalog().docs.some((d) => d.name === 'договор №17.md'));
    check('node_modules пропущен', !store.catalog().docs.some((d) => d.dir.includes('node_modules')));
    check('неизвестное расширение не попало в картотеку', !store.catalog().docs.some((d) => d.name.endsWith('.unknown')));
    check('текст проиндексирован', r1.indexed === 3 && store.catalog().docs.find((d) => d.name === 'акт сверки.txt').hasText);
    check('текст лежит отдельно от записей', !('text' in store.catalog().docs[0]) && fs.existsSync(store.paths.INDEX));

    /* 2. Повторное сканирование без изменений */
    const r2 = await catalog.scan();
    check('повторное сканирование не плодит дубликаты', r2.added === 0 && r2.updated === 0 && store.catalog().docs.length === 3,
      'added=' + r2.added + ' updated=' + r2.updated + ' docs=' + store.catalog().docs.length);
    check('неизменившиеся файлы не переиндексируются', r2.indexed === 0, 'indexed=' + r2.indexed);

    /* 3. Новый файл */
    fs.writeFileSync(path.join(deep, 'счёт 44.txt'), 'Счёт на оплату 44', 'utf8');
    const r3 = await catalog.scan();
    check('новый файл добавлен', r3.added === 1 && store.catalog().docs.length === 4);

    /* 4. Изменившийся файл */
    const changed = path.join(root, 'акт сверки.txt');
    fs.writeFileSync(changed, 'Акт сверки с новой суммой 123456', 'utf8');
    fs.utimesSync(changed, new Date(Date.now() + 86400000), new Date(Date.now() + 86400000));
    const r4 = await catalog.scan();
    check('изменившийся файл обновлён и переиндексирован', r4.updated === 1 && r4.indexed === 1,
      'updated=' + r4.updated + ' indexed=' + r4.indexed);
    check('поиск находит новый текст', catalog.search('123456').length === 1);
    check('поиск не находит старый текст', catalog.search('взаиморасчётов').length === 0);
    check('фрагмент вокруг совпадения возвращается', !!catalog.search('123456')[0].hit);

    /* 5. Исчезнувший файл: запись и теги сохраняются */
    const doomed = store.catalog().docs.find((d) => d.name === 'счёт 44.txt');
    catalog.updateTags([doomed.id], 'add', ['Важное']);
    fs.unlinkSync(path.join(deep, 'счёт 44.txt'));
    const r5 = await catalog.scan();
    const after = store.catalog().docs.find((d) => d.id === doomed.id);
    check('пропавший файл помечен, запись не удалена', r5.missing === 1 && after && after.missing === true);
    check('теги пропавшего документа сохранены', after.tags.includes('Важное'));

    /* 6. Удаление источника не трогает записи */
    catalog.removeRoot(root);
    check('источник убран из наблюдения', store.settings().roots.length === 0);
    check('документы после удаления источника остались', store.catalog().docs.length === 4);

    /* 7. Запись из картотеки убирается вместе со своим текстом */
    const victim = store.catalog().docs[0];
    catalog.removeRecords([victim.id]);
    check('запись убрана из картотеки', !store.catalog().docs.some((d) => d.id === victim.id));
    check('текст убранной записи удалён из индекса', store.text(victim.id) === '');
  }

  /* 8. Приём путей: папка становится источником, повтор не дублирует */
  {
    const { store, catalog } = freshModules('paths');
    const { root } = tree();
    const single = path.join(root, 'акт сверки.txt');
    const a = await catalog.addPaths([root, single], { [single]: ['Из диалога'], [root]: ['Ромашка'] });
    check('папка принята как источник', store.settings().roots.length === 1 && store.settings().roots[0].path === path.normalize(root));
    check('теги папки сохранены как правило', store.settings().roots[0].tags.includes('Ромашка'));
    check('найденные в папке документы получили её теги',
      store.catalog().docs.every((d) => d.tags.includes('Ромашка')));
    check('файл из той же папки не продублирован', store.catalog().docs.length === 3, 'docs=' + store.catalog().docs.length);
    check('отчёт по папке возвращён', a.rows.some((r) => r.message.includes('папка добавлена')));
    check('статистика сканирования приложена', a.scan && a.scan.total === 3);

    const b = await catalog.addPaths([root], {});
    check('повторное добавление той же папки не создаёт второй источник', store.settings().roots.length === 1);
    check('повторное добавление не плодит записи', store.catalog().docs.length === 3);
    check('повторная папка помечена как пересканированная', b.rows.some((r) => r.status === 'skip'));

    const c = await catalog.addFiles([single], { [single]: ['Ещё тег'] });
    const doc = store.catalog().docs.find((d) => d.name === 'акт сверки.txt');
    check('повторный файл пропущен, а не продублирован', c[0].status === 'skip');
    check('теги повторного файла дополнены', doc.tags.includes('Ещё тег'));

    const d = await catalog.addFiles([path.join(root, 'нет такого.txt')], {});
    check('несуществующий файл даёт понятную ошибку, а не падение', d[0].status === 'err' && d[0].message === 'файл не найден');

    /* Правило тегов папки действует и на то, что появится позже */
    catalog.setRootTags(root, ['Ромашка', 'Договоры']);
    const old = store.catalog().docs.find((x) => x.name === 'акт сверки.txt');
    const oldTags = old.tags.slice();
    fs.writeFileSync(path.join(root, 'новый акт.txt'), 'Появился после добавления папки', 'utf8');
    await catalog.scan();
    const fresh = store.catalog().docs.find((x) => x.name === 'новый акт.txt');
    check('новый документ в папке получил теги правила', fresh && fresh.tags.includes('Ромашка') && fresh.tags.includes('Договоры'));
    check('у ранее заведённых документов теги не переписаны',
      store.catalog().docs.find((x) => x.name === 'акт сверки.txt').tags.join() === oldTags.join());

    /* Вложенная папка со своим правилом перекрывает правило родителя */
    const inner = path.join(root, 'Договоры 2024');
    await catalog.addPaths([inner], { [inner]: ['Только 2024'] });
    fs.writeFileSync(path.join(inner, 'свежий.txt'), 'файл во вложенной папке', 'utf8');
    await catalog.scan();
    const deepDoc = store.catalog().docs.find((x) => x.name === 'свежий.txt');
    check('правило вложенной папки точнее родительского', deepDoc && deepDoc.tags.includes('Только 2024'));
    check('к файлу добавились теги по именам папок пути', deepDoc && deepDoc.tags.includes('Договоры 2024'));

    /* Старый формат настроек (список строк) поднимается без потерь */
    const { store: s2 } = freshModules('oldroots');
    fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ theme: 'dark', roots: ['C:\\Docs', 'D:\\Сканы'], indexText: true }), 'utf8');
    const roots = s2.settings().roots;
    check('старый список папок прочитан как правила без тегов',
      roots.length === 2 && roots[0].path === 'C:\\Docs' && Array.isArray(roots[1].tags) && roots[1].tags.length === 0);
  }

  /* 9. Пустая и недоступная папка */
  {
    const { store, catalog } = freshModules('empty');
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kuller-empty-'));
    store.saveSettings({ roots: [empty, path.join(empty, 'нет такой папки')] });
    const r = await catalog.scan();
    check('пустая и отсутствующая папки не ломают сканирование', r.total === 0 && r.added === 0);

    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (process.platform !== 'win32' && !isRoot) {
      const locked = fs.mkdtempSync(path.join(os.tmpdir(), 'kuller-locked-'));
      fs.writeFileSync(path.join(locked, 'файл.txt'), 'текст');
      fs.chmodSync(locked, 0o000);
      store.saveSettings({ roots: [locked] });
      const r2 = await catalog.scan();
      check('папка без прав доступа пропускается без падения', r2.total === 0);
      fs.chmodSync(locked, 0o700);
    } else {
      results.push('  skip папка без прав доступа — проверяется только вне Windows и не от администратора');
    }
  }

  /* 10. Повреждённый каталог не затирается, данные восстанавливаются из копии */
  {
    const { store, catalog } = freshModules('corrupt');
    const { root } = tree();
    store.saveSettings({ roots: [root] });
    await catalog.scan();
    const count = store.catalog().docs.length;
    store.saveCatalog();                       // появляется .bak с теми же данными
    fs.writeFileSync(store.paths.CATALOG, '{ это не json', 'utf8');

    const again = freshModules2();
    function freshModules2() {
      for (const k of Object.keys(require.cache)) if (k.includes(path.join('src', 'main'))) delete require.cache[k];
      return { store: require('../src/main/store'), catalog: require('../src/main/catalog') };
    }
    const docs = again.store.catalog().docs;
    check('повреждённый каталог восстановлен из резервной копии', docs.length === count, 'docs=' + docs.length);
    check('повреждённый файл отведён в сторону, а не затёрт',
      fs.readdirSync(DATA).some((f) => f.includes('.corrupt-')));
    check('пользователю есть что показать о восстановлении', again.store.notes().length > 0);
  }

  /* 11. Переход со старой схемы: текст переезжает в отдельный индекс */
  {
    const { store } = freshModules('migrate');
    fs.writeFileSync(path.join(DATA, 'catalog.json'), JSON.stringify({
      nextId: 3,
      docs: [
        { id: 1, name: 'старый.txt', dir: 'C:\\Docs', kind: 'docx', date: '2024-01-01', size: 10, sizeText: '10 Б', party: '', tags: ['Архив'], text: 'содержимое старой записи', missing: false },
        { id: 2, name: 'без текста.png', dir: 'C:\\Docs', kind: 'скан', date: '2024-01-02', size: 20, sizeText: '20 Б', party: '', tags: [], text: '', missing: false }
      ]
    }), 'utf8');
    const docs = store.catalog().docs;
    check('старый каталог прочитан целиком', docs.length === 2 && docs[0].tags.includes('Архив'));
    check('текст перенесён в отдельный индекс', store.text(1) === 'содержимое старой записи');
    check('запись больше не носит текст с собой', !('text' in docs[0]) && docs[0].hasText === true);
    check('документ без текста помечен честно', docs[1].hasText === false);
    check('версия схемы записана', store.catalog().schema === 2);
    check('исходный каталог сохранён как резервная копия', fs.existsSync(store.paths.CATALOG + '.bak'));
  }

  /* 11b. Теги по именам папок: все уровни, сверка с существующими, мусорные имена */
  {
    const { store, catalog } = freshModules('foldertags');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kuller-ft-'));
    const deep = path.join(root, '2024', 'РОМАШКА');
    const junk = path.join(root, 'Новая папка');
    fs.mkdirSync(deep, { recursive: true });
    fs.mkdirSync(junk, { recursive: true });
    fs.writeFileSync(path.join(deep, 'акт.txt'), 'текст', 'utf8');
    fs.writeFileSync(path.join(junk, 'черновик.txt'), 'текст', 'utf8');
    fs.writeFileSync(path.join(root, 'корневой.txt'), 'текст', 'utf8');

    // существующий тег другого написания — новый не должен появиться
    await catalog.addFiles([path.join(root, 'корневой.txt')], { [path.join(root, 'корневой.txt')]: ['Ромашка'] });
    await catalog.addPaths([root], {});

    const act = store.catalog().docs.find((d) => d.name === 'акт.txt');
    const dr  = store.catalog().docs.find((d) => d.name === 'черновик.txt');
    const base = path.basename(root);
    check('теги взяты со всех уровней пути', act && act.tags.includes(base) && act.tags.includes('2024'));
    check('написание тега подхвачено у существующего', act && act.tags.includes('Ромашка') && !act.tags.includes('РОМАШКА'));
    check('мусорное имя папки тегом не стало', dr && !dr.tags.some((t) => t.toLowerCase() === 'новая папка'));
    check('у файла из мусорной папки остались осмысленные теги', dr && dr.tags.includes(base));

    const plan = await catalog.folderPlan(root);
    check('разбор папки видит подпапки с документами', plan.dirs.length === 3, 'dirs=' + plan.dirs.length);
    check('разбор предлагает теги по умолчанию',
      plan.dirs.some((d) => d.rel === path.join('2024', 'РОМАШКА') && d.tags.includes('Ромашка')));
  }

  /* 11c. История: отмена и возврат на уровне данных */
  {
    const { store, catalog } = freshModules('history');
    const history = require('../src/main/history');
    history.clear();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kuller-h-'));
    fs.writeFileSync(path.join(root, 'файл.txt'), 'текст', 'utf8');
    await catalog.addPaths([root], {});
    const doc = store.catalog().docs[0];

    const before = { [doc.id]: [...doc.tags] };
    catalog.updateTags([doc.id], 'add', ['Срочное']);
    const after = { [doc.id]: [...store.catalog().docs[0].tags] };
    history.push({ label: 'теги', undo: async () => catalog.setTagsExact(before), redo: async () => catalog.setTagsExact(after) });
    check('история знает, что можно отменить', history.state().undo && history.state().undo.can);
    await history.undo();
    check('отмена вернула прежние теги', !store.catalog().docs[0].tags.includes('Срочное'));
    await history.redo();
    check('возврат применил изменение снова', store.catalog().docs[0].tags.includes('Срочное'));

    const cut = catalog.cutRecords([doc.id]);
    check('запись и её текст изъяты', store.catalog().docs.length === 0);
    catalog.restoreRecords(cut);
    const back = store.catalog().docs[0];
    check('запись возвращена целиком', back && back.id === doc.id && back.tags.includes('Срочное'));

    history.push({ label: 'Корзина', why: 'отменяется из самой Корзины Windows' });
    check('неотменяемый шаг так и помечен', history.state().undo.can === false);
    let refused = false;
    try { await history.undo(); } catch (e) { refused = e.message.includes('Корзины'); }
    check('попытка отменить его объясняет причину', refused);
  }

  /* 12. Большая вложенная структура: первое и повторное сканирование */
  {
    const { store, catalog } = freshModules('big');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kuller-big-'));
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const dir = path.join(root, 'Отдел ' + (i % 10), 'Папка ' + (i % 50));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `документ ${i}.txt`), 'Договор номер ' + i + ' '.repeat(200), 'utf8');
    }
    store.saveSettings({ roots: [root], indexText: true });
    const t1 = Date.now(); const a = await catalog.scan(); const first = Date.now() - t1;
    const t2 = Date.now(); const b = await catalog.scan(); const second = Date.now() - t2;
    const t3 = Date.now(); const hits = catalog.search('номер 1999'); const find = Date.now() - t3;
    check(`${N} файлов проиндексированы`, a.total === N && a.added === N);
    check('повторное сканирование ничего не переиндексирует', b.added === 0 && b.indexed === 0);
    check('поиск по тексту находит нужный документ', hits.length === 1);
    results.push(`  инфо  ${N} файлов: первое сканирование ${first} мс, повторное ${second} мс, поиск по тексту ${find} мс`);
    results.push(`  инфо  catalog.json ${Math.round(fs.statSync(store.paths.CATALOG).size / 1024)} КБ, index.json ${Math.round(fs.statSync(store.paths.INDEX).size / 1024)} КБ`);
  }

  console.log('\nKULLER INDEX — проверки главного процесса\n');
  console.log(results.join('\n'));
  console.log(`\nпройдено: ${passed} · не пройдено: ${failed}\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Сценарий не выполнен:', e); process.exit(1); });
