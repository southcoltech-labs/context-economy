// SPDX-License-Identifier: Apache-2.0

// Proof module for the tool-gateway plugin. It lives here, not under plugins/, because plugins/
// ships to users and test-only code would turn into a release. Data only: the step data (piece 3)
// and the evaluator (e1-evidence.mjs) read it, and the driver holds nothing plugin-specific.
//
// Shape (a departure from the design's sketch, review 114 E7: `dataLeft` keeps the design's meaning, the
// files uninstall leaves, and the other expectations have their own keys):
//   name         the plugin's name in marketplace.json
//   hosts        which hosts it ships to
//   ledgerDirs   per host, the whole folder that holds its ledger, relative to the home (the driver holds
//                no part of the path; it assumes the plugin writes to its default location, see e1-evidence.mjs)
//   behaviour    per host, the call that must run while the plugin is installed: its command, the required
//                result choice (1 rewritten short output) and the ledger rows it must leave
//   uninstall    per host, the same after uninstall (2 git's plain output, no new ledger row)
//   dataLeft     what uninstall leaves, exactly (F.6 asserts this list)
export default {
  name: "tool-gateway",
  hosts: ["claude", "pi"],
  ledgerDirs: { claude: ".claude/context-economy/gateway-ledger", pi: ".claude/context-economy/gateway-ledger-pi" },
  behaviour: [
    { host: "claude", command: "git status", result: 1, ledger: { rows: 1, rewrite: "applied", is_error: false } },
    { host: "pi", command: "git status", result: 1, ledger: { rows: 1, rewrite: "applied", is_error: false } },
  ],
  uninstall: [
    { host: "claude", command: "git status", result: 2, ledger: { rows: 0 } },
    { host: "pi", command: "git status", result: 2, ledger: { rows: 0 } },
  ],
  dataLeft: ["config.json", "gateway-ledger", "gateway-ledger-pi"],
};
