// SPDX-License-Identifier: Apache-2.0

import { addRaw, rawSplit } from './split'
import type { MessageItem, RawSplit } from './split'

/** At most this many of the latest messages are walked in one full split; older ones are not read, and the band marks the estimate. */
export const MAX_MESSAGES_WALKED = 20_000
/** A value larger than this is sized by length and never inspected: a command is not classified, an argument is not traversed further. */
export const MAX_PARSED_CHARS = 1_048_576
const MAX_NODES = 100_000
const MAX_DEPTH = 64

/** A command the plugin may inspect: present and not over the size limit. */
export const inspectable = (command: unknown): command is string => typeof command === 'string' && command.length <= MAX_PARSED_CHARS

/** The latest MAX_MESSAGES_WALKED messages of a transcript, and how many older ones were left out. A non-array is an empty transcript. */
export const latest = <T>(messages: readonly T[] | unknown): { recent: readonly T[]; omitted: number } => {
  if (!Array.isArray(messages)) return { recent: [], omitted: 0 }
  const omitted = Math.max(0, messages.length - MAX_MESSAGES_WALKED)
  return { recent: omitted === 0 ? messages : messages.slice(omitted), omitted }
}

const SHORT_STRING = 4096

/**
 * The length `JSON.stringify(value)` would have, found without building the string, and cut short: once the length passes
 * MAX_PARSED_CHARS (or the walk passes MAX_NODES values or MAX_DEPTH levels of nesting: that counts as over the limit) it returns what it has, a lower bound over the limit. A long string counts
 * as its length plus quotes (escapes are not counted). Exact for ordinary values. Never throws.
 */
export const boundedJsonLength = (value: unknown): number => {
  let total = 0
  let nodes = 0
  const walk = (v: unknown, depth: number): void => {
    if (total > MAX_PARSED_CHARS || nodes++ > MAX_NODES || depth > MAX_DEPTH) { total = Math.max(total, MAX_PARSED_CHARS + 1); return }
    if (v === null) { total += 4; return }
    switch (typeof v) {
      case 'string': total += v.length <= SHORT_STRING ? JSON.stringify(v).length : v.length + 2; return
      case 'number': total += Number.isFinite(v) ? String(v).length : 4; return
      case 'boolean': total += v ? 4 : 5; return
      case 'object': break
      default: return
    }
    if (Array.isArray(v)) {
      total += 2
      for (let i = 0; i < v.length; i++) {
        if (i > 0) total += 1
        const item = v[i]
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') total += 4
        else walk(item, depth + 1)
        if (total > MAX_PARSED_CHARS) return
      }
      return
    }
    total += 2
    let first = true
    for (const key of Object.keys(v as object)) {
      const item = (v as Record<string, unknown>)[key]
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue
      if (!first) total += 1
      first = false
      total += (key.length <= SHORT_STRING ? JSON.stringify(key).length : key.length + 2) + 1
      walk(item, depth + 1)
      if (total > MAX_PARSED_CHARS) return
    }
  }
  try { walk(value, 0) } catch { return 0 }
  return total
}

/** A cheap number that changes when a message's size-bearing parts change. Integers only; callers combine with `mix`. */
export const mix = (h: number, n: number): number => (Math.imul(h ^ (n | 0), 16777619) + 0x9e3779b9) | 0

/** What a refresh remembers: the sums so far, how far the transcript was read, and one signature per message read. */
export type Walk<S> = { seen: number; raw: RawSplit; state: S; omitted: number; signatures: number[] }
export type Convert<S> = (messages: readonly unknown[], state: S | undefined) => { items: MessageItem[]; state: S }
/** The host-specific part of a walk: how to convert messages, and the signature of one message (it must not throw). */
export type Adapter<S> = { convert: Convert<S>; signature: (message: unknown) => number }

const signed = (messages: readonly unknown[], signature: (m: unknown) => number): number[] => {
  const out = new Array<number>(messages.length)
  for (let i = 0; i < messages.length; i++) { try { out[i] = signature(messages[i]) } catch { out[i] = 0 } }
  return out
}

/**
 * Bring a walk up to date with the transcript. A full split is made on the first walk, when the caller drops the previous walk
 * (`/context-bar r`, compaction, a new session), when the transcript got shorter, when any message already read has a different
 * signature (an edit, a late result, a replaced branch), and whenever the transcript is over the cap (then the latest
 * MAX_MESSAGES_WALKED are split on every refresh and `omitted` counts the rest). Otherwise only the messages added since the
 * last walk are split. A change that keeps every signature the same (same sizes, different words) is not seen; the split is
 * made from sizes, so it is not a difference in what the band shows.
 */
export const walkMessages = <S>(previous: Walk<S> | undefined, messages: readonly unknown[], adapter: Adapter<S>): Walk<S> => {
  const { recent, omitted } = latest(messages)
  if (omitted > 0) {
    const out = adapter.convert(recent, undefined)
    return { seen: messages.length, raw: rawSplit(out.items), state: out.state, omitted, signatures: [] }
  }
  const signatures = signed(recent, adapter.signature)
  if (previous !== undefined && previous.omitted === 0 && recent.length >= previous.seen && previous.signatures.every((s, i) => s === signatures[i])) {
    const out = adapter.convert(recent.slice(previous.seen), previous.state)
    return { seen: recent.length, raw: addRaw(previous.raw, rawSplit(out.items)), state: out.state, omitted: 0, signatures }
  }
  const out = adapter.convert(recent, undefined)
  return { seen: recent.length, raw: rawSplit(out.items), state: out.state, omitted: 0, signatures }
}
