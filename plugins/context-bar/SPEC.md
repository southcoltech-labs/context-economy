# context-bar specification

A band above the prompt that shows what fills the context window. One shared core (`plugins/context-bar/hooks`) serves the
Claude Code plugin and the Pi extension (`extensions/context-bar`).

## Scope

- It only reads what the host already gives it: token counts, the message transcript, the tool and prompt sizes. It runs no
  model call, no token-count request, no command and no network access.
- It is display only. It never changes a prompt, a tool call, a message or a setting.
- It writes nothing and logs nothing. Its figures live in memory for the session and are gone when it ends. The only file it
  reads is the optional Pi config (below).

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
| Refresh work | only the messages added since the last refresh are split; a full split happens after the first read, a compaction, a shorter transcript or `/context-bar r` |
| Refresh time | at most 25 ms at the 95th percentile for a refresh that adds a turn to a 5,000-message session (measured in the tests; the figure is a budget, not a promise for every machine) |
| Messages walked in one full split | the latest 20,000; older ones are not read and the band marks the estimate with `≈` |
| One command, one message | a Bash command over 1 MiB (1,048,576 characters) is not inspected: it counts as tool output by its length |
| Trend history | at most 120 points per series, in memory only |

## Malformed input

Nothing the host passes in may throw into the host.

- A message with an unknown or missing role adds nothing to the split.
- A message, tool call or result with missing or wrongly typed fields adds only what is well formed.
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
keeps only numbers (sums, token counts, timestamps for the trend) and the text it draws, and does not write, log or transmit
anything. The one place text from the transcript can appear is `/context-bar top`, under the rule above.

## Acceptance

- Both hosts: the band shows the bar, legend and header from the host's numbers; the rows add up to the host's total.
- `CE_CONTEXT_BAR=off` shows nothing on either host.
- Uninstalling removes the band; nothing is left behind, because nothing was written.
- The limits and the malformed-input rules above hold, each with an automated test.
