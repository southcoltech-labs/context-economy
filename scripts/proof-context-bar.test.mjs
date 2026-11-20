// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import proof from "./proof/context-bar.mjs";

const hostsOf = (entries, host) => entries.filter((e) => e.host === host);
const said = (entry) => entry.say.join(" ");
const enables = (entry) => /type \/context-bar( to show the band)?[ ,]/.test(said(entry));

// The Claude plugin starts with the band hidden (its own test pins this), so a fresh-session sequence that never types
// /context-bar would attest to a band that is not there. Pi shows the band from the start, and /context-bar there hides it.
test("the Claude proof enables the hidden band before it attests to the band, and Pi's does not toggle it", () => {
  const pluginTest = readFileSync(new URL("../plugins/context-bar/hooks/register.test.tsx", import.meta.url), "utf8");
  assert.match(pluginTest, /starts hidden and toggles on/, "the default this proof relies on is no longer pinned by a plugin test");
  const piTest = readFileSync(new URL("../extensions/context-bar/register.ts", import.meta.url), "utf8");
  assert.match(piTest, /let isEnabled = true/);
  const [claude] = hostsOf(proof.behaviour, "claude");
  const [pi] = hostsOf(proof.behaviour, "pi");
  assert.ok(enables(claude), "the Claude behaviour does not enable the band");
  assert.ok(said(claude).indexOf("/context-bar to show") < said(claude).indexOf("send a short prompt"), "the band is enabled after the prompt");
  assert.ok(!/type \/context-bar to show/.test(said(pi)), "Pi's band is already shown; typing /context-bar would hide it");
});

test("the Claude off-switch and uninstall checks also type /context-bar, so an absent band is not just the hidden default", () => {
  for (const list of [proof.offSwitch.checks, proof.uninstall]) {
    const [claude] = hostsOf(list, "claude");
    assert.ok(enables(claude), `${said(claude)} does not type /context-bar`);
    assert.deepEqual(claude.expect, ["No band appears above the prompt"]);
  }
});

test("the off switch is set for one launch only, and the uninstall check runs without it", () => {
  assert.deepEqual(proof.offSwitch.env, { CE_CONTEXT_BAR: "off" });
  for (const e of hostsOf(proof.offSwitch.checks, "claude").concat(hostsOf(proof.offSwitch.checks, "pi"))) assert.match(said(e), /for this launch only/);
  for (const e of proof.uninstall) assert.match(said(e), /without the switch/);
});
