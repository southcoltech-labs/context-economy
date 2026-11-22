---
"context-economy": patch
---

context-bar on Pi: when Pi reports no usage after a compaction, the header now reads `usage is being recalculated after compaction` (shorter in narrow windows) in place of the bare `n/a`, and the line below keeps the compaction history (`compacted 1× · just now · was 118k`), so the band no longer looks as if it stopped. No bar or distribution is drawn then, and a pre-compaction count is never shown as current. A measurement error, or unknown usage with no compaction on record, still reads `n/a`. The refresh stays on `agent_end`. A failed or aborted compaction (`session_compact_failed`) now re-measures through the guarded refresh and drops the cached split, also while the band is hidden. A failure reading the compaction history is clipped to the window width. Supported terminal width (60 columns and up) is documented; the Claude Code band is unchanged.
