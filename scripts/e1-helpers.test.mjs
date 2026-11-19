// SPDX-License-Identifier: Apache-2.0

// Tests for the driver's guards (environment, update, host version, permission mode).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ALLOWED_VARIABLES, REFUSED_VARIABLES, MIN_HOST_VERSION, allowedEnv, judgeVersion, meetsFloor, permissionMode, refuseEnvironment, refuseUpdate, versionNumbers } from "./e1-helpers.mjs";

test("the allow-list and the refused list are the constants the brief names", () => {
  assert.deepEqual(ALLOWED_VARIABLES, ["PATH", "HOME", "TERM", "LANG", "USER", "SHELL"]);
  assert.deepEqual(REFUSED_VARIABLES, ["CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR", "CE_RTK_BIN"]);
});

test("allowedEnv keeps the allow-list and nothing else", () => {
  const env = { PATH: "/bin", HOME: "/h", TERM: "x", LANG: "C", USER: "u", SHELL: "/bin/zsh", TMPDIR: "/t", GITHUB_TOKEN: "t", LC_ALL: "C" };
  assert.deepEqual(allowedEnv(env), { PATH: "/bin", HOME: "/h", TERM: "x", LANG: "C", USER: "u", SHELL: "/bin/zsh" });
  assert.deepEqual(allowedEnv({ HOME: "/h" }), { HOME: "/h" });
});

for (const name of REFUSED_VARIABLES) {
  test(`environment refusal fires for ${name}, even set empty`, () => {
    assert.match(refuseEnvironment({ HOME: "/h", [name]: "/x" }), new RegExp(name));
    assert.match(refuseEnvironment({ HOME: "/h", [name]: "" }), new RegExp(name));
  });
}
test("environment refusal stays quiet on a clean environment", () => {
  assert.equal(refuseEnvironment({ HOME: "/h", PATH: "/bin" }), undefined);
});

test("update guard: exactly `claude update` and `pi update` are refused", () => {
  assert.match(refuseUpdate("claude", ["update"]), /claude update/);
  assert.match(refuseUpdate("pi", ["update"]), /pi update/);
});
test("update guard: plugin and extension updates run", () => {
  assert.equal(refuseUpdate("claude", ["plugin", "update", "tool-gateway@context-economy"]), undefined);
  assert.equal(refuseUpdate("pi", ["update", "--extensions"]), undefined);
  assert.equal(refuseUpdate("claude", ["--version"]), undefined);
  assert.equal(refuseUpdate("git", ["update"]), undefined);
});

test("version numbers are read as dotted numbers", () => {
  assert.deepEqual(versionNumbers("2.1.119 (Claude Code)"), [2, 1, 119]);
  assert.equal(versionNumbers("no number"), undefined);
});

test("judgeVersion: first, same, later (numerically), earlier, unreadable", () => {
  assert.equal(judgeVersion(undefined, "2.1.0").verdict, "first");
  assert.equal(judgeVersion("2.1.9", "2.1.9").verdict, "same");
  assert.equal(judgeVersion("2.1.9", "2.1.10").verdict, "later");
  assert.equal(judgeVersion("2.1.10", "2.1.9").verdict, "earlier");
  assert.equal(judgeVersion("1.9.9", "2.0.0").verdict, "later");
  assert.equal(judgeVersion("2.1.9", "garbage").verdict, "unreadable");
  assert.equal(judgeVersion("garbage", "2.1.9").verdict, "unreadable");
});

test("permissionMode refuses a non-default defaultMode and passes the default", () => {
  const home = mkdtempSync(join(tmpdir(), "e1-perm-"));
  const cwd = mkdtempSync(join(tmpdir(), "e1-perm-cwd-"));
  assert.equal(permissionMode({ home, cwd }).ok, true);
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }));
  const r = permissionMode({ home, cwd });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /acceptEdits/);
});

test("E12: managed settings are injected; an unparseable settings file is a problem, not a note", () => {
  const home = mkdtempSync(join(tmpdir(), "e1-perm-"));
  const cwd = mkdtempSync(join(tmpdir(), "e1-perm-cwd-"));
  const managed = join(mkdtempSync(join(tmpdir(), "e1-managed-")), "managed-settings.json");
  writeFileSync(managed, JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }));
  assert.equal(permissionMode({ home, cwd, managed: [] }).ok, true);
  assert.equal(permissionMode({ home, cwd, managed: [managed] }).ok, false);
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), "{ not json");
  const r = permissionMode({ home, cwd, managed: [] });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(";"), /unreadable/);
});

test("E8: the update guard compares the command's basename", () => {
  assert.match(refuseUpdate("/opt/homebrew/bin/pi", ["update"]), /pi update/);
  assert.match(refuseUpdate("/usr/local/bin/claude", ["update"]), /claude update/);
  assert.equal(refuseUpdate("/usr/bin/git", ["update"]), undefined);
  assert.equal(refuseUpdate("/opt/homebrew/bin/pi", ["--version"]), undefined);
});

test("host version floor: claude 2.1.273, pi 1.0.0; the floor itself is accepted", () => {
  assert.deepEqual({ ...MIN_HOST_VERSION }, { claude: "2.1.273", pi: "1.0.0" });
  for (const [host, v, ok] of [["claude", "2.1.273", true], ["claude", "2.1.272", false], ["claude", "2.0.999", false], ["claude", "2.2.0", true], ["claude", "3.0.0", true],
    ["pi", "1.0.0", true], ["pi", "0.73.1", false], ["pi", "0.99.9", false], ["pi", "1.0.1", true]]) assert.equal(meetsFloor(host, v), ok, `${host} ${v}`);
});

test("F1: every host the driver knows has a floor, and a host without one does not meet it", async () => {
  const { HOSTS } = await import("./e1-run.mjs");
  for (const host of HOSTS) assert.ok(MIN_HOST_VERSION[host], `${host} has a floor`);
  assert.equal(meetsFloor("codex", "99.0.0"), false);
});
