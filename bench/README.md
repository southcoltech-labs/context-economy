# Append measurement (not a gate)

Exploratory timing of one append against a full re-walk, for the context-bar walk. It asserts nothing about timing, is not discovered by any
test run CI enforces, and does not touch the official "controlled append benchmark" in `walk.test.ts` and `items.test.ts`.

| Host | Run (explicitly, after the normal suite) | Needs |
|---|---|---|
| Claude plugin | `node bench/run.mjs claude` | `node`, `claude` on PATH |
| Pi extension | `node bench/run.mjs pi` | `node`, `bun` |

`run.mjs` is a bounded runner. It starts the host in its own process group with a hard deadline (default 240 s; `--deadline-ms N`, a plain
integer from 1000 to 3600000), terminates the whole group on timeout or on SIGINT/SIGTERM/SIGHUP (SIGTERM, then SIGKILL after 3 s, then waits up
to 5 s to confirm the group is gone and reports `cleanup: unconfirmed` if it cannot), removes the scratch copy, keeps at most 200,000 bytes of
each output stream (exact cap, `truncated` flag, UTF-8 decoded as a whole), and prints one complete `APPEND-RUN-JSON {...}` line, written and
flushed before exit. `status` is `valid`, `invalid`, `incomplete`, `timeout`, `interrupted`, `no-record` or `startup-failure`. Exit code 0
means `valid` only; any other status is not a sample. A host that exits while descendants remain is `invalid` and the descendants are killed.
`valid` also requires the record to pass validation: schema, kind, requested host, flags, four pairs in the fixed order, state sizes, 40 append
and five warm samples per pair, finite non-negative times, a complete cold sample, derived p95/median/ratios recomputed, and exactly one record.
SIGKILL of the runner itself cannot be handled: it can leave the host running and prints nothing.
The measurement itself also has a soft bound: it stops starting new pairs after 90 s and says so. That is not a maximum runtime.

`claude plugin test` refuses imports from outside a plugin folder and runs every `*.test.ts` under it. For the Claude host, `run.mjs` copies
`plugins/context-bar` byte for byte without its tests into a scratch folder, checks the copy against the source by SHA-256 (the manifest hash is
in the output), adds the measurement file and its core, checks that exactly that one test file is present, and runs the host there. The code
measured is the production files, not a reimplementation. The scratch folder is deleted afterwards.

## What is measured

A pair is 40 appends from a 5,000-message state plus five warm full walks of the final 5,040-message transcript (5,000 tool calls with
1,000-field arguments, then 40 plain user messages). The pair is stored as soon as it is measured. Four pairs per run, in the fixed order
append-first, full-first, full-first, append-first; that order is the same in every run, so there is no counterbalancing across runs.

- Warm walks reuse the same message and argument objects. The append side starts from its own 5,000-message walk and adds 40 messages; the full
  side walks the prebuilt final transcript. The appended and full results are compared outside every timer.
- One cold full walk per pair (not five): a freshly built transcript of the same shape with new argument objects, built outside the timer after
  a warm-up on different disposable objects, compared with the warm final state outside timing. Warm and cold are by construction; the argument
  cache is not queried or reset.
- Per pair the record has the 40 raw append times, the five raw warm times, p95 and median, and two exploratory ratios (append p95 over
  warm-full median, tail to typical; append median over warm-full median, typical to typical). They are not equal-quantile comparisons.

The record (`APPEND-MEASURE-JSON`, schema 1) also has `valid`, `complete`, `stage`, reasons, warnings, the realm facts that are available
(`unavailable` otherwise) and the soft budget. A failed equality or shape check, any thrown error (including in a cold sample), or fewer than four finished pairs makes
it not `valid`. Samples are pushed into the pair record as they are taken, so a failure keeps everything collected before it, with
`appendDone`/`fullDone` flags saying which blocks finished. Claude version, runner OS/arch and start time are not
available inside the test realm; add them from the calling workflow.

## Failure fixtures

Explicit, not part of any enforced run.

- `bun test bench/fixtures`: the measurement core (throws in each block in both orders, in the cold pass and in initialization).
- `node --test bench/fixtures/*.fixture.mjs`: the runner, with real stand-in child processes. `run.fixture.mjs` drives the runner library: large
  report through a pipe, interruption signals, a child that ignores SIGTERM, descendants holding the pipes, timeout with a partial record,
  missing executable (ENOENT, no unhandled error), no/duplicate/wrong-host records, truncated stdout or stderr, output cap and UTF-8.
  `cli.fixture.mjs` runs the actual CLI from a temporary repo layout with stand-in `claude` and `bun` executables that record any launch:
  invalid host or deadline (including a flag without a value), preparation failure, SIGTERM during preparation, missing executables. Each asserts
  one complete report, no launch where none is allowed, and no scratch folder left behind.

The runner fixtures are written for Node and are named `.fixture.mjs` so that `bun test` does not collect them.

Any truncation of the captured output (more than 200,000 bytes on stdout or stderr) makes the run `invalid`: uniqueness of the record cannot
be established over discarded bytes. A signal that arrives during the synchronous plugin copy is serviced when the copy returns, before any
launch; the copy itself is not interruptible.

## Harvesting results from CI

`bench/harvest.mjs` collects the evidence from past runs into a durable, append-only dataset. It is read-only: it only calls `gh api` GET endpoints (list runs, list the jobs of every attempt, download job logs) and writes only the files you name.

```sh
node bench/harvest.mjs --repo OWNER/REPO --out-dir DIR --tsv data.tsv --since 2026-11-24T00:00:00Z --limit 50
```

- Workflow logs expire (GitHub's default is 90 days; this repository's setting is not verified), so harvest soon after runs finish. Keep the dataset somewhere reviewable that is not this repository's source tree.
- For each completed run **and each attempt** it records every `append measurement (<os>)` job (metadata and both host status lines kept verbatim, each host re-validated with the runner's `validateRecord`, plus the report verdict) and the three round p95s printed by the official benchmark in the `plugins (<os>)` and `pi (<os>)` jobs. A job whose log has no usable report, was cancelled or can no longer be downloaded is recorded as well, so missing observations stay visible.
- The dataset is a directory of monthly files, `append-YYYY-MM.jsonl`: one object per job per attempt, keyed `runId/attempt/jobId`, filed under the UTC month the run was created in (so a rerun lands beside its original). An existing key is never replaced. The same content is skipped, different content is a conflict, and the command exits 1 without writing anything. A rerun of a job is a new attempt and so a new key.
- Rotation and compression: when a month has ended, its file is gzipped to `append-YYYY-MM.jsonl.gz`. The archive is read back and compared before the plain file is removed. A late row for an archived month is appended as another gzip member, which `gunzip`/`zcat` read as part of the same file. The current month stays plain text. Every run reads the whole directory, archives included, so the duplicate check covers all history.
- `--tsv` rewrites a derived table from the whole directory: one row per pair for each host, one row per official job, and one row for each missing observation. A run is about 32 KB of JSONL and 5.5 KB of TSV (estimated from 5 real run attempts).
- Anything that cannot be parsed is stored as such (`valid: false` with the problems), never dropped or repaired. The numbers are exploratory, not a gate and not a threshold.

`node --test bench/fixtures/harvest.fixture.mjs` runs the parser, merge and CLI fixtures against a stand-in `gh` that records every call (a test asserts that none uses a method, field or body option). `real-report.log` is the report step of a real hosted run.
