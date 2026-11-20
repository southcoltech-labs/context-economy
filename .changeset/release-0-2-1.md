---
"context-economy": patch
---

Release housekeeping: the 0.2.0 version commit failed an append-timing test on the macOS runner, so this release carries the test fix (a deterministic read-count gate and a controlled append benchmark, SPEC "Controlled append benchmark"). No behaviour change in any plugin or extension; context-bar, tool-gateway and the Pi extension work as in 0.2.0.
