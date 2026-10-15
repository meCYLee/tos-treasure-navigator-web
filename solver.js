const SIZE = 8;
const SHAPES = Object.freeze({ '1x2': [1, 2], '1x3': [1, 3], '2x2': [2, 2], '3x3': [3, 3] });
const TYPES = Object.keys(SHAPES);

function placement(type, row, col, rotated = false) {
  const dimensions = SHAPES[type];
  if (!dimensions) return null;
  const [height, width] = rotated ? [dimensions[1], dimensions[0]] : dimensions;
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row + height > SIZE || col + width > SIZE) return null;
  let mask = 0n;
  for (let r = row; r < row + height; r++) {
    for (let c = col; c < col + width; c++) mask |= 1n << BigInt(r * SIZE + c);
  }
  return { mask };
}

function allPlacements(type, emptyMask) {
  const result = [];
  const rotations = type === '1x2' || type === '1x3' ? [false, true] : [false];
  for (const rotated of rotations) {
    for (let row = 0; row < SIZE; row++) {
      for (let col = 0; col < SIZE; col++) {
        const item = placement(type, row, col, rotated);
        if (item && !(item.mask & emptyMask)) result.push(item);
      }
    }
  }
  return result;
}

function randomGenerator(seed) {
  let value = (Number(seed) >>> 0) || 1;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 4294967296;
  };
}

function shuffle(items, random) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function failure(status, reason, method = 'exact') {
  return {
    status, reason, method, candidateCount: 0,
    probabilities: Array(64).fill(null), certain: Array(64).fill(false),
    recommendation: null, complete: false, pendingCertainCount: 0,
  };
}

function bestNextBlankRate(boards, dugMask) {
  if (!boards.length) return 0;
  let maxHits = 0;
  for (let index = 0; index < 64; index++) {
    const bit = 1n << BigInt(index);
    if (dugMask & bit) continue;
    let hits = 0;
    for (const board of boards) if (board & bit) hits++;
    if (hits > maxHits) maxHits = hits;
  }
  return maxHits ? 1 - maxHits / boards.length : 0;
}

function recommend(boards, probabilities, certain, dugMask, totalArea, hitCount) {
  if (hitCount === totalArea || !boards.length) return null;
  const options = [];
  for (let index = 0; index < 64; index++) {
    if (!(dugMask & (1n << BigInt(index))) && probabilities[index] > 0) options.push(index);
  }
  if (!options.length) return null;
  const certainOption = options.find(index => certain[index]);
  if (certainOption !== undefined) {
    return { index: certainOption, row: Math.floor(certainOption / 8), col: certainOption % 8, kind: 'finish' };
  }

  // Compare the immediate blank cost and the best next move after either report.
  let bestIndex = options[0];
  let bestScore = Infinity;
  for (const index of options) {
    const bit = 1n << BigInt(index);
    const hitBoards = [];
    const emptyBoards = [];
    for (const board of boards) (board & bit ? hitBoards : emptyBoards).push(board);
    const nextMask = dugMask | bit;
    const score = emptyBoards.length / boards.length
      + hitBoards.length / boards.length * bestNextBlankRate(hitBoards, nextMask)
      + emptyBoards.length / boards.length * bestNextBlankRate(emptyBoards, nextMask);
    if (score < bestScore - 1e-12 || (Math.abs(score - bestScore) < 1e-12 && probabilities[index] > probabilities[bestIndex])) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return { index: bestIndex, row: Math.floor(bestIndex / 8), col: bestIndex % 8, kind: 'search' };
}

/** Evaluate legal 8×8 layouts. Confirmed shapes count as already dug. */
export function solve(state, options = {}) {
  const counts = state?.counts;
  const cells = state?.cells;
  const confirmed = state?.confirmed ?? [];
  if (!counts || !TYPES.every(type => Number.isInteger(counts[type]) && counts[type] >= 0 && counts[type] <= 64) ||
      !Array.isArray(cells) || cells.length !== 64 || !cells.every(value => ['unknown', 'empty', 'hit'].includes(value)) || !Array.isArray(confirmed)) {
    return failure('contradiction', '輸入資料格式或寶箱數量無效');
  }
  const totalArea = TYPES.reduce((sum, type) => sum + counts[type] * SHAPES[type][0] * SHAPES[type][1], 0);
  const hitCount = cells.filter(value => value === 'hit').length;
  if (totalArea > 64 || hitCount > totalArea) return failure('contradiction', '寶箱面積或命中數超過棋盤容量');

  let emptyMask = 0n;
  let hitMask = 0n;
  let dugMask = 0n;
  cells.forEach((value, index) => {
    const bit = 1n << BigInt(index);
    if (value === 'empty') emptyMask |= bit;
    if (value === 'hit') hitMask |= bit;
    if (value !== 'unknown') dugMask |= bit;
  });
  const remaining = { ...counts };
  let fixedMask = 0n;
  for (const item of confirmed) {
    if (!item || !SHAPES[item.type] || remaining[item.type] <= 0) return failure('contradiction', '已確認寶箱的數量或種類矛盾');
    const shape = placement(item.type, item.row, item.col, item.rotated === true);
    if (!shape || shape.mask & (fixedMask | emptyMask)) return failure('contradiction', '已確認寶箱越界、重疊或包含空格');
    fixedMask |= shape.mask;
    remaining[item.type]--;
  }
  const effectiveDugMask = dugMask | fixedMask;
  let effectiveHitCount = hitCount;
  for (let index = 0; index < 64; index++) {
    const bit = 1n << BigInt(index);
    if ((fixedMask & bit) && !(hitMask & bit)) effectiveHitCount++;
  }
  if ((hitMask & fixedMask) !== hitMask && Object.values(remaining).every(count => count === 0)) {
    return failure('contradiction', '命中格不在任何已確認寶箱內');
  }

  const random = randomGenerator(options.seed ?? 20261014);
  const groups = TYPES.map(type => ({ type, count: remaining[type], placements: shuffle(allPlacements(type, emptyMask | fixedMask), random) }))
    .filter(group => group.count > 0)
    .sort((a, b) => a.placements.length - b.placements.length);
  if (groups.some(group => group.placements.length < group.count)) return failure('contradiction', '可放置位置不足');

  const maxNodes = Number.isInteger(options.maxNodes) && options.maxNodes > 0 ? options.maxNodes : 60000;
  const maxSamples = Number.isInteger(options.maxSamples) && options.maxSamples > 0 ? options.maxSamples : 1200;
  const maxMs = Number.isFinite(options.maxMs) && options.maxMs > 0 ? options.maxMs : 150;
  const deadline = Date.now() + maxMs;
  const searchDeadline = Date.now() + maxMs * 0.6;
  let boards = [];
  let hits = Array(64).fill(0);
  let visited = 0;
  let candidateCount = 0;
  let truncated = false;

  function acceptBoard(mask) {
    if ((mask & hitMask) !== hitMask) return;
    candidateCount++;
    for (let index = 0; index < 64; index++) if (mask & (1n << BigInt(index))) hits[index]++;
    if (boards.length < maxSamples) boards.push(mask);
    else {
      const position = Math.floor(random() * candidateCount);
      if (position < maxSamples) boards[position] = mask;
    }
  }

  function search(groupIndex, selectedInGroup, start, occupiedMask) {
    if (truncated) return;
    visited++;
    if (visited > maxNodes || ((visited & 255) === 0 && Date.now() > searchDeadline)) { truncated = true; return; }
    if (groupIndex === groups.length) { acceptBoard(occupiedMask); return; }
    const group = groups[groupIndex];
    const needed = group.count - selectedInGroup;
    for (let i = start; i <= group.placements.length - needed; i++) {
      const candidate = group.placements[i];
      if (candidate.mask & occupiedMask) continue;
      const nextMask = occupiedMask | candidate.mask;
      if (needed === 1) search(groupIndex + 1, 0, 0, nextMask);
      else search(groupIndex, selectedInGroup + 1, i + 1, nextMask);
      if (truncated) return;
    }
  }

  search(0, 0, 0, fixedMask);
  if (truncated && maxNodes >= 10) {
    // A DFS prefix overrepresents its first large shape placement. Draw complete
    // independent arrangements so unexplored regions remain represented.
    const sampledBoards = [];
    const maxAttempts = Math.max(maxSamples * 30, 300);
    for (let attempt = 0; attempt < maxAttempts && sampledBoards.length < maxSamples && Date.now() < deadline; attempt++) {
      let mask = fixedMask;
      let valid = true;
      for (const group of groups) {
        let placed = 0;
        for (const candidate of shuffle(group.placements, random)) {
          if (candidate.mask & mask) continue;
          mask |= candidate.mask;
          if (++placed === group.count) break;
        }
        if (placed < group.count) { valid = false; break; }
      }
      if (valid && (mask & hitMask) === hitMask) sampledBoards.push(mask);
    }
    if (sampledBoards.length >= Math.min(32, maxSamples)) {
      boards = sampledBoards;
      candidateCount = sampledBoards.length;
      hits = Array(64).fill(0);
      for (const mask of sampledBoards) {
        for (let index = 0; index < 64; index++) if (mask & (1n << BigInt(index))) hits[index]++;
      }
    }
  }
  if (candidateCount === 0) {
    return failure(truncated ? 'incomplete' : 'contradiction', truncated ? '計算預算耗盡，尚未找到合法盤面；不能判定紀錄矛盾' : '紀錄矛盾：沒有符合目前紀錄的合法盤面', truncated ? 'sampled' : 'exact');
  }
  const exhaustive = !truncated;
  const probabilities = hits.map(count => count / candidateCount);
  const certain = probabilities.map(probability => exhaustive && probability === 1);
  const sampled = truncated || candidateCount > maxSamples;
  const recommendation = recommend(boards, probabilities, certain, effectiveDugMask, totalArea, effectiveHitCount);
  return {
    status: 'ok',
    reason: sampled ? '以合法候選盤面估算；比例並非遊戲官方機率' : '已完整枚舉符合紀錄的盤面；各候選盤面採等權計算',
    method: sampled ? 'sampled' : 'exact',
    candidateCount,
    probabilities,
    certain,
    recommendation,
    complete: effectiveHitCount === totalArea,
    pendingCertainCount: certain.filter((value, index) => value && !(effectiveDugMask & (1n << BigInt(index)))).length,
    totalTreasureCells: totalArea,
    dugHitCount: effectiveHitCount,
    exhaustive,
  };
}
