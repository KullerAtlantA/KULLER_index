'use strict';
/* Интерфейс KULLER INDEX. Все файловые операции уходят в главный процесс через window.api. */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ru = (s) => { const d = new Date(s); return isNaN(d) ? '—' : d.toLocaleDateString('ru-RU'); };
const fmtShort = (ms) => new Date(ms).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: '2-digit' });
const isoDay = (ms) => { const d = new Date(ms); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const plural = (n, a, b, c) => { const m = n % 100, k = n % 10; return n + ' ' + (m >= 11 && m <= 14 ? c : k === 1 ? a : k >= 2 && k <= 4 ? b : c); };
const TYPES = ['pdf', 'docx', 'xlsx', 'скан'];

let DOCS = [];
let SETTINGS = { theme: { source: 'dark', resolved: 'dark' }, roots: [], rules: [], indexText: true, lastZipDir: '', lastMoveDir: '' };
let PRINTERS = [];
let TAGS = [], DATES = [], MIN = 0, MAX = 0;
const st = {
  q: '', deep: true, types: new Set(), from: 0, to: 0, party: '', tags: new Set(),
  sortBy: 'date', sortDir: -1,      // -1 — сначала новые, крупные, Я→А
  sel: new Set(), anchor: null, cursor: null, lastZip: null, limit: 0
};

const PAGE = 200;      // строк в списке за раз: DOM не растёт на тысячи узлов
const TICKS = 160;     // засечек на шкале времени: по узлу на документ было слишком дорого
// Текст документов остаётся в главном процессе. Сюда приходят только совпадения по текущему запросу.
const DEEP = { q: null, hits: new Map(), busy: false };

/* ——— служебное ——— */
function toast(m) { const t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3600); }
function busy(text, pct, onStop) {
  const b = $('busy'), stop = $('busyStop');
  if (text === false) { b.hidden = true; stop.hidden = true; stop.onclick = null; return; }
  b.hidden = false; $('busyText').textContent = text || 'Работаем…';
  $('busyBar').style.width = (pct == null ? 35 : pct) + '%';
  if (onStop) { stop.hidden = false; stop.onclick = onStop; }
}
function sheet(html) { $('sheet').innerHTML = html; $('drawer').hidden = false; }
function closeSheet() { $('drawer').hidden = true; }
$('drawer').onclick = (e) => { if (e.target.id === 'drawer' || e.target.dataset.close) closeSheet(); };

async function call(promise, label) {
  const res = await promise;
  if (!res || res.ok !== true) { toast((label ? label + ': ' : '') + ((res && res.error) || 'неизвестная ошибка')); return null; }
  return res.data;
}
function report(title, rows, extra = '') {
  const ok = rows.filter((r) => r.status === 'ok').length;
  const skip = rows.filter((r) => r.status === 'skip').length;
  const err = rows.filter((r) => r.status === 'err').length;
  sheet(`<h2>${esc(title)}</h2>
    <div class="note ${err ? 'bad' : skip ? '' : 'ok'}">Выполнено: ${ok} · пропущено: ${skip} · с ошибкой: ${err}</div>
    <div class="filelist">${rows.map((r) => `<div class="fileline"><b>${esc(r.name)}</b><i class="${r.status}">${esc(r.message)}</i></div>`).join('')}</div>
    ${extra}<button class="act primary" data-close="1">Закрыть</button>`);
}

/* ——— выбор тегов ——— */
// Один компонент на все окна: порядок по частоте, поиск при длинном списке,
// выбранные закреплены сверху, чтобы не пропадали из виду при фильтрации.
let TAGFREQ = new Map();
function recountTags() {
  TAGFREQ = new Map();
  for (const d of DOCS) for (const t of (d.tags || [])) TAGFREQ.set(t, (TAGFREQ.get(t) || 0) + 1);
}
const byFreq = (list) => [...list].sort((a, b) => (TAGFREQ.get(b) || 0) - (TAGFREQ.get(a) || 0) || a.localeCompare(b, 'ru'));

function tagPicker(box, pool, selected, onToggle, opts = {}) {
  const limit = opts.limit || 30;
  let q = '', all = false;
  const draw = () => {
    const sorted = byFreq(pool);
    const sel = sorted.filter((t) => selected.has(t));
    const rest = sorted.filter((t) => !selected.has(t) && (!q || t.toLowerCase().includes(q)));
    const shown = all ? rest : rest.slice(0, limit);
    const chip = (t) => {
      const m = opts.mark ? opts.mark(t) : null;
      return `<button class="tag${m && m.cls ? ' ' + m.cls : ''}" type="button" data-t="${esc(t)}"`
        + ` aria-pressed="${selected.has(t)}"${m && m.title ? ` title="${esc(m.title)}"` : ''}>`
        + esc(t) + (m && m.suffix ? ' ' + m.suffix : '') + '</button>';
    };
    box.innerHTML =
      (pool.length > 12 ? `<input type="search" class="tagsearch" placeholder="Поиск по тегам" value="${esc(q)}">` : '')
      + '<div class="tagcloud">'
      + ([...sel, ...shown].map(chip).join('')
         || `<span class="hint" style="margin:0">${pool.length ? 'Ничего не нашлось' : (opts.empty || 'Тегов пока нет')}</span>`)
      + '</div>'
      + (!all && rest.length > shown.length
          ? `<button class="tagmore" type="button">Показать все · ещё ${rest.length - shown.length}</button>` : '');

    const inp = box.querySelector('.tagsearch');
    if (inp) inp.oninput = () => {
      q = inp.value.trim().toLowerCase();
      draw();
      const again = box.querySelector('.tagsearch');
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    };
    const more = box.querySelector('.tagmore');
    if (more) more.onclick = () => { all = true; draw(); };
    box.querySelector('.tagcloud').onclick = (e) => {
      const b = e.target.closest('.tag'); if (!b) return;
      onToggle(b.dataset.t);
      draw();
    };
  };
  draw();
  return {
    draw,
    add(t) { if (!pool.includes(t)) pool.push(t); selected.add(t); draw(); }
  };
}

// Список файлов в панелях: справа либо размер, либо папка — больше вариантов не нужно.
const fileList = (docs, right = 'size') => '<div class="filelist">'
  + docs.map((d) => `<div class="fileline"><b>${esc(d.name)}</b>`
      + (right === 'dir' ? `<i>${esc(d.dir)}</i>` : `<span>${esc(d.sizeText)}</span>`) + '</div>').join('')
  + '</div>';

// Поле «Новый тег» и его обвязка: три окна просили одно и то же.
const newTagField = (hint) => `<div class="field"><span>Новый тег</span><div style="display:flex;gap:6px">
  <input type="text" id="nt" placeholder="Например: ${esc(hint)}"><button class="act" id="ntAdd">Создать</button></div></div>`;
function wireNewTag(onAdd) {
  if (!$('ntAdd')) return;
  const add = () => { const v = $('nt').value.trim(); if (!v) return; onAdd(v); $('nt').value = ''; };
  $('ntAdd').onclick = add;
  $('nt').addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
}

/* ——— тема ——— */
function applyTheme(resolved) { document.documentElement.dataset.theme = resolved; }
function markTheme(source) { [...$('theme').children].forEach((b) => b.setAttribute('aria-pressed', b.dataset.t === source)); }
$('theme').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-t]'); if (!b) return;
  const s = await call(window.api.settings.set({ theme: b.dataset.t }), 'Тема');
  if (s) { SETTINGS = s; markTheme(s.theme.source); applyTheme(s.theme.resolved); }
});

/* ——— фильтры ——— */
function recalc(resetRange) {
  TAGS = [...new Set(DOCS.flatMap((d) => d.tags || []))].sort((a, b) => a.localeCompare(b, 'ru'));
  DATES = DOCS.map((d) => +new Date(d.date)).filter((n) => !isNaN(n));
  const wasFull = resetRange || (st.from <= MIN && st.to >= MAX);
  // Math.min(...DATES) на десятках тысяч значений переполняет стек вызовов — считаем проходом.
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < DATES.length; i++) { if (DATES[i] < lo) lo = DATES[i]; if (DATES[i] > hi) hi = DATES[i]; }
  MIN = DATES.length ? lo : Date.now();
  MAX = DATES.length ? hi : Date.now();
  if (wasFull) { st.from = MIN; st.to = MAX; }
  else { st.from = Math.max(MIN, Math.min(st.from, MAX)); st.to = Math.min(MAX, Math.max(st.to, MIN)); }
  [...st.tags].forEach((t) => { if (!TAGS.includes(t)) st.tags.delete(t); });

  recountTags();
  tagPicker($('tags'), TAGS, st.tags, (t) => { st.tags.has(t) ? st.tags.delete(t) : st.tags.add(t); st.limit = 0; render(); });
  // Засечки сводятся в корзины: шкала выглядит так же, но узлов не больше TICKS.
  const bucket = new Set();
  for (let i = 0; i < DATES.length; i++) bucket.add(Math.round(pct(DATES[i]) * TICKS / 100));
  $('ticks').innerHTML = [...bucket].map((b) => `<b style="left:${(b * 100 / TICKS).toFixed(2)}%"></b>`).join('');
  $('types').innerHTML = TYPES.map((t) => `<label><input type="checkbox" value="${t}" class="ft" ${st.types.has(t) ? 'checked' : ''}> ${t.toUpperCase()} <span class="cnt">${DOCS.filter((d) => d.kind === t).length}</span></label>`).join('');
  const parties = [...new Set(DOCS.map((d) => d.party).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  $('party').innerHTML = '<option value="">Все</option>' + parties.map((p) => `<option ${st.party === p ? 'selected' : ''}>${esc(p)}</option>`).join('');
  syncTime();
}
const pct = (ms) => (MAX === MIN ? 0 : ((ms - MIN) / (MAX - MIN)) * 100);
function syncTime() {
  $('r1').value = pct(st.from); $('r2').value = pct(st.to);
  $('railFill').style.left = pct(st.from) + '%';
  $('railFill').style.width = (pct(st.to) - pct(st.from)) + '%';
  $('lbFrom').textContent = fmtShort(st.from); $('lbTo').textContent = fmtShort(st.to);
  $('from').value = isoDay(st.from); $('to').value = isoDay(st.to);
}

function match(d) {
  if (st.types.size && !st.types.has(d.kind)) return null;
  if (st.party && d.party !== st.party) return null;
  for (const t of st.tags) if (!(d.tags || []).includes(t)) return null;
  const ms = +new Date(d.date);
  if (!isNaN(ms) && (ms < st.from || ms > st.to)) return null;
  const q = st.q.trim().toLowerCase();
  if (!q) return { d, hit: '' };
  if ((d.name + ' ' + (d.party || '') + ' ' + d.dir + ' ' + (d.tags || []).join(' ')).toLowerCase().includes(q)) return { d, hit: '' };
  if (st.deep && DEEP.q === q) {
    const h = DEEP.hits.get(d.id);
    if (h) return { d, hit: esc(h.pre) + '<mark>' + esc(h.hit) + '</mark>' + esc(h.post) };
  }
  return null;
}

// Поиск внутри документов: запрос уходит в главный процесс не на каждую букву,
// а после паузы в наборе, и возвращает только совпадения с фрагментом вокруг них.
let deepTimer = null;
function scheduleDeep() {
  clearTimeout(deepTimer);
  const q = st.q.trim().toLowerCase();
  if (!st.deep || !q) { DEEP.q = q ? null : ''; DEEP.hits = new Map(); return; }
  if (DEEP.q === q) return;
  deepTimer = setTimeout(async () => {
    if (DEEP.busy) return scheduleDeep();
    DEEP.busy = true;
    const hits = await call(window.api.catalog.search(q), 'Поиск');
    DEEP.busy = false;
    if (st.q.trim().toLowerCase() !== q) return scheduleDeep();   // пока искали, запрос сменился
    DEEP.q = q;
    DEEP.hits = new Map((hits || []).map((h) => [h.id, h]));
    render();
  }, 220);
}
// Порядок задаётся над списком: поле плюс направление. Повторное нажатие разворачивает.
const SORTERS = {
  date: (a, b) => +new Date(a.d.date) - +new Date(b.d.date),
  size: (a, b) => a.d.size - b.d.size,
  name: (a, b) => a.d.name.localeCompare(b.d.name, 'ru')
};
const SORT_DEFAULT = { date: -1, size: -1, name: 1 };
const SORT_LABEL = { date: 'Дата', size: 'Размер', name: 'Имя' };
function markSort() {
  $('lhead').querySelectorAll('button[data-s]').forEach((b) => {
    const on = b.dataset.s === st.sortBy;
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('num', b.dataset.s !== 'name');
    b.textContent = SORT_LABEL[b.dataset.s] + (on ? (st.sortDir < 0 ? ' ↓' : ' ↑') : '');
    b.title = on ? 'Нажмите, чтобы развернуть порядок' : 'Упорядочить по этому столбцу';
  });
}
$('lhead').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-s]'); if (!b) return;
  if (st.sortBy === b.dataset.s) st.sortDir = -st.sortDir;
  else { st.sortBy = b.dataset.s; st.sortDir = SORT_DEFAULT[st.sortBy]; }
  markSort(); render();
});
const chosen = () => DOCS.filter((d) => st.sel.has(d.id));

/* ——— список ——— */
// Пересчёт панели выделения без перестройки списка.
function syncSel(res) {
  const ids = new Set(res.map((r) => r.d.id));
  const hidden = [...st.sel].filter((id) => !ids.has(id)).length;
  const si = $('selinfo');
  if (st.sel.size) {
    si.hidden = false;
    si.innerHTML = `<span>Выбрано <b>${st.sel.size}</b></span>`
      + (hidden ? `<span class="warnpart">· ${hidden} скрыт${hidden === 1 ? '' : 'о'} текущим фильтром, но останется в операции</span>` : '')
      + '<button id="clearSel">Снять выделение</button>';
  } else si.hidden = true;
  $('all').checked = res.length > 0 && res.every((r) => st.sel.has(r.d.id));
  $('btnActions').disabled = st.sel.size === 0;
}
const visibleRes = () => DOCS.map(match).filter(Boolean);
let ORDER = [];   // id в порядке показа — по нему Shift выбирает диапазон

// Отметки проставляются по месту, без перестройки списка и сброса прокрутки.
function paintSel() {
  $('view').querySelectorAll('.row').forEach((row) => {
    const on = st.sel.has(+row.dataset.id);
    row.classList.toggle('sel', on);
    const cb = row.querySelector('.pick');
    if (cb) cb.checked = on;
  });
  syncSel(visibleRes());
}

// Выбор по всей строке, а не только по галочке. Shift добавляет диапазон от предыдущей.
// Название из этого исключено: оно ссылка и открывает файл, выбора не касаясь.
document.addEventListener('click', async (e) => {
  if (e.target.classList.contains('pick')) return;   // галочкой занимается обработчик input
  const row = e.target.closest('#view .row'); if (!row) return;
  const id = +row.dataset.id;
  if (e.target.closest('.name')) {
    if (e.detail > 1) return;                        // второй клик двойного не открывает файл повторно
    return void await call(window.api.file.open(id), 'Открытие');
  }
  if (e.detail > 1) return;                          // двойной клик показывает карточку и отметку не трогает
  if (e.shiftKey && st.anchor != null && st.anchor !== id) {
    const a = ORDER.indexOf(st.anchor), b = ORDER.indexOf(id);
    if (a >= 0 && b >= 0) {
      const [from, to] = a < b ? [a, b] : [b, a];
      for (let i = from; i <= to; i++) st.sel.add(ORDER[i]);
      st.anchor = id;
      return paintSel();
    }
  }
  st.sel.has(id) ? st.sel.delete(id) : st.sel.add(id);
  st.anchor = id;
  setCursor(id, false);
  paintSel();
});

function render() {
  [...st.sel].forEach((id) => { if (!DOCS.some((d) => d.id === id)) st.sel.delete(id); });
  const cmp = SORTERS[st.sortBy];
  const res = DOCS.map(match).filter(Boolean).sort((a, b) => cmp(a, b) * st.sortDir);
  const limit = Math.max(PAGE, st.limit || PAGE);
  const shown = res.length > limit ? res.slice(0, limit) : res;
  ORDER = shown.map((r) => r.d.id);

  $('lhead').hidden = !res.length;
  $('found').textContent = res.length
    ? `${plural(res.length, 'документ', 'документа', 'документов')} в списке` + (shown.length < res.length ? ` · показано ${shown.length}` : '')
    : '';

  $('view').innerHTML = res.length
    ? '<div class="list">' + shown.map(({ d, hit }) => `
      <div class="row cols-grid${st.sel.has(d.id) ? ' sel' : ''}${d.missing ? ' missing' : ''}" data-id="${d.id}">
        <input type="checkbox" class="pick" data-id="${d.id}" ${st.sel.has(d.id) ? 'checked' : ''} aria-label="Выбрать ${esc(d.name)}">
        <div style="min-width:0"><div><span class="name" title="Открыть файл">${esc(d.name)}</span></div><div class="path">${esc(d.dir)}</div>
          <div class="meta"><span class="chip k ${d.kind}">${d.kind.toUpperCase()}</span>
            ${d.party ? `<span class="chip">${esc(d.party)}</span>` : ''}
            ${(d.tags || []).map((t) => `<span class="chip t">${esc(t)}</span>`).join('') || '<span class="chip">без тегов</span>'}
            ${d.missing ? '<span class="chip miss">файл не найден</span>' : ''}</div>
          ${hit ? `<div class="hit">${hit}</div>` : ''}</div>
        <div class="col">${ru(d.date)}</div>
        <div class="col">${esc(d.sizeText)}</div>
      </div>`).join('') + '</div>'
      + (shown.length < res.length
        ? `<button class="act" id="more" style="margin-top:8px;width:100%">Показать ещё ${Math.min(PAGE, res.length - shown.length)} из ${res.length - shown.length}</button>`
        : '')
    : (DOCS.length
      ? '<div class="empty"><b>Ничего не нашлось</b>Сдвиньте промежуток времени, снимите теги или очистите строку поиска.</div>'
      : '<div class="empty"><b>Картотека пуста</b>Добавьте папку кнопкой «Добавить папку» или перетащите папку либо файлы прямо в окно.</div>');

  if (st.cursor != null && !ORDER.includes(st.cursor)) st.cursor = null;
  if (st.cursor != null) setCursor(st.cursor, false);
  syncSel(res);
}

document.addEventListener('click', (e) => {
  if (e.target.id === 'clearSel') { st.sel.clear(); render(); }
  if (e.target.id === 'more') { st.limit = Math.max(PAGE, st.limit || PAGE) + PAGE; render(); }
});
let renderTimer = null;
const renderSoon = () => { clearTimeout(renderTimer); renderTimer = setTimeout(render, 150); };

document.addEventListener('input', (e) => {
  const t = e.target;
  // Отметка документа меняет одну строку, а не перестраивает весь список и прокрутку.
  if (t.classList.contains('pick')) {
    const id = +t.dataset.id;
    t.checked ? st.sel.add(id) : st.sel.delete(id);
    const row = t.closest('.row');
    if (row) row.classList.toggle('sel', t.checked);
    st.anchor = id;
    syncSel(visibleRes());
    return;
  }
  if (t.id === 'q') { st.q = t.value; st.limit = 0; scheduleDeep(); return renderSoon(); }
  if (t.id === 'deep') { st.deep = t.checked; st.limit = 0; scheduleDeep(); return renderSoon(); }
  st.limit = 0;
  if (t.classList.contains('ft')) t.checked ? st.types.add(t.value) : st.types.delete(t.value);
  else if (t.id === 'party') st.party = t.value;
  else if (t.id === 'r1' || t.id === 'r2') {
    let a = +$('r1').value, b = +$('r2').value;
    if (a > b) { if (t.id === 'r1') a = b; else b = a; }
    st.from = MIN + (MAX - MIN) * a / 100; st.to = MIN + (MAX - MIN) * b / 100; syncTime();
  } else if (t.id === 'from' && t.value) { st.from = +new Date(t.value); if (st.from > st.to) st.to = st.from; syncTime(); }
  else if (t.id === 'to' && t.value) { st.to = +new Date(t.value); if (st.to < st.from) st.from = st.to; syncTime(); }
  else if (t.id === 'all') { visibleRes().forEach((x) => (t.checked ? st.sel.add(x.d.id) : st.sel.delete(x.d.id))); }
  else return;
  render();
});
$('reset').onclick = () => {
  st.q = ''; st.types.clear(); st.tags.clear(); st.party = ''; st.limit = 0;
  st.sortBy = 'date'; st.sortDir = -1;
  $('q').value = '';
  DEEP.q = null; DEEP.hits = new Map();
  markSort(); recalc(true); render();
};

/* ——— карточка документа ——— */
function openCard(d) {
  sheet(`<h2>${esc(d.name)}</h2>
    <div><div class="kv"><span>Путь к оригиналу</span><b>${esc(d.dir)}</b></div>
      <div class="kv"><span>Расширение</span><b>${d.kind.toUpperCase()}</b></div>
      <div class="kv"><span>Изменён</span><b>${ru(d.date)}</b></div>
      <div class="kv"><span>Размер</span><b>${esc(d.sizeText)}</b></div>
      <div class="kv"><span>Контрагент</span><b>${esc(d.party || '—')}</b></div>
      <div class="kv"><span>Теги</span><b>${(d.tags || []).map(esc).join(', ') || '—'}</b></div></div>
    ${d.missing ? '<div class="note bad">Файл не найден по этому пути. Он мог быть перемещён или удалён вне приложения.</div>' : ''}
    <div class="preview" id="pretext">${d.hasText ? 'Загружаем фрагмент…' : 'Текстовый слой не проиндексирован. Для сканов нужно распознавание, для PDF и Word — установленные пакеты индексации.'}</div>
    <div class="field"><span>Контрагент или проект</span>
      <div style="display:flex;gap:6px"><input type="text" id="pv" value="${esc(d.party || '')}"><button class="act" id="psave">Сохранить</button></div></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="act primary" id="cOpen" style="flex:1">Открыть файл</button>
      <button class="act" id="cReveal">Показать в папке</button></div>`);
  // Текст подтягивается по требованию: в памяти интерфейса он больше не лежит.
  if (d.hasText) window.api.catalog.text(d.id).then((r) => {
    const box = $('pretext');
    if (box && r && r.ok) box.textContent = r.data || 'Фрагмент недоступен.';
  });
  $('cOpen').onclick = async () => { const r = await call(window.api.file.open(d.id), 'Открытие'); if (r) closeSheet(); };
  $('cReveal').onclick = () => window.api.file.reveal(d.id);
  $('psave').onclick = async () => {
    const v = $('pv').value.trim();
    await call(window.api.catalog.party([d.id], v), 'Контрагент');
    d.party = v; recalc(false); render(); toast('Контрагент сохранён');
  };
}
// Двойной клик по строке — карточка документа. По названию ничего не делает:
// файл уже открылся по первому клику.
document.addEventListener('dblclick', (e) => {
  const r = e.target.closest('#view .row'); if (!r) return;
  if (e.target.closest('.name')) return;
  const d = DOCS.find((x) => x.id === +r.dataset.id);
  if (d) openCard(d);
});

/* ——— меню действий ——— */
const menu = $('menu');
let ctxDoc = null;
const hideMenu = () => (menu.hidden = true);
document.addEventListener('click', (e) => { if (!e.target.closest('#menu') && e.target.id !== 'btnActions') hideMenu(); });
document.addEventListener('scroll', hideMenu, true);
function placeMenu(x, y) {
  menu.hidden = false;
  menu.style.left = Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)) + 'px';
}
const actionItems = (head) => `<div class="lbl">${esc(head)}</div>
  <button data-a="print">Печать</button>
  <button data-a="mail">Отправить по почте</button>
  <button data-a="zip">Создать ZIP-архив</button>
  <button data-a="move">Переместить</button>
  <button data-a="tags">Изменить теги</button>
  <hr><button class="danger" data-a="del">Удалить</button>`;
function openActions() {
  if (!st.sel.size) return;
  ctxDoc = null;
  menu.innerHTML = actionItems('Выбрано: ' + st.sel.size);
  menu.hidden = false;
  const r = $('btnActions').getBoundingClientRect();
  placeMenu(r.right - menu.offsetWidth, r.bottom + 6);
}
$('btnActions').onclick = (e) => { e.stopPropagation(); menu.hidden ? openActions() : hideMenu(); };
document.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.row'); if (!row) return;
  e.preventDefault();
  const d = DOCS.find((x) => x.id === +row.dataset.id); if (!d) return;
  if (!st.sel.has(d.id)) { st.sel = new Set([d.id]); render(); }
  ctxDoc = d;
  menu.innerHTML = `<div class="lbl">${esc(d.name)}</div>
    <button data-a="open">Открыть файл</button>
    <button data-a="card">Карточка документа</button>
    <button data-a="reveal">Показать в папке</button>
    <button data-a="rename">Переименовать</button><hr>` + actionItems('Выбрано: ' + st.sel.size);
  menu.hidden = false;
  placeMenu(e.clientX, e.clientY);
});
menu.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-a]'); if (!b) return;
  const a = b.dataset.a, d = ctxDoc; hideMenu();
  if (a === 'open' && d) { await call(window.api.file.open(d.id), 'Открытие'); return; }
  if (a === 'card' && d) return openCard(d);
  if (a === 'reveal' && d) { window.api.file.reveal(d.id); return; }
  if (a === 'rename' && d) return renamePanel(d);
  ({ print: printPanel, mail: mailPanel, zip: zipPanel, move: movePanel, tags: tagsPanel, del: deletePanel }[a] || (() => {}))();
});

/* ——— переименование ——— */
function renamePanel(d) {
  sheet(`<h2>Переименовать файл</h2>
    <div class="field"><span>Имя файла на диске</span><input type="text" id="rv" value="${esc(d.name)}"></div>
    <div class="note">Переименование затрагивает оригинал: файл на диске получит новое имя, картотека обновит путь.</div>
    <div style="display:flex;gap:8px"><button class="act primary" id="rok" style="flex:1">Переименовать</button><button class="act" data-close="1">Отмена</button></div>`);
  const input = $('rv'); input.focus();
  const go = async () => {
    const v = input.value.trim(); if (!v || v === d.name) return closeSheet();
    const r = await call(window.api.file.rename(d.id, v), 'Переименование');
    if (r) { closeSheet(); await reload(); toast('Файл переименован'); }
  };
  $('rok').onclick = go;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

/* ——— печать ——— */
async function printPanel() {
  const c = chosen();
  if (!PRINTERS.length) PRINTERS = (await call(window.api.op.printers())) || [];
  sheet(`<h2>Печать</h2>
    ${fileList(c)}
    <div class="field"><span>Принтер</span><select id="pr">
      <option value="">Принтер по умолчанию</option>
      ${PRINTERS.map((p) => `<option>${esc(p)}</option>`).join('')}</select></div>
    <div class="field"><span>Копий</span><input type="text" id="cp" value="1" inputmode="numeric"></div>
    <div class="note">Файл открывается в своей программе и печатается её средствами. Двусторонность и другие тонкие настройки задаются в свойствах принтера Windows.</div>
    <div style="display:flex;gap:8px"><button class="act primary" id="go" style="flex:1">Печатать (${c.length})</button><button class="act" data-close="1">Отмена</button></div>`);
  $('go').onclick = async () => {
    const printer = $('pr').value, copies = Math.max(1, Math.min(20, parseInt($('cp').value, 10) || 1));
    busy('Отправляем на печать…');
    const rows = await call(window.api.op.print(c.map((d) => d.id), { printer, copies }), 'Печать');
    busy(false);
    if (rows) report('Печать', rows);
  };
}

/* ——— почта ——— */
function mailPanel(withZip) {
  const c = chosen(), zip = withZip && st.lastZip;
  const attachNames = zip ? [zip.name] : c.map((d) => d.name);
  sheet(`<h2>Отправка по почте</h2>
    <div class="field"><span>Кому</span><input type="text" id="to" placeholder="buh@example.ru"></div>
    <div class="field"><span>Тема</span><input type="text" id="subj" value="${esc((c[0] && c[0].party) || 'Документы')} — документы (${attachNames.length})"></div>
    <div class="field"><span>Текст</span><textarea id="body">Здравствуйте!

Во вложении документы по списку. Если что-то не открывается — напишите, пришлю повторно.</textarea></div>
    <div class="field"><span>Вложения</span><div class="filelist">
      ${attachNames.map((n) => `<div class="fileline"><b>${esc(n)}</b></div>`).join('')}</div></div>
    ${zip ? '<div class="note">Отправляется один архив, а не документы по отдельности.</div>' : ''}
    <div class="note">Письмо откроется в Outlook с уже прикреплёнными файлами — отправку вы подтверждаете сами. Если Outlook не установлен, откроется почтовый клиент по умолчанию, а вложения появятся в проводнике.</div>
    <div style="display:flex;gap:8px"><button class="act primary" id="go" style="flex:1">Подготовить письмо</button><button class="act" data-close="1">Отмена</button></div>`);
  $('go').onclick = async () => {
    const attachments = zip ? [zip.path] : c.map((d) => d.dir + '\\' + d.name);
    busy('Готовим письмо…');
    const r = await call(window.api.op.mail({ to: $('to').value.trim(), subject: $('subj').value, body: $('body').value, attachments }), 'Почта');
    busy(false);
    if (r) { closeSheet(); toast(r.message); }
  };
}

/* ——— ZIP ——— */
function zipPanel() {
  const c = chosen(), now = new Date();
  const dd = String(now.getDate()).padStart(2, '0'), mm = String(now.getMonth() + 1).padStart(2, '0');
  let dir = SETTINGS.lastZipDir || '';
  sheet(`<h2>Создать ZIP-архив</h2>
    <div class="field"><span>Имя архива</span><input type="text" id="zn" value="Документы_${dd}-${mm}-${now.getFullYear()}.zip"></div>
    <div class="field"><span>Папка сохранения</span>
      <div style="display:flex;gap:6px"><input type="text" id="zp" value="${esc(dir)}" placeholder="Выберите папку"><button class="act" id="zpick">Обзор…</button></div></div>
    <div class="field"><span>В архив войдут файлы (${c.length})</span>
      ${fileList(c)}</div>
    <div class="note">Файлы кладутся в корень архива без путей Windows. Совпадающие имена получают номер, оригиналы не изменяются.</div>
    <div style="display:flex;gap:8px"><button class="act primary" id="go" style="flex:1">Создать архив</button><button class="act" data-close="1">Отмена</button></div>`);
  $('zpick').onclick = async () => {
    const p = await call(window.api.dialog.folder('Куда сохранить архив'));
    if (p) { dir = p; $('zp').value = p; }
  };
  $('go').onclick = async () => {
    const target = $('zp').value.trim(), name = $('zn').value.trim();
    if (!target) return toast('Выберите папку сохранения');
    if (!name) return toast('Укажите имя архива');
    busy('Собираем архив…', 60);
    const r = await call(window.api.op.zip(c.map((d) => d.id), target, name), 'Архив');
    busy(false);
    if (!r) return;
    st.lastZip = { name: r.name, path: r.path };
    SETTINGS.lastZipDir = target;
    report(`Архив создан · ${r.size}`, r.rows, '<button class="act" id="toMail">Перейти к отправке по почте</button>');
    $('toMail').onclick = () => mailPanel(true);
  };
}

/* ——— перемещение ——— */
function movePanel() {
  const c = chosen();
  let dest = SETTINGS.lastMoveDir || '';
  sheet(`<h2>Переместить файлы</h2>
    <div class="field"><span>Папка назначения</span>
      <div style="display:flex;gap:6px"><input type="text" id="mp" value="${esc(dest)}" placeholder="Выберите папку"><button class="act" id="mpick">Обзор…</button></div></div>
    <div class="field"><span>Будут перемещены (${c.length})</span>
      ${fileList(c, 'dir')}</div>
    <div class="note">Перемещается оригинал на диске, путь в картотеке обновляется. Теги, контрагент и остальные метаданные сохраняются. Существующие файлы не перезаписываются.</div>
    <div style="display:flex;gap:8px"><button class="act primary" id="go" style="flex:1">Переместить</button><button class="act" data-close="1">Отмена</button></div>`);
  $('mpick').onclick = async () => {
    const p = await call(window.api.dialog.folder('Куда переместить файлы'));
    if (p) { dest = p; $('mp').value = p; }
  };
  $('go').onclick = async () => {
    const target = $('mp').value.trim();
    if (!target) return toast('Выберите папку назначения');
    busy('Перемещаем файлы…');
    const rows = await call(window.api.op.move(c.map((d) => d.id), target), 'Перемещение');
    busy(false);
    if (!rows) return;
    SETTINGS.lastMoveDir = target;
    await reload();
    report('Перемещение', rows);
  };
}

/* ——— массовые теги ——— */
function tagsPanel() {
  const c = chosen();
  let mode = 'add', picked = new Set(), pool = [...TAGS];
  const inAll = (t) => c.every((d) => (d.tags || []).includes(t));
  const inSome = (t) => c.some((d) => (d.tags || []).includes(t));
  const draw = () => {
    const list = mode === 'remove' ? pool.filter(inSome) : pool;
    const willDrop = [...new Set(c.flatMap((d) => d.tags || []))].filter((t) => !picked.has(t)).length;
    sheet(`<h2>Изменить теги · ${plural(c.length, 'документ', 'документа', 'документов')}</h2>
      <div class="seg" id="tm" role="group" aria-label="Операция">
        <button data-m="add" aria-pressed="${mode === 'add'}">Добавить</button>
        <button data-m="remove" aria-pressed="${mode === 'remove'}">Удалить</button>
        <button data-m="replace" aria-pressed="${mode === 'replace'}">Заменить все</button></div>
      <p class="hint" style="margin:0">${mode === 'add' ? 'Выбранные теги добавятся ко всем документам. Уже имеющиеся не продублируются.'
        : mode === 'remove' ? 'Выбранные теги снимутся со всех документов. Остальные теги каждого документа сохранятся.'
        : 'Текущий набор тегов у каждого документа будет полностью заменён выбранным.'}</p>
      <div class="field"><span>${mode === 'remove' ? 'Теги у выбранных документов' : 'Теги'}</span>
        <div id="tc"></div></div>
      ${mode === 'remove' ? '' : newTagField('На подпись')}
      <div class="note">✓ — тег есть у всех выбранных, ◐ — только у части. Теги меняются только в картотеке, содержимое файлов не затрагивается.</div>
      <div id="droppc">${mode === 'replace' && willDrop ? `<div class="note bad">Будет снято ${plural(willDrop, 'тег', 'тега', 'тегов')} у выбранных документов.</div>` : ''}</div>
      <div style="display:flex;gap:8px"><button class="act primary" id="go" style="flex:1">Применить</button><button class="act" data-close="1">Отмена</button></div>`);
    $('tm').onclick = (e) => { const b = e.target.closest('button[data-m]'); if (!b) return; mode = b.dataset.m; picked = new Set(); draw(); };
    const picker = tagPicker($('tc'), list, picked, (t) => { picked.has(t) ? picked.delete(t) : picked.add(t); redrawHints(); }, {
      empty: 'Нет подходящих тегов',
      mark: (t) => inAll(t) ? { suffix: '✓', title: 'есть у всех выбранных' }
        : inSome(t) ? { cls: 'part', suffix: '◐', title: 'есть только у части выбранных' }
        : { title: 'нет ни у одного выбранного' }
    });
    // подсказка о снимаемых тегах зависит от выбора, но перерисовывать всё окно ради неё не нужно
    function redrawHints() {
      const box = $('droppc');
      if (!box) return;
      const n = [...new Set(c.flatMap((d) => d.tags || []))].filter((t) => !picked.has(t)).length;
      box.innerHTML = mode === 'replace' && n ? `<div class="note bad">Будет снято ${plural(n, 'тег', 'тега', 'тегов')} у выбранных документов.</div>` : '';
    }
    wireNewTag((v) => picker.add(v));
    $('go').onclick = async () => {
      if (!picked.size && mode !== 'replace') return toast('Выберите хотя бы один тег');
      const rows = await call(window.api.catalog.tags(c.map((d) => d.id), mode, [...picked]), 'Теги');
      if (!rows) return;
      await reload();
      report('Теги обновлены', rows);
    };
  };
  draw();
}

/* ——— удаление: выбор, затем подтверждение ——— */
function deletePanel() {
  const c = chosen();
  let pick = null;
  sheet(`<h2>Удалить · ${plural(c.length, 'документ', 'документа', 'документов')}</h2>
    ${fileList(c, 'dir')}
    <p style="margin:0">Выберите, что именно удалить, затем нажмите «Подтвердить».</p>
    <div class="choice" id="choice">
      <button class="act" data-c="cat" aria-pressed="false" style="text-align:left">Убрать из картотеки<br><span class="hint" style="margin:0">Запись и её поисковые данные исчезнут. Файл останется на компьютере.</span></button>
      <button class="act danger" data-c="disk" aria-pressed="false" style="text-align:left">Удалить файл с компьютера<br><span class="hint" style="margin:0">Затрагивается оригинальный документ, а не только запись.</span></button>
    </div>
    <div class="note" id="what">Пока ничего не выбрано — ни один документ не затронут.</div>
    <div style="display:flex;gap:8px"><button class="act primary" id="confirm" style="flex:1" disabled>Подтвердить</button><button class="act" data-close="1">Отмена</button></div>`);
  $('choice').onclick = (e) => {
    const b = e.target.closest('button[data-c]'); if (!b) return;
    pick = b.dataset.c;
    [...$('choice').children].forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $('confirm').disabled = false;
    $('confirm').className = 'act ' + (pick === 'disk' ? 'danger' : 'primary');
    $('what').className = 'note' + (pick === 'disk' ? ' bad' : '');
    $('what').textContent = pick === 'disk'
      ? 'Выбрано удаление оригиналов. После подтверждения будет ещё один экран с предупреждением про Корзину Windows.'
      : 'Выбрано удаление записей. Файлы на компьютере останутся на месте.';
  };
  $('confirm').onclick = () => (pick === 'cat' ? fromCatalog() : askDisk());

  const fromCatalog = async () => {
    const names = c.map((d) => d.name);
    const r = await call(window.api.catalog.removeRecords(c.map((d) => d.id)), 'Удаление записей');
    if (!r) return;
    st.sel.clear(); await reload();
    report('Убрано из картотеки', names.map((n) => ({ name: n, status: 'ok', message: 'запись убрана, файл на диске остался' })));
  };
  const askDisk = () => {
    sheet(`<h2>Удалить ${c.length === 1 ? 'файл' : 'файлы'} с компьютера?</h2>
      <div class="note bad">${c.length === 1
        ? `Файл «${esc(c[0].name)}» будет перемещён в Корзину Windows.`
        : `${plural(c.length, 'файл', 'файла', 'файлов')} будут перемещены в Корзину Windows.`}
        Это действие затрагивает оригинальные документы, а не только записи в картотеке.</div>
      ${fileList(c, 'dir')}
      <div style="display:flex;gap:8px"><button class="act danger" id="binOk" style="flex:1">В Корзину</button><button class="act" id="back">Назад</button><button class="act" data-close="1">Отмена</button></div>`);
    $('back').onclick = () => deletePanel();
    $('binOk').onclick = async () => {
      busy('Удаляем в Корзину…');
      const rows = await call(window.api.op.trash(c.map((d) => d.id)), 'Удаление');
      busy(false);
      if (!rows) return;
      st.sel.clear(); await reload();
      report('Удаление в Корзину', rows);
    };
  };
}

/* ——— папки и сканирование ——— */
const HOTKEYS = [
  ['↑ ↓', 'перейти по списку'],
  ['Пробел', 'отметить или снять отметку'],
  ['Shift + ↑ ↓', 'расширить выделение'],
  ['Enter', 'открыть файл в его программе'],
  ['Ctrl + Enter', 'карточка документа'],
  ['Delete', 'удалить выделенное'],
  ['Ctrl + A', 'выделить всё в списке'],
  ['Ctrl + F', 'перейти в поиск'],
  ['Ctrl + Z', 'отменить действие'],
  ['Ctrl + Y', 'вернуть отменённое'],
  ['Esc', 'снять выделение или закрыть панель'],
  ['Двойной клик', 'карточка документа'],
  ['Клик по названию', 'открыть файл']
];

function settingsPanel() {
  const draw = async () => {
    const info = (await call(window.api.info())) || {};
    sheet(`<h2>Настройки</h2>
      <h3 class="sect">Папки картотеки</h3>
      <p class="hint" style="margin:0">Приложение следит за этими папками и всем, что внутри них. Оригиналы остаются на месте, копий не делается.</p>
      ${(info.notes || []).map((n) => `<div class="note bad">${esc(n)}</div>`).join('')}
      <div style="display:flex;flex-direction:column;gap:7px">
        ${SETTINGS.roots.map((r) => `<div class="rootrow">
            <div style="min-width:0"><code class="open" data-open="${esc(r.path)}" title="Двойной клик — открыть папку в проводнике">${esc(r.path)}</code>
              <div class="meta">${(r.tags || []).map((t) => `<span class="chip t">${esc(t)}</span>`).join('') || '<span class="chip">без тегов</span>'}</div></div>
            <button data-tags="${esc(r.path)}" class="quiet">Теги…</button>
            <button data-del="${esc(r.path)}">Убрать</button></div>`).join('')
          || '<div class="note">Пока не добавлено ни одной папки.</div>'}
      </div>
      <button class="act" id="addRoot">Добавить папку…</button>
      <p class="hint" style="margin:0">«Убрать» снимает наблюдение за папкой. Документы остаются в картотеке, файлы на диске не трогаются.</p>
      <h3 class="sect">Поиск внутри документов</h3>
      <div class="field"><label class="deep" style="border:0;background:none;padding:0">
        <input type="checkbox" id="idx" ${SETTINGS.indexText ? 'checked' : ''}> Индексировать текст внутри документов</label></div>
      <div class="note">Поиск по тексту: PDF — ${info.pdfIndex ? 'доступен' : 'не установлен пакет pdf-parse'}, Word — ${info.docxIndex ? 'доступен' : 'не установлен пакет mammoth'}. Простой текст и CSV читаются всегда, сканы требуют распознавания.</div>
      <h3 class="sect">Горячие клавиши</h3>
      <div class="keys">${HOTKEYS.map(([k, v]) => `<kbd>${esc(k)}</kbd><span>${esc(v)}</span>`).join('')}</div>

      <h3 class="sect">О программе</h3>
      <div class="kv"><span>Версия</span><b>${esc(info.version || '—')}</b></div>
      <div class="kv"><span>Документов в картотеке</span><b>${info.docs == null ? '—' : info.docs}</b></div>
      <div class="kv"><span>Данные картотеки</span><b>${esc(info.dataDir || '—')}</b></div>
      <div style="display:flex;gap:8px"><button class="act primary" id="rescan" style="flex:1">Обновить картотеку</button><button class="act" data-close="1">Закрыть</button></div>`);
    $('addRoot').onclick = async () => {
      const dirs = await call(window.api.dialog.folders());
      if (dirs && dirs.length) { closeSheet(); await addPaths(dirs); }
    };
    $('sheet').querySelectorAll('code[data-open]').forEach((c) => c.ondblclick = () => window.api.op.openDir(c.dataset.open));
    $('sheet').querySelectorAll('button[data-tags]').forEach((b) => b.onclick = () => rootTagsPanel(b.dataset.tags, draw));
    $('sheet').querySelectorAll('button[data-del]').forEach((b) => b.onclick = async () => {
      const roots = await call(window.api.catalog.removeRoot(b.dataset.del), 'Настройки');
      if (roots) { SETTINGS = { ...SETTINGS, roots }; draw(); }
    });
    $('idx').onchange = async (e) => {
      const s = await call(window.api.settings.set({ indexText: e.target.checked }), 'Настройки');
      if (s) SETTINGS = s;
    };
    $('rescan').onclick = () => { closeSheet(); scan(); };
  };
  draw();
}
$('btnSettings').onclick = settingsPanel;

// Правило тегов для папки. Применяется к тому, что найдётся дальше;
// уже заведённые документы не трогает — их теги принадлежат пользователю.
function rootTagsPanel(rootPath, back) {
  const root = SETTINGS.roots.find((r) => r.path === rootPath) || { path: rootPath, tags: [] };
  let picked = new Set(root.tags || []), pool = [...new Set([...TAGS, ...(root.tags || [])])];
  const draw = () => {
    sheet(`<h2>Теги папки</h2>
      <div class="kv"><span>Папка</span><b>${esc(rootPath)}</b></div>
      <div class="field"><span>Эти теги получат документы, найденные в папке</span>
        <div id="rt"></div></div>
      ${newTagField('Ромашка')}
      <div class="note">Правило действует на новые находки: при следующем «Обновить» документы, появившиеся в папке, получат эти теги. Уже заведённым документам теги не меняются.</div>
      <div style="display:flex;gap:8px"><button class="act primary" id="go" style="flex:1">Сохранить</button><button class="act" id="back">Назад</button></div>`);
    const picker = tagPicker($('rt'), pool, picked, (t) => { picked.has(t) ? picked.delete(t) : picked.add(t); },
      { empty: 'Тегов пока нет — создайте первый ниже.' });
    wireNewTag((v) => picker.add(v));
    $('back').onclick = () => back();
    $('go').onclick = async () => {
      const roots = await call(window.api.catalog.rootTags(rootPath, [...picked]), 'Теги папки');
      if (roots) { SETTINGS = { ...SETTINGS, roots }; toast('Правило сохранено'); back(); }
    };
  };
  draw();
}

const stopScan = () => { window.api.catalog.cancel(); busy('Останавливаем…', 100); };

async function scan(silent) {
  if (!SETTINGS.roots.length) {
    if (silent) return;
    toast('Сначала добавьте хотя бы одну папку');
    return settingsPanel();
  }
  busy('Просматриваем папки…', 10, stopScan);
  const res = await call(window.api.catalog.scan(), 'Сканирование');
  busy(false);
  if (!res) return;
  await reload();
  toast((res.cancelled ? 'Остановлено. ' : '')
    + `Найдено файлов: ${res.total} · новых: ${res.added} · обновлено: ${res.updated}`
    + (res.missing ? ' · пропало: ' + res.missing : '')
    + (res.failed ? ' · не прочитано: ' + res.failed : ''));
}
$('btnScan').onclick = () => scan();
const PHASE = { walk: 'Ищем документы…', read: 'Читаем свойства… ', index: 'Индексируем текст… ' };
window.api.onScanProgress((p) => {
  const label = PHASE[p.phase] || 'Просматриваем папки… ';
  if (!p.total) return busy(label, 5, stopScan);
  busy(label + p.done + ' из ' + p.total, Math.round((p.done / p.total) * 100), stopScan);
});

/* ——— добавление файлов ——— */
$('btnAdd').onclick = async () => {
  const files = await call(window.api.dialog.files());
  if (files && files.length) await addPaths(files);
};
$('btnAddDir').onclick = async () => {
  const dirs = await call(window.api.dialog.folders());
  if (dirs && dirs.length) await addPaths(dirs);
};

// Единая точка приёма: и диалоги, и перетаскивание. Папки и файлы разбирает главный процесс.
async function addPaths(paths) {
  const cls = await call(window.api.catalog.classify(paths), 'Проверка путей');
  if (!cls) return;
  if (!cls.files.length && !cls.dirs.length) return toast('Эти пути недоступны');
  if (cls.bad.length) toast(`Пропущено недоступных: ${cls.bad.length}`);
  // Для папок сперва смотрим, что внутри: сколько подпапок и какие теги они получат.
  const plans = [];
  if (cls.dirs.length) {
    busy('Смотрим, что в папках…', 20, stopScan);
    for (const d of cls.dirs) {
      const plan = await call(window.api.catalog.folderPlan(d), 'Разбор папки');
      if (plan) plans.push(plan);
    }
    busy(false);
  }
  importPanel(cls.files, cls.dirs, plans);
}
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; $('overlay').hidden = false; } });
window.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('overlay').hidden = true; } });
window.addEventListener('drop', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault(); dragDepth = 0; $('overlay').hidden = true;
  const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
  if (paths.length) addPaths(paths);
});

function importPanel(paths, dirs = [], plans = []) {
  // Правила подпапок: по умолчанию теги по именам папок, их видно и можно поправить.
  const rules = new Map();
  plans.forEach((p) => (p.dirs || []).forEach((d) => rules.set(d.path, { ...d, custom: false })));
  // Папки и файлы — элементы одного списка: тегами снабжаются и те и другие.
  // Для файла теги попадают прямо в запись, для папки становятся её правилом.
  const items = [
    ...dirs.map((p) => ({ path: p, name: p, dir: true, tags: [] })),
    ...paths.map((p) => ({ path: p, name: p.split('\\').pop().split('/').pop(), dir: false, tags: [] }))
  ];
  const nFiles = paths.length;
  let mode = 'all', common = new Set(), pool = [...TAGS];
  const head = dirs.length && nFiles ? `Папок: ${dirs.length} · файлов: ${nFiles}`
    : dirs.length ? `Новые папки: ${dirs.length}` : `Новые файлы: ${nFiles}`;
  const line = (it) => `<div class="fileline"><b>${esc(it.name)}</b>${it.dir ? '<i>папка</i>' : ''}</div>`;

  const draw = () => {
    sheet(`<h2>${esc(head)}</h2>
      ${dirs.length ? `<div class="note">Папка просматривается целиком, включая вложенные. Теги получат все найденные документы — и сейчас, и те, что появятся в папке потом.</div>
        ${plans.map((p) => `<div class="field"><span>${esc(p.root)} · ${plural(p.total, 'документ', 'документа', 'документов')} в ${plural(p.folders, 'папке', 'папках', 'папках')}</span>
          ${p.truncated ? `<div class="note bad">Подпапок больше ${p.dirs.length}, показаны первые. Остальные получат теги по именам папок.</div>` : ''}
          <div class="plan">${p.dirs.map((d) => {
            const r = rules.get(d.path) || d;
            return `<div class="planrow"><div class="t"><b>${esc(d.rel === '.' ? 'корень папки' : d.rel)}</b><span>${d.count}</span></div>
              <div class="tagcloud">${(r.tags || []).map((t) => `<span class="chip t">${esc(t)}</span>`).join('') || '<span class="hint" style="margin:0">без тегов</span>'}</div>
              <button class="edit" type="button" data-rule="${esc(d.path)}">Изменить теги этой папки</button></div>`;
          }).join('')}</div></div>`).join('')}
        <button class="act primary" id="godefault" style="width:100%">Перенести по умолчанию</button>
        <p class="hint" id="defhint" style="margin:0" title="Файлы получат теги по именам папок, в которых лежат">Файлы получат теги по именам папок, в которых лежат.</p>` : ''}
      <div class="seg" id="mode" role="group" aria-label="Как раздавать теги">
        <button data-m="all" aria-pressed="${mode === 'all'}">Одни теги на всех</button>
        <button data-m="each" aria-pressed="${mode === 'each'}">Каждому свои</button></div>
      ${mode === 'all' ? `
        <div class="field"><span>Эти теги получат все ${dirs.length && nFiles ? 'папки и файлы' : dirs.length ? 'папки' : 'файлы'}</span>
          <div id="common"></div></div>
        <div class="filelist">${items.map(line).join('')}</div>`
      : `<div style="display:flex;flex-direction:column;gap:9px">${items.map((it, i) => `
          <div class="impfile"><div class="t"><b>${esc(it.name)}</b>${it.dir ? '<span>папка</span>' : ''}</div>
            <div class="tagcloud" data-i="${i}">${byFreq(pool).slice(0, 30).map((t) => `<button class="tag" data-t="${esc(t)}" aria-pressed="${it.tags.includes(t)}">${esc(t)}</button>`).join('') || '<span class="hint" style="margin:0">Тегов пока нет.</span>'}</div></div>`).join('')}</div>`}
      ${newTagField('Октябрь')}
      <div class="note">Документы остаются там, где лежат: картотека запоминает путь к оригиналу и читает дату, размер и текст.</div>
      <div style="display:flex;gap:8px"><button class="act primary" id="go" style="flex:1">Добавить в картотеку</button><button class="act" data-close="1">Отмена</button></div>`);

    $('sheet').querySelectorAll('button[data-rule]').forEach((b) => b.onclick = () => {
      const r = rules.get(b.dataset.rule);
      if (r) ruleEditor(r, () => draw());
    });
    if ($('godefault')) $('godefault').onclick = () => go(true);
    $('mode').onclick = (e) => {
      const b = e.target.closest('button[data-m]'); if (!b) return;
      mode = b.dataset.m;
      if (mode === 'each') items.forEach((it) => common.forEach((t) => { if (!it.tags.includes(t)) it.tags.push(t); }));
      draw();
    };
    let picker = null;
    if (mode === 'all' && $('common')) picker = tagPicker($('common'), pool, common,
      (t) => { common.has(t) ? common.delete(t) : common.add(t); },
      { empty: 'Тегов пока нет — создайте первый ниже.' });
    if (mode === 'each') $('sheet').querySelectorAll('.tagcloud[data-i]').forEach((box) => box.onclick = (e) => {
      const b = e.target.closest('.tag'); if (!b) return;
      const it = items[+box.dataset.i], t = b.dataset.t;
      it.tags = it.tags.includes(t) ? it.tags.filter((x) => x !== t) : it.tags.concat(t);
      b.setAttribute('aria-pressed', String(it.tags.includes(t)));
    });
    wireNewTag((v) => {
      if (!pool.includes(v)) pool.push(v);
      if (picker) picker.add(v); else draw();   // в режиме «каждому свои» облака рисуются заново
    });

    const go = async (byDefault) => {
      const map = {};
      items.forEach((it) => { map[it.path] = byDefault ? [] : (mode === 'all' ? [...common] : [...new Set(it.tags)]); });
      // в главный процесс уходят только поправленные вручную подпапки: остальное считается там же
      const custom = byDefault ? [] : [...rules.values()].filter((r) => r.custom).map((r) => ({ path: r.path, tags: r.tags }));
      closeSheet();
      busy(dirs.length ? 'Просматриваем папки…' : 'Читаем файлы…', 5, dirs.length ? stopScan : null);
      const res = await call(window.api.catalog.addPaths(items.map((it) => it.path), map, { rules: custom }), 'Добавление');
      busy(false);
      if (!res) return;
      await reload();
      const s = res.scan;
      report('Добавление в картотеку', res.rows, s
        ? `<div class="note ${s.cancelled ? 'bad' : 'ok'}">${s.cancelled ? 'Просмотр остановлен. ' : ''}В папках найдено файлов: ${s.total} · новых: ${s.added} · обновлено: ${s.updated}${s.failed ? ' · не прочитано: ' + s.failed : ''}</div>`
        : '');
    };
    $('go').onclick = () => go(false);
  };
  draw();
}

// Правка тегов одной подпапки. По умолчанию здесь имена папок пути;
// что видно в списке, то и получат документы этой папки.
function ruleEditor(rule, back) {
  const picked = new Set(rule.tags || []);
  const pool = [...new Set([...TAGS, ...(rule.tags || [])])];
  sheet(`<h2>Теги папки</h2>
    <div class="kv"><span>Папка</span><b>${esc(rule.rel === '.' ? rule.path : rule.rel)}</b></div>
    <div class="kv"><span>Документов в ней</span><b>${rule.count}</b></div>
    <div class="field"><span>Эти теги получат документы этой папки</span><div id="re"></div></div>
    ${newTagField('Ромашка')}
    <div class="note">По умолчанию здесь имена папок пути. Вложенные папки этой папки правятся отдельно.</div>
    <div style="display:flex;gap:8px"><button class="act primary" id="ok" style="flex:1">Сохранить</button><button class="act" id="back">Назад</button></div>`);
  const picker = tagPicker($('re'), pool, picked, (t) => { picked.has(t) ? picked.delete(t) : picked.add(t); });
  wireNewTag((v) => picker.add(v));
  $('back').onclick = back;
  $('ok').onclick = () => { rule.tags = [...picked]; rule.custom = true; back(); };
}

/* ——— отмена и возврат ——— */
// История живёт в главном процессе: там же, где данные, которые она откатывает.
async function syncHistory() {
  const h = await call(window.api.history.state());
  const set = (btn, e, verb) => {
    const b = $(btn);
    b.disabled = !e || !e.can;
    b.title = !e ? (verb === 'Отменить' ? 'Отменять нечего' : 'Возвращать нечего')
      : e.can ? `${verb}: ${e.label}`
      : `${e.label} — ${e.why || 'это действие отменить нельзя'}`;
  };
  if (h) { set('btnUndo', h.undo, 'Отменить'); set('btnRedo', h.redo, 'Вернуть'); }
}

async function step(dir) {
  const btn = $(dir === 'undo' ? 'btnUndo' : 'btnRedo');
  if (btn.disabled) { if (btn.title) toast(btn.title); return; }
  const res = await call(dir === 'undo' ? window.api.history.undo() : window.api.history.redo(),
    dir === 'undo' ? 'Отмена' : 'Возврат');
  if (!res) return syncHistory();
  await reload();
  // Операции с диском возвращают построчный отчёт: если что-то не вернулось, это видно.
  const rows = Array.isArray(res.result) ? res.result : null;
  const bad = rows ? rows.filter((r) => r.status === 'err') : [];
  if (bad.length) report(dir === 'undo' ? 'Отменено частично' : 'Возвращено частично', rows);
  else toast((dir === 'undo' ? 'Отменено: ' : 'Возвращено: ') + res.label);
}
$('btnUndo').onclick = () => step('undo');
$('btnRedo').onclick = () => step('redo');

/* ——— клавиатура ——— */
// Текущая строка — то, на чём стоит фокус списка. Выделение это отдельная вещь:
// по строкам можно ходить, ничего не отмечая.
function setCursor(id, scroll) {
  st.cursor = id;
  $('view').querySelectorAll('.row').forEach((r) => {
    const on = +r.dataset.id === id;
    r.classList.toggle('cursor', on);
    if (on && scroll) r.scrollIntoView({ block: 'nearest' });
  });
}
function moveCursor(delta, extend) {
  if (!ORDER.length) return;
  let i = ORDER.indexOf(st.cursor);
  i = i < 0 ? (delta > 0 ? 0 : ORDER.length - 1) : Math.max(0, Math.min(ORDER.length - 1, i + delta));
  const id = ORDER[i];
  if (extend) { st.sel.add(id); if (st.anchor == null) st.anchor = id; paintSel(); }
  setCursor(id, true);
}
const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

document.addEventListener('keydown', (e) => {
  const inField = typing(document.activeElement);
  const inSheet = !$('drawer').hidden;

  if (e.key === 'Escape') {
    if (inSheet) return closeSheet();
    if (!$('menu').hidden) return hideMenu();
    if (st.sel.size) { st.sel.clear(); render(); }
    return;
  }
  if (e.ctrlKey && (e.key === 'f' || e.key === 'а' || e.key === 'F')) { e.preventDefault(); $('q').focus(); $('q').select(); return; }
  if (e.ctrlKey && !e.shiftKey && (e.key === 'z' || e.key === 'я')) { e.preventDefault(); return void step('undo'); }
  if (e.ctrlKey && ((e.key === 'y' || e.key === 'н') || (e.shiftKey && (e.key === 'Z' || e.key === 'Я')))) { e.preventDefault(); return void step('redo'); }

  if (inField || inSheet) return;   // в полях ввода и при открытой панели список клавиши не слушает

  if (e.ctrlKey && (e.key === 'a' || e.key === 'ф')) {
    e.preventDefault();
    visibleRes().forEach((x) => st.sel.add(x.d.id));
    paintSel();
    return;
  }
  if (e.key === 'ArrowDown') { e.preventDefault(); return moveCursor(1, e.shiftKey); }
  if (e.key === 'ArrowUp') { e.preventDefault(); return moveCursor(-1, e.shiftKey); }
  if (e.key === 'Home' && ORDER.length) { e.preventDefault(); return setCursor(ORDER[0], true); }
  if (e.key === 'End' && ORDER.length) { e.preventDefault(); return setCursor(ORDER[ORDER.length - 1], true); }
  if (st.cursor == null) return;

  if (e.key === ' ') {
    e.preventDefault();
    st.sel.has(st.cursor) ? st.sel.delete(st.cursor) : st.sel.add(st.cursor);
    st.anchor = st.cursor;
    paintSel();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const d = DOCS.find((x) => x.id === st.cursor);
    if (!d) return;
    if (e.ctrlKey) return openCard(d);
    return void call(window.api.file.open(d.id), 'Открытие');
  }
  if (e.key === 'Delete') {
    e.preventDefault();
    if (!st.sel.size) { st.sel.add(st.cursor); paintSel(); }
    deletePanel();
  }
});

/* ——— запуск ——— */
// Настройки и каталог всегда читаются вместе: список папок мог измениться
// в главном процессе — при добавлении папки, перетаскивании или отмене действия.
async function reload(first) {
  const s = await call(window.api.settings.get(), 'Настройки');
  if (s) {
    SETTINGS = s;
    if (first) { markTheme(s.theme.source); applyTheme(s.theme.resolved); }
  }
  const docs = await call(window.api.catalog.list(), 'Каталог');
  if (docs || first) {
    DOCS = docs || [];
    recalc(!!first);
    render();
  }
  if (DEEP.q) { DEEP.q = null; scheduleDeep(); }
  syncHistory();
}
(async function boot() {
  markSort();
  await reload(true);
  call(window.api.info()).then((i) => { if (i && i.version) $('ver').textContent = i.version; });
  window.api.ready();
  if (SETTINGS.roots.length) setTimeout(() => scan(true), 400);
})();
