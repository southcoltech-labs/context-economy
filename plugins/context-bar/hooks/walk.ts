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
 * MAX_PARSED_CHARS, or `maxNodes` values have been visited, or the nesting passes MAX_DEPTH, it returns what it has, a lower bound
 * over the limit for the first and last cases. EVERY visit counts, including a property or element that is skipped (undefined,
 * a function), and an object is walked with `for...in` and stopped at the budget, so the work is bounded by `maxNodes` however
 * wide the value is. A long string counts as its length plus quotes (escapes are not counted). Exact for ordinary values that
 * fit the budget. Never throws.
 */
export const boundedJsonLength = (value: unknown, maxNodes: number = MAX_NODES): number => {
  let total = 0
  let nodes = 0
  const over = (): boolean => total > MAX_PARSED_CHARS || nodes > maxNodes
  const walk = (v: unknown, depth: number): void => {
    nodes += 1
    if (over() || depth > MAX_DEPTH) { total = Math.max(total, nodes > maxNodes || depth > MAX_DEPTH ? MAX_PARSED_CHARS + 1 : total); return }
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
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') { nodes += 1; total += 4 } else walk(item, depth + 1)
        if (over()) { total = Math.max(total, MAX_PARSED_CHARS + 1); return }
      }
      return
    }
    total += 2
    let first = true
    for (const key in v as object) {
      if (!Object.prototype.hasOwnProperty.call(v, key)) continue
      const item = (v as Record<string, unknown>)[key]
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') { nodes += 1; if (over()) { total = Math.max(total, MAX_PARSED_CHARS + 1); return } continue }
      if (!first) total += 1
      first = false
      total += (key.length <= SHORT_STRING ? JSON.stringify(key).length : key.length + 2) + 1
      walk(item, depth + 1)
      if (over()) { total = Math.max(total, MAX_PARSED_CHARS + 1); return }
    }
  }
  try { walk(value, 0) } catch { return 0 }
  return total
}

/** Combines integers into one hash: a cheap way to sign a message from its parts. */
export const mix = (h: number, n: number): number => (Math.imul(h ^ (n | 0), 16777619) + 0x9e3779b9) | 0

/** A short hash of a string: its length and up to 384 of its characters (the first 256 and the last 128). Never throws. */
export const hashText = (value: unknown): number => {
  if (typeof value !== 'string') return 0
  let h = mix(7, value.length)
  const n = value.length
  const end = Math.min(n, 256)
  for (let i = 0; i < end; i++) h = mix(h, value.charCodeAt(i))
  for (let i = Math.max(end, n - 128); i < n; i++) h = mix(h, value.charCodeAt(i))
  return h
}
/** How many values of a tool call's arguments its signature looks at. Edits past these are not noticed (see SPEC, Cache validity). */
export const SIGNATURE_NODES = 48
/** What a message's signature takes from one tool call's arguments: their size over the first SIGNATURE_NODES values, and the command's hash. */
export const argumentSignature = (args: unknown, command: unknown): number => {
  let size = 0
  if (typeof args === 'object' && args !== null) {
    const known = argumentSizes.get(args)
    if (known !== undefined) size = known
    else { size = boundedJsonLength(args, SIGNATURE_NODES); argumentSizes.set(args, size) }
  } else size = boundedJsonLength(args, SIGNATURE_NODES)
  return mix(mix(5, size), hashText(command))
}
/** The bounded size of an argument object already seen, so an append does not traverse the arguments of every earlier call again. An object edited in place after it was first seen is not re-read. */
const argumentSizes = new WeakMap<object, number>()

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
 * last walk are split. A signature covers the role, the tool name, the id, the text sizes, the first SIGNATURE_NODES values of a
 * call's arguments and a hash of its command, so the changes that move a message between rows are seen. A change outside those
 * (a later value of a wide argument object, edited in place after it was first seen, a command differing only past its first 256
 * and last 128 characters) is not: a bounded policy, not an equivalence guarantee. See SPEC, Cache validity.
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
