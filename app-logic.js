import { exportGame, importGame } from './state.js';

const TYPES = ['1x2', '1x3', '2x2', '3x3'];
const AREAS = [2, 3, 4, 9];

function validSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('無效歷史紀錄');
  const checked = importGame(JSON.stringify({ version: 1, ...snapshot }));
  return { counts: checked.counts, cells: checked.cells, shapes: checked.shapes, selected: checked.selected };
}

export function serializeSession(game) {
  const current = JSON.parse(exportGame(game));
  return JSON.stringify({ format: 'session-v1', current, past: game.past.slice(-128), future: game.future.slice(-128) });
}

export function restoreSession(json) {
  const data = JSON.parse(json);
  if (data?.version === 1) return importGame(json);
  if (data?.format !== 'session-v1' || !Array.isArray(data.past) || !Array.isArray(data.future) || data.past.length > 128 || data.future.length > 128) {
    throw new Error('無效進度資料');
  }
  const game = importGame(JSON.stringify(data.current));
  return { ...game, past: data.past.map(validSnapshot), future: data.future.map(validSnapshot) };
}

export function shouldConfirmReset(game) {
  return Boolean(game && (game.cells.some(cell => cell !== 'unknown') || game.shapes.length > 0));
}

export function shouldAcceptAnalysis(responseId, currentId) {
  return responseId === currentId;
}

export function unconfirmedHitIndexes(game) {
  if (!game) return [];
  const confirmed = new Set();
  for (const shape of game.shapes) {
    let [height, width] = shape.type.split('x').map(Number);
    if (shape.rotated) [height, width] = [width, height];
    for (let row = shape.row; row < shape.row + height; row++) {
      for (let col = shape.col; col < shape.col + width; col++) confirmed.add(row * 8 + col);
    }
  }
  return game.cells.flatMap((cell, index) => cell === 'hit' && !confirmed.has(index) ? [index] : []);
}

export function parseCounts(values) {
  if (!Array.isArray(values) || values.length !== 4) throw new Error('請填寫四種寶箱數量');
  const counts = {};
  let area = 0;
  values.forEach((value, i) => {
    const text = String(value).trim();
    if (!/^\d+$/.test(text)) throw new Error('數量必須是非負整數');
    const count = Number(text);
    if (!Number.isSafeInteger(count)) throw new Error('數量過大');
    counts[TYPES[i]] = count;
    area += count * AREAS[i];
  });
  if (area === 0) throw new Error('至少需要一個寶箱');
  if (area > 64) throw new Error('寶箱總面積超過棋盤 64 格');
  return counts;
}
