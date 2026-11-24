// SPDX-License-Identifier: Apache-2.0
//
// Measurement only, never a gate. Not part of any test run that CI enforces: invoke it explicitly (see bench/README.md).
// The caller passes the production `walkMessages` and adapter in; nothing here re-implements them. It uses no Node globals, because the Claude
// test realm has none, and it imports nothing, so the same file runs from the repo (Pi, bun) and from a copy of the plugin folder (Claude).
//
// One experimental pair = one block of 40 appends starting from a 5,000-message state, plus five warm full walks of the final 5,040-message
// transcript (5,000 tool calls with 1,000-field arguments, then 40 plain user messages). A cold sample walks a freshly built transcript of the
// same shape (new argument objects, same ids and order). Warm and cold are by construction, not by inspecting the module's argument cache.
type Walk<S> = { seen: number; raw: Record<string, number>; state: S; omitted: number; signatures: number[] }
type Adapter<S> = { convert: (messages: readonly unknown[], state: S | undefined) => unknown; signature: (message: unknown) => number }
export type WalkFn<S> = (previous: Walk<S> | undefined, messages: readonly unknown[], adapter: Adapter<S>) => Walk<S>

export const SCHEMA = 1
const BASE = 5000
const APPENDS = 40
const WARM_WALKS = 5
const ORDERS = ['append-first', 'full-first', 'full-first', 'append-first'] as const // ABBA: counterbalanced inside one process
const BUDGET_MS = 90_000 // soft bound: stop starting new pairs after this and say so. It is not a maximum runtime (see bench/run.mjs for the hard deadline)

export type Host<S> = {
  host: 'claude' | 'pi'
  walkMessages: WalkFn<S>
  adapter: Adapter<S>
  call: (id: string, args: unknown) => unknown
  next: (i: number) => unknown
}

const wide = (): Record<string, string> => Object.fromEntries(Array.from({ length: 1000 }, (_, k) => ['f' + k, 'v' + k]))
const sorted = (xs: number[]): number[] => [...xs].sort((a, b) => a - b)
const median = (xs: number[]): number => { const s = sorted(xs); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2 }
const p95 = (xs: number[]): number => sorted(xs)[Math.ceil(xs.length * 0.95) - 1]!
const g = globalThis as unknown as Record<string, unknown> & { Bun?: { version?: string; gc?: (sync: boolean) => void } }
const known = (name: string): string => (name in g ? 'present' : 'unavailable')

const resolutionMs = (): number => {
  let best = Infinity
  for (let i = 0; i < 2000; i++) { const a = performance.now(); let b = performance.now(); while (b === a) b = performance.now(); best = Math.min(best, b - a) }
  return best
}

const sameRaw = <S>(a: Walk<S>, b: Walk<S>): boolean => (Object.keys(a.raw) as (keyof typeof a.raw)[]).every(k => Math.abs(a.raw[k] - b.raw[k]) < 1e-6) && a.seen === b.seen

export const measure = <S>(h: Host<S>): void => {
  const walkMessages = h.walkMessages
  const started = performance.now()
  const fail: string[] = []
  const warnings: string[] = []
  const pairs: Record<string, unknown>[] = []
  let stage = 'init'
  let base: unknown[] = []
  try {
    // The shared fixture: the same message and argument objects serve the base walk, the final transcript and the warm full walks.
    base = Array.from({ length: BASE }, (_, i) => h.call(`t${i}`, wide()))
    const baseHead = base[0]
    for (let pair = 0; pair < ORDERS.length; pair++) {
      if (performance.now() - started > BUDGET_MS) { warnings.push(`stopped before pair ${pair}: soft budget ${BUDGET_MS} ms`); break }
      const order = ORDERS[pair]!
      stage = `pair ${pair}`
      const extras = Array.from({ length: APPENDS }, (_, i) => h.next(pair * APPENDS + i))
      const final = [...base, ...extras] // prebuilt outside every timer; same message and argument objects as base
      // The pair record exists before any block runs and samples are pushed into it as they are taken, so a throw in either block, in
      // either order, keeps every sample already collected. The flags say which parts finished.
      const entry: Record<string, unknown> = {
        pair, order, equal: false, appendDone: false, fullDone: false, cold: 'not run',
        stateSizes: { appendStart: BASE, appendEnd: BASE + APPENDS, fullWalk: final.length },
      }
      const appendMs: number[] = []
      const warmFullMs: number[] = []
      entry.appendMs = appendMs
      entry.warmFullMs = warmFullMs
      pairs.push(entry)
      const appendBlock = (): Walk<S> => {
        const all = base.slice() // the 5,000-message starting state, not final
        let walk = walkMessages(undefined, all, h.adapter) // untimed: the incremental state the appends continue from
        if (h.host === 'pi') g.Bun?.gc?.(true)
        for (let n = 0; n < APPENDS; n++) {
          all.push(extras[n])
          const t0 = performance.now()
          walk = walkMessages(walk, all, h.adapter)
          appendMs.push(performance.now() - t0)
        }
        entry.appendDone = true
        return walk
      }
      const fullBlock = (): Walk<S> => {
        let walk = walkMessages(undefined, final, h.adapter) // untimed warm-up on the same objects
        for (let n = 0; n < WARM_WALKS; n++) {
          const t0 = performance.now()
          walk = walkMessages(undefined, final, h.adapter)
          warmFullMs.push(performance.now() - t0)
        }
        entry.fullDone = true
        return walk
      }
      let aw: Walk<S>
      let fw: Walk<S>
      if (order === 'append-first') { stage = `pair ${pair} append block`; aw = appendBlock(); stage = `pair ${pair} full block`; fw = fullBlock() }
      else { stage = `pair ${pair} full block`; fw = fullBlock(); stage = `pair ${pair} append block`; aw = appendBlock() }
      const equal = sameRaw(aw, fw) && aw.seen === BASE + APPENDS
      entry.equal = equal
      if (!equal) fail.push(`pair ${pair}: appended walk and full walk differ outside timing`)
      if (base.length !== BASE || base[0] !== baseHead) fail.push(`pair ${pair}: base fixture changed`)
      entry.appendP95 = p95(appendMs); entry.appendMedian = median(appendMs); entry.warmFullMedian = median(warmFullMs)
      // Exploratory only. The first is tail-to-typical (a p95 over a median), the second typical-to-typical; neither is a gate or an equal-quantile comparison.
      entry.ratioP95OverWarmMedian = p95(appendMs) / median(warmFullMs)
      entry.ratioMedianOverWarmMedian = median(appendMs) / median(warmFullMs)
      // Cold: one sample per pair (a deliberate reduction; it is a side measurement, not the denominator). The same shape as the warm final state,
      // 5,000 tool calls plus the 40 user messages, with new argument objects built outside the timer, after a warm-up on different disposable
      // objects. Its result is compared with the warm final state outside timing. A planned cold sample that throws invalidates the observation;
      // the append and warm samples stay in the record for inspection.
      try {
        stage = `pair ${pair} cold`
        walkMessages(undefined, Array.from({ length: 1000 }, (_, i) => h.call(`d${i}`, wide())), h.adapter)
        const fresh = [...Array.from({ length: BASE }, (_, i) => h.call(`t${i}`, wide())), ...extras]
        const c0 = performance.now()
        const cw = walkMessages(undefined, fresh, h.adapter)
        const ms = performance.now() - c0
        const same = sameRaw(cw, fw)
        entry.cold = { ms, messages: fresh.length, shapeMatchesWarm: same }
        if (!same) fail.push(`pair ${pair}: cold walk result differs from the warm final state`)
      } catch (e) {
        entry.cold = { error: String((e as Error)?.message ?? e).slice(0, 200) }
        fail.push(`pair ${pair}: cold sample failed: ` + String((e as Error)?.message ?? e).slice(0, 120))
      }
    }
  } catch (e) {
    fail.push(`measurement threw at ${stage}: ` + String((e as Error)?.message ?? e).slice(0, 200))
  }
  let resolution: number | string = 'unavailable'
  try { resolution = resolutionMs() } catch { /* the record is still written */ }
  const complete = pairs.length === ORDERS.length && pairs.every(p => p.appendDone === true && p.fullDone === true && typeof (p.cold as { ms?: unknown })?.ms === 'number')
  const valid = fail.length === 0 && complete
  const r = {
    schema: SCHEMA, host: h.host, kind: 'append-measurement', valid, complete, stage, invalidReasons: fail.slice(0, 5), warnings,
    config: { base: BASE, appends: APPENDS, warmWalks: WARM_WALKS, orders: ORDERS, softBudgetMs: BUDGET_MS, coldSamplesPerPair: 1 },
    realm: {
      process: known('process'), navigator: known('navigator'), Bun: h.host === 'pi' ? (g.Bun?.version ?? 'unavailable') : known('Bun'),
      gc: typeof g.Bun?.gc === 'function' ? 'Bun.gc present, requested before each Pi append block' : 'Bun.gc unavailable (no collection requested)',
      performanceNowResolutionMs: resolution,
    },
    pairs, elapsedMs: performance.now() - started,
    note: 'warm and cold are by construction; exploratory ratios are not gates; not the official benchmark',
  }
  console.log('APPEND-MEASURE-JSON ' + JSON.stringify(r))
  if (!valid) throw new Error('invalid or incomplete measurement: ' + (fail[0] ?? `only ${pairs.length} of ${ORDERS.length} pairs`))
}
