// SPDX-License-Identifier: Apache-2.0

// scripts/install-rtk.sh must fail closed like the README block it replaces: an unsupported platform,
// a failed download, a missing, ambiguous or mismatched checksum, or a wrong version stops it before
// anything is installed or the config is touched. Runs the script under bash with stand-ins for curl
// and uname that serve local, synthetic files. No network.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, symlinkSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "install-rtk.sh");
const MAC = "rtk-aarch64-apple-darwin.tar.gz";
const LINUX = "rtk-x86_64-unknown-linux-musl.tar.gz";
const which = (cmd) => spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).stdout.trim() || undefined;
const TOOLS = { shasum: which("shasum"), sha256sum: which("sha256sum") };
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** A tar.gz holding an `rtk` script that leaves `marker` when run and prints `version`. */
function archive(dir, name, marker, version, symlink = false) {
  const src = mkdtempSync(join(tmpdir(), "rtk-src-"));
  if (symlink) symlinkSync("/bin/echo", join(src, "rtk"));
  else {
    writeFileSync(join(src, "rtk"), `#!/bin/sh\ntouch '${marker}'\necho "rtk ${version}"\n`);
    chmodSync(join(src, "rtk"), 0o755);
  }
  execFileSync("tar", ["-czf", join(dir, name), "-C", src, "rtk"]);
}

/**
 * One run in a fresh HOME. `tamper` alters the served archive after hashing, `dropEntry` removes its
 * checksum line, `dropAsset` makes its download fail, `dup` adds a second entry with another hash,
 * `sep` separates hash and name in checksums.txt, `version` is what the archive's rtk prints,
 * `config` is a pre-existing config.json, `symlink` makes the archive's rtk a symlink, `homeSuffix` is appended to the HOME folder's name, `home` reuses an earlier run's HOME.
 */
function run({ asset = MAC, os = "Darwin", arch = "arm64", tamper = false, dropEntry = false, dropAsset = false, dup = "", sep = "  ", version = "0.47.0", symlink = false, homeSuffix = "", config, home } = {}) {
  const w = mkdtempSync(join(tmpdir(), "install-rtk-"));
  const marker = join(w, "RAN");
  const real = join(w, "real");
  const served = join(w, "served");
  const bin = join(w, "bin");
  for (const d of [real, served, bin]) mkdirSync(d);
  archive(real, asset, marker, version, symlink);
  writeFileSync(join(served, "checksums.txt"), [
    `${"0".repeat(64)}  rtk-x86_64-pc-windows-msvc.zip`,
    ...(dup === "before" ? [`${"b".repeat(64)} *${asset}`] : []),
    ...(dropEntry ? [] : [`${sha256(join(real, asset))}${sep}${asset}`]),
    ...(dup === "after" ? [`${"b".repeat(64)} *${asset}`] : []),
    "",
  ].join("\n"));
  if (!dropAsset) {
    writeFileSync(join(served, asset), readFileSync(join(real, asset)));
    if (tamper) appendFileSync(join(served, asset), "x");
  }
  const calls = join(w, "calls");
  const stub = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("curl", `echo "curl $*" >> '${calls}'\nfor a; do url=$a; done\nf=$(basename "$url")\n[ -f '${served}'/"$f" ] || { echo "curl: (22) 404 $f" >&2; exit 22; }\ncp '${served}'/"$f" "$f"`);
  stub("uname", `case "$1" in -s) echo ${os} ;; -m) echo ${arch} ;; esac`);
  for (const [tool, path] of Object.entries(TOOLS)) if (path) stub(tool, `echo "${tool}" >> '${calls}'\nexec '${path}' "$@"`);
  const h = home ?? join(w, `home${homeSuffix}`);
  mkdirSync(h, { recursive: true });
  if (config !== undefined) {
    mkdirSync(join(h, ".claude/context-economy"), { recursive: true });
    writeFileSync(join(h, ".claude/context-economy/config.json"), config);
  }
  const r = spawnSync("bash", [SCRIPT], { cwd: w, encoding: "utf8", env: { HOME: h, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` } });
  const opt = join(h, ".local/opt/rtk-0.47.0");
  return {
    code: r.status,
    out: r.stdout + r.stderr,
    home: h,
    rtk: join(opt, "rtk"),
    installed: existsSync(join(opt, "rtk")),
    leftovers: existsSync(opt) ? readdirSync(opt).filter((n) => n !== "rtk") : [],
    config: join(h, ".claude/context-economy/config.json"),
    ran: existsSync(marker),
    calls: existsSync(calls) ? readFileSync(calls, "utf8") : "",
  };
}

const skipMac = !TOOLS.shasum && "no shasum";

test("a verified archive is installed, reports its version and writes the config", { skip: skipMac }, () => {
  const r = run();
  assert.equal(r.code, 0, r.out);
  assert.ok(r.installed);
  assert.deepEqual(r.leftovers, []);
  assert.match(r.out, /installed: rtk 0\.47\.0 at .*\/\.local\/opt\/rtk-0\.47\.0\/rtk/);
  assert.deepEqual(JSON.parse(readFileSync(r.config, "utf8")), { rtk: { path: r.rtk } });
  assert.match(r.out, /next: install the plugins/);
  assert.match(r.calls, /^shasum$/m);
});

test("running it twice succeeds and leaves one install and the same config", { skip: skipMac }, () => {
  const first = run();
  const second = run({ home: first.home });
  assert.equal(second.code, 0, second.out);
  assert.deepEqual(second.leftovers, []);
  assert.match(second.out, /already names this path/);
  assert.deepEqual(JSON.parse(readFileSync(second.config, "utf8")), { rtk: { path: second.rtk } });
});

test("an existing config that names another path is not edited; the line to add is printed", { skip: skipMac }, () => {
  const mine = '{ "rtk": { "path": "/opt/other/rtk" }, "keep": true }\n';
  const r = run({ config: mine });
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(r.config, "utf8"), mine);
  assert.match(r.out, /exists and was not changed/);
  assert.ok(r.out.includes(`"path": "${r.rtk}"`), r.out);
});

for (const [label, sep] of [["one space", " "], ["a binary-mode marker", " *"], ["three spaces", "   "]]) {
  test(`a checksums.txt line with ${label} between hash and name still verifies`, { skip: skipMac }, () => {
    const r = run({ sep });
    assert.equal(r.code, 0, r.out);
    assert.ok(r.installed);
  });
}

const refusals = [
  ["a checksum mismatch", { tamper: true }, /FAILED|did NOT match/],
  ["a checksum mismatch with a collapsed-space line", { tamper: true, sep: " " }, /FAILED|did NOT match/],
  ["a missing checksum entry", { dropEntry: true }, /no checksum for/],
  ["a second checksum entry before the real one", { dup: "before" }, /ambiguous checksum for/],
  ["a second checksum entry after the real one", { dup: "after" }, /ambiguous checksum for/],
  ["a failed download", { dropAsset: true }, /curl: \(22\)/],
  ["an unsupported platform", { arch: "x86_64" }, /unsupported platform: Darwin-x86_64/],
  ["an archive whose rtk is a symlink", { symlink: true }, /does not hold a regular file rtk/],
  ["a HOME containing a quote", { homeSuffix: '"x' }, /HOME contains a quote or backslash/],
  ["a binary that reports another version", { version: "0.46.0" }, /expected 'rtk 0\.47\.0', got 'rtk 0\.46\.0'/],
];
for (const [label, opts, message] of refusals) {
  test(`${label} installs nothing and leaves the config alone`, { skip: skipMac }, () => {
    const r = run(opts);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, message);
    assert.equal(r.installed, false, r.out);
    assert.deepEqual(r.leftovers, []);
    assert.equal(existsSync(r.config), false);
    if (!opts.version) assert.equal(r.ran, false, r.out);
  });
}

test("a path under another key does not count as already named", { skip: skipMac }, () => {
  const first = run();
  const other = JSON.stringify({ elsewhere: first.rtk });
  const r = run({ home: first.home, config: other });
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(r.config, "utf8"), other);
  assert.match(r.out, /exists and was not changed/);
});

test("downloads are limited to https", { skip: skipMac }, () => {
  const r = run();
  const curls = r.calls.split("\n").filter((l) => l.startsWith("curl "));
  assert.equal(curls.length, 2);
  for (const l of curls) assert.match(l, /^curl --proto =https --tlsv1\.2 /);
});

test("an unsupported platform downloads nothing", () => {
  assert.equal(run({ arch: "x86_64" }).calls.includes("curl"), false);
});

test("Linux x86_64 takes the musl archive and verifies it with sha256sum", { skip: !TOOLS.sha256sum && "no sha256sum" }, () => {
  const r = run({ asset: LINUX, os: "Linux", arch: "x86_64" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.calls, /^sha256sum$/m);
  assert.doesNotMatch(r.calls, /^shasum$/m);
  assert.match(r.calls, new RegExp(`curl .*${LINUX.replaceAll(".", "\\.")}`));
});

// The README's pasted block and the script are two copies of one procedure. At an RTK bump both must change:
// the pinned version, both asset names and their verifiers, the checksum match and the single-entry guard.
test("the script and the README's RTK block carry the same pin, assets, verifiers and checksum checks", () => {
  const readme = readFileSync(join(dirname(SCRIPT), "..", "README.md"), "utf8");
  const from = readme.indexOf("**RTK 0.47.0.**");
  const start = readme.indexOf("```bash\n", from) + "```bash\n".length;
  const block = readme.slice(start, readme.indexOf("\n```", start)).split("\n").map((l) => l.trim());
  const script = readFileSync(SCRIPT, "utf8").split("\n").map((l) => l.trim());
  const pick = (lines, re) => lines.filter((l) => re.test(l));
  for (const re of [/^v=/, /^Darwin-arm64\)/, /^Linux-x86_64\)/, /^\*\) echo "unsupported platform/, /^line=\$\(grep/, /wc -l/, /\| verify$/, /^tar -xzf/]) {
    const a = pick(block, re);
    const b = pick(script, re);
    assert.ok(a.length > 0 && b.length > 0, `${re} missing from the README block or the script`);
    assert.deepEqual(b, a, `${re} differs between the README block and the script`);
  }
});
