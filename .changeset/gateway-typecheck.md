---
"context-economy": patch
---

tool-gateway developer tooling: the documented `tsc -p plugins/tool-gateway --noEmit` now passes (it failed with 30 to 32 errors). The plugin's `tsconfig.json` allows the `.ts` import extensions its sources already use, and its tests are corrected to match the host's declared types (complete `process.run` results, checked array reads, one declared test timer). No runtime or plugin behaviour change. CONTRIBUTING states that CI does not run the typecheck.
