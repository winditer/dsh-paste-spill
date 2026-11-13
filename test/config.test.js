import { test } from "node:test";
import assert from "node:assert/strict";

import { Config } from "../lib/index.js";

/**
 * The thresholds are declared in the HOST half because that is where the settings
 * domain reads a plugin's schema from (`entry.fiber.runtime.Config`), and because the
 * form is addressed by the profile entry id. These tests pin the three things the
 * browser half and the settings page both depend on: the defaults, the bounds the page
 * mirrors, and the `volatile` marker that makes a write live instead of a remount.
 */

/** Resolve one field's schema node from schemastery's ref-based `toJSON()` output. */
function field(name) {
  const json = Config.toJSON();
  const root = json.refs[json.uid];
  const id = root.dict[name];
  return id === undefined ? undefined : json.refs[id];
}

test("Config declares both thresholds with the documented defaults", () => {
  assert.equal(field("foldBytes").meta.default, 4000);
  assert.equal(field("spillBytes").meta.default, 50000);
  // A volatile field materializes as a live reference (cosmokit's Volatile box) rather
  // than a plain number -- that box is exactly what makes the settings write live.
  const resolved = Config({});
  assert.equal(resolved.foldBytes.get(), 4000);
  assert.equal(resolved.spillBytes.get(), 50000);
});

test("Config bounds match the ranges the settings page validates against", () => {
  assert.equal(field("foldBytes").meta.min, 1000);
  assert.equal(field("foldBytes").meta.max, 1000000);
  assert.equal(field("spillBytes").meta.min, 2000);
  assert.equal(field("spillBytes").meta.max, 10000000);
});

test("both fields are volatile, so saving them cannot remount the plugin", () => {
  // volatile is what keeps the composer's already-folded chips alive across a save:
  // a non-volatile field would reload the plugin and drop every by-ref fold.
  assert.equal(field("foldBytes").meta.volatile, true);
  assert.equal(field("spillBytes").meta.volatile, true);
});

test("Config rejects non-numeric and out-of-range values", () => {
  assert.throws(() => Config({ foldBytes: "4000" }));
  assert.throws(() => Config({ foldBytes: 999 }));
  assert.throws(() => Config({ spillBytes: 10000001 }));
});
test("Config declares the always-text switch, off by default and live", () => {
  // Off by default: content sniffing stays the default for a pasted code fragment.
  assert.equal(field("alwaysText").meta.default, false);
  // Volatile for the same reason as the thresholds -- a write must not remount the
  // plugin, and it must take effect on the NEXT paste without a restart.
  assert.equal(field("alwaysText").meta.volatile, true);
  assert.equal(Config({}).alwaysText.get(), false);
  assert.equal(Config({ alwaysText: true }).alwaysText.get(), true);
});

test("Config rejects a non-boolean alwaysText", () => {
  assert.throws(() => Config({ alwaysText: "yes" }));
});
