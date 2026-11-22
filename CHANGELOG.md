# context-economy

## 0.2.2

### Patch Changes

- 78c8486: tool-gateway developer tooling: the documented `tsc -p plugins/tool-gateway --noEmit` now passes (it failed with 30 to 32 errors). The plugin's `tsconfig.json` allows the `.ts` import extensions its sources already use, and its tests are corrected to match the host's declared types (complete `process.run` results, checked array reads, one declared test timer). No runtime or plugin behaviour change. CONTRIBUTING states that CI does not run the typecheck.
- dc6d904: context-bar on Pi: when Pi reports no usage after a compaction, the header now reads `usage is being recalculated after compaction` (shorter in narrow windows) in place of the bare `n/a`, and the line below keeps the compaction history (`compacted 1× · just now · was 118k`), so the band no longer looks as if it stopped. No bar or distribution is drawn then, and a pre-compaction count is never shown as current. A measurement error, or unknown usage with no compaction on record, still reads `n/a`. The refresh stays on `agent_end`. A failed or aborted compaction (`session_compact_failed`) now re-measures through the guarded refresh and drops the cached split, also while the band is hidden. A failure reading the compaction history is clipped to the window width. Supported terminal width (60 columns and up) is documented; the Claude Code band is unchanged.

## 0.2.1

### Patch Changes

- adb672d: Release housekeeping: the 0.2.0 version commit failed an append-timing test on the macOS runner, so this release carries the test fix (a deterministic read-count gate and a controlled append benchmark, SPEC "Controlled append benchmark"). No behaviour change in any plugin or extension; context-bar, tool-gateway and the Pi extension work as in 0.2.0.

## 0.2.0

### Minor Changes

- f994ea9: Add the context-bar plugin and Pi extension: a band above the prompt that shows what fills the context window, by category. It is display only: it runs nothing, writes nothing and sends nothing. `CE_CONTEXT_BAR=off` turns it off on both hosts. `/context-bar top` shows a tool name and, for Bash, at most one common command name, never arguments.

## 0.1.2

### Patch Changes

- 9e2c1c2: Release tooling: candidates and promotion now use separate GitHub Apps and environments. `release.yml` first reads the release state in a job with no environment and no secrets, and starts the candidate job only when there is a version PR to open or update, a candidate to tag, or a missing GitHub release to repair. Merges with nothing to release no longer wait for an approval. Promotion still needs a second maintainer.

## 0.1.1

### Patch Changes

- e1597b0: Release tooling: promotion now sets the release bot's git identity before it runs, so each `promoted-v<version>` tag names the bot as its tagger. Without `RELEASE_BOT_EMAIL` the promotion stops before `release` moves.

## 0.1.0

### Minor Changes

- a7b622c: First preview release: tool-gateway for Claude Code and Pi.

### Patch Changes

- a7b622c: tool-gateway: commands that discard stderr with `2>/dev/null` are now rewritten through RTK instead of running unrewritten.
