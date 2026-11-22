---
"context-economy": patch
---

context-bar on Pi: when Pi reports no usage after a compaction, the band now shows `n/a`, a short "usage is being recalculated after compaction" line and the known compaction history, instead of a bare `n/a` that looked like a failure. The band still refreshes on `agent_end` as before; a pre-compaction count is never shown as current. A failed or aborted compaction (`session_compact_failed`) now re-measures through the same guarded refresh. The Claude Code band is unchanged.
