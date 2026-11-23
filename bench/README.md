# Append measurement (not a gate)

Exploratory timing of one append against a full re-walk, for the context-bar walk. It does not assert on timing, is not discovered by any
test run CI enforces, and does not touch the official "controlled append benchmark" in `walk.test.ts` and `items.test.ts`.

| Host | Run (explicitly, after the normal suite) | Needs |
|---|---|---|
| Claude plugin | `bench/run-claude.sh` | `claude` on PATH |
| Pi extension | `bun run bench/append-pi/measure.ts` | `bun` |

`claude plugin test` refuses imports from outside a plugin folder and runs every `*.test.ts` under it, so `run-claude.sh` copies the plugin
byte for byte without its tests into a scratch folder, adds the measurement file and runs the host there. The code measured is the production
files, not a reimplementation.

Each run prints one line, `APPEND-MEASURE-JSON {...}` (schema 1): per pair the order, the 40 raw append times, five raw warm full-walk times,
p95 and median, and two exploratory ratios (append p95 over warm-full median: tail to typical; append median over warm-full median: typical to
typical), plus one cold full walk per pair, the realm facts that are available (`unavailable` otherwise) and `valid` with reasons. A failed
equality check or a thrown error makes the record `valid:false` and the run fail; such a record is never a sample. Add Claude version, runner
OS/arch and start time from the workflow step: the test realm cannot report them.

Definitions (protocol v3, review 195): a pair is 40 appends from a 5,000-message state plus five warm full walks of the final 5,040-message
transcript. Warm walks reuse the same objects; each cold walk uses freshly built objects after a warm-up on different disposable ones. Order is
ABBA within a run. These are by construction; the argument cache is not queried or reset.
