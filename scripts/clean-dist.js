'use strict';
// Очистка папки сборки перед новой сборкой: установщики прошлых версий не копятся,
// и в dist всегда ровно то, что собрано сейчас. Исходники и node_modules не трогаются.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'dist');
let entries;
try { entries = fs.readdirSync(dir); } catch (e) { process.exit(0); }   // папки ещё нет — чистить нечего

let files = 0, bytes = 0;
for (const name of entries) {
  const full = path.join(dir, name);
  try {
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(full, { recursive: true })) {
        try { const s = fs.statSync(path.join(full, f)); if (s.isFile()) { files++; bytes += s.size; } } catch (e) {}
      }
    } else { files++; bytes += st.size; }
    fs.rmSync(full, { recursive: true, force: true });
  } catch (e) {
    console.error('не удалось удалить ' + name + ': ' + e.message + ' — закройте программу, если она запущена');
    process.exit(1);
  }
}
if (files) console.log(`dist очищена: удалено файлов ${files}, освобождено ${(bytes / 1048576).toFixed(1)} МБ`);
