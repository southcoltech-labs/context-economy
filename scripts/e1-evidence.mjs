// SPDX-License-Identifier: Apache-2.0

// Evidence for a host step (design, "Evidence for a host step"; review 109, 112 B3/B4).
//
// The host's exit proves nothing, so a host step passes only on evidence that the required call ran,
// inside that step's window, with the required result. This module has three parts:
//
//   1. A normalised evidence model, and the evaluator that applies the design's rules to it.
//   2. The ledger check, always a machine check: a cursor taken before the host starts, and the rows
//      that are new since.
//   3. The attestation path: fixed questions asked after the host exits, every answer written to the
//      transcript verbatim. This is the real path for now.
//
// No parser for a real host's session record lives here or anywhere in `scripts/`. A parser for a host
// version is added only with a fixture captured from that version by the owner's read-only check, and
// the two are reviewed together. The only parser today is the synthetic one in the tests, which builds
// the model from invented records. Until a real one exists, `deps.sessionReader` is absent and every
// host step is attested, with the ledger still checked by machine.
//
// Decisions stated here, as the review asked:
//   - An attestation never overrides the ledger: answers that say "pass" with a ledger that disagrees
//     fail the step.
//   - The host's own exit code or signal is recorded in the transcript and shown to the operator with
//     the questions. It does not fail the step by itself: a host killed after the required call
//     completed has still produced the evidence, and a host that exits 0 with no call has not. The
//     evidence decides. (A host that could not be started at all is a stop in the engine.)
//   - The recorder's proof holds only `pass` and `fail`. The `attested` marker lives in the transcript,
//     one line per step.
//
// The model (what a parser must produce):
//   { sessions: [ { id, startedAt, calls: [ { command, startedAt, endedAt, isError, refused, output } ] } ] }
// `sessions` holds the session records that are new since the cursor, for the drill folder. Times are
// milliseconds since the epoch.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The result choices, numbered (S4); the driver compares the number, never the wording. */
export const RESULT_CHOICES = Object.freeze({ 1: "rewritten short output", 2: "git's plain output", 3: "error", 4: "refused" });

/** The fixed questions, asked after the host exits. `typed` and `shown` stay free text. */
export const QUESTIONS = Object.freeze([
  { id: "typed", ask: "What did you type?" },
  { id: "shown", ask: "What command did the call show?" },
  { id: "result", ask: `What was the result? ${Object.entries(RESULT_CHOICES).map(([n, t]) => `${n} = ${t}`).join(", ")}` },
  { id: "prompt", ask: "How many permission prompts appeared, and what did you choose at each? (zero is a valid answer)" },
]);

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The result choice for a call's output (V7: result 1 is any line starting with `* word`. That matches
 * the run sheet's example and the published record, and only the machine path uses it. Tighten it when
 * the first real fixture arrives.): 4 refused, 3 error, 2 git's plain output (`On branch …`,
 * `HEAD detached …`), 1 RTK's short form (a `* <branch>…` line), `undefined` when it is none of these.
 */
export function classifyOutput(output, { isError = false, refused = false } = {}) {
  if (refused) return 4;
  if (isError) return 3;
  const text = String(output ?? "");
  if (/^\s*(On branch |HEAD detached )/m.test(text)) return 2;
  if (/^\s*\* \S+/m.test(text)) return 1;
  return undefined;
}

// --- the ledger -------------------------------------------------------------------------------------

/**
 * The ledger folder is `evidence.ledgerDir`, a path relative to the home (the proof module holds the
 * whole path, V9). Assumption, stated because it is not checked: the plugin writes its ledger to the
 * default location. A `config.json` that moves the ledger would make every window read empty, and a
 * behaviour step would then fail on "expected 1 new ledger row, found 0", never pass.
 */
const folderOf = (home, dir) => join(home, ...dir.split("/"));
const sha = (lines) => createHash("sha256").update(lines.join("\n")).digest("hex");

/**
 * The cursor, taken before the host starts: for each ledger file, its row count and a hash of those
 * rows (V4), so a file that is replaced during the window is seen, not just a file that grew.
 */
export function ledgerCursor(home, dir) {
  const folder = folderOf(home, dir);
  const files = {};
  if (existsSync(folder)) for (const name of readdirSync(folder).filter((n) => n.endsWith(".jsonl")).sort()) {
    const lines = rowLines(join(folder, name));
    files[name] = { count: lines.length, hash: sha(lines) };
  }
  return { dir, files };
}

function rowLines(file) {
  return readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
}

function readRows(file) {
  return rowLines(file).map((line, i) => {
    let row;
    try { row = JSON.parse(line); } catch { throw new Error(`${file} line ${i + 1}: not valid JSON`); }
    if (!isObject(row)) throw new Error(`${file} line ${i + 1}: not a JSON object`);
    return row;
  });
}

/**
 * The rows that are new since `cursor`: the rows past each file's old count, and every row of a new
 * file. A file that had rows at the cursor and now has different ones, fewer, or is gone throws (V4):
 * "no new row" is the whole machine evidence of an uninstall step, so a rewritten file is not a pass.
 */
export function ledgerWindow(home, cursor) {
  const folder = folderOf(home, cursor.dir);
  const present = existsSync(folder) ? readdirSync(folder).filter((n) => n.endsWith(".jsonl")).sort() : [];
  for (const name of Object.keys(cursor.files)) if (!present.includes(name)) throw new Error(`ledger file ${name} existed before the host was launched and is gone`);
  const fresh = [];
  for (const name of present) {
    const old = cursor.files[name];
    if (old) {
      const lines = rowLines(join(folder, name));
      if (sha(lines.slice(0, old.count)) !== old.hash) throw new Error(`ledger file ${name} was changed or replaced during the window (its earlier rows differ)`);
    }
    fresh.push(...readRows(join(folder, name)).slice(old?.count ?? 0));
  }
  return fresh;
}

const LEDGER_SLACK_MS = 1000;

/**
 * Applies a step's ledger expectation, `{ rows, rewrite?, is_error? }`, to the new rows. With a call
 * (machine evidence) each row must also be timestamped between the call's start and its result.
 */
export function checkLedger(expected, rows, call, window) {
  const reasons = [];
  if (rows.length !== expected.rows) reasons.push(`expected ${expected.rows} new ledger row${expected.rows === 1 ? "" : "s"}, found ${rows.length}`);
  else for (const row of rows) {
    if (expected.rewrite !== undefined && row.rewrite !== expected.rewrite) reasons.push(`ledger row rewrite is ${JSON.stringify(row.rewrite)}, expected ${JSON.stringify(expected.rewrite)}`);
    if (expected.is_error !== undefined && row.is_error !== expected.is_error) reasons.push(`ledger row is_error is ${JSON.stringify(row.is_error)}, expected ${JSON.stringify(expected.is_error)}`);
    if (call) {
      const t = Date.parse(row.ts);
      if (!Number.isFinite(t)) reasons.push(`ledger row has no readable time (${JSON.stringify(row.ts)})`);
      else if (t < call.startedAt || t > call.endedAt) reasons.push("ledger row is timestamped outside the call");
    } else if (window) {
      // V5: with no session record the row is bounded by the step's own launch and exit. The slack is
      // one second each side: a ledger `ts` may be truncated to whole seconds.
      const t = Date.parse(row.ts);
      if (!Number.isFinite(t)) reasons.push(`ledger row has no readable time (${JSON.stringify(row.ts)})`);
      else if (t < window.launchedAt - LEDGER_SLACK_MS || t > window.exitedAt + LEDGER_SLACK_MS) reasons.push("ledger row is timestamped outside the host's launch-to-exit window");
    }
  }
  return reasons;
}

// --- the model and its evaluator -----------------------------------------------------------------------

/** Whether `model` has the normalised shape. A parser that produced anything else counts as "no machine evidence". */
export function validModel(model) {
  if (!isObject(model) || !Array.isArray(model.sessions)) return false;
  return model.sessions.every((s) => isObject(s) && typeof s.id === "string" && Number.isFinite(s.startedAt) && Array.isArray(s.calls)
    && s.calls.every((c) => isObject(c) && typeof c.command === "string" && Number.isFinite(c.startedAt) && Number.isFinite(c.endedAt)
      && typeof c.isError === "boolean" && typeof c.refused === "boolean" && typeof c.output === "string"));
}

/**
 * The design's rules over the model and the ledger window. `evidence`: `{ command, result, ledger }`
 * (`result` is the required result choice); `window`: `{ launchedAt, exitedAt }` in ms. Returns `{ result: "pass" | "fail", reasons }`. Every
 * "fails, never pass" case is a `fail`: no new session record, two, no call, the only call another
 * command, two candidate calls, a call that failed or was refused, an output that is not the required
 * form, a ledger row outside the call, a stale or unrelated row.
 */
export function evaluate(evidence, model, rows, window) {
  const reasons = [];
  const { launchedAt, exitedAt } = window ?? {};
  if (!Number.isFinite(launchedAt) || !Number.isFinite(exitedAt) || exitedAt < launchedAt) return { result: "fail", reasons: ["the step's launch and exit times are missing or out of order, so the window cannot be applied"] };
  const sessions = model.sessions;
  if (sessions.length === 0) return { result: "fail", reasons: ["no new session record in the window"] };
  if (sessions.length > 1) return { result: "fail", reasons: [`${sessions.length} new session records in the window, expected exactly one`] };
  const calls = sessions[0].calls;
  const candidates = calls.filter((c) => c.command.trim() === evidence.command);
  if (calls.length === 0) return { result: "fail", reasons: ["the host exited with no call"] };
  if (candidates.length === 0) return { result: "fail", reasons: [`no call with command \`${evidence.command}\` (the calls were: ${calls.map((c) => `\`${c.command}\``).join(", ")})`] };
  if (candidates.length > 1) return { result: "fail", reasons: [`${candidates.length} calls with command \`${evidence.command}\`, expected exactly one`] };
  const [call] = candidates;
  // The window rule lives here, once, so a parser stays thin (V2): the session is new since launch and
  // the call lies wholly inside launch-to-exit. Not checked yet: that the ledger row's `session` equals
  // the host's session id. Whether it does is unknown, so that cross-check waits for the first fixture.
  if (sessions[0].startedAt < launchedAt) reasons.push("the session started before the host was launched");
  if (call.endedAt < call.startedAt) reasons.push("the call ends before it starts");
  if (call.startedAt < launchedAt || call.endedAt > exitedAt) reasons.push("the call is not wholly inside the step's launch-to-exit window");
  const got = classifyOutput(call.output, call);
  if (got !== evidence.result) reasons.push(`the call's result is ${got === undefined ? "not a recognised form" : `${got} (${RESULT_CHOICES[got]})`}, expected ${evidence.result} (${RESULT_CHOICES[evidence.result]})`);
  reasons.push(...checkLedger(evidence.ledger, rows, call));
  return { result: reasons.length ? "fail" : "pass", reasons };
}

// --- attestation -----------------------------------------------------------------------------------------

/**
 * Asks the fixed questions through `ask(question) -> Promise<string>`. `result` must be a number from the
 * list and the other answers must not be empty; each is asked again up to three times, every try kept by the caller. Returns the answers, verbatim.
 */
export async function askQuestions(ask) {
  const answers = {};
  for (const q of QUESTIONS) {
    for (let attempt = 1; ; attempt++) {
      const answer = String(await ask(q.ask)).trim();
      // V1: an empty free-text answer (a stray Enter) is asked again, like a result that is not a choice.
      const good = q.id === "result" ? RESULT_CHOICES[answer] !== undefined : answer !== "";
      if (good) { answers[q.id] = answer; break; }
      if (attempt === 3) { answers[q.id] = answer; break; }
    }
  }
  return answers;
}

/**
 * Judges the answers against the step and the ledger. The answers pass only when: each free-text answer
 * is non-empty, the result number is the step's required one, and the ledger check passes. The ledger is
 * checked whatever the answers say (an attestation never overrides it).
 */
export function evaluateAttested(evidence, answers, rows, window) {
  const reasons = [];
  for (const id of ["typed", "shown", "prompt"]) if (!answers[id]) reasons.push(`no answer to "${QUESTIONS.find((q) => q.id === id).ask}"`);
  if (RESULT_CHOICES[answers.result] === undefined) reasons.push(`the result answer ${JSON.stringify(answers.result)} is not one of 1, 2, 3, 4`);
  else if (Number(answers.result) !== evidence.result) reasons.push(`the operator reported result ${answers.result} (${RESULT_CHOICES[answers.result]}), expected ${evidence.result} (${RESULT_CHOICES[evidence.result]})`);
  // G1: like `evaluate`, the attested path needs the window; without it the time bound would be skipped.
  if (!window || !Number.isFinite(window.launchedAt) || !Number.isFinite(window.exitedAt) || window.exitedAt < window.launchedAt) reasons.push("the step's launch and exit times are missing or out of order, so the window cannot be applied");
  reasons.push(...checkLedger(evidence.ledger, rows, undefined, window));
  return { result: reasons.length ? "fail" : "pass", reasons };
}

/** What is wrong with a ledger folder path (relative to the home: no traversal, no absolute path, no dot segment), or undefined. */
export function ledgerDirProblem(d) {
  return typeof d === "string" && /^(?:[a-z0-9][a-z0-9.-]*|\.claude)(?:\/[a-z0-9][a-z0-9.-]*)*$/.test(d) && !d.split("/").some((seg) => /^\.+$/.test(seg) || seg.includes(".."))
    ? undefined : `is not a relative folder path (no traversal, absolute path or dot segment): ${JSON.stringify(d)}`;
}

/** The step data a human step must carry: what the call is, its required result, and which ledger to check. */
export function validateEvidence(evidence) {
  if (!isObject(evidence)) return "no evidence (every human step needs it)";
  const unknown = Object.keys(evidence).filter((k) => !["kind", "command", "result", "ledgerDir", "ledger"].includes(k));
  if (unknown.length) return `unknown evidence key ${unknown.join(", ")}`;
  if (typeof evidence.kind !== "string" || !evidence.kind) return "evidence.kind is missing";
  if (typeof evidence.command !== "string" || !evidence.command) return "evidence.command is missing";
  if (RESULT_CHOICES[evidence.result] === undefined) return "evidence.result is not 1, 2, 3 or 4";
  if (ledgerDirProblem(evidence.ledgerDir)) return "evidence.ledgerDir is not a relative folder path";
  const l = evidence.ledger;
  if (!isObject(l) || !Number.isInteger(l.rows) || l.rows < 0) return "evidence.ledger.rows is not a count";
  if (Object.keys(l).some((k) => !["rows", "rewrite", "is_error"].includes(k))) return "unknown evidence.ledger key";
  return undefined;
}

// --- visual entries (design: "E1 driver: several plugins", section 1) ---------------------------------------------
//
// A band drawn above the prompt leaves no session record and no ledger row, so its evidence is always attested:
// the proof module writes fixed yes/no statements and the operator says whether each was seen.

const VISUAL_KEYS = ["host", "kind", "say", "expect"];

/**
 * Positive phrasing (design: "confirm only the unexpected answer"): a fixed question or a proof statement carries no
 * negation word outside quotes, so that "yes" always means the good outcome and nothing reads as a double negative.
 * Text inside backticks or double quotes is exempt (a quoted command, UI label or answer token). A crude guard, not a
 * proof: a reviewer still checks that "yes" is the expected answer of every statement, and that quoted text is only a
 * command, a UI label or an answer token (a statement written as `"No band" appears` would pass). The `say` lines are not linted:
 * the lint does not cover the whole screen.
 */
const NEGATION = /\b(?:no|not|none|nothing|without|never)\b/i;
export function negationProblem(text) {
  const bare = String(text).replace(/`[^`]*`|"[^"]*"/g, " ");
  const m = NEGATION.exec(bare);
  return m ? `holds the negation word "${m[0]}" outside quotes` : undefined;
}

/** The fixed strings the attestation asks, as functions of a statement where they take one. All are linted (negationProblem). */
export const VISUAL_QUESTION = (statement) => `Did you see: ${statement}? ("yes" or "no")`;
export const CONFIRM_QUESTION = (statement) => `Your answer to "${statement}" was: "no". Confirm that, or correct it? ("confirm" or "correct")`;
export const REASON_QUESTION = "Why did you change it? One line.";
export const DESCRIBE_QUESTION = "Describe in a few words what you saw";

/** The fields of a `visual` entry, as a reason string, or undefined when they are valid. `host` is checked by the caller. */
export function validateVisual(entry) {
  if (!isObject(entry)) return "not an object";
  const unknown = Object.keys(entry).filter((k) => !VISUAL_KEYS.includes(k));
  if (unknown.length) return `unknown field ${unknown.join(", ")} for a visual entry`;
  if (!Array.isArray(entry.say) || entry.say.length > 3 || entry.say.some((l) => typeof l !== "string" || l === "" || /[\r\n]/.test(l))) return "`say` is not a list of at most 3 lines";
  if (!Array.isArray(entry.expect) || entry.expect.length < 1 || entry.expect.length > 4) return "`expect` is not a list of 1 to 4 statements";
  const negated = entry.expect.map((s) => (typeof s === "string" ? negationProblem(s) : undefined)).find(Boolean);
  if (negated) return `an \`expect\` statement ${negated} (write it so that "yes" is the expected answer)`;
  if (entry.expect.some((s) => typeof s !== "string" || s.trim() === "" || s.length > 100 || s.includes("?") || /[\r\n]/.test(s))) return "an `expect` statement is empty, longer than 100 characters or holds a `?`";
  return undefined;
}

const YES_NO = /^(yes|no)$/i;
const CONFIRM_CORRECT = /^(confirm|correct)$/i;

/**
 * Asks one statement at a time through `ask(question) -> Promise<string>`: `Did you see: <statement>? ("yes" or "no")`, then a
 * free-text description. A `yes` is never asked again. A valid `no` gets exactly one confirmation prompt that states the answer
 * and takes only the words "confirm" or "correct" (anything else, "yes" and "no" included, is asked again, up to three times,
 * then the step fails): `confirm` fails the statement; `correct` asks the original question once more, and that answer is
 * final. A `yes` after a correction is a changed answer: it needs a one-line reason (empty is asked again, three tries, then a
 * fail) and is passed to `onChange({ statement, first, second, reason })` at once, so a later stop cannot lose it. An answer that is
 * neither `yes` nor `no` (or an empty description) is asked again up to three times. Returns `{ result, reasons }`; the caller keeps every try.
 */
export async function askVisual(ask, expect, { onChange = () => {} } = {}) {
  const askUntil = async (question, valid) => {
    let answer;
    for (let attempt = 1; attempt <= 3; attempt++) {
      answer = String(await ask(question)).trim();
      if (valid.test(answer)) return answer;
    }
    return undefined;
  };
  for (const statement of expect) {
    const first = await askUntil(VISUAL_QUESTION(statement), YES_NO);
    if (first === undefined) return { result: "fail", reasons: [`no valid yes/no answer for "${statement}" after 3 tries`] };
    if (/^no$/i.test(first)) {
      const choice = await askUntil(CONFIRM_QUESTION(statement), CONFIRM_CORRECT);
      if (choice === undefined) return { result: "fail", reasons: [`no valid confirm/correct answer for "${statement}" after 3 tries`] };
      if (/^confirm$/i.test(choice)) return { result: "fail", reasons: [`the operator did not see: ${statement}`] };
      const second = await askUntil(VISUAL_QUESTION(statement), YES_NO);
      if (second === undefined) return { result: "fail", reasons: [`no valid yes/no answer for "${statement}" after 3 tries`] };
      if (/^no$/i.test(second)) return { result: "fail", reasons: [`the operator did not see: ${statement} (confirmed after a correction)`] };
      const reason = await askUntil(REASON_QUESTION, /\S/);
      if (reason === undefined) return { result: "fail", reasons: [`no reason for changing the answer to "${statement}" after 3 tries`] };
      onChange({ statement, first: "no", second: "yes", reason });
    }
  }
  let description = "";
  for (let attempt = 1; attempt <= 3 && description === ""; attempt++) description = String(await ask(DESCRIBE_QUESTION)).trim();
  if (description === "") return { result: "fail", reasons: ["no description of what the operator saw after 3 tries"] };
  return { result: "pass", reasons: [] };
}
