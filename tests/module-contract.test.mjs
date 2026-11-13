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
  for (const action of ["apply-awards", "award-break", "award-mid-game-break"]) {
    assert.match(source, new RegExp(`"${action}"`));
  }
  assert.match(source, /Math\.min\(maximum, Math\.max\(minimum, value\)\)/);
  assert.match(source, /bonusDie === "clear"/);
  assert.match(source, /mythicChanged/);
  assert.match(source, /mythicSet/);
  assert.match(source, /mythicAdd/);
  assert.match(source, /Mythic Points —/);
  assert.doesNotMatch(source, /Mythic Points:<\/strong> \$\{actor\.name\}/);
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
  assert.match(source, /async function criticalConditionSource/);
  assert.match(source, /nativeCondition\.toObject\(\)/);
  assert.doesNotMatch(source, /key: "GrantItem"/);
  assert.match(source, /async function removeLegacyCriticalInitiativeEffects/);
  assert.match(source, /item\.type === "effect" && item\.getFlag\(MODULE_ID, CRITICAL_INITIATIVE_FLAG\)/);
  assert.match(source, /Hooks\.on\("createChatMessage"/);
  assert.match(source, /Hooks\.on\("updateCombatant"/);
  assert.match(source, /Hooks\.on\("updateCombat"/);
  assert.match(source, /state\.kind === "failure" && current\?\.id === combatant\.id/);
  assert.match(source, /state\.kind === "success" && state\.started && current\?\.id !== combatant\.id/);
});

test("Oracular Warning uses native PF2e effects for nearby non-deafened allies", async () => {
  const source = await readFile(new URL("scripts/hero-bonus-points.js", root), "utf8");
  assert.match(source, /"oracularWarning"/);
  assert.match(source, /Compendium\.pf2e\.feat-effects\.Item\.7XxZ4YJ6c97D9Fc9/);
  assert.match(source, /Compendium\.pf2e\.feat-effects\.Item\.ETZHTCjlOUHHSE0Z/);
  assert.match(source, /function hasOracularWarning/);
  assert.match(source, /token\?\.actor\?\.type === "character"/);
  assert.match(source, /function isDeafened/);
  assert.match(source, /canvas\.grid\.measurePath/);
  assert.match(source, /key: "TempHP"/);
  assert.match(source, /removeAfterRoll: true/);
  assert.match(source, /type: "status"/);
  assert.match(source, /Hooks\.on\("createCombat"/);
  assert.match(source, /Hooks\.on\("createCombatant"/);
});

test("Retributive Strike validates targets, uses the native resistance effect, and resolves the triggering damage", async () => {
  const source = await readFile(new URL("scripts/hero-bonus-points.js", root), "utf8");
  assert.match(source, /"retributiveStrike"/);
  assert.match(source, /Compendium\.pf2e\.feat-effects\.Item\.DawVHfoPKbPJsz4k/);
  assert.match(source, /function retributiveValidation/);
  assert.match(source, /championAuraRadius/);
  assert.match(source, /function triggeringDamageMessage/);
  assert.match(source, /await ally\.actor\.applyDamage/);
  assert.match(source, /await effect\?\.delete\(\)/);
  assert.match(source, /strike\.variants\[0\]\.roll\(\{ target: enemy \}\)/);
  assert.match(source, /game\.socket\.on\(RETRIBUTIVE_STRIKE_SOCKET/);
  assert.doesNotMatch(source, /timestamp\s*\?\?\s*0\)\s*<\s*60_000/);
});

test("mid-game Hero Point awards are deliberate and available during Break Time", async () => {
  const source = await readFile(new URL("scripts/hero-bonus-points.js", root), "utf8");
  assert.match(source, /async function awardMidGameBreakHeroPoints/);
  assert.match(source, /Award HP/);
  assert.match(source, /data-tooltip", "Award Mid-Game Hero Points/);
  assert.match(source, /game\.BreakTime\.showApp/);
  assert.match(source, /app\.addEventListener\("render"/);
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
