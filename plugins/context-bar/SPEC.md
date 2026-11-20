# context-bar specification

A band above the prompt that shows what fills the context window. One shared core (`plugins/context-bar/hooks`) serves the
Claude Code plugin and the Pi extension (`extensions/context-bar`).

## Scope

- It only reads what the host already gives it: token counts, the message transcript, the tool and prompt sizes. It runs no
  model call, no token-count request, no command and no network access.
- It is display only. It never changes a prompt, a tool call, a message or a setting.
- It writes nothing and logs nothing. Its figures live in memory for the session and are gone when it ends. The only file it
  reads is the optional Pi config (below).
- On Claude Code the band starts hidden: `/context-bar` shows it. On Pi it is shown from the start and `/context-bar` hides it.

## Hosts

| | Claude Code | Pi |
| --- | --- | --- |
| Entry | `hooks/register.tsx` | `extensions/context-bar/index.ts` |
| Total and fixed rows | the engine's own breakdown (`summary` detail) | `ctx.getContextUsage()`, plus sizes of the system prompt and active tool declarations |
| Messages split | estimated from character counts | the same estimate |
| Refresh | on `refreshGrowthPercent` growth, after compaction, `/context-bar r` | after every round, after compaction, `/context-bar r` |
| Trend (expanded band) | yes | no |
| Settings | plugin options | `~/.config/context-bar/config.json` |

## Off switch

`CE_CONTEXT_BAR=off` turns it off on both hosts. Only the exact value `off` counts; `OFF`, `0`, `false`, an empty value or a value
with spaces leave it on. Off means: the Pi entrypoint registers no event and no command, and the Claude hooks do nothing
(the `/context-bar` command answers that it is switched off). Nothing is measured and nothing is drawn.

## Configuration

Claude Code (plugin options):

| Option | Default | Meaning |
| --- | --- | --- |
| `labels` | `norm` | Legend detail: `min`, `norm` or `max` |
| `refreshGrowthPercent` | `5` | Refresh when the context grows or shrinks by this percent of the window |
| `trendRefreshSeconds` | `30` | How often the open trend redraws while idle: `15`, `30` or `60` |
| `theme`, `colors` | `auto` | Palette: `auto`, `dark` or `light`; single colour overrides as `#rrggbb` |

Pi (`~/.config/context-bar/config.json`, optional): `labels`, `theme`, `colors` as above, and `offloadAtTokens` (a positive
integer, off by default). With `offloadAtTokens` set, the marker on the bar shows that token count; without it the marker shows
the host's compaction point. The bar only marks the point; it never triggers anything.

A bad value shows `n/a (<reason>)` in the band, naming the field (Pi: the file path too). It never throws into the host.

## Split of the messages row

The host gives the total of the messages. The split into User prompt, Replies, Tool in, Tool out, Reads and Writes is an
estimate from character counts (about 4 characters per token, a different ratio for tool results) scaled so the rows add up
exactly to the host's total. Reads are the file-reading tools and Bash commands made only of read commands (`cat`, `head`,
`sed -n`, ...). Because it is an estimate, the band says `distribution est.`.

## Limits

These bound the work and the memory the plugin may use, however long the session.

| Limit | Value |
| --- | --- |
| Refresh work | only the messages added since the last refresh are split (see Cache validity); a full split happens after the first read, a compaction, a new session, a shorter transcript, `/context-bar r`, or when a message already read has changed |
| Refresh time | at most 25 ms at the 95th percentile for a refresh that adds a turn to a 5,000-message session (measured in the tests; the figure is a budget, not a promise for every machine) |
| Messages walked in one full split | the latest 20,000; older ones are not read and the band marks the estimate with `≈`. Over this limit every refresh splits the whole retained window again; the "only new messages" rule does not apply there |
| `/context-bar top` | reads the latest 20,000 messages, lists exactly 5 rows (equal sizes keep transcript order) and says how many older messages were not read |
| One command, one message | a Bash command over 1 MiB (1,048,576 characters) is not inspected: it counts as tool output by its length. The size of a tool call's arguments is found by a bounded count (stops past 1 MiB, 100,000 values or 64 levels of nesting; every property or element visited counts, ignored ones included, and a wide object is walked only as far as the budget), never by building the whole text. A message's signature reads at most 48 values of its arguments, once per argument object (about 5,000 messages with 1,000-field arguments: p95 of 40 appends under 25 ms in the tests, on one machine) |
| Trend history | at most 120 points per series, in memory only |

## Cache validity

A refresh keeps, for each message already read, a signature: a hash of the role, the text size, and for each tool call its tool
name, its id, a hash of its arguments' first 48 values (keys, value types and sizes, and up to 384 characters of each string; a flag when there are more) and a hash of its command (its length and its first
256 and last 128 characters); for each result its id and size. It adds only the new messages when every earlier signature is
unchanged and the transcript did not get shorter. An edited message, a late result, a replaced branch, a changed tool, id or
command class (for example `cat x` to `npm x`) and a compaction all change a signature or the length, so the transcript is
split afresh.

This is a bounded policy, not a guarantee that the incremental split always equals a full one. It does not notice a change in
the 49th or later value of a call's arguments, a command that differs only between its first 256 and last 128 characters, or an
argument object edited in place after the plugin first read it (the host normally hands over new objects). Checking those would
mean reading every earlier argument again on every append. In those cases the band stays on the earlier figures until the next
full split (`/context-bar r`, compaction, a new session, or any change that is noticed).

## What is kept in memory

Between refreshes it keeps: per-message signatures (numbers), the sums per row, the trend points (timestamps and token counts),
and, to pair a result with its call, the tool-call id, the tool name and whether the command was only read commands. A call is
dropped once its result has been read. It does not keep command text, paths, search patterns, message text or result text
between refreshes. `/context-bar top` needs labels, so it converts the transcript for that one command, keeps the text only
while building the list, and drops it.

## Proportions

The split of the messages row describes the messages that were read: the latest 20,000 at most, and only messages with a
role the plugin knows. Its proportions may differ from the full history's. The total is always the host's, unchanged, and the
band marks the estimate (`≈`, or `distribution est.`).

## Malformed input

Nothing the host passes in may throw into the host.

- A message that is not an object, or whose role is not one the plugin knows, adds nothing to the split, its tool fields included.
- A tool call, result or content block with missing or wrongly typed fields adds only what is well formed. A missing argument
  sizes as nothing.
- Every command path, including `/context-bar top`, ends in a message and never an exception: a transcript that cannot be read
  shows a short, bounded `context-bar: cannot list the top items (...)` or `n/a (...)`.
- A bad option or config file is shown in the band (see Configuration).
- Any other failure while measuring is shown as `n/a (<reason>)` in the band, and the session continues.

## `/context-bar top`

Lists the largest single messages by estimated tokens. The label shows the tool name and, for a read, its target (a path or a
search pattern). For a Bash result it shows at most one command name, never its arguments:

1. Skip leading `NAME=value` words.
2. Take the next word and keep the part after its last `/`.
3. Show it only if it matches `^[A-Za-z0-9._+-]{1,32}$` and is on the fixed list in `hooks/top.ts` (`SHOWN_COMMANDS`).
4. Otherwise, including a URL, an unknown word, quoted or escaped text, or no word, the row shows `Bash` alone.

The list is printed to you in the session. It is never stored or sent anywhere. A read's target is shown as the host gave it.

## Privacy

The plugin sees the transcript, so what it does with it is limited on purpose: it counts characters and classifies messages,
keeps between refreshes only numbers and short pairing metadata (see What is kept in memory), and does not write, log or
transmit anything. The one place text from the transcript can appear is `/context-bar top`, under the rule above.

## Acceptance

- Both hosts: the band shows the bar, legend and header from the host's numbers; the rows add up to the host's total.
- `CE_CONTEXT_BAR=off` shows nothing on either host.
- Uninstalling removes the band; context-bar leaves nothing behind, because it wrote nothing. (tool-gateway's config and ledgers, if installed, stay in their own folder.)
- The limits and the malformed-input rules above hold, each with an automated test.
