// SPDX-License-Identifier: Apache-2.0

// Proof module for the context-bar plugin. It writes no ledger and no data, so it has visual entries only: the operator
// confirms by sight what the band shows (see the shape notes in tool-gateway.mjs). The wording is the operator's to read,
// so each statement says one thing a person can see.
// On Claude Code the band starts hidden: /context-bar shows it. On Pi it is shown from the start, and /context-bar would hide it.
const claudeUp = ["Start a session, type /context-bar to show the band, then send a short prompt.", "Type /context-bar top."];
const piUp = ["Start a session and send a short prompt.", "Type /context-bar top."];
const bandAbove = "A band above the prompt shows a bar and a legend";
const rowsAdd = "The rows of the legend add up to the used figure in the header";
const topLabels = "In the top list a Bash row shows at most one command name, and only that name";
const noBand = "The area above the prompt is empty";

export default {
  name: "context-bar",
  hosts: ["claude", "pi"],
  behaviour: [
    {
      host: "claude",
      kind: "visual",
      say: [...claudeUp, "Press the ▼ button at the right end of the band header."],
      expect: [bandAbove, rowsAdd, topLabels, "The expanded band draws a line graph with a time axis"],
    },
    {
      host: "pi",
      kind: "visual",
      say: piUp,
      expect: [bandAbove, rowsAdd, topLabels, "A footer under the legend says distribution est."],
    },
  ],
  offSwitch: {
    env: { CE_CONTEXT_BAR: "off" },
    checks: [
      { host: "claude", kind: "visual", say: ["Start a session with the switch set for this launch only, type /context-bar, then send a short prompt."], expect: [noBand] },
      { host: "pi", kind: "visual", say: ["Start a session with the switch set for this launch only, then send a short prompt."], expect: [noBand] },
    ],
  },
  uninstall: [
    { host: "claude", kind: "visual", say: ["Start a session without the switch, type /context-bar, then send a short prompt."], expect: [noBand] },
    { host: "pi", kind: "visual", say: ["Start a session without the switch, then send a short prompt."], expect: [noBand] },
  ],
  dataLeft: [],
};
