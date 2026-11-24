# E1a candidate check: runbook

E1a gates every promotion: a candidate tag `v<version>` is installed on each supported platform, from the README alone, against the **staging** repository `southcoltech-labs/context-economy` (named `context-economy-preview` until it was renamed), on both hosts. It proves what ships: every plugin the marketplace lists, and every Pi extension in `package.json`. Today that is tool-gateway, one Claude Code plugin and one Pi extension. The result is `docs/release-proof/<version>.json` on `main`, which `promote.mjs` validates. A transcript goes in `docs/release-proof/<version>.md` as supporting evidence.

Run once on **macOS arm64** and once on **Linux x86_64**, each on a clean machine or a clean user account, with nothing from earlier installs under `~/.claude/` or `~/.pi/`.

## Inputs

```bash
STAGING=southcoltech-labs/context-economy   # the staging repository
V=<version>                      # the candidate, e.g. 0.1.0
SHA=<40-hex commit of v$V>       # git rev-parse "v$V^{commit}" in a staging clone
```

## 1. Install RTK (README §1 only)

Follow the README's "Install RTK" exactly: the RTK block (it must end with `rtk 0.47.0` and the `rtk.path` line), and `~/.claude/context-economy/config.json`. Note anything the README did not tell you; a gap fails the run.

## 2. Install the candidate

E1a installs the candidate tag, not `release`:

```bash
claude plugin marketplace add "$STAGING#v$V"
claude plugin install tool-gateway@context-economy   # one line per plugin the marketplace lists
pi install "git:github.com/$STAGING@v$V"
```

Start a new `claude` session and a new `pi` session (do not restart the machine). With several plugins, install every one and confirm each is installed; the install result for a host is `pass` only when all of them are.

## 3. Run the behaviour check

Record each command and its output in the transcript. Do not uninstall yet: step 4 reads the installed state.

| Coding agent | Behaviour | Pass when |
| --- | --- | --- |
| Claude Code | Type: Run git status | It runs as `'<rtk path>' git status`; a ledger row in `~/.claude/context-economy/gateway-ledger/` has `"rewrite":"applied"`. A permission prompt after the rewrite is recorded, not failed: Claude Code checks permissions on the rewritten command (`'<rtk path>' git status`), which it does not recognise as read-only, so it may ask. That shows the rewrite reached Claude Code. |
| Pi | Type: Run git status | Rewritten to the quoted RTK path; a row in `gateway-ledger-pi/` with `"rewrite":"applied"` |

### With more than one plugin (§5a): the whole-run manual fallback

Applies only when the marketplace at `v$V` lists more than one plugin; with tool-gateway alone, the table above is the whole step. It is the fallback for the driver pilot: if the driver stops for a driver fault, the **whole** E1a is run by hand from this runbook, for every plugin. Never run one plugin by hand and another through the driver (no hybrid run).

`install`, `behavior` and `uninstall` are recorded **per coding agent**, not per plugin. Each is an aggregate: `pass` only after **every** plugin's checks for that host and that attestation pass. Give each check its own transcript row, naming the plugin.

| Attestation | Passed only after | When |
| --- | --- | --- |
| `install` | Every listed plugin is installed and confirmed (step 2) | Before capture |
| `behavior` | Every plugin's behaviour check (this step), **and** every required off-switch check below | Before capture, while the plugins are still installed |
| `uninstall` | Every plugin is removed and the post-uninstall checks of step 5 pass, including data left | After capture, passed to finalize |

Steps 3 and 5 hold these checks:

| Check | Claude Code | Pi | Step |
| --- | --- | --- | --- |
| Behaviour, one row per plugin | The plugin's own check, from its SPEC or test plan (tool-gateway: the row above) | The same, on Pi | 3 |
| Off switch (a plugin that has one) | Start the coding agent with that plugin's switch set (for example `CE_<NAME>=off`): the plugin does nothing, and every **other** plugin's behaviour row still passes | The same | 3 |
| Uninstall | Remove every plugin and start a new session. No plugin's feature appears, and no new ledger row | `pi remove` the package and start a new session. No extension's feature appears | 5 |
| Data left | Exactly the README list. A plugin that keeps no data adds nothing, which does **not** mean the shared folder is empty | The same | 5 |

Off-switch overrides are **command-scoped**: set the variable on that one launch only, for example `CE_<NAME>=off claude` and `CE_<NAME>=off pi`, never with `export`, and not in any settings or config file. Then check that no off switch is left in effect before the next launch: `env | grep '^CE_'` prints nothing in the shell, and no host settings file sets one. The post-uninstall launches of step 5 must run with every off switch absent, in the same shell set-up as the behaviour checks, or a missing feature proves the switch, not the removal. A persistent off switch never counts as uninstall evidence.

## 4. Capture (before uninstall)

Run from a checkout of the candidate's `main`, with both coding agents still installed, giving the install and behaviour results from steps 2–3:

```bash
node scripts/e1a-record.mjs capture --version "$V" --sha "$SHA" --platform macos-arm64 --pi-repo "$STAGING" \
  --claude "install=<pass|fail>,behavior=<pass|fail>" --pi "install=<pass|fail>,behavior=<pass|fail>"
```

Quote each result argument, and replace each `<pass|fail>` with the result you observed in steps 2 and 3, never a value you did not check. Left unquoted, zsh reads `<` and `|` as shell operators.

- `installed_commit` is not attested by you. The recorder reads it from `~/.claude/plugins/installed_plugins.json` (`gitCommitSha` of each plugin the marketplace lists) and from the Pi package clone's HEAD, and passes it only when every one equals `$SHA`.
- It writes `docs/release-proof/$V-<platform>.capture.json`, bound to `$V`, `$SHA`, the platform, `$STAGING` and the Claude and Pi host folders it read.
- Before reading the coding agents it removes this platform's earlier run file (`$V-<platform>.json`) and any pending capture, so a capture that then fails leaves nothing to finalize or promote. A failed capture is kept as failed; to try again, start over from step 2 and capture again.

## 5. Uninstall

```bash
claude plugin uninstall tool-gateway@context-economy   # one line per installed plugin
pi remove "git:github.com/$STAGING"
```

Start each coding agent again, with no off switch set (see §5a: `env | grep '^CE_'` prints nothing). No rewrite happens, and no new ledger rows appear. The data folders left are exactly the ones the README lists.

## 6. Finalize (after uninstall)

```bash
node scripts/e1a-record.mjs finalize --version "$V" --sha "$SHA" --platform macos-arm64 --pi-repo "$STAGING" \
  --claude "uninstall=<pass|fail>" --pi "uninstall=<pass|fail>"
```

- Finalize uses the capture's commits and results as they are; it does not read the installed commits again.
- It refuses a missing capture, one for another version, SHA or platform, and a different `--pi-repo`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR` or `HOME` than at capture. Run it in the same shell set-up as step 4.
- It checks that the installs are gone: a remaining Claude entry or Pi clone records uninstall as failed.
- It writes this platform's run to its own file, `docs/release-proof/$V-<platform>.json`, and deletes the capture, so a capture is used once. Each machine keeps its own run file; nothing is copied between machines during the runs.

## 7. Combine (after both platforms)

Copy each machine's `docs/release-proof/$V-<platform>.json` into one staging checkout, then:

```bash
node scripts/e1a-record.mjs combine --version "$V" --sha "$SHA"
node scripts/check-release-proof.mjs "$V" "$SHA" tool-gateway --pi tool-gateway   # every listed plugin, then --pi every extension
```

- `combine` writes `docs/release-proof/$V.json` from the run files, one run per platform. It reads no host. It refuses a missing platform, a run file for another version, SHA or platform, and a pending capture. `$V.json` is derived: a new capture, finalize or combine for this version removes the earlier one first, so a refused or aborted step never leaves an earlier pass in place.
- The checker must print "complete pass".

`$V.md` is written by the engineer, not by a script and not by the runner. Each runner keeps a plain-text transcript (commands and their output, the clean checks, host versions; no screenshots, login details or personal addresses), and the engineer combines the transcripts into `$V.md`.

Commit `docs/release-proof/$V.json` and `$V.md` to `main` in a pull request (docs-only, labeled `no-release`). The promotion workflow reads them from there. The per-platform run files are not committed.

Open that pull request **without** `--label`, wait until its first `ci` run has finished (its `repo checks` job is expected to fail: the changeset gate exempts only a docs-only PR labeled `no-release`), then add the label, which starts one new run. `ci` runs on both `opened` and `labeled` and cancels the older run, so `gh pr create --label no-release` can leave a cancelled run as the latest and all five required checks reading "cancelled". Before asking for the merge, check `statusCheckRollup` is `SUCCESS` and `mergeStateStatus` is `CLEAN`; a cancelled run left as the latest is fixed by re-running it.

## E1b (release drill)

See `E1B-RUNBOOK.md`: it uses the same machine set-up and the README's update and rollback commands, with `scripts/e1b-data.mjs` checking that the ledger rows and `config.json` survive.
