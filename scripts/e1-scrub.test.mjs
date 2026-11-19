// SPDX-License-Identifier: Apache-2.0

// Scrubber tests. They run the real gitleaks (the pinned version) with the project's config: the
// scrubber has no other engine, so a machine without it fails these tests, it does not skip them.
// Tokens are generated here at run time, never written into the repo.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GITLEAKS_VERSION, checkGitleaks, hitsReport, overlaps, scan, scrub } from "./e1-scrub.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, ".gitleaks.toml");
const alnum = (n) => randomBytes(n * 2).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, n);
const token = () => `ghp_${alnum(36)}`;
const pem = () => {
  const body = randomBytes(300).toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
};
const opts = (extra = {}) => ({ config: CONFIG, hostname: "mac", label: "mac", realHome: "/Users/realperson", ...extra });
const ownTmp = () => mkdtempSync(join(tmpdir(), "e1-scrubtest-"));

test("the pinned version is the one installed", () => {
  assert.deepEqual(checkGitleaks(), { ok: true });
});

test("S3: the driver's gitleaks version is the one CI installs", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const versions = new Set([...ci.matchAll(/gitleaks[ _-]v?(\d+\.\d+\.\d+)/gi)].map((m) => m[1]));
  assert.deepEqual([...versions], [GITLEAKS_VERSION]);
});

test("a clean transcript comes back unchanged with no hits", () => {
  const raw = "$ git status\nOn branch main\n";
  const r = scrub(raw, opts());
  assert.equal(r.ok, true);
  assert.equal(r.text, raw);
  assert.deepEqual(r.hits, []);
});

test("a token is scrubbed; the hit list has rule and line, never the value", () => {
  const t = token();
  const r = scrub(`line one\nexport GITHUB_TOKEN=${t}\nline three\n`, opts());
  assert.equal(r.ok, true);
  assert.ok(!r.text.includes(t));
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].line, 2);
  assert.ok(!JSON.stringify(r.hits).includes(t));
  assert.ok(!hitsReport(r.hits).includes(t));
});

test("the text is scrubbed whole: a token split over output chunks is joined first", () => {
  const t = token();
  const chunks = [`before ${t.slice(0, 10)}`, `${t.slice(10, 25)}`, `${t.slice(25)} after\n`];
  const r = scrub(chunks.join(""), opts());
  assert.equal(r.ok, true);
  assert.ok(!r.text.includes(t.slice(5, 30)));
});

test("a token a terminal wrapped across lines is scrubbed", () => {
  const t = token();
  const r = scrub(`GITHUB_TOKEN=${t.slice(0, 20)}\n${t.slice(20)}\n`, opts());
  assert.equal(r.ok, true);
  assert.ok(!r.text.includes(t.slice(20)));
});

test("a PEM private key block is scrubbed whole", () => {
  const key = pem();
  const r = scrub(`before\n${key}\nafter\n`, opts());
  assert.equal(r.ok, true);
  for (const line of key.split("\n").slice(1, -1)) assert.ok(!r.text.includes(line));
  // spans are widened by one character each side, so the neighbours may lose one
  assert.ok(r.text.includes("befor") && r.text.includes("after"));
});

test("false positives stay: commit SHAs, capture ids, ledger hashes", () => {
  const raw = [
    "3b86e7a1f0c2d4e5a6b7c8d9e0f1a2b3c4d5e6f7",
    "capture-id 7f3a9c1e-52b4-4d0e-9a61-0c8e2b7d4f15",
    JSON.stringify({ schema: 1, session: "s1", hash: randomBytes(32).toString("hex") }),
    "macos-arm64 0.1.2 linux-x86_64",
  ].join("\n");
  const r = scrub(raw, opts());
  assert.equal(r.ok, true);
  assert.equal(r.text, raw);
});

test("the machine name goes on word boundaries: a host named mac leaves macos-arm64 alone", () => {
  const r = scrub("run on mac, then macos-arm64 and Mac.local\nmac-mini stays; mac.\n", opts({ hostname: "mac" }));
  assert.equal(r.ok, true);
  assert.ok(r.text.includes("macos-arm64"));
  assert.ok(r.text.includes("mac-mini"));
  assert.ok(r.text.startsWith("run on mac, then"));
  assert.deepEqual(r.hits.map((h) => h.rule), ["machine-name", "machine-name", "machine-name"]);
});

test("a full machine name with a domain is scrubbed", () => {
  const r = scrub("host studio.example.net and studio\n", opts({ hostname: "studio.example.net", label: "mac" }));
  assert.equal(r.ok, true);
  assert.ok(!/studio/.test(r.text));
});

test("the OS user's real home is scrubbed whatever HOME is, and e-mail addresses too", () => {
  const r = scrub("/Users/realperson/work and /Users/drill2/x and me@example.com, git@github.com:o/r.git\n", opts());
  assert.equal(r.ok, true);
  assert.ok(!r.text.includes("/Users/realperson"));
  assert.ok(!r.text.includes("me@example.com"));
  assert.ok(r.text.includes("git@github.com"));
});

test("overlaps reports an assertion match that falls inside a scrubbed span", () => {
  const t = token();
  const raw = `a ${t} b\n`;
  const r = scrub(raw, opts());
  const at = raw.indexOf(t);
  assert.equal(overlaps(r.spans, at + 2, at + 6), true);
  assert.equal(overlaps(r.spans, 0, 1), false);
});

test("gitleaks missing: no scrubbed copy", () => {
  const r = scrub("text\n", opts({ bin: join(tmpdir(), "no-such-gitleaks") }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /not installed/);
  assert.equal(r.text, undefined);
});

test("gitleaks of another version: no scrubbed copy", () => {
  const run = () => ({ status: 0, stdout: "8.0.0\n", stderr: "" });
  const r = scrub("text\n", opts({ run }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /not the pinned/);
});

/** A run that is the real gitleaks, with `change(args, result, call)` applied to scans (not to `version`). */
function wrapRun(change) {
  let call = 0;
  return (bin, args, o) => {
    const r = spawnSync(bin, args, o);
    if (args[0] !== "dir") return r;
    return change(args, r, ++call) ?? r;
  };
}
const reportPath = (args) => args[args.indexOf("--report-path") + 1];

test("S1.4: gitleaks exits with an error: no scrubbed copy", () => {
  const tmp = ownTmp();
  const r = scrub("text\n", opts({ tmp, run: wrapRun((a, r) => ({ ...r, status: 2 })) }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /exited 2/);
  assert.deepEqual(readdirSync(tmp), []);
});

test("S1.4: a bad config (exit 1, empty report) is not read as 'leaks found'", () => {
  const r = scrub("text\n", opts({ config: join(tmpdir(), "no-such-config.toml") }));
  assert.equal(r.ok, false);
});

test("S1.4: exit 1 with an empty report is not read as 'leaks found' (a bad config exits 1 too)", () => {
  const r = scrub("text\n", opts({ run: wrapRun((a, r) => ({ ...r, status: 1 })) }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /exited 1 with no findings/);
});

test("S1.4: a config that does not load: no scrubbed copy", () => {
  const bad = join(mkdtempSync(join(tmpdir(), "e1-badcfg-")), "bad.toml");
  writeFileSync(bad, "not toml [[[");
  assert.equal(scrub("text\n", opts({ config: bad })).ok, false);
});

test("S1.4: the report is absent: no scrubbed copy", () => {
  const run = wrapRun((args, r) => { try { writeFileSync(reportPath(args), ""); } catch {} return { ...r, _: 0 }; });
  const noReport = (bin, args, o) => {
    const r = run(bin, args, o);
    if (args[0] === "dir") spawnSync("rm", ["-f", reportPath(args)]);
    return r;
  };
  const r = scrub("text\n", opts({ run: noReport }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /no report/);
});

test("S1.4: the report is not JSON: no scrubbed copy", () => {
  const r = scrub("text\n", opts({ run: wrapRun((args, r) => { writeFileSync(reportPath(args), "not json {"); return r; }) }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /not JSON/);
});

test("S1.4: a token surviving a deliberately short span is caught by the second pass", () => {
  const t = token();
  const raw = `ok\nGITHUB_TOKEN=${t}\n`;
  // The first two scans (raw and unwrapped) are made to report a harmless two characters instead.
  const run = wrapRun((args, r, call) => {
    if (call > 2) return r;
    writeFileSync(reportPath(args), JSON.stringify([{ RuleID: "planted", Secret: "ok", StartLine: 1, EndLine: 1, StartColumn: 1, EndColumn: 2 }]));
    return { ...r, status: 1 };
  });
  const r = scrub(raw, opts({ run }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /second pass found/);
  assert.equal(r.text, undefined);
});

test("scan removes its temporary folder, report included", () => {
  const tmp = ownTmp();
  const s = scan(`x ${token()}\n`, { config: CONFIG, tmp });
  assert.equal(s.ok, true);
  assert.equal(s.findings.length, 1);
  assert.deepEqual(readdirSync(tmp), []);
});

test("E6: non-ASCII text before a finding does not widen the scrubbed span", () => {
  const t = token();
  const raw = `── RTK ✓ — gain ──\nkey: ${t} and ordinary text after it\n`;
  const r = scrub(raw, opts({ tmp: ownTmp() }));
  assert.equal(r.ok, true);
  assert.ok(!r.text.includes(t));
  assert.ok(r.text.includes(" and ordinary text after it"));
});

test("E6: with no secret in the report, line and column are converted from bytes to characters", () => {
  const raw = "✓✓✓ abc SECRETVALUE tail\n";
  const start = Buffer.byteLength("✓✓✓ abc ") + 1; // 1-based byte column of SECRETVALUE
  const end = start + "SECRETVALUE".length - 1;
  let first = true;
  const run = (bin, args, o) => {
    if (args[0] === "version") return spawnSync(bin, args, o);
    const report = args[args.indexOf("--report-path") + 1];
    const hasValue = readFileSync(args.at(-1), "utf8").includes("SECRETVALUE");
    if (!hasValue) { writeFileSync(report, "[]"); return { status: 0, stdout: "", stderr: "" }; }
    writeFileSync(report, JSON.stringify([{ RuleID: "fake", Secret: "", StartLine: 1, EndLine: 1, StartColumn: start, EndColumn: end }]));
    return { status: 1, stdout: "", stderr: "" };
  };
  const r = scrub(raw, opts({ tmp: ownTmp(), run }));
  assert.equal(r.ok, true);
  assert.ok(!r.text.includes("SECRETVALUE"));
  // the span keeps its one-column margin (rules differ by one); a byte/character mix-up would eat six more
  assert.ok(r.text.startsWith("✓✓✓ ab"));
  assert.ok(r.text.includes("tail"));
});

test("E10: the scan copy lives under the folder given, and nothing is left behind", () => {
  const tmp = ownTmp();
  const seen = [];
  const real = spawnSync;
  const run = (bin, args, o) => { const input = args.at(-1); seen.push(input); return real(bin, args, o); };
  const r = scrub("plain text\n", opts({ tmp, run }));
  assert.equal(r.ok, true);
  assert.ok(seen.filter((p) => p.endsWith("input.txt")).every((p) => p.startsWith(tmp)));
  assert.deepEqual(readdirSync(tmp), []);
});

test("E11: a machine name merged with a secret shows [scrubbed:…], not the machine label", () => {
  const t = token();
  // the machine name "ghp" matches as a whole word at the start of the token (`_` is not a word character here), so the two spans merge
  const r = scrub(`key ${t}\n`, opts({ hostname: "ghp", label: "LABELX", tmp: ownTmp() }));
  assert.equal(r.ok, true);
  assert.ok(!r.text.includes("LABELX"));
  assert.match(r.text, /\[scrubbed:/);
});

test("E11: a machine-name span that starts first and merges with a secret span still shows [scrubbed:…]", () => {
  const raw = "see box_k_tail here\n";
  const run = (bin, args, o) => {
    if (args[0] === "version") return spawnSync(bin, args, o);
    const report = args[args.indexOf("--report-path") + 1];
    if (!readFileSync(args.at(-1), "utf8").includes("k_tail")) { writeFileSync(report, "[]"); return { status: 0, stdout: "", stderr: "" }; }
    writeFileSync(report, JSON.stringify([{ RuleID: "fake", Secret: "k_tail", StartLine: 1, EndLine: 1, StartColumn: 9, EndColumn: 14 }]));
    return { status: 1, stdout: "", stderr: "" };
  };
  const r = scrub(raw, opts({ hostname: "box_k", label: "LABELX", tmp: ownTmp(), run }));
  assert.equal(r.ok, true);
  assert.ok(!r.text.includes("LABELX"));
  assert.match(r.text, /\[scrubbed:/);
});
