// SPDX-License-Identifier: Apache-2.0

// Proof module for the context-bar plugin. It writes no ledger and no data, so it has visual entries only: the operator
// confirms by sight what the band shows (see the shape notes in tool-gateway.mjs). The wording is the operator's to read,
// so each statement says one thing a person can see.
const bandUp = ["Start a session, send a short prompt, then type /context-bar top."];
const bandAbove = "A band above the prompt shows a bar and a legend";
const rowsAdd = "The rows of the legend add up to the used figure in the header";
const topLabels = "In the top list a Bash row names at most one command and shows no arguments";
const noBand = "No band appears above the prompt";

export default {
  name: "context-bar",
  hosts: ["claude", "pi"],
  behaviour: [
    {
      host: "claude",
      kind: "visual",
      say: [...bandUp, "Press the ▼ button at the right end of the band header."],
      expect: [bandAbove, rowsAdd, topLabels, "The expanded band draws a line graph with a time axis"],
    },
    {
      host: "pi",
      kind: "visual",
      say: bandUp,
      expect: [bandAbove, rowsAdd, topLabels, "A footer under the legend says distribution est."],
    },
  ],
  offSwitch: {
    env: { CE_CONTEXT_BAR: "off" },
    checks: [
      { host: "claude", kind: "visual", say: ["Start a session with the switch set for this launch only, then send a short prompt."], expect: [noBand] },
      { host: "pi", kind: "visual", say: ["Start a session with the switch set for this launch only, then send a short prompt."], expect: [noBand] },
    ],
  },
  uninstall: [
    { host: "claude", kind: "visual", say: ["Start a session without the switch, then send a short prompt."], expect: [noBand] },
    { host: "pi", kind: "visual", say: ["Start a session without the switch, then send a short prompt."], expect: [noBand] },
  ],
  dataLeft: [],
};
