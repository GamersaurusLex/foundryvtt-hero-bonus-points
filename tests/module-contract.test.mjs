import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("manifest targets Foundry V14 and both supported systems", async () => {
  const manifest = JSON.parse(await readFile(new URL("module.json", root), "utf8"));
  assert.equal(manifest.id, "hero-bonus-points");
  assert.equal(manifest.title, "Lex's Variant Rules");
  assert.equal(manifest.compatibility.minimum, "14.365");
  assert.deepEqual(manifest.relationships.systems.map((system) => system.id), ["pf2e", "sf2e"]);
});

test("award panel exposes the required GM workflows", async () => {
  const source = await readFile(new URL("scripts/hero-bonus-points.js", root), "utf8");
  for (const action of ["apply-awards", "award-break", "award-mid-game-break", "change-mythic"]) {
    assert.match(source, new RegExp(`"${action}"`));
  }
  assert.match(source, /Math\.min\(maximum, Math\.max\(minimum, value\)\)/);
  assert.match(source, /bonusDie === "clear"/);
  assert.doesNotMatch(source, /actor\.sheet\?\.render/);
});

test("variant settings retain bonus-die state and add only requested PF2e content", async () => {
  const source = await readFile(new URL("scripts/hero-bonus-points.js", root), "utf8");
  assert.match(source, /"bonusDice"/);
  assert.match(source, /"dynamicStride"/);
  assert.match(source, /"midGameBreakHeroPoints"/);
  assert.match(source, /async function ensureDynamicStride/);
  assert.match(source, /game\.items\.some\(isDynamicStride\)/);
  assert.match(source, /Item\.create\(/);
});

test("Critical Initiative uses named effects and combat turn boundaries", async () => {
  const source = await readFile(new URL("scripts/hero-bonus-points.js", root), "utf8");
  assert.match(source, /"Critical Initiative Success"/);
  assert.match(source, /"Critical Initiative Failure"/);
  assert.match(source, /Compendium\.pf2e\.conditionitems\.Item\.nlCjDvLMf2EkV2dl/);
  assert.match(source, /Compendium\.pf2e\.conditionitems\.Item\.AJh5ex99aV6VTggg/);
  assert.match(source, /Hooks\.on\("createChatMessage"/);
  assert.match(source, /Hooks\.on\("updateCombatant"/);
  assert.match(source, /Hooks\.on\("updateCombat"/);
  assert.match(source, /state\.kind === "failure" && current\?\.id === combatant\.id/);
  assert.match(source, /state\.kind === "success" && state\.started && current\?\.id !== combatant\.id/);
});

test("bonus die uses a guarded PF2e card-rebuild compatibility path", async () => {
  const source = await readFile(new URL("scripts/hero-bonus-points.js", root), "utf8");
  assert.match(source, /Add Bonus Die to Roll/);
  assert.match(source, /game\.pf2e\?\.Check/);
  assert.match(source, /foldBonusIntoCheck/);
  assert.match(source, /could not fold bonus die into check/);
  assert.match(source, /"flags\.pf2e\.modifiers": modifiers/);
});

test("held bonus dice use a compact, legible badge beside Hero Points", async () => {
  const source = await readFile(new URL("scripts/hero-bonus-points.js", root), "utf8");
  assert.match(source, /badge\.textContent = `d\$\{die\}`/);
  assert.match(source, /Bonus d\$\{die\}\. Add it to an eligible d20 roll\./);
  assert.match(source, /data-resource="mythic-points"/);
  assert.match(source, /anchor\.insertAdjacentElement\("afterend", readout\)/);
});

test("Careful Consumption intercepts only Toolbelt healing-consumable uses", async () => {
  const source = await readFile(new URL("scripts/hero-bonus-points.js", root), "utf8");
  assert.match(source, /pf2e-toolbelt\.preUsePhysicalItem/);
  assert.match(source, /damage\?\.kind === "healing"/);
  assert.match(source, /labelCarefulConsumption/);
  assert.match(source, /PF2E\.ActionsNumber\.Two/);
  assert.match(source, /label: "Careful Consumption"/);
  assert.match(source, /evaluate\(\{ maximize: true \}\)/);
  assert.match(source, /Regular Consumption/);
  assert.match(source, /"system\.uses\.value": Math\.max\(uses\.value - 1, 0\)/);
});
