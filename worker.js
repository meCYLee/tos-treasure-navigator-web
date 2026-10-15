import { solve } from './solver.js';

self.onmessage = event => {
  const { id, input } = event.data;
  try {
    self.postMessage({ id, result: solve(input, { maxNodes: 90000, maxSamples: 1000, maxMs: 350 }) });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
