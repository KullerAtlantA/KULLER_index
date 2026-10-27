'use strict';
// История действий: отмена и возврат.
//
// Запись хранит не «что произошло», а две готовые функции — как откатить и как повторить.
// Это дешевле снимков всей картотеки и не держит в памяти лишнего.
//
// История живёт только пока открыто приложение. Хранить её между запусками значило бы
// обещать отмену действия недельной давности, когда файлов на тех местах уже нет.
const MAX = 20;

const done = [];     // выполненное, последнее — в конце
const undone = [];   // отменённое, ждёт возврата

// label — что увидит человек в подсказке у стрелки.
// undo/redo — функции; их отсутствие означает, что шаг отменить нельзя (например, Корзина).
function push(entry) {
  done.push(entry);
  if (done.length > MAX) done.shift();
  undone.length = 0;   // новая ветка действий: возвращать больше нечего
  return entry;
}

const last = (arr) => (arr.length ? arr[arr.length - 1] : null);

function state() {
  const u = last(done), r = last(undone);
  return {
    undo: u ? { label: u.label, can: typeof u.undo === 'function', why: u.why || '' } : null,
    redo: r ? { label: r.label, can: typeof r.redo === 'function', why: r.why || '' } : null
  };
}

async function undo() {
  const e = last(done);
  if (!e) throw new Error('отменять нечего');
  if (typeof e.undo !== 'function') throw new Error(e.why || 'это действие отменить нельзя');
  const result = await e.undo();
  done.pop();
  undone.push(e);
  return { label: e.label, result: result || null };
}

async function redo() {
  const e = last(undone);
  if (!e) throw new Error('возвращать нечего');
  if (typeof e.redo !== 'function') throw new Error(e.why || 'это действие вернуть нельзя');
  const result = await e.redo();
  undone.pop();
  done.push(e);
  return { label: e.label, result: result || null };
}

function clear() { done.length = 0; undone.length = 0; }

module.exports = { push, undo, redo, state, clear, MAX };
