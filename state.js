const TYPES = Object.freeze({ '1x2': [1, 2], '1x3': [1, 3], '2x2': [2, 2], '3x3': [3, 3] });
const VERSION = 1;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactFields(value, names) {
  if (!plainObject(value) || Object.keys(value).sort().join('|') !== [...names].sort().join('|')) {
    throw new Error('Invalid field set');
  }
}

function normalizeCounts(counts) {
  if (!plainObject(counts) || Object.keys(counts).some(key => !(key in TYPES))) throw new Error('Invalid counts');
  const normalized = {};
  for (const type of Object.keys(TYPES)) {
    const count = counts[type] ?? 0;
    if (!Number.isInteger(count) || count < 0) throw new Error(`Invalid count for ${type}`);
    normalized[type] = count;
  }
  const area = Object.entries(normalized).reduce((sum, [type, count]) => sum + count * TYPES[type][0] * TYPES[type][1], 0);
  if (area > 64 || normalized['3x3'] > 4) throw new Error('Treasure capacity exceeded');
  return normalized;
}

function validateIndex(index) {
  if (!Number.isInteger(index) || index < 0 || index >= 64) throw new Error('Invalid cell index');
}

function shapeIndexes(shape) {
  exactFields(shape, ['type', 'row', 'col', 'rotated']);
  if (!(shape.type in TYPES) || !Number.isInteger(shape.row) || !Number.isInteger(shape.col) || typeof shape.rotated !== 'boolean') {
    throw new Error('Invalid confirmed shape');
  }
  const [height, width] = TYPES[shape.type];
  const rows = shape.rotated ? width : height;
  const cols = shape.rotated ? height : width;
  if (shape.row < 0 || shape.col < 0 || shape.row + rows > 8 || shape.col + cols > 8) {
    throw new Error('Confirmed shape out of bounds');
  }
  const indexes = [];
  for (let row = shape.row; row < shape.row + rows; row++) {
    for (let col = shape.col; col < shape.col + cols; col++) indexes.push(row * 8 + col);
  }
  return indexes;
}

function snapshot(state) {
  return { counts: { ...state.counts }, cells: [...state.cells], shapes: state.shapes.map(shape => ({ ...shape })), selected: state.selected };
}

function commit(state, change) {
  return { ...change, past: [...state.past, snapshot(state)], future: [] };
}

function validateCurrent(state) {
  exactFields(state, ['version', 'counts', 'cells', 'shapes', 'selected']);
  if (state.version !== VERSION) throw new Error('Unsupported version');
  const counts = normalizeCounts(state.counts);
  exactFields(state.counts, Object.keys(TYPES));
  if (!Array.isArray(state.cells) || state.cells.length !== 64 || state.cells.some(cell => !['unknown', 'empty', 'hit'].includes(cell))) {
    throw new Error('Invalid cells');
  }
  if (state.selected !== null) validateIndex(state.selected);
  if (!Array.isArray(state.shapes)) throw new Error('Invalid confirmed shapes');
  const occupied = new Set();
  const used = Object.fromEntries(Object.keys(TYPES).map(type => [type, 0]));
  for (const shape of state.shapes) {
    const indexes = shapeIndexes(shape);
    used[shape.type]++;
    if (used[shape.type] > counts[shape.type]) throw new Error('Confirmed count exceeded');
    for (const index of indexes) {
      if (occupied.has(index)) throw new Error('Confirmed shapes overlap');
      if (state.cells[index] === 'empty') throw new Error('Confirmed shape includes empty cell');
      occupied.add(index);
    }
  }
  const totalArea = Object.entries(counts).reduce((sum, [type, count]) => sum + count * TYPES[type][0] * TYPES[type][1], 0);
  const hits = state.cells.filter(cell => cell === 'hit').length;
  const empties = state.cells.filter(cell => cell === 'empty').length;
  if (hits > totalArea || empties > 64 - totalArea) throw new Error('Cell results exceed treasure capacity');
  if (Object.keys(TYPES).every(type => used[type] === counts[type]) && state.cells.some((cell, index) => cell === 'hit' && !occupied.has(index))) {
    throw new Error('Hit outside confirmed treasure');
  }
  return counts;
}

export function createGame(counts) {
  const normalized = normalizeCounts(counts);
  return { version: VERSION, counts: normalized, cells: Array(64).fill('unknown'), shapes: [], selected: null, past: [], future: [] };
}

export function selectCell(state, index) {
  validateIndex(index);
  return { ...state, selected: index };
}

export function recordCell(state, index, result) {
  validateIndex(index);
  if (result !== 'empty' && result !== 'hit') throw new Error('Invalid dig result');
  if (state.cells[index] === result) return state;
  const cells = [...state.cells];
  cells[index] = result;
  const next = { ...snapshot(state), version: VERSION, cells, selected: index };
  validateCurrent(next);
  return commit(state, next);
}

export function confirmShape(state, shape) {
  const shapes = [...state.shapes, { ...shape }];
  const next = { ...snapshot(state), version: VERSION, shapes };
  validateCurrent(next);
  return commit(state, next);
}

export function removeShape(state, index) {
  if (!Number.isInteger(index) || index < 0 || index >= state.shapes.length) throw new Error('Invalid shape index');
  const shapes = state.shapes.filter((_, i) => i !== index);
  return commit(state, { ...snapshot(state), version: VERSION, shapes });
}

export function clearConfirmed(state) {
  if (state.shapes.length === 0) return state;
  return commit(state, { ...snapshot(state), version: VERSION, shapes: [] });
}

export function undo(state) {
  if (state.past.length === 0) return state;
  const previous = state.past.at(-1);
  return { ...snapshot(previous), version: VERSION, past: state.past.slice(0, -1), future: [...state.future, snapshot(state)] };
}

export function redo(state) {
  if (state.future.length === 0) return state;
  const next = state.future.at(-1);
  return { ...snapshot(next), version: VERSION, past: [...state.past, snapshot(state)], future: state.future.slice(0, -1) };
}

export function getStats(state) {
  const empties = state.cells.filter(cell => cell === 'empty').length;
  const confirmed = new Set(state.shapes.flatMap(shapeIndexes));
  const hits = state.cells.filter((cell, index) => cell === 'hit' || confirmed.has(index)).length;
  const totalArea = Object.entries(state.counts).reduce((sum, [type, count]) => sum + count * TYPES[type][0] * TYPES[type][1], 0);
  return { dug: hits + empties, hits, empties, confirmed: confirmed.size, complete: hits === totalArea };
}

export function exportGame(state) {
  const current = { version: VERSION, ...snapshot(state) };
  validateCurrent(current);
  return JSON.stringify(current);
}

export function importGame(json) {
  let current;
  try { current = JSON.parse(json); } catch { throw new Error('Invalid JSON'); }
  validateCurrent(current);
  return { version: VERSION, ...snapshot(current), past: [], future: [] };
}
