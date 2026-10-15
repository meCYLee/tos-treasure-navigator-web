function bounds(start, end) {
  if (![start, end].every(index => Number.isInteger(index) && index >= 0 && index < 64)) return null;
  const startRow = Math.floor(start / 8);
  const endRow = Math.floor(end / 8);
  const startCol = start % 8;
  const endCol = end % 8;
  const row = Math.min(startRow, endRow);
  const col = Math.min(startCol, endCol);
  return { row, col, height: Math.abs(startRow - endRow) + 1, width: Math.abs(startCol - endCol) + 1 };
}

export function rectangleIndexes(start, end) {
  const rect = bounds(start, end);
  if (!rect) return [];
  const indexes = [];
  for (let row = rect.row; row < rect.row + rect.height; row++)
    for (let col = rect.col; col < rect.col + rect.width; col++) indexes.push(row * 8 + col);
  return indexes;
}

export function shapeFromCorners(start, end) {
  const rect = bounds(start, end);
  if (!rect) return null;
  const { row, col, height, width } = rect;
  if (height === 1 && (width === 2 || width === 3)) return { type: `1x${width}`, row, col, rotated: false };
  if (width === 1 && (height === 2 || height === 3)) return { type: `1x${height}`, row, col, rotated: true };
  if (height === width && (height === 2 || height === 3)) return { type: `${height}x${width}`, row, col, rotated: false };
  return null;
}
