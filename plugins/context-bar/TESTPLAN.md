# context-bar test plan

The behaviour is specified in [SPEC.md](SPEC.md).

## Automated tests

From the repository root:

```bash
claude plugin validate . --strict
claude plugin test plugins/context-bar    # Claude Code plugin and the shared core
bun test extensions                       # Pi extension
```

What they cover:

- split, view, legend, bar and band formatting, label levels, palettes and trend charts, against the host's numbers;
- the off switch on both hosts: `off` registers or does nothing, any other value leaves it on;
- the `/context-bar top` label rule: assignments skipped, paths cut to the last part, URLs, unknown words, quoted and escaped
  input and empty input shown as `Bash`; arguments never shown;
- the limits: incremental refresh equals a full split, a compaction splits afresh, the 20,000-message cap marks the estimate,
  a Bash command over 1 MiB is not inspected, the trend keeps at most 120 points, and a 5,000-message refresh stays within 25 ms
  at the 95th percentile;
- malformed input never throws: unknown roles, missing fields, odd tool fields; bad options are shown in the band.

The 25 ms test measures wall-clock time, so a loaded machine may need a rerun before the result is treated as a failure.

## Live check: what the tests cannot show

The unit tests do not draw the band in a real terminal. For each host, in a real session:

| Check | Expect |
| --- | --- |
| Install, start a session, send a prompt | the band shows above the prompt with a bar, legend and header |
| `/context-bar min`, `norm`, `max` | the legend detail changes |
| `/context-bar top` | rows show a tool name and at most one command name, never arguments |
| `/context-bar r` | refreshes |
| Start with `CE_CONTEXT_BAR=off` | no band, no command effect |
| Uninstall, start again with the switch unset | no band, and no data folder left |

For Claude Code, open the trend with `▼` and check the line moves while idle.

Run the visual rows through the release proof driver (`scripts/e1-run.mjs`), or by hand with the manual runbook.
