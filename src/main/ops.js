'use strict';
// Операции над оригиналами: печать, Корзина, перемещение, ZIP, письмо.
// Каждая возвращает построчный отчёт: ok / skip / err с причиной.
// Ни одна операция не сообщает об успехе, пока результат не проверен на диске.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { shell } = require('electron');
const { execFile } = require('child_process');
const store = require('./store');
const catalog = require('./catalog');

const isWin = process.platform === 'win32';
const full = catalog.fullPath;

function ps(script, timeout = 120000) {
  return new Promise((resolve, reject) => {
    if (!isWin) return reject(new Error('операция доступна только в Windows'));
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message || '').trim().split('\n')[0] || 'сбой PowerShell'));
        resolve(String(stdout || '').trim());
      });
  });
}

// Литерал PowerShell в одинарных кавычках: подстановки и команды внутри не выполняются,
// поэтому имя файла не может превратиться в команду. Удваивается только сама кавычка.
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const psList = (arr) => '@(' + arr.map(q).join(',') + ')';

async function checkFile(d) {
  const file = full(d);
  try { await fsp.access(file, fs.constants.R_OK); } catch (e) {
    return { ok: false, message: e.code === 'ENOENT' ? 'файл не найден на диске' : 'нет доступа к файлу' };
  }
  return { ok: true, file };
}

async function openFile(doc) {
  const c = await checkFile(doc);
  if (!c.ok) throw new Error(c.message);
  const err = await shell.openPath(c.file);
  if (err) throw new Error(err);
  return true;
}

function revealFile(doc) {
  shell.showItemInFolder(full(doc));
  return true;
}

// Печать. Раньше на каждый файл и каждую копию запускался отдельный PowerShell,
// задания уходили в очередь вперемешку. Теперь один запуск на всю пачку,
// внутри — строгая последовательность с паузой: программа успевает открыть файл и отдать задание.
async function printDocs(docs, { printer, copies = 1 } = {}) {
  const rows = [];
  const queue = [];
  for (const d of docs) {
    const c = await checkFile(d);
    if (!c.ok) rows.push({ name: d.name, status: 'err', message: c.message });
    else queue.push({ doc: d, file: c.file });
  }
  if (!queue.length) return rows;

  const n = Math.max(1, Math.min(20, parseInt(copies, 10) || 1));
  const verb = printer ? `-Verb PrintTo -ArgumentList ${q(printer)}` : '-Verb Print';
  const script = [
    `$files = ${psList(queue.map((x) => x.file))}`,
    'foreach ($f in $files) {',
    '  try {',
    `    for ($i = 0; $i -lt ${n}; $i++) {`,
    `      Start-Process -FilePath $f ${verb} | Out-Null`,
    '      Start-Sleep -Milliseconds 1500',
    '    }',
    '    Write-Output ("OK`t" + $f)',
    '  } catch { Write-Output ("ERR`t" + $f + "`t" + $_.Exception.Message) }',
    '}'
  ].join('\n');

  let out = '';
  try {
    out = await ps(script, 60000 + queue.length * n * 20000);
  } catch (e) {
    queue.forEach((x) => rows.push({ name: x.doc.name, status: 'err', message: e.message }));
    return rows;
  }

  const byFile = new Map();
  out.split(/\r?\n/).forEach((line) => {
    const [tag, file, msg] = line.split('\t');
    if (file) byFile.set(file.toLowerCase(), { tag, msg });
  });
  for (const x of queue) {
    const r = byFile.get(x.file.toLowerCase());
    if (!r || r.tag === 'ERR') rows.push({ name: x.doc.name, status: 'err', message: (r && r.msg) || 'задание не создано' });
    else rows.push({
      name: x.doc.name, status: 'ok',
      message: (n > 1 ? n + ' копии · ' : '') + 'передан в очередь ' + (printer ? printer : 'принтера по умолчанию')
    });
  }
  return rows;
}

async function listPrinters() {
  try {
    const out = await ps('Get-Printer | Select-Object -ExpandProperty Name', 20000);
    return out ? out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  } catch (e) { return []; }
}

// Удаление оригиналов: только в Корзину, никогда безвозвратно.
// Если один физический файл записан в картотеке дважды, в Корзину он уходит один раз,
// но обе записи получают честный результат.
async function trashDocs(docs) {
  const rows = [];
  const done = new Map();
  for (const d of docs) {
    const file = full(d);
    const k = path.normalize(file).toLowerCase();
    if (done.has(k)) { rows.push({ id: d.id, name: d.name, ...done.get(k) }); continue; }
    let res;
    if (!fs.existsSync(file)) res = { status: 'err', message: 'файл не найден на диске' };
    else {
      try { await shell.trashItem(file); res = { status: 'ok', message: 'перемещён в Корзину' }; }
      catch (e) { res = { status: 'err', message: e.message || 'не удалось удалить' }; }
    }
    done.set(k, res);
    rows.push({ id: d.id, name: d.name, ...res });
  }
  return rows;
}

// Перемещение. Между дисками переименование невозможно, поэтому копия с проверкой размера
// и только затем удаление оригинала: при сбое копирования исходный файл остаётся на месте.
async function moveDocs(docs, dest) {
  const rows = [];
  let st;
  try { st = await fsp.stat(dest); } catch (e) { throw new Error('папка назначения не найдена: ' + dest); }
  if (!st.isDirectory()) throw new Error('это не папка: ' + dest);
  try { await fsp.access(dest, fs.constants.W_OK); } catch (e) { throw new Error('нет прав на запись в папку назначения'); }

  for (const d of docs) {
    const c = await checkFile(d);
    if (!c.ok) { rows.push({ id: d.id, name: d.name, status: 'err', message: c.message }); continue; }
    if (path.normalize(d.dir).toLowerCase() === path.normalize(dest).toLowerCase()) {
      rows.push({ id: d.id, name: d.name, status: 'skip', message: 'уже в этой папке' });
      continue;
    }
    const target = path.join(dest, d.name);
    if (fs.existsSync(target)) {
      rows.push({ id: d.id, name: d.name, status: 'err', message: 'в папке уже есть файл с таким именем' });
      continue;
    }
    try {
      try {
        await fsp.rename(c.file, target);
      } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        const srcSize = (await fsp.stat(c.file)).size;
        await fsp.copyFile(c.file, target, fs.constants.COPYFILE_EXCL);
        const copied = (await fsp.stat(target)).size;
        if (copied !== srcSize) {
          try { await fsp.unlink(target); } catch (e2) {}
          throw new Error('копия неполная, оригинал не удалён');
        }
        await fsp.unlink(c.file);
      }
      d.dir = dest;   // путь в картотеке обновляется только после удачного перемещения
      rows.push({ id: d.id, name: d.name, status: 'ok', message: 'перемещён в ' + dest });
    } catch (e) {
      rows.push({ id: d.id, name: d.name, status: 'err', message: e.message });
    }
  }
  store.saveCatalog();
  return rows;
}

async function renameDoc(doc, newName) {
  const c = await checkFile(doc);
  if (!c.ok) throw new Error(c.message);
  if (!newName || /[\\/:*?"<>|]/.test(newName)) throw new Error('недопустимое имя файла');
  const target = path.join(doc.dir, newName);
  if (fs.existsSync(target)) throw new Error('в этой папке уже есть файл с таким именем');
  await fsp.rename(c.file, target);
  doc.name = newName;
  store.saveCatalog();
  return true;
}

// ZIP: файлы пишутся в архив потоком средствами .NET, который входит в Windows.
// Временная копия всего набора больше не делается — раньше объём записи на диск удваивался.
// Ошибка одного файла не отменяет архив, но и не выдаётся за успех.
async function makeZip(docs, dir, name) {
  if (!name.toLowerCase().endsWith('.zip')) name += '.zip';
  if (/[\\/:*?"<>|]/.test(name)) throw new Error('недопустимое имя архива');
  if (!fs.existsSync(dir)) throw new Error('папка сохранения не найдена');
  const target = path.join(dir, name);
  if (fs.existsSync(target)) throw new Error('архив с таким именем уже есть в этой папке');

  const rows = [];
  const entries = [];
  const used = new Map();
  for (const d of docs) {
    const c = await checkFile(d);
    if (!c.ok) { rows.push({ name: d.name, status: 'err', message: c.message }); continue; }
    const seen = (used.get(d.name.toLowerCase()) || 0) + 1;
    used.set(d.name.toLowerCase(), seen);
    let inner = d.name;
    if (seen > 1) {
      const i = d.name.lastIndexOf('.');
      inner = i > 0 ? `${d.name.slice(0, i)} (${seen})${d.name.slice(i)}` : `${d.name} (${seen})`;
    }
    entries.push({ doc: d, file: c.file, inner });
  }
  if (!entries.length) throw new Error('ни один файл не удалось прочитать, архив не создан');

  const script = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$src = ${psList(entries.map((e) => e.file))}`,
    `$names = ${psList(entries.map((e) => e.inner))}`,
    `$zip = [System.IO.Compression.ZipFile]::Open(${q(target)}, 'Create')`,
    'try {',
    '  for ($i = 0; $i -lt $src.Length; $i++) {',
    '    try {',
    "      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $src[$i], $names[$i], 'Optimal') | Out-Null",
    '      Write-Output ("OK`t" + $src[$i])',
    '    } catch { Write-Output ("ERR`t" + $src[$i] + "`t" + $_.Exception.Message) }',
    '  }',
    '} finally { $zip.Dispose() }'
  ].join('\n');

  let out;
  try {
    out = await ps(script, 1800000);
  } catch (e) {
    try { if (fs.existsSync(target)) await fsp.unlink(target); } catch (e2) {}
    throw new Error('архив не создан: ' + e.message);
  }

  const byFile = new Map();
  out.split(/\r?\n/).forEach((line) => {
    const [tag, file, msg] = line.split('\t');
    if (file) byFile.set(file.toLowerCase(), { tag, msg });
  });
  let ok = 0;
  for (const e of entries) {
    const r = byFile.get(e.file.toLowerCase());
    if (r && r.tag === 'OK') {
      ok++;
      rows.push({ name: e.doc.name, status: 'ok', message: e.inner !== e.doc.name ? 'добавлен как ' + e.inner : 'добавлен в архив' });
    } else {
      rows.push({ name: e.doc.name, status: 'err', message: (r && r.msg) || 'не удалось добавить в архив' });
    }
  }
  if (!ok || !fs.existsSync(target)) {
    try { if (fs.existsSync(target)) await fsp.unlink(target); } catch (e2) {}
    throw new Error('ни один файл не попал в архив, архив не создан');
  }
  store.saveSettings({ lastZipDir: dir });
  return { path: target, name, rows, size: catalog.human((await fsp.stat(target)).size) };
}

// Письмо: сначала Outlook через COM (вложения прикрепляются сами),
// если его нет — почтовый клиент по умолчанию и открытая папка с файлами.
async function sendMail({ to = '', subject = '', body = '', attachments = [] }) {
  const missing = attachments.filter((f) => !fs.existsSync(f));
  if (missing.length) throw new Error('не найдены файлы: ' + missing.map((f) => path.basename(f)).join(', '));
  try {
    const atts = attachments.map((f) => `$m.Attachments.Add(${q(f)}) | Out-Null`).join('; ');
    await ps([
      '$o = New-Object -ComObject Outlook.Application',
      '$m = $o.CreateItem(0)',
      `$m.To = ${q(to)}`,
      `$m.Subject = ${q(subject)}`,
      `$m.Body = ${q(body)}`,
      atts,
      '$m.Display()'
    ].filter(Boolean).join('; '), 60000);
    return { via: 'outlook', message: 'письмо открыто в Outlook с вложениями — отправьте его сами' };
  } catch (e) {
    const url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    await shell.openExternal(url);
    if (attachments[0]) shell.showItemInFolder(attachments[0]);
    return { via: 'mailto', message: 'Outlook не найден: открыт почтовый клиент, вложения показаны в проводнике — прикрепите их вручную' };
  }
}

module.exports = { openFile, revealFile, printDocs, listPrinters, trashDocs, moveDocs, renameDoc, makeZip, sendMail };
