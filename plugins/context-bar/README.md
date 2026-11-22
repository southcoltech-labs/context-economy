# context-bar

A band above the prompt shows what fills the context window. Claude Code plugin and Pi extension; one shared bar, legend and format.

## What it does

- Draws one stacked bar of the window by category: the static prefix (System, Tool defs, MCP, Agent defs, AGENTS.md, Skills), then User prompt, Replies, Tool in, Tool out, Reads and Other, then Free and the autocompact Buffer.
- Draws the static prefix solid (`█`), the changing conversation dotted (`▓`) and unused space (free, buffer) light (`░`), and marks where the prefix ends with `┃`, so you see how much of each request is the fixed prefix. The header gives its size (`prefix 37.6k`).
- Sorts the conversation rows biggest first. Free and Buffer stay at the right; `│` marks where autocompact starts.
- Splits messages into rows from their sizes. The total and the fixed rows (System, Tool defs, …) come from the engine; the split of Messages into User prompt, Replies, Tool in, Tool out, Reads and Writes is estimated from character counts, so a dim italic footer under the legend always says `distribution est.`. When the breakdown is older than the latest turn it adds `- updated N turns ago`.
- Shows one footer line under the legend: `distribution est.` (with `- updated N turns ago` when stale) on the left and, after a compaction, the compaction summary (`compacted 2× · 48m ago · 207k→22.2k`) on the right. When the width is too narrow for both, the compaction text is hidden, never wrapped or overlapped. Claude Code and Pi.
- Supports terminal widths of 60 columns and up. Below that the band degrades and is not guaranteed legible: the header's right side shortens or drops (title only), the footer's compaction text is hidden when it cannot fit (the history line in the unknown-usage state below is clipped instead), and no line is wider than the window.
- On Pi, right after a compaction the host reports no usage until a later assistant reply has usable usage. Until then the header's right side reads `usage is being recalculated after compaction` in place of `n/a` (shorter in narrow windows), the line below keeps the compaction history (`compacted 1× · just now · was 118k`) and no distribution is drawn. The old count is never shown as the current one. With no compaction on record, or when measuring fails, the header reads `n/a` (with the error, if any). A failed or aborted compaction re-measures the band.
- Refreshes when the band is shown and: you type `/context-bar r`; the context is compacted, however triggered; or the context grows or shrinks by `refreshGrowthPercent` of the window (Claude Code). Pi refreshes after every round.
- Does nothing while the band is hidden, apart from noting two numbers per turn for the trend (below); no usage or token-count calls.
- Starts hidden on Claude Code: `/context-bar` shows it (on Pi it is shown from the start, and `/context-bar` hides it).
- Opens an expanded band with the `▼` button at the right end of the header (it becomes `▲` to close). The expanded band draws a line graph of the last 30 minutes: time along the x axis (`-30m` to `now`), tokens up the y axis (three labels, rounded to the data in the window, so they move as it grows; it starts at 0 when the series begins near zero), each turn a point joined by a line and held flat to now. A button in it switches the metric:
  - **resident context**: the context size after each turn (what the window holds now).
  - **cumulative processed**: a running total of every token the model processed, summed per main-thread turn from the API's four counts (input, output, cache read, cache write). Subagent turns are not counted. It counts from when the plugin loaded in this session.

  A line that starts part-way along means no sample before then. The trend is redrawn when a turn adds a sample, when the bar refreshes (it takes the size the bar just measured, so the graph's latest point matches the bar), or when you press a button. While it is open it also redraws every `trendRefreshSeconds` (15, 30 or 60; default 30), so the line slides left as time passes even when the session is idle (points older than 30 minutes drop off, and the last value holds flat to `now`). The timer runs only while the band is shown and expanded. It is Claude Code only.

On Claude Code the breakdown is counted with `summary` detail: from the last response's usage and local estimates, with no token-count requests.

## Commands

| Command | Does |
| --- | --- |
| `/context-bar` | Show or hide the band |
| `/context-bar r` | Refresh now |
| `/context-bar top` | List the largest single messages (tool name, and for Bash one command name, never arguments) |
| `/context-bar min\|norm\|max` | Legend detail for this session |

Label levels:

- `min`: Static prefix, Chat, Tools, Reads, Free, Buffer (and Other when not empty).
- `norm` (default): Static prefix, User prompt, Replies, Tool in, Tool out, Reads, Other, Free, Buffer.
- `max`: every static part on its own row.

## Setup

Install as in the [main README](../../README.md#2-install):

```bash
claude plugin install context-bar@context-economy
```

- **Claude Code:** plugin options `labels` (`min`, `norm` or `max`, default `norm`), `refreshGrowthPercent` (default 5) and `trendRefreshSeconds` (`15`, `30` or `60`, default 30; how often the open trend redraws while idle). A bad value shows `n/a (...)` in the band.
- **Pi:** optional `~/.config/context-bar/config.json`, for example `{"labels": "max"}`; `offloadAtTokens` (a positive integer, off by default) moves the marker to that token count. A bad file shows its path and the error.

## Off switch, limits and privacy

- `CE_CONTEXT_BAR=off` turns it off on both hosts (only the exact value `off`).
- It runs no model call and no command, writes nothing, logs nothing and uses no network. Its figures stay in memory for the session.
- It re-splits only new messages on a refresh (and the whole transcript again if an earlier message changed), and reads at most the latest 20,000 messages; past that the band marks the estimate with `≈` and every refresh splits the retained window again. `/context-bar top` lists five rows and says when older messages were not read.
- Details and the exact rules: [SPEC.md](SPEC.md). How it is tested: [TESTPLAN.md](TESTPLAN.md).

## Files

| File | Holds |
| --- | --- |
| `hooks/` | The Claude Code plugin and the shared core the Pi extension also uses (`split.ts`, `levels.ts`, `legend.ts`, `ansi.ts`, `view.ts`) |
| `../../extensions/context-bar/` | The Pi extension |

For development, load it for one session with `claude --plugin-dir "$PWD/plugins/context-bar"`, or `pi -e "$PWD/extensions/context-bar/index.ts"`.
