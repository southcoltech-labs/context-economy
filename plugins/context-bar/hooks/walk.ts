// SPDX-License-Identifier: Apache-2.0

import { addRaw, rawSplit } from './split'
import type { MessageItem, RawSplit } from './split'

/** At most this many of the latest messages are walked in one full split; older ones are not read, and the band marks the estimate. */
export const MAX_MESSAGES_WALKED = 20_000
/** A command longer than this is never inspected (read-or-not, name): it is sized by its length and counts as tool output. */
export const MAX_PARSED_CHARS = 1_048_576

/** What a refresh remembers: the sums so far and how far the transcript was read. */
export type Walk<S> = { seen: number; raw: RawSplit; state: S; omitted: number }
export type Convert<S> = (messages: readonly unknown[], state: S | undefined) => { items: MessageItem[]; state: S }

/**
 * Bring a walk up to date with the transcript. Only the messages added since the last walk are split. A full split happens
 * on the first walk, when the transcript got shorter (a compaction), when the caller drops the previous walk (`/context-bar r`,
 * compaction), and while the transcript is over the cap (then the latest MAX_MESSAGES_WALKED are split and `omitted` counts the rest).
 */
export const walkMessages = <S>(previous: Walk<S> | undefined, messages: readonly unknown[], convert: Convert<S>): Walk<S> => {
  const omitted = Math.max(0, messages.length - MAX_MESSAGES_WALKED)
  if (previous !== undefined && previous.omitted === 0 && omitted === 0 && messages.length >= previous.seen) {
    const out = convert(messages.slice(previous.seen), previous.state)
    return { seen: messages.length, raw: addRaw(previous.raw, rawSplit(out.items)), state: out.state, omitted: 0 }
  }
  const out = convert(omitted === 0 ? messages : messages.slice(omitted), undefined)
  return { seen: messages.length, raw: rawSplit(out.items), state: out.state, omitted }
}

/** A command the plugin may inspect: present and not over the size limit. */
export const inspectable = (command: unknown): command is string => typeof command === 'string' && command.length <= MAX_PARSED_CHARS
