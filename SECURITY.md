# Security

## Reporting a vulnerability

Email **support@southcoltech.com** with "security" in the subject. Do not open a public issue for
a suspected vulnerability. South Col Tech, Inc. owns reports for this repository.

Include the plugin, its version (`.claude-plugin/plugin.json`), your OS, and steps to reproduce.

## What each plugin reads, writes and sends

Public preview scope: the Claude Code plugin listed in `.claude-plugin/marketplace.json`, and the
Pi extension listed in `package.json` (`pi.extensions`): tool-gateway and context-bar, each on both hosts. Neither starts
a network connection or a model call of its own.

| Plugin | Reads | Writes (where) | Runs | Plugin-initiated sends |
| --- | --- | --- | --- | --- |
| tool-gateway | Each tool call's name and size; Bash command text, to rewrite it; `~/.claude/context-economy/config.json` | A metadata-only ledger in `~/.claude/context-economy/gateway-ledger/` (session id, agent, tool name, tool-use id, rewrite status and reason code, byte counts, timings; never command text or output). The host sets its modes, typically `0755`/`0644`. Never pruned | The RTK you configure (`CE_RTK_BIN` or `rtk.path`), after a trust check by `/usr/bin/stat`, `/usr/bin/uname`, `/usr/bin/id` | None |
| tool-gateway (Pi extension) | Each tool call's name and output size; `bash` command text, to rewrite it; `config.json` | A metadata-only ledger in `~/.claude/context-economy/gateway-ledger-pi/` (same fields as the Claude ledger), folder `0700`, files `0600`. Never pruned | The same configured RTK, after the same trust check | None |
| context-bar | The host's token counts and message transcript (message sizes and tool names, never kept); on Pi, an optional `~/.config/context-bar/config.json` | Nothing. Its figures are kept in memory for the session and logged nowhere | Nothing | None |
| context-bar (Pi extension) | The same counts and transcript from Pi; the optional config file | Nothing | Nothing | None |

On Pi the extension also changes two host behaviours, and `CE_TOOL_GATEWAY=off` turns both off
with the rest: it re-registers the built-in `edit` and `write` tools as sequential (same
behaviour, run in order), and deactivates the background tools `bg_task`, `bg_status`,
`bg_task_list` and `bg_task_watch` at session start when another package registered them.

A subprocess's output is capped at 1 MiB per stream on Pi (Claude Code caps it at 4 MiB): past
it the process is killed and the rewrite is not used. The rewrite as a whole, reading
`config.json` included, gives up after 1.1 s, and a ledger write holds a tool result for at most
0.5 s.

### context-bar and your transcript

context-bar reads the message transcript to size it. Between refreshes it keeps in memory only numbers (sums, token counts, a
size signature per message, timestamps for the trend, at most 120 points per series) and, to pair a result with its call, the
tool-call id, the tool name and whether a command was only read commands. It keeps no command, path, pattern, message or
result text; `/context-bar top` holds text only while it builds its list. It writes and logs nothing and starts no process or
connection. `CE_CONTEXT_BAR=off`
turns it off on both hosts (only the exact value `off`).

Text from the transcript can appear in one place: `/context-bar top`, printed to you in the session. For a Bash result it shows
at most one command name, never arguments, by a fixed rule: skip leading `NAME=value` words, take the next word's last path
part, and show it only if it is 1 to 32 characters of letters, digits and `._+-` and is on a fixed list of common commands
(`SHOWN_COMMANDS` in `plugins/context-bar/hooks/top.ts`). Anything else, including a URL, a path, an unknown word or quoted
text, shows as `Bash`. A file read shows its path and a search shows its pattern, as the host gave them. A bad setting shows
in the band as `n/a (...)`, never in a log.

### What stays on disk

The gateway ledgers are never pruned; delete them yourself if you no longer need them. They can
identify clients or workspaces by session and tool-use ids. Uninstalling keeps them and
`config.json`. context-bar leaves nothing on disk.

The Claude Code ledger gets the host's default modes, so other local users can read it unless
`~/.claude/context-economy` is `0700`. To restrict it: `chmod 700 ~/.claude/context-economy`.

## Trust limits

The gateway runs RTK only from an absolute path you configure, never from `PATH`. Before first use
and before every later use it checks the file through the system `stat`: it must be a regular file
owned by you or root, not writable by group or others, and unchanged since the session's first
check. A failed check turns rewriting off for the session; the ledger is still written.

These checks stop `PATH` drift, name collisions, and a binary or permission change made before a
check. They do not stop:

- a malicious program you configured yourself;
- a change made between sessions by a process running as you that still passes the checks;
- a swap between the check and the shell running the command (time of check to time of use);
- a process with root access that forges file times.

Running `rtk --version` already runs the program, so the version check is a compatibility check,
not proof of origin. Install RTK from its upstream, https://github.com/rtk-ai/rtk.
