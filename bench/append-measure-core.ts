// SPDX-License-Identifier: Apache-2.0
//
// Measurement only, never a gate. Not part of any test run that CI enforces: invoke it explicitly (see bench/README.md).
// The caller passes the production `walkMessages` and adapter in; nothing here re-implements them. It uses no Node globals, because the Claude
// test realm has none, and it imports nothing, so the same file runs from the repo (Pi, bun) and from a copy of the plugin folder (Claude).
//
// One experimental pair = one block of 40 appends starting from a 5,000-message state, plus five warm full walks of the final 5,040-message
// transcript. Warm and cold are by construction, not by inspecting the module's argument cache. See the measurement protocol (team docs).
type Walk<S> = { seen: number; raw: Record<string, number>; state: S; omitted: number; signatures: number[] }
type Adapter<S> = { convert: (messages: readonly unknown[], state: S | undefined) => unknown; signature: (message: unknown) => number }
export type WalkFn<S> = (previous: Walk<S> | undefined, messages: readonly unknown[], adapter: Adapter<S>) => Walk<S>

export const SCHEMA = 1
const BASE = 5000
const APPENDS = 40
const WARM_WALKS = 5
const ORDERS = ['append-first', 'full-first', 'full-first', 'append-first'] as const // ABBA: counterbalanced inside one process
const BUDGET_MS = 90_000 // stop starting pairs after this; the record says so

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
  const pairs: unknown[] = []
  const cold: { pair: number; ms: number; messages: number }[] = []
  // The shared fixture: the same message and argument objects serve the base walk, the final transcript and the warm full walks.
  const base = Array.from({ length: BASE }, (_, i) => h.call(`t${i}`, wide()))
  const baseSnapshot = base.length
  const baseHead = base[0]
  const record = (extra: Record<string, unknown>): void => {
    const out = { schema: SCHEMA, host: h.host, ...extra }
    console.log('APPEND-MEASURE-JSON ' + JSON.stringify(out))
  }
  try {
    for (let pair = 0; pair < ORDERS.length; pair++) {
      if (performance.now() - started > BUDGET_MS) { warnings.push(`truncated before pair ${pair}: budget ${BUDGET_MS} ms`); break }
      const order = ORDERS[pair]!
      const extras = Array.from({ length: APPENDS }, (_, i) => h.next(pair * APPENDS + i))
      const final = [...base, ...extras] // prebuilt outside every timer; same message and argument objects as base
      const appendBlock = (): { times: number[]; walk: Walk<S> } => {
        const all = base.slice() // the 5,000-message starting state, not final
        let walk = walkMessages(undefined, all, h.adapter) // untimed: the incremental state the appends continue from
        const times: number[] = []
        h.host === 'pi' && g.Bun?.gc?.(true)
        for (let n = 0; n < APPENDS; n++) {
          all.push(extras[n])
          const t0 = performance.now()
          walk = walkMessages(walk, all, h.adapter)
          times.push(performance.now() - t0)
        }
        return { times, walk }
      }
      const fullBlock = (): { times: number[]; walk: Walk<S> } => {
        const times: number[] = []
        let walk = walkMessages(undefined, final, h.adapter) // untimed warm-up on the same objects
        for (let n = 0; n < WARM_WALKS; n++) {
          const t0 = performance.now()
          walk = walkMessages(undefined, final, h.adapter)
          times.push(performance.now() - t0)
        }
        return { times, walk }
      }
      let a: { times: number[]; walk: Walk<S> }
      let f: { times: number[]; walk: Walk<S> }
      if (order === 'append-first') { a = appendBlock(); f = fullBlock() } else { f = fullBlock(); a = appendBlock() }
      const equal = sameRaw(a.walk, f.walk) && a.walk.seen === BASE + APPENDS
      if (!equal) fail.push(`pair ${pair}: appended walk and full walk differ outside timing`)
      if (base.length !== baseSnapshot || base[0] !== baseHead) fail.push(`pair ${pair}: base fixture changed`)
      // Cold: a freshly built transcript (new argument identities, built outside the timer), after a warm-up on different disposable identities.
      const disposable = Array.from({ length: 1000 }, (_, i) => h.call(`d${i}`, wide()))
      walkMessages(undefined, disposable, h.adapter)
      const fresh = Array.from({ length: BASE + APPENDS }, (_, i) => h.call(`c${pair}-${i}`, wide()))
      const c0 = performance.now()
      walkMessages(undefined, fresh, h.adapter)
      cold.push({ pair, ms: performance.now() - c0, messages: fresh.length })
      pairs.push({
        pair, order, equal,
        stateSizes: { appendStart: BASE, appendEnd: BASE + APPENDS, fullWalk: final.length },
        appendMs: a.times, warmFullMs: f.times,
        appendP95: p95(a.times), appendMedian: median(a.times), warmFullMedian: median(f.times),
        // Exploratory only. The first is tail-to-typical (a p95 over a median), the second typical-to-typical; neither is a gate or an equal-quantile comparison.
        ratioP95OverWarmMedian: p95(a.times) / median(f.times), ratioMedianOverWarmMedian: median(a.times) / median(f.times),
      })
    }
  } catch (e) {
    fail.push('measurement threw: ' + String((e as Error)?.message ?? e).slice(0, 200))
  }
  const r = {
    kind: 'append-measurement', valid: fail.length === 0 && pairs.length === ORDERS.length, invalidReasons: fail.slice(0, 5), warnings,
    config: { base: BASE, appends: APPENDS, warmWalks: WARM_WALKS, orders: ORDERS, budgetMs: BUDGET_MS },
    realm: {
      process: known('process'), navigator: known('navigator'), Bun: h.host === 'pi' ? (g.Bun?.version ?? 'unavailable') : known('Bun'),
      gc: typeof g.Bun?.gc === 'function' ? 'Bun.gc present, requested before each Pi append block' : 'Bun.gc unavailable (no collection requested)',
      performanceNowResolutionMs: resolutionMs(),
    },
    pairs, coldMs: cold, elapsedMs: performance.now() - started,
    note: 'warm and cold are by construction; exploratory ratios are not gates; not the official benchmark',
  }
  record(r)
  if (!r.valid) throw new Error('invalid measurement: ' + (fail[0] ?? 'incomplete'))
}
