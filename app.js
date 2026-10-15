import { createGame, selectCell, recordCell, confirmShape, clearConfirmed, undo, redo, getStats } from './state.js';
import { parseCounts, shouldAcceptAnalysis, serializeSession, restoreSession, shouldConfirmReset, unconfirmedHitIndexes } from './app-logic.js';
import { rectangleIndexes, shapeFromCorners } from './shape-selection.js';

const KEY = 'treasure-navigator-v1';
const $ = id => document.getElementById(id);
const TYPES = ['1x2', '1x3', '2x2', '3x3'];
const COUNT_IDS = TYPES.map(type => `shape-count-${type}`);
const alphabet = 'ABCDEFGH';
let game = null;
let analysis = null;
let requestId = 0;
let worker = null;
let toastTimer = 0;
let drawMode = false;
let drag = null;
let suppressCellClickUntil = 0;

function coordinate(index) { return `${alphabet[index % 8]}${Math.floor(index / 8) + 1}`; }

function notify(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3500);
}

function occupiedIndexes(shape) {
  let [height, width] = shape.type.split('x').map(Number);
  if (shape.rotated) [height, width] = [width, height];
  const indexes = [];
  for (let row = shape.row; row < shape.row + height; row++)
    for (let col = shape.col; col < shape.col + width; col++) indexes.push(row * 8 + col);
  return indexes;
}

function paintDragPreview() {
  const indexes = drag ? rectangleIndexes(drag.start, drag.end) : [];
  const selected = new Set(indexes);
  const shape = drag ? shapeFromCorners(drag.start, drag.end) : null;
  const valid = shape && indexes.some(index => game?.cells[index] === 'hit')
    && indexes.every(index => game?.cells[index] !== 'empty');
  for (const cell of $('board').querySelectorAll('.board-cell')) {
    const active = selected.has(Number(cell.dataset.index));
    cell.classList.toggle('is-preview', active && !!valid);
    cell.classList.toggle('is-preview-invalid', active && !valid);
  }
}

function setDrawMode(active) {
  drawMode = active;
  drag = null;
  $('board').classList.toggle('is-draw-mode', active);
  $('draw-shape-button').setAttribute('aria-pressed', String(active));
  $('draw-shape-button').textContent = active ? '取消框選' : '框選寶箱範圍';
  $('draw-shape-hint').textContent = active
    ? '從寶箱一角拖到對角；也可按 Esc 改用手動輸入。'
    : '命中後請框出完整寶箱範圍，再取得下一格建議。';
  paintDragPreview();
}

function cellAtPoint(event) {
  const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest('.board-cell');
  return cell && $('board').contains(cell) ? Number(cell.dataset.index) : null;
}

function setupBoardDrawing() {
  const board = $('board');
  $('draw-shape-button').addEventListener('click', () => setDrawMode(!drawMode));
  board.addEventListener('pointerdown', event => {
    if (!drawMode || !game || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const cell = event.target.closest('.board-cell');
    if (!cell || !board.contains(cell)) return;
    const start = Number(cell.dataset.index);
    drag = { pointerId: event.pointerId, start, end: start };
    board.setPointerCapture(event.pointerId);
    event.preventDefault();
    paintDragPreview();
  });
  board.addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const index = cellAtPoint(event);
    if (index === null || index === drag.end) return;
    drag.end = index;
    paintDragPreview();
  });
  board.addEventListener('pointerup', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const start = drag.start;
    const end = cellAtPoint(event);
    drag = null;
    if (board.hasPointerCapture(event.pointerId)) board.releasePointerCapture(event.pointerId);
    paintDragPreview();
    if (end === null) return notify('請在棋盤內放開，或按 Esc 取消框選');
    const shape = shapeFromCorners(start, end);
    if (!shape) return notify('範圍須為 1×2、1×3、2×2 或 3×3');
    if (!rectangleIndexes(start, end).some(index => game.cells[index] === 'hit'))
      return notify('框選範圍需包含已記錄的命中格');
    try {
      game = confirmShape(game, shape);
      suppressCellClickUntil = Date.now() + 300;
      setDrawMode(false);
      persist();
      calculate();
      notify('已確認寶箱範圍；範圍內格子已視為挖完');
    } catch {
      notify('無法確認範圍：請檢查空格、重疊或寶箱數量');
    }
  });
  const cancelDrag = event => {
    if (drag?.pointerId !== event.pointerId) return;
    drag = null;
    paintDragPreview();
  };
  board.addEventListener('pointercancel', cancelDrag);
  board.addEventListener('lostpointercapture', cancelDrag);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drawMode) setDrawMode(false);
  });
}

function renderBoard() {
  const board = $('board');
  const known = new Set(game?.shapes.flatMap(occupiedIndexes) ?? []);
  const selected = game?.selected;
  const recommended = analysis?.status === 'ok' ? analysis.recommendation?.index : null;
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < 64; index++) {
    const value = game?.cells[index] ?? 'unknown';
    const assumedDug = known.has(index) && value === 'unknown';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'board-cell';
    button.dataset.index = String(index);
    if (value === 'hit' || assumedDug) button.classList.add('is-hit');
    else if (value === 'empty') button.classList.add('is-empty');
    else if (index === recommended) button.classList.add('is-recommended');
    if (known.has(index)) button.classList.add('is-known');
    if (index === selected) button.classList.add('is-selected');
    button.setAttribute('role', 'gridcell');
    button.setAttribute('aria-selected', String(index === selected));
    const names = { unknown: '未挖', hit: '命中', empty: '空格' };
    button.setAttribute('aria-label', `${coordinate(index)}，${assumedDug ? '已視為挖完' : names[value]}${known.has(index) ? '，已確認寶箱範圍' : ''}${index === recommended ? '，建議挖掘' : ''}`);
    button.textContent = value === 'hit' || assumedDug ? '◆' : value === 'empty' ? '×' : index === recommended ? '✦' : '·';
    button.addEventListener('click', () => {
      if (drawMode || Date.now() < suppressCellClickUntil) return;
      if (!game) return notify('請先設定寶箱數量');
      game = selectCell(game, index);
      persist();
      render();
    });
    fragment.append(button);
  }
  board.replaceChildren(fragment);
  paintDragPreview();
}

function render() {
  if (drawMode && !game?.cells.includes('hit')) setDrawMode(false);
  const pendingHits = unconfirmedHitIndexes(game);
  renderBoard();
  $('draw-shape-button').disabled = !game?.cells.includes('hit');
  $('board-hint').textContent = pendingHits.length ? '先框出命中的寶箱' : '先選格，再記錄結果';
  $('selected-coordinate').textContent = game?.selected == null ? '尚未選取' : coordinate(game.selected);
  const selectedConfirmed = game?.selected != null && game.shapes.some(shape => occupiedIndexes(shape).includes(game.selected));
  $('record-empty').disabled = $('record-hit').disabled = game?.selected == null || selectedConfirmed;
  $('undo-button').disabled = !game?.past.length;
  $('redo-button').disabled = !game?.future.length;
  const stats = game ? getStats(game) : { dug: 0, hits: 0, empties: 0, confirmed: 0, complete: false };
  $('stats-dug').textContent = String(stats.dug);
  $('stats-hit').textContent = String(stats.hits);
  $('stats-empty').textContent = String(stats.empties);
  $('stats-confirmed').textContent = String(stats.confirmed);
  const output = $('recommendation');
  const detail = $('analysis-status');
  if (!game) {
    output.textContent = '設定寶箱數量後開始';
    detail.textContent = '依目前紀錄估算；實際結果仍以遊戲為準。';
  } else if (pendingHits.length) {
    output.textContent = '請先框出寶箱範圍';
    detail.textContent = `尚有 ${pendingHits.length} 個命中格未納入已確認範圍。拖曳框選後才會推薦下一格。`;
  } else if (stats.complete) {
    output.textContent = '所有寶箱格都已挖出';
    detail.textContent = `本局共挖 ${stats.dug} 格，其中空格 ${stats.empties} 格。`;
  } else if (!analysis) {
    output.textContent = '正在分析棋盤…';
    detail.textContent = '新紀錄已保存；正在計算下一格。';
  } else if (analysis.status !== 'ok') {
    output.textContent = analysis.status === 'contradiction' ? '紀錄可能矛盾' : '暫時無法給出建議';
    detail.textContent = analysis.reason;
  } else if (analysis.recommendation) {
    const { index, kind } = analysis.recommendation;
    output.textContent = `${coordinate(index)} · ${kind === 'finish' ? '補完寶箱' : '搜尋寶箱'}`;
    const chance = analysis.probabilities[index];
    detail.textContent = `${analysis.method === 'exact' ? '完整枚舉' : '有限盤面估算'} · 候選命中比例 ${Math.round(chance * 100)}% · ${analysis.reason}`;
  } else {
    output.textContent = '目前沒有可推薦的格子';
    detail.textContent = analysis.reason;
  }
}

function persist() {
  if (!game) return;
  try { localStorage.setItem(KEY, serializeSession(game)); }
  catch { notify('此瀏覽器無法儲存進度，重新整理後可能遺失'); }
}

function calculate() {
  if (!game) { analysis = null; render(); return; }
  analysis = null;
  requestId++;
  if (unconfirmedHitIndexes(game).length) {
    if (!drawMode) setDrawMode(true);
    render();
    return;
  }
  if (drawMode) setDrawMode(false);
  render();
  if (!worker) {
    $('analysis-status').textContent = '此瀏覽器無法啟動計算引擎。';
    return;
  }
  worker.postMessage({ id: requestId, input: { counts: game.counts, cells: game.cells, confirmed: game.shapes } });
}

function mutate(action) {
  if (!game) return notify('請先設定寶箱數量');
  try { game = action(game); persist(); calculate(); }
  catch (error) { notify(error.message || '操作失敗'); }
}

function setupAnchorOptions() {
  const select = $('shape-anchor');
  for (let index = 0; index < 64; index++) {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = coordinate(index);
    select.append(option);
  }
}

function setup() {
  setupAnchorOptions();
  setupBoardDrawing();
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) game = restoreSession(saved);
  } catch { notify('舊進度無法載入，請開始新局'); }
  if (game) COUNT_IDS.forEach((id, i) => { $(id).value = game.counts[TYPES[i]]; });

  try {
    worker = new Worker('./worker.js', { type: 'module' });
    worker.onmessage = event => {
      if (!shouldAcceptAnalysis(event.data.id, requestId)) return;
      if (event.data.error) { analysis = null; $('analysis-status').textContent = `分析失敗：${event.data.error}`; return; }
      analysis = event.data.result;
      render();
    };
    worker.onerror = () => { $('analysis-status').textContent = '分析引擎發生錯誤，請重新載入'; };
  } catch { worker = null; }

  $('apply-settings').addEventListener('click', () => {
    try {
      const counts = parseCounts(COUNT_IDS.map(id => $(id).value));
      if (shouldConfirmReset(game) && !window.confirm('套用新設定會清除目前這局進度，確定要繼續嗎？')) return;
      game = createGame(counts);
      setDrawMode(false);
      persist();
      calculate();
      notify('新局已開始，進度會自動保存');
      $('settings-panel').open = false;
    } catch (error) { notify(error.message || '設定無效'); }
  });
  $('record-empty').addEventListener('click', () => mutate(s => recordCell(s, s.selected, 'empty')));
  $('record-hit').addEventListener('click', () => mutate(s => recordCell(s, s.selected, 'hit')));
  $('undo-button').addEventListener('click', () => mutate(undo));
  $('redo-button').addEventListener('click', () => mutate(redo));
  $('confirm-shape').addEventListener('click', () => {
    const value = $('shape-select').value;
    const anchor = $('shape-anchor').value;
    if (anchor === '') return notify('請先選擇寶箱左上角');
    const rotated = value === '2x1' || value === '3x1';
    const type = value === '2x1' ? '1x2' : value === '3x1' ? '1x3' : value;
    const index = Number(anchor);
    mutate(s => confirmShape(s, { type, row: Math.floor(index / 8), col: index % 8, rotated }));
  });
  $('clear-shape').addEventListener('click', () => mutate(clearConfirmed));
  $('compact-toggle').addEventListener('click', () => {
    const pressed = $('compact-toggle').getAttribute('aria-pressed') !== 'true';
    $('compact-toggle').setAttribute('aria-pressed', String(pressed));
    document.querySelector('.app-shell').classList.toggle('is-compact', pressed);
  });
  $('new-game-button').addEventListener('click', () => {
    if (shouldConfirmReset(game) && !window.confirm('開始新局會清除目前這局進度，確定要繼續嗎？')) return;
    game = null;
    setDrawMode(false);
    analysis = null;
    requestId++;
    try { localStorage.removeItem(KEY); } catch {}
    COUNT_IDS.forEach(id => { $(id).value = '0'; });
    $('settings-panel').open = true;
    render();
    notify('已清除本機這局進度');
  });
  calculate();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

setup();
