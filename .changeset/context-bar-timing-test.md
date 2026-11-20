---
---

context-bar tests: the append-time check is now a controlled benchmark (the minimum of three round p95s, each over 40 appends, under 25 ms, with a full collection requested before each round where available), and a deterministic read-count test gates re-reading of old arguments. This follows two shared-runner timing failures on macOS (p95 40.2 ms and 47.5 ms); the cause is not established (runtime, scheduler or collector interference is a hypothesis). It is not the overall refresh p95. No behaviour or version change.
