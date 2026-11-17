// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { proofErrors } from "./check-release-proof.mjs";
import { capturePath, main, parseSteps, runPath } from "./e1a-record.mjs";
import { must } from "./release-lib.mjs";
import { commitAll, fixtureRepo, PI_EXTENSIONS, PLUGINS, writeJson } from "./test-fixture.mjs";

const CAPTURE_PASS = "install=pass,behavior=pass";
const UNINSTALL_PASS = "uninstall=pass";

/** A candidate repo plus host records: Claude's installed_plugins.json and a Pi clone. */
function hosts({ claudeAt, piAt, missing = [] } = {}) {
  const fx = fixtureRepo("0.1.0");
  const sha = must(fx.run, "git", ["rev-parse", "HEAD"]);
  const other = commitAll(fx.run, "later");
  const home = mkdtempSync(join(tmpdir(), "e1a-home-"));
  const config = join(home, "claude");
  const agent = join(home, "pi");
  const clone = join(agent, "git", "github.com", "o", "staging");
  const at = (x) => (x === "other" ? other : sha);
  /** Install both hosts: Claude entries at `claudeAt`, a Pi clone at `piAt`. */
  const install = () => {
    writeJson(config, "plugins/installed_plugins.json", {
      version: 2,
      plugins: Object.fromEntries(PLUGINS.filter((p) => !missing.includes(p)).map((p) => [`${p}@context-economy`, [{ gitCommitSha: at(claudeAt) }]])),
    });
    mkdirSync(join(agent, "git", "github.com", "o"), { recursive: true });
    must(fx.run, "git", ["clone", "-q", fx.root, clone]);
    must(fx.run, "git", ["-C", clone, "checkout", "-q", "--detach", at(piAt)]);
  };
  /** What a successful uninstall leaves: no candidate Claude entries, no Pi clone. */
  const uninstall = ({ claude = true, pi = true } = {}) => {
    if (claude) writeJson(config, "plugins/installed_plugins.json", { version: 2, plugins: {} });
    if (pi) rmSync(clone, { recursive: true, force: true });
  };
  install();
  const broken = new Set();
  const run = (cmd, args) => {
    if (broken.has(cmd)) return { code: 1, stdout: "", stderr: `${cmd}: broken` };
    if (cmd === "claude" && args[0] === "--version") return { code: 0, stdout: "2.1.310 (Claude Code)", stderr: "" };
    if (cmd === "pi" && args[0] === "--version") return { code: 0, stdout: "1.0.2", stderr: "" };
    return fx.run(cmd, args);
  };
  const logs = [];
  /** `extra` flags replace the defaults of the same name; `env` entries replace the host locations. */
  const record = (command, platform, extra = [], env = {}) => main(
    [command, ...Object.entries({
      version: "0.1.0", sha,
      ...(command === "combine" ? {} : {
        platform, "pi-repo": "o/staging",
        claude: command === "capture" ? CAPTURE_PASS : UNINSTALL_PASS, pi: command === "capture" ? CAPTURE_PASS : UNINSTALL_PASS,
      }),
      ...Object.fromEntries(extra.flatMap((v, k) => (k % 2 ? [] : [[v.slice(2), extra[k + 1]]]))),
    }).flatMap(([k, v]) => [`--${k}`, v])],
    { env: { CLAUDE_CONFIG_DIR: config, PI_CODING_AGENT_DIR: agent, HOME: home, ...env }, root: fx.root, run, log: { log: (m) => logs.push(m), error: (m) => logs.push(m) } },
  );
  const readIf = (file) => (existsSync(join(fx.root, file)) ? JSON.parse(readFileSync(join(fx.root, file), "utf8")) : undefined);
  /** The combined proof `combine` writes. */
  const proof = () => readIf("docs/release-proof/0.1.0.json");
  /** One platform's run file, as finalize leaves it on that machine. */
  const runFile = (platform) => readIf(runPath("0.1.0", platform));
  const runOf = (platform) => runFile(platform)?.runs.find((r) => r.platform === platform);
  const captured = (platform) => existsSync(join(fx.root, capturePath("0.1.0", platform)));
  const expected = { version: "0.1.0", sha, plugins: PLUGINS, extensions: PI_EXTENSIONS };
  return { fx, sha, home, config, clone, broken, install, uninstall, record, proof, runFile, runOf, captured, expected, logs };
}

/** install → capture → uninstall → finalize, for one platform. */
function lifecycle(h, platform, { finalize = [] } = {}) {
  assert.equal(h.record("capture", platform), 0, h.logs.join("\n"));
  h.uninstall();
  return h.record("finalize", platform, finalize);
}

test("each platform writes its own run file; combine gives a proof the checker accepts", () => {
  const h = hosts();
  assert.equal(lifecycle(h, "macos-arm64"), 0, h.logs.join("\n"));
  assert.equal(h.proof(), undefined, "finalize writes no combined proof");
  h.install();
  assert.equal(lifecycle(h, "linux-x86_64"), 0, h.logs.join("\n"));
  assert.equal(h.runFile("macos-arm64").runs.length, 1, "the other platform's file is untouched");
  assert.equal(h.runFile("linux-x86_64").runs.length, 1);
  assert.equal(h.record("combine"), 0, h.logs.join("\n"));
  assert.deepEqual(proofErrors(h.proof(), h.expected), []);
  assert.deepEqual(h.proof().runs.map((r) => r.platform), ["macos-arm64", "linux-x86_64"]);
  const run = h.runOf("macos-arm64");
  assert.deepEqual(run.plugins, Object.fromEntries(PLUGINS.map((p) => [p, h.sha])));
  assert.equal(run.pi.installed_commit, h.sha);
  assert.equal(run.claude_code_version, "2.1.310 (Claude Code)");
  assert.equal(run.pi.pi_version, "1.0.2");
  assert.deepEqual(run.pi.extensions, PI_EXTENSIONS);
  assert.ok(!h.captured("macos-arm64") && !h.captured("linux-x86_64"), "finalize consumes the capture");
});

test("finalize does not reread the hosts' commits: the captured SHAs survive uninstall", () => {
  const h = hosts();
  lifecycle(h, "macos-arm64");
  const run = h.runOf("macos-arm64");
  assert.equal(run.steps.installed_commit, "pass");
  assert.equal(run.pi.steps.installed_commit, "pass");
  assert.equal(run.steps.uninstall, "pass");
});

test("a failed uninstall is recorded: attested fail, or installs still present", () => {
  const a = hosts();
  assert.equal(lifecycle(a, "macos-arm64", { finalize: ["--pi", "uninstall=fail"] }), 1);
  assert.equal(a.runOf("macos-arm64").pi.steps.uninstall, "fail");
  assert.equal(a.runOf("macos-arm64").result, "pass");

  const b = hosts();
  assert.equal(b.record("capture", "macos-arm64"), 0);
  b.uninstall({ pi: false });
  assert.equal(b.record("finalize", "macos-arm64"), 1);
  assert.equal(b.runOf("macos-arm64").pi.steps.uninstall, "fail");
  assert.match(b.logs.join("\n"), /still installed: Pi clone o\/staging/);
  assert.ok(proofErrors(b.runFile("macos-arm64"), b.expected).some((e) => /pi step uninstall is fail/.test(e)));
});

test("a failed capture stays failed through finalize", () => {
  const a = hosts({ claudeAt: "other" });
  assert.equal(a.record("capture", "macos-arm64"), 1);
  a.uninstall();
  assert.equal(a.record("finalize", "macos-arm64"), 1);
  assert.equal(a.runOf("macos-arm64").steps.installed_commit, "fail");
  assert.ok(proofErrors(a.runFile("macos-arm64"), a.expected).some((e) => /installed at/.test(e)));

  const b = hosts({ missing: ["third-plugin"], piAt: "other" });
  assert.equal(b.record("capture", "macos-arm64", ["--pi", "install=pass,behavior=fail"]), 1);
  b.uninstall();
  assert.equal(b.record("finalize", "macos-arm64"), 1);
  const run = b.runOf("macos-arm64");
  assert.equal(run.pi.steps.behavior, "fail");
  assert.equal(run.pi.steps.installed_commit, "fail");
  assert.ok(proofErrors(b.runFile("macos-arm64"), b.expected).some((e) => /plugin third-plugin missing/.test(e)));
});

test("finalize needs this candidate's capture for this platform, and uses it once", () => {
  const h = hosts();
  assert.equal(h.record("finalize", "macos-arm64"), 2);
  assert.match(h.logs.at(-1), /no capture for 0.1.0 on macos-arm64/);

  assert.equal(h.record("capture", "macos-arm64"), 0);
  h.uninstall();
  assert.equal(h.record("finalize", "linux-x86_64"), 2, "another platform has no capture");
  assert.equal(h.record("finalize", "macos-arm64", ["--sha", "c".repeat(40)]), 2);
  assert.match(h.logs.at(-1), /capture is for 0.1.0 at [0-9a-f]{40} on macos-arm64, not 0.1.0 at c{40}/);
  assert.ok(h.captured("macos-arm64"), "a refused finalize leaves the capture");

  // The capture itself names another candidate: refused, even with no proof file yet.
  const file = join(h.fx.root, capturePath("0.1.0", "macos-arm64"));
  const capture = JSON.parse(readFileSync(file, "utf8"));
  writeJson(h.fx.root, capturePath("0.1.0", "macos-arm64"), { ...capture, candidate_sha: "d".repeat(40) });
  assert.equal(h.record("finalize", "macos-arm64"), 2);
  assert.match(h.logs.at(-1), /capture is for 0.1.0 at d{40} on macos-arm64/);
  writeJson(h.fx.root, capturePath("0.1.0", "macos-arm64"), capture);

  assert.equal(h.record("finalize", "macos-arm64"), 0);
  assert.equal(h.record("finalize", "macos-arm64"), 2, "a capture is consumed by finalize");
});

test("a new capture drops the platform's earlier run; its evidence is never reused", () => {
  const h = hosts();
  assert.equal(lifecycle(h, "macos-arm64"), 0);
  const first = h.runOf("macos-arm64").capture_id;
  h.install();
  assert.equal(h.record("capture", "macos-arm64", ["--claude", "install=pass,behavior=fail"]), 1);
  assert.equal(h.runOf("macos-arm64"), undefined, "the passing run is gone while the new attempt is open");
  h.uninstall();
  assert.equal(h.record("finalize", "macos-arm64"), 1);
  assert.notEqual(h.runOf("macos-arm64").capture_id, first);
  assert.equal(h.runOf("macos-arm64").steps.behavior, "fail");
  assert.equal(h.runFile("macos-arm64").runs.length, 1);
});

test("bad arguments or an existing run file for another candidate are refused without writing", () => {
  const h = hosts();
  assert.equal(h.record("capture", "windows-x86_64"), 2);
  assert.equal(h.record("record", "macos-arm64"), 2);
  assert.equal(h.record("capture", "macos-arm64", ["--claude", "install=pass,behavior=pass,uninstall=pass"]), 2, "uninstall is not attested at capture");
  assert.equal(h.record("finalize", "macos-arm64", ["--pi", "uninstall=pass,install=pass"]), 2);
  assert.throws(() => parseSteps("install=pass", ["install", "behavior"]), /behavior not given/);
  assert.throws(() => parseSteps("install=ok,behavior=pass", ["install", "behavior"]), /bad step/);
  assert.throws(() => parseSteps("installed_commit=pass,install=pass,behavior=pass", ["install", "behavior"]), /bad step/);
  writeJson(h.fx.root, runPath("0.1.0", "macos-arm64"), { version: "0.1.0", tag: "v0.1.0", candidate_sha: "b".repeat(40), runs: [] });
  assert.equal(h.record("capture", "macos-arm64"), 2);
  assert.match(h.logs.at(-1), /existing run file is for 0.1.0 at b{40}/);
  assert.equal(h.runFile("macos-arm64").candidate_sha, "b".repeat(40));
  assert.ok(!h.captured("macos-arm64"));
});

test("finalize is bound to the captured Pi repository and host directories", () => {
  const h = hosts();
  assert.equal(h.record("capture", "macos-arm64"), 0);
  h.uninstall({ pi: false });
  const elsewhere = mkdtempSync(join(tmpdir(), "e1a-elsewhere-"));
  const refusals = [
    [["--pi-repo", "o/other"], {}, /capture pi_repo is o\/staging, not o\/other/],
    [[], { PI_CODING_AGENT_DIR: elsewhere }, /capture pi_agent_dir is .*: finalize where you captured/],
    [[], { CLAUDE_CONFIG_DIR: elsewhere }, /capture claude_config_dir is .*: finalize where you captured/],
    [[], { CLAUDE_CONFIG_DIR: "", PI_CODING_AGENT_DIR: "", HOME: elsewhere }, /capture claude_config_dir/],
  ];
  for (const [extra, env, message] of refusals) {
    assert.equal(h.record("finalize", "macos-arm64", extra, env), 2);
    assert.match(h.logs.at(-1), message);
    assert.ok(h.captured("macos-arm64"), "a refused finalize leaves the capture");
    assert.equal(h.runFile("macos-arm64"), undefined, "and writes no run file");
  }
  // At the captured origin, the original Pi clone is still there: uninstall fails.
  assert.equal(h.record("finalize", "macos-arm64"), 1);
  assert.equal(h.runOf("macos-arm64").pi.steps.uninstall, "fail");
  assert.equal(h.runOf("macos-arm64").steps.uninstall, "pass");

  const g = hosts();
  assert.equal(g.record("capture", "macos-arm64"), 0);
  const file = join(g.fx.root, capturePath("0.1.0", "macos-arm64"));
  const { origin, ...bare } = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(origin.pi_repo, "o/staging");
  writeJson(g.fx.root, capturePath("0.1.0", "macos-arm64"), bare);
  g.uninstall();
  assert.equal(g.record("finalize", "macos-arm64"), 2);
  assert.match(g.logs.at(-1), /capture origin pi_repo is missing/);
});

test("a recapture that fails while probing the hosts leaves no earlier pass or pending capture", () => {
  // A host version query fails after a passing run.
  const a = hosts();
  assert.equal(lifecycle(a, "macos-arm64"), 0);
  a.install();
  a.broken.add("claude");
  assert.equal(a.record("capture", "macos-arm64"), 2);
  assert.match(a.logs.at(-1), /claude --version failed/);
  assert.equal(a.runOf("macos-arm64"), undefined);
  assert.ok(!a.captured("macos-arm64"));
  assert.equal(a.runFile("macos-arm64"), undefined, "the earlier run file is gone");

  // A malformed host record, with a pending capture from an earlier attempt.
  const b = hosts();
  assert.equal(b.record("capture", "macos-arm64"), 0);
  writeFileSync(join(b.config, "plugins", "installed_plugins.json"), "{not json");
  assert.equal(b.record("capture", "macos-arm64"), 2);
  assert.ok(!b.captured("macos-arm64"), "the pending capture is gone");
  b.uninstall();
  assert.equal(b.record("finalize", "macos-arm64"), 2);
  assert.match(b.logs.at(-1), /no capture for 0.1.0 on macos-arm64/);

  // A bad request or another candidate's pending capture destroys nothing.
  const c = hosts();
  assert.equal(lifecycle(c, "macos-arm64"), 0);
  c.install();
  assert.equal(c.record("capture", "macos-arm64"), 0);
  assert.equal(c.record("capture", "macos-arm64", ["--claude", "install=pass"]), 2);
  assert.equal(c.record("capture", "macos-arm64", ["--sha", "e".repeat(40)]), 2);
  assert.ok(c.captured("macos-arm64"));
  const file = join(c.fx.root, capturePath("0.1.0", "macos-arm64"));
  writeJson(c.fx.root, capturePath("0.1.0", "macos-arm64"), { ...JSON.parse(readFileSync(file, "utf8")), candidate_sha: "f".repeat(40) });
  assert.equal(c.record("capture", "macos-arm64"), 2);
  assert.match(c.logs.at(-1), /a pending capture is for 0.1.0 at f{40}/);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).candidate_sha, "f".repeat(40));
});

test("combine needs every platform's finalized run file for this candidate, and reads no host", () => {
  const h = hosts();
  assert.equal(h.record("combine"), 2);
  assert.match(h.logs.at(-1), /no run file for macos-arm64, linux-x86_64/);

  assert.equal(lifecycle(h, "macos-arm64"), 0);
  assert.equal(h.record("combine"), 2);
  assert.match(h.logs.at(-1), /no run file for linux-x86_64: copy docs\/release-proof\/0.1.0-linux-x86_64.json from that machine/);
  assert.equal(h.proof(), undefined);

  // A pending capture means that machine has not finalized.
  h.install();
  assert.equal(h.record("capture", "linux-x86_64"), 0);
  assert.equal(h.record("combine"), 2);
  assert.match(h.logs.at(-1), /a capture is pending for linux-x86_64/);
  h.uninstall();
  assert.equal(h.record("finalize", "linux-x86_64"), 0);

  const linux = h.runFile("linux-x86_64");
  const refusals = [
    [{ ...linux, candidate_sha: "a".repeat(40) }, /existing docs\/release-proof\/0.1.0-linux-x86_64.json is for 0.1.0 at a{40}/],
    [{ ...linux, runs: [{ ...linux.runs[0], platform: "macos-arm64" }] }, /must hold exactly one linux-x86_64 run/],
    [{ ...linux, runs: [...linux.runs, linux.runs[0]] }, /must hold exactly one linux-x86_64 run/],
  ];
  for (const [file, message] of refusals) {
    writeJson(h.fx.root, runPath("0.1.0", "linux-x86_64"), file);
    assert.equal(h.record("combine"), 2);
    assert.match(h.logs.at(-1), message);
    assert.equal(h.proof(), undefined, "a refused combine writes nothing");
  }
  writeJson(h.fx.root, runPath("0.1.0", "linux-x86_64"), linux);
  assert.equal(h.record("combine", undefined, ["--sha", "c".repeat(40)]), 2);
  assert.match(h.logs.at(-1), /is for 0.1.0 at [0-9a-f]{40}, not 0.1.0 at c{40}/);

  h.broken.add("claude").add("pi").add("git");
  assert.equal(h.record("combine"), 0, h.logs.join("\n"));
  assert.deepEqual(proofErrors(h.proof(), h.expected), []);
  assert.ok(h.runFile("macos-arm64") && h.runFile("linux-x86_64"), "combine keeps the run files");
});

test("combine records a failed platform run as it is", () => {
  const h = hosts();
  assert.equal(lifecycle(h, "macos-arm64", { finalize: ["--pi", "uninstall=fail"] }), 1);
  h.install();
  assert.equal(lifecycle(h, "linux-x86_64"), 0);
  assert.equal(h.record("combine"), 1);
  assert.ok(proofErrors(h.proof(), h.expected).some((e) => /macos-arm64: pi step uninstall is fail/.test(e)));
});

/** Both platforms finalized and combined: a passing combined proof to start from. */
function combinedPass() {
  const h = hosts();
  assert.equal(lifecycle(h, "macos-arm64"), 0);
  h.install();
  assert.equal(lifecycle(h, "linux-x86_64"), 0);
  assert.equal(h.record("combine"), 0, h.logs.join("\n"));
  assert.deepEqual(proofErrors(h.proof(), h.expected), []);
  return h;
}

test("from a passing combined proof, an aborted recapture leaves no passing proof", () => {
  const h = combinedPass();
  h.install();
  h.broken.add("pi");
  assert.equal(h.record("capture", "macos-arm64"), 2);
  assert.match(h.logs.at(-1), /pi --version failed/);
  assert.equal(h.proof(), undefined, "the combined proof is removed before the hosts are probed");
  assert.equal(h.runFile("macos-arm64"), undefined);
  assert.equal(h.record("combine"), 2);
  assert.match(h.logs.at(-1), /no run file for macos-arm64/);
  assert.equal(h.proof(), undefined);
});

test("from a passing combined proof, a pending capture leaves no passing proof", () => {
  const h = combinedPass();
  h.install();
  assert.equal(h.record("capture", "linux-x86_64"), 0);
  assert.equal(h.proof(), undefined);
  assert.equal(h.record("combine"), 2);
  assert.match(h.logs.at(-1), /a capture is pending for linux-x86_64/);
  assert.equal(h.proof(), undefined);
});

test("from a passing combined proof, a refused combine removes it", () => {
  const h = combinedPass();
  rmSync(join(h.fx.root, runPath("0.1.0", "linux-x86_64")));
  assert.equal(h.record("combine"), 2);
  assert.match(h.logs.at(-1), /no run file for linux-x86_64/);
  assert.equal(h.proof(), undefined, "the earlier combined proof does not survive a refused combine");
});

test("from a passing combined proof, a failed replacement run makes the recombined proof fail", () => {
  const h = combinedPass();
  h.install();
  assert.equal(h.record("capture", "macos-arm64", ["--claude", "install=pass,behavior=fail"]), 1);
  assert.equal(h.proof(), undefined);
  h.uninstall();
  assert.equal(h.record("finalize", "macos-arm64"), 1);
  assert.equal(h.proof(), undefined);
  assert.equal(h.record("combine"), 1);
  assert.ok(proofErrors(h.proof(), h.expected).some((e) => /macos-arm64: step behavior is fail/.test(e)));
});

test("a passing combined proof survives bad arguments and requests for another candidate", () => {
  const h = combinedPass();
  const before = readFileSync(join(h.fx.root, "docs/release-proof/0.1.0.json"), "utf8");
  const unchanged = () => assert.equal(readFileSync(join(h.fx.root, "docs/release-proof/0.1.0.json"), "utf8"), before);
  h.install();
  assert.equal(h.record("capture", "windows-x86_64"), 2);
  assert.equal(h.record("capture", "macos-arm64", ["--claude", "install=pass"]), 2);
  assert.equal(h.record("capture", "macos-arm64", ["--sha", "e".repeat(40)]), 2);
  assert.equal(h.record("finalize", "macos-arm64"), 2, "no capture to finalize");
  assert.equal(h.record("combine", undefined, ["--sha", "e".repeat(40)]), 2);
  unchanged();

  // No run files left, only the combined proof: another candidate's request still leaves it alone.
  for (const p of ["macos-arm64", "linux-x86_64"]) rmSync(join(h.fx.root, runPath("0.1.0", p)));
  assert.equal(h.record("capture", "macos-arm64", ["--sha", "e".repeat(40)]), 2);
  assert.match(h.logs.at(-1), /existing combined proof is for 0.1.0 at [0-9a-f]{40}, not 0.1.0 at e{40}/);
  assert.equal(h.record("combine", undefined, ["--sha", "e".repeat(40)]), 2);
  assert.match(h.logs.at(-1), /existing combined proof is for/);
  unchanged();
});

test("combine checks every run file's identity before it removes the combined proof", () => {
  const h = combinedPass();
  const file = join(h.fx.root, "docs/release-proof/0.1.0.json");
  const before = readFileSync(file, "utf8");
  const linux = h.runFile("linux-x86_64");
  const mismatched = [
    [{ ...linux, candidate_sha: "a".repeat(40) }, /existing docs\/release-proof\/0.1.0-linux-x86_64.json is for 0.1.0 at a{40}/],
    [{ ...linux, version: "0.0.9" }, /existing docs\/release-proof\/0.1.0-linux-x86_64.json is for 0.0.9/],
    [{ ...linux, runs: [{ ...linux.runs[0], platform: "macos-arm64" }] }, /must hold exactly one linux-x86_64 run/],
  ];
  for (const [run, message] of mismatched) {
    writeJson(h.fx.root, runPath("0.1.0", "linux-x86_64"), run);
    assert.equal(h.record("combine"), 2);
    assert.match(h.logs.at(-1), message);
    assert.equal(readFileSync(file, "utf8"), before, "a mismatched run file leaves the combined proof untouched");
  }
  // With the run file restored, a missing platform still invalidates (a valid recombination refused).
  writeJson(h.fx.root, runPath("0.1.0", "linux-x86_64"), linux);
  rmSync(join(h.fx.root, runPath("0.1.0", "macos-arm64")));
  assert.equal(h.record("combine"), 2);
  assert.equal(h.proof(), undefined);
});

test("a valid finalize removes a coexisting combined proof before it reads the host records", () => {
  const h = combinedPass();
  const file = join(h.fx.root, "docs/release-proof/0.1.0.json");
  const before = readFileSync(file, "utf8");
  h.install();
  assert.equal(h.record("capture", "macos-arm64"), 0);
  writeFileSync(file, before); // a combined proof copied in beside the pending capture
  h.uninstall();
  writeFileSync(join(h.config, "plugins", "installed_plugins.json"), "{not json");
  assert.equal(h.record("finalize", "macos-arm64"), 2, "the host probe fails");
  assert.equal(h.proof(), undefined, "the earlier combined proof is gone");
  assert.ok(h.captured("macos-arm64"), "the capture is kept for a retry");

  // An invalid finalize (wrong origin) leaves a coexisting combined proof alone.
  writeFileSync(file, before);
  assert.equal(h.record("finalize", "macos-arm64", ["--pi-repo", "o/other"]), 2);
  assert.equal(readFileSync(file, "utf8"), before);
});
