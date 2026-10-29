import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("manifest targets Foundry V14 and both supported systems", async () => {
  const manifest = JSON.parse(await readFile(new URL("module.json", root), "utf8"));
  assert.equal(manifest.id, "hero-bonus-points");
  assert.equal(manifest.compatibility.minimum, "14.365");
  assert.deepEqual(manifest.relationships.systems.map((system) => system.id), ["pf2e", "sf2e"]);
});

test("award panel exposes the required GM workflows", async () => {
  const source = await readFile(new URL("scripts/hero-bonus-points.js", root), "utf8");
  for (const action of ["apply-opening", "award-break", "change-mythic", "apply-die"]) {
    assert.match(source, new RegExp(`"${action}"`));
  }
  assert.match(source, /Math\.min\(maximum, Math\.max\(minimum, value\)\)/);
});

test("bonus die uses a guarded PF2e card-rebuild compatibility path", async () => {
  const source = await readFile(new URL("scripts/hero-bonus-points.js", root), "utf8");
  assert.match(source, /Add Bonus Die to Roll/);
  assert.match(source, /game\.pf2e\?\.Check/);
  assert.match(source, /foldBonusIntoCheck/);
  assert.match(source, /could not fold bonus die into check/);
  assert.match(source, /"flags\.pf2e\.modifiers": modifiers/);
});
