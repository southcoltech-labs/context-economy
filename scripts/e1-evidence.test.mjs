// SPDX-License-Identifier: Apache-2.0

// Evidence model, evaluator, ledger window and attestation, run on invented records. The parser below
// is SYNTHETIC: it builds the model from records made up here and parses no real host's session file.
// (A real parser comes only with a fixture captured from that host version, reviewed with it.)
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendFileSync, rmSync } from "node:fs";
import { QUESTIONS, RESULT_CHOICES, askQuestions, checkLedger, classifyOutput, evaluate, evaluateAttested, ledgerCursor, ledgerWindow, validModel, validateEvidence } from "./e1-evidence.mjs";

const T0 = Date.parse("2026-11-14T10:00:00Z");
const LEDGER = ".claude/context-economy/gateway-ledger";
const iso = (ms) => new Date(ms).toISOString();
const SHORT = "* main...origin/main\n M README.md\n";
const PLAIN = "On branch main\nYour branch is up to date with 'origin/main'.\n";

/** SYNTHETIC parser: invented records `{ session, call, command, at, until, output, error, refused }` to the model. */
function synthetic(records) {
  const sessions = new Map();
  for (const r of records) {
    if (!sessions.has(r.session)) sessions.set(r.session, { id: r.session, startedAt: r.at - 1, calls: [] });
    if (r.call) sessions.get(r.session).calls.push({ command: r.command, startedAt: r.at, endedAt: r.until ?? r.at + 100, isError: Boolean(r.error), refused: Boolean(r.refused), output: r.output ?? "" });
  }
  return { sessions: [...sessions.values()] };
}
const call = (over = {}) => ({ session: "s1", call: true, command: "git status", at: T0 + 1000, until: T0 + 1500, output: SHORT, ...over });
const row = (over = {}) => ({ ts: iso(T0 + 1200), rewrite: "applied", is_error: false, ...over });
const BEHAVIOUR = { kind: "behaviour", command: "git status", result: 1, ledgerDir: ".claude/context-economy/gateway-ledger", ledger: { rows: 1, rewrite: "applied", is_error: false } };
const UNINSTALL = { kind: "uninstall", command: "git status", result: 2, ledgerDir: ".claude/context-economy/gateway-ledger", ledger: { rows: 0 } };
const WINDOW = { launchedAt: T0, exitedAt: T0 + 2000 };
const verdict = (evidence, records, rows, window = WINDOW) => evaluate(evidence, synthetic(records), rows, window);
const fails = (v, re) => { assert.equal(v.result, "fail"); assert.match(v.reasons.join("; "), re); };

test("classifyOutput: short form, plain form, error, refused, and anything else", () => {
  assert.equal(classifyOutput(SHORT), 1);
  assert.equal(classifyOutput(` * main...origin/main\n`), 1);
  assert.equal(classifyOutput(PLAIN), 2);
  assert.equal(classifyOutput("HEAD detached at 3b86e7a\n"), 2);
  assert.equal(classifyOutput(SHORT, { isError: true }), 3);
  assert.equal(classifyOutput(SHORT, { refused: true, isError: true }), 4);
  assert.equal(classifyOutput("something else"), undefined);
});

test("the synthetic model is a valid model, and bad shapes are not", () => {
  assert.equal(validModel(synthetic([call()])), true);
  assert.equal(validModel(undefined), false);
  assert.equal(validModel({ sessions: [{ id: "s", startedAt: 1, calls: [{ command: "x" }] }] }), false);
  assert.equal(validModel({ sessions: "none" }), false);
});

test("behaviour step passes: one call, short form, one applied row inside the call", () => {
  assert.deepEqual(verdict(BEHAVIOUR, [call()], [row()]), { result: "pass", reasons: [] });
});
test("uninstall step passes: one call, plain form, no new row", () => {
  assert.deepEqual(verdict(UNINSTALL, [call({ output: PLAIN })], []), { result: "pass", reasons: [] });
});

// the design's "fails, never pass" cases
test("fails: the host exits with no call", () => fails(verdict(BEHAVIOUR, [{ session: "s1" }], [row()]), /no call/));
test("fails: the only call is another command", () => fails(verdict(BEHAVIOUR, [call({ command: "ls docs" })], [row()]), /no call with command `git status`/));
test("fails: the call failed", () => fails(verdict(BEHAVIOUR, [call({ error: true })], [row()]), /3 \(error\)/));
test("fails: the call was refused", () => fails(verdict(BEHAVIOUR, [call({ refused: true, error: true })], [row()]), /4 \(refused\)/));
test("fails: two candidate calls", () => fails(verdict(BEHAVIOUR, [call(), call({ at: T0 + 5000 })], [row()]), /2 calls with command/));
test("fails: no new session record", () => fails(verdict(BEHAVIOUR, [], [row()]), /no new session record/));
test("fails: two new session records", () => fails(verdict(BEHAVIOUR, [call(), call({ session: "s2" })], [row()]), /2 new session records/));
test("fails: a ledger row whose time is outside the call", () => {
  fails(verdict(BEHAVIOUR, [call()], [row({ ts: iso(T0 + 900) })]), /outside the call/);
  fails(verdict(BEHAVIOUR, [call()], [row({ ts: iso(T0 + 1600) })]), /outside the call/);
  fails(verdict(BEHAVIOUR, [call()], [row({ ts: "not a time" })]), /no readable time/);
});
test("fails: behaviour with no new ledger row, two rows, a row not applied, or an errored row", () => {
  fails(verdict(BEHAVIOUR, [call()], []), /expected 1 new ledger row, found 0/);
  fails(verdict(BEHAVIOUR, [call()], [row(), row()]), /found 2/);
  fails(verdict(BEHAVIOUR, [call()], [row({ rewrite: "none" })]), /rewrite is "none"/);
  fails(verdict(BEHAVIOUR, [call()], [row({ is_error: true })]), /is_error is true/);
});
test("fails: behaviour with git's plain output, uninstall with RTK's short output, or an unrecognised output", () => {
  fails(verdict(BEHAVIOUR, [call({ output: PLAIN })], [row()]), /result is 2/);
  fails(verdict(UNINSTALL, [call({ output: SHORT })], []), /result is 1/);
  fails(verdict(BEHAVIOUR, [call({ output: "banana" })], [row()]), /not a recognised form/);
});
test("fails: uninstall with a new ledger row", () => fails(verdict(UNINSTALL, [call({ output: PLAIN })], [row()]), /expected 0 new ledger rows, found 1/));

// the ledger window
function ledgerHome(files = {}) {
  const home = mkdtempSync(join(tmpdir(), "e1-ev-"));
  const dir = join(home, ".claude", "context-economy", "gateway-ledger");
  mkdirSync(dir, { recursive: true });
  for (const [name, rows] of Object.entries(files)) writeFileSync(join(dir, name), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { home, dir };
}
test("a stale applied row before the cursor does not count; the new row does", () => {
  const { home, dir } = ledgerHome({ "s-1-0.jsonl": [row({ ts: iso(T0 - 60000) })] });
  const cursor = ledgerCursor(home, ".claude/context-economy/gateway-ledger");
  assert.deepEqual(Object.keys(cursor.files), ["s-1-0.jsonl"]);
  assert.equal(cursor.files["s-1-0.jsonl"].count, 1);
  assert.deepEqual(ledgerWindow(home, cursor), []);
  writeFileSync(join(dir, "s-1-0.jsonl"), [row({ ts: iso(T0 - 60000) }), row()].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const fresh = ledgerWindow(home, cursor);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].ts, iso(T0 + 1200));
  assert.deepEqual(verdict(BEHAVIOUR, [call()], fresh), { result: "pass", reasons: [] });
  // with the stale row alone in the window the step must fail
  assert.equal(evaluate(BEHAVIOUR, synthetic([call()]), [], WINDOW).result, "fail");
});
test("rows in a new ledger file are new; an absent folder is an empty window", () => {
  const { home, dir } = ledgerHome({});
  const cursor = ledgerCursor(home, ".claude/context-economy/gateway-ledger");
  writeFileSync(join(dir, "s-2-0.jsonl"), JSON.stringify(row()) + "\n");
  assert.equal(ledgerWindow(home, cursor).length, 1);
  const none = mkdtempSync(join(tmpdir(), "e1-ev-"));
  assert.deepEqual(ledgerWindow(none, ledgerCursor(none, ".claude/context-economy/gateway-ledger")), []);
});
test("a new ledger row that is not JSON stops with its file name and line", () => {
  const { home, dir } = ledgerHome({});
  const cursor = ledgerCursor(home, LEDGER);
  writeFileSync(join(dir, "s-3-0.jsonl"), "{ nope\n");
  assert.throws(() => ledgerWindow(home, cursor), /s-3-0\.jsonl line 1: not valid JSON/);
});

// attestation
const ANSWERS = { typed: "git status", shown: "Bash(git status)", result: "1", prompt: "no prompt" };
test("the fixed questions, with the result as a numbered choice (S4)", () => {
  assert.deepEqual(QUESTIONS.map((q) => q.id), ["typed", "shown", "result", "prompt"]);
  assert.deepEqual(RESULT_CHOICES, { 1: "rewritten short output", 2: "git's plain output", 3: "error", 4: "refused" });
});
test("askQuestions keeps free text verbatim and asks the result again until it is a choice", async () => {
  const given = ["  git status  ", "Bash(git status)", "rewritten", "7", "1", "no prompt"];
  const asked = [];
  const answers = await askQuestions(async (q) => { asked.push(q); return given.shift(); });
  assert.deepEqual(answers, { typed: "git status", shown: "Bash(git status)", result: "1", prompt: "no prompt" });
  assert.equal(asked.filter((q) => /result/i.test(q)).length, 3);
});
test("askQuestions gives up on a result that is never a choice, and the evaluator fails it", async () => {
  const answers = await askQuestions(async (q) => (/result/i.test(q) ? "great" : "x"));
  assert.equal(answers.result, "great");
  fails(evaluateAttested(BEHAVIOUR, answers, [row()], WINDOW), /not one of 1, 2, 3, 4/);
});
test("attestation passes only with matching answers and a passing ledger", () => {
  assert.deepEqual(evaluateAttested(BEHAVIOUR, ANSWERS, [row()], WINDOW), { result: "pass", reasons: [] });
  assert.deepEqual(evaluateAttested(UNINSTALL, { ...ANSWERS, result: "2" }, [], WINDOW), { result: "pass", reasons: [] });
});
test("G1: the attested path fails when no window is given, as the machine path does", () => {
  fails(evaluateAttested(BEHAVIOUR, ANSWERS, [row({ ts: "2001-01-01T00:00:00Z" })]), /window cannot be applied/);
  fails(evaluateAttested(BEHAVIOUR, ANSWERS, [row()], { launchedAt: T0 + 5, exitedAt: T0 }), /window cannot be applied/);
});
test("an attestation never overrides the ledger: 'pass' with no new row fails, with two rows fails", () => {
  fails(evaluateAttested(BEHAVIOUR, ANSWERS, [], WINDOW), /expected 1 new ledger row, found 0/);
  fails(evaluateAttested(BEHAVIOUR, ANSWERS, [row(), row()], WINDOW), /found 2/);
  fails(evaluateAttested(BEHAVIOUR, ANSWERS, [row({ rewrite: "none" })], WINDOW), /rewrite is "none"/);
  fails(evaluateAttested(UNINSTALL, { ...ANSWERS, result: "2" }, [row()], WINDOW), /found 1/);
});
test("attestation fails on a wrong result number and on an empty free-text answer", () => {
  fails(evaluateAttested(BEHAVIOUR, { ...ANSWERS, result: "2" }, [row()], WINDOW), /reported result 2/);
  fails(evaluateAttested(BEHAVIOUR, { ...ANSWERS, result: "4" }, [row()], WINDOW), /refused/);
  fails(evaluateAttested(BEHAVIOUR, { ...ANSWERS, prompt: "" }, [row()], WINDOW), /no answer to/);
  fails(evaluateAttested(BEHAVIOUR, { ...ANSWERS, typed: "" }, [row()], WINDOW), /no answer to/);
});
test("checkLedger without a call does not check times", () => assert.deepEqual(checkLedger(BEHAVIOUR.ledger, [row({ ts: "whenever" })]), []));

test("validateEvidence", () => {
  assert.equal(validateEvidence(BEHAVIOUR), undefined);
  assert.equal(validateEvidence(UNINSTALL), undefined);
  assert.match(validateEvidence(undefined), /no evidence/);
  assert.match(validateEvidence({ ...BEHAVIOUR, ledgerDir: "../x" }), /ledgerDir/);
  assert.match(validateEvidence({ ...BEHAVIOUR, result: 0 }), /result/);
  assert.match(validateEvidence({ ...BEHAVIOUR, ledger: { rows: "1" } }), /rows/);
  assert.match(validateEvidence({ ...BEHAVIOUR, extra: 1 }), /unknown evidence key/);
  assert.match(validateEvidence({ ...BEHAVIOUR, command: "" }), /command/);
});

// --- V1: an empty free-text answer is asked again ------------------------------------------------------------------

test("V1: an empty free-text answer is asked again, up to three tries, every try visible to the caller", async () => {
  const seen = [];
  const script = { "What did you type?": ["", "  ", "git status"] };
  const ask = async (q) => { seen.push(q); const l = script[q]; return l?.length ? l.shift() : /result/i.test(q) ? "1" : "x"; };
  const a = await askQuestions(ask);
  assert.equal(a.typed, "git status");
  assert.equal(seen.filter((q) => q === "What did you type?").length, 3);
  // three empty tries: the answer stays empty and the step fails
  const b = await askQuestions(async (q) => (/type\?/.test(q) ? "" : /result/i.test(q) ? "1" : "x"));
  assert.equal(b.typed, "");
  fails(evaluateAttested(BEHAVIOUR, b, [row()], WINDOW), /no answer to/);
});

// --- V2: the machine evaluator applies the launch-to-exit window ---------------------------------------------------

test("V2: a session that started before the host was launched fails", () => {
  const early = { ...synthetic([call()]) };
  early.sessions[0].startedAt = T0 - 7200_000;
  fails(evaluate(BEHAVIOUR, early, [row()], WINDOW), /session started before the host was launched/);
});
test("V2: a call before launch, or after exit, fails", () => {
  fails(verdict(BEHAVIOUR, [call({ at: T0 - 500, until: T0 + 500 })], [row({ ts: iso(T0) })]), /not wholly inside/);
  fails(verdict(BEHAVIOUR, [call({ at: T0 + 1500, until: T0 + 2500 })], [row({ ts: iso(T0 + 2000) })]), /not wholly inside/);
});
test("V2: a call that ends before it starts fails", () => {
  fails(verdict(BEHAVIOUR, [call({ at: T0 + 1500, until: T0 + 1000 })], [row({ ts: iso(T0 + 1200) })]), /ends before it starts/);
});
test("V2: a call exactly on the window edges passes; a missing or reversed window fails", () => {
  assert.equal(verdict(BEHAVIOUR, [call({ at: T0 + 100, until: T0 + 2000 })], [row({ ts: iso(T0 + 1200) })]).result, "pass");
  fails(evaluate(BEHAVIOUR, synthetic([call()]), [row()], undefined), /window cannot be applied/);
  fails(verdict(BEHAVIOUR, [call()], [row()], { launchedAt: T0 + 5000, exitedAt: T0 }), /window cannot be applied/);
});

// --- V4: a ledger file replaced during the window is seen ----------------------------------------------------------

test("V4: a file replaced during the window stops, even when the new file has as many rows as the old one", () => {
  for (const after of [[row({ ts: iso(T0 + 1) })], [row({ ts: iso(T0 + 2) }), row({ ts: iso(T0 + 3) })], []]) {
    const { home, dir } = ledgerHome({ "s-1-0.jsonl": [row({ ts: iso(T0 - 60000) }), row({ ts: iso(T0 - 50000) })].slice(0, after.length === 1 ? 1 : 2) });
    const cursor = ledgerCursor(home, LEDGER);
    writeFileSync(join(dir, "s-1-0.jsonl"), after.map((r) => JSON.stringify(r)).join("\n") + (after.length ? "\n" : ""));
    assert.throws(() => ledgerWindow(home, cursor), /changed or replaced/);
  }
});
test("V4: a ledger file that is gone stops; a file that only grew is fine", () => {
  const { home, dir } = ledgerHome({ "s-1-0.jsonl": [row({ ts: iso(T0 - 1000) })] });
  const cursor = ledgerCursor(home, LEDGER);
  appendFileSync(join(dir, "s-1-0.jsonl"), JSON.stringify(row()) + "\n");
  assert.equal(ledgerWindow(home, cursor).length, 1);
  rmSync(join(dir, "s-1-0.jsonl"));
  assert.throws(() => ledgerWindow(home, cursor), /is gone/);
});

// --- V5: with no session record the row is bounded by launch and exit ---------------------------------------------------

test("V5: an attested step counts a row only when its time is inside launch-to-exit", () => {
  const ok = evaluateAttested(BEHAVIOUR, ANSWERS, [row()], WINDOW);
  assert.deepEqual(ok, { result: "pass", reasons: [] });
  fails(evaluateAttested(BEHAVIOUR, ANSWERS, [row({ ts: iso(T0 - 86400_000) })], WINDOW), /outside the host's launch-to-exit window/);
  fails(evaluateAttested(BEHAVIOUR, ANSWERS, [row({ ts: iso(T0 + 2000 + 5000) })], WINDOW), /outside the host's launch-to-exit window/);
  fails(evaluateAttested(BEHAVIOUR, ANSWERS, [row({ ts: "garbage" })], WINDOW), /no readable time/);
  // a ts truncated to the second is tolerated by one second
  assert.equal(evaluateAttested(BEHAVIOUR, ANSWERS, [row({ ts: iso(T0 - 900) })], WINDOW).result, "pass");
});

// --- V9: the module holds the whole folder -------------------------------------------------------------------------------

test("V9: ledgerDir is a relative path the module holds; absolute paths and .. are refused", () => {
  assert.equal(validateEvidence(BEHAVIOUR), undefined);
  for (const bad of ["/etc", "../x", ".claude/../x", "", "a//b", ".claude/", "gateway ledger"]) assert.match(validateEvidence({ ...BEHAVIOUR, ledgerDir: bad }) ?? "", /ledgerDir/, bad);
});
