// SPDX-License-Identifier: Apache-2.0
// Shared fixture helpers.
const sorted = (xs) => [...xs].sort((a, b) => a - b)
const median = (xs) => { const s = sorted(xs); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const p95 = (xs) => sorted(xs)[Math.ceil(xs.length * 0.95) - 1]
export const goodRecord = (host = 'pi') => ({
  schema: 1, host, kind: 'append-measurement', valid: true, complete: true, stage: 'done', invalidReasons: [], warnings: [],
  config: { base: 5000, appends: 40, warmWalks: 5, orders: ['append-first', 'full-first', 'full-first', 'append-first'] },
  pairs: ['append-first', 'full-first', 'full-first', 'append-first'].map((order, pair) => {
    const appendMs = Array.from({ length: 40 }, (_, i) => 1 + i / 100), warmFullMs = [300, 301, 302, 303, 304]
    return {
      pair, order, equal: true, appendDone: true, fullDone: true, stateSizes: { appendStart: 5000, appendEnd: 5040, fullWalk: 5040 }, appendMs, warmFullMs,
      appendP95: p95(appendMs), appendMedian: median(appendMs), warmFullMedian: median(warmFullMs),
      ratioP95OverWarmMedian: p95(appendMs) / median(warmFullMs), ratioMedianOverWarmMedian: median(appendMs) / median(warmFullMs),
      cold: { ms: 400, messages: 5040, shapeMatchesWarm: true },
    }
  }),
  elapsedMs: 1000,
})
export const printRecord = (r) => `console.log('APPEND-MEASURE-JSON ' + JSON.stringify(${JSON.stringify(r)}))`
