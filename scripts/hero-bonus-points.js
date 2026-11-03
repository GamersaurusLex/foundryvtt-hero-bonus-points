const MODULE_ID = "hero-bonus-points";
const DIE_SIZES = [4, 6, 8, 10, 12];
const CRITICAL_INITIATIVE_FLAG = "criticalInitiative";
const CONDITION_UUIDS = {
  quickened: "Compendium.pf2e.conditionitems.Item.nlCjDvLMf2EkV2dl",
  offGuard: "Compendium.pf2e.conditionitems.Item.AJh5ex99aV6VTggg"
};
const pendingInitiatives = new Map();
const breaktimeRenderListeners = new WeakSet();
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const spending = new Set();

function bonusDiceEnabled() {
  return game.settings.get(MODULE_ID, "bonusDice");
}

function heldDie(actor) {
  if (!bonusDiceEnabled()) return null;
  const die = Number(actor?.getFlag(MODULE_ID, "bonusDie"));
  return DIE_SIZES.includes(die) ? die : null;
}

function partyMembers() {
  return (game.actors.party?.members ?? game.actors.filter((actor) => actor.type === "character"))
    .filter((actor) => actor.type === "character");
}

function mythicResource(actor) {
  const resource = actor.system?.resources?.mythicPoints;
  return Number.isFinite(resource?.max) && resource.max > 0 ? resource : null;
}

async function announce(content) {
  await ChatMessage.create({ speaker: { alias: game.user.name }, content, whisper: [] });
}

async function awardMidGameBreakHeroPoints() {
  const actors = partyMembers();
  if (!actors.length) return ui.notifications.warn("No party characters were found.");
  const awarded = [];
  const capped = [];
  await Promise.all(actors.map(async (actor) => {
    const current = Number(actor.system.resources?.heroPoints?.value) || 0;
    if (current >= 3) return capped.push(actor.name);
    await actor.update({ "system.resources.heroPoints.value": current + 1 });
    awarded.push(actor.name);
  }));
  if (awarded.length) await announce(`<p><strong>Mid-game break Hero Point award:</strong> ${awarded.join(", ")} each gain 1 Hero Point.</p>`);
  if (capped.length) ui.notifications.info(`${capped.join(", ")} ${capped.length === 1 ? "is" : "are"} already at the 3-point cap.`);
}

function carefulConsumptionEnabled() {
  return game.settings.get(MODULE_ID, "carefulConsumption");
}

function criticalInitiativeEnabled() {
  return game.system.id === "pf2e" && game.settings.get(MODULE_ID, "criticalInitiative");
}

function isActiveGM() {
  return game.user.isGM && game.users.activeGM?.id === game.user.id;
}

function isDynamicStride(item) {
  return item.type === "action" && item.name === "Dynamic Stride";
}

async function ensureDynamicStride() {
  if (game.system.id !== "pf2e" || !isActiveGM() || game.items.some(isDynamicStride)) return;
  await Item.create({
    name: "Dynamic Stride",
    type: "action",
    img: "systems/pf2e/icons/actions/TwoActions.webp",
    system: {
      description: {
        value: "<p>You move and take action along the way.</p><p>You Stride. During your Stride, you can use a basic action that takes a single action or less during your movement. If your action is interrupted for any reason, your Stride immediately ends.</p>",
        gm: ""
      },
      rules: [],
      slug: null,
      traits: { value: [], otherTags: [] },
      actionType: { value: "action" },
      actions: { value: 2 },
      category: null,
      deathNote: false
    }
  }, { renderSheet: false });
  ui.notifications.info("Dynamic Stride was added to the Items directory.");
}

function initiativeNatural(message) {
  if (!message?.flags?.core?.initiativeRoll && message?.flags?.pf2e?.context?.type !== "initiative") return null;
  return naturalD20(message.rolls?.[0]);
}

async function criticalConditionSource(kind, combatant, messageId) {
  const combat = combatant.parent;
  const success = kind === "success";
  const name = success ? "Critical Initiative Success" : "Critical Initiative Failure";
  const conditionUuid = success ? CONDITION_UUIDS.quickened : CONDITION_UUIDS.offGuard;
  const description = success
    ? "<p>You rolled a natural 20 on initiative. You are quickened through the end of your first turn. Use the additional action only to Step, Stride, or Strike.</p>"
    : "<p>You rolled a natural 1 on initiative. You are off-guard until the beginning of your first turn.</p>";
  const nativeCondition = await fromUuid(conditionUuid);
  if (!nativeCondition?.isOfType?.("condition")) return null;

  // Clone the PF2e condition itself. A wrapper Effect with GrantItem creates a
  // second, visible condition, whereas this remains one native condition with
  // our explanatory name and lifecycle flag.
  const source = nativeCondition.toObject();
  delete source._id;
  source.name = name;
  source.system.description.value = description;
  source.flags = foundry.utils.mergeObject(source.flags ?? {}, {
    [MODULE_ID]: {
      [CRITICAL_INITIATIVE_FLAG]: {
        combatId: combat.id,
        combatantId: combatant.id,
        kind,
        messageId,
        started: combat.combatant?.id === combatant.id
      }
    }
  }, { inplace: false });
  return source;
}

function criticalInitiativeEffects(actor, combat) {
  return actor.items.filter((item) => item.getFlag(MODULE_ID, CRITICAL_INITIATIVE_FLAG)?.combatId === combat.id);
}

async function removeLegacyCriticalInitiativeEffects() {
  const removals = game.actors.contents.map(async (actor) => {
    const ids = actor.items
      .filter((item) => item.type === "effect" && item.getFlag(MODULE_ID, CRITICAL_INITIATIVE_FLAG))
      .map((item) => item.id);
    if (ids.length) await actor.deleteEmbeddedDocuments("Item", ids);
  });
  await Promise.all(removals);
}

async function applyCriticalInitiative(combatant, pending) {
  if (!criticalInitiativeEnabled() || !isActiveGM() || !combatant?.actor || !pending) return;
  const combat = combatant.parent;
  if (!combat) return;
  const { actor } = combatant;
  const kind = pending.natural === 20 ? "success" : pending.natural === 1 ? "failure" : null;
  if (!kind) return;
  const hasEffect = criticalInitiativeEffects(actor, combat)
    .some((effect) => effect.getFlag(MODULE_ID, CRITICAL_INITIATIVE_FLAG)?.messageId === pending.messageId);
  if (hasEffect) return;
  const source = await criticalConditionSource(kind, combatant, pending.messageId);
  if (source) await actor.createEmbeddedDocuments("Item", [source]);
}

async function resolveCriticalInitiativeEffects(combat, changed) {
  if (!isActiveGM() || !("turn" in changed || "round" in changed)) return;
  const current = combat.combatant;
  const updates = [];
  const removals = [];
  for (const combatant of combat.combatants) {
    const actor = combatant.actor;
    if (!actor) continue;
    for (const effect of criticalInitiativeEffects(actor, combat)) {
      const state = effect.getFlag(MODULE_ID, CRITICAL_INITIATIVE_FLAG);
      if (state.combatantId !== combatant.id) continue;
      if (state.kind === "failure" && current?.id === combatant.id) removals.push(effect);
      else if (state.kind === "success" && current?.id === combatant.id && !state.started) {
        updates.push(effect.update({ [`flags.${MODULE_ID}.${CRITICAL_INITIATIVE_FLAG}.started`]: true }));
      } else if (state.kind === "success" && state.started && current?.id !== combatant.id) removals.push(effect);
    }
  }
  await Promise.all([...updates, ...removals.map((effect) => effect.delete())]);
}

function isHealingConsumable(item) {
  const damage = item?.system?.damage;
  return item?.isOfType?.("consumable")
    && damage?.kind === "healing"
    && typeof damage.formula === "string"
    && damage.formula.trim().length > 0;
}

function damageRollClass() {
  return CONFIG.Dice.rolls.find((RollClass) => RollClass.name === "DamageRoll") ?? Roll;
}

function labelCarefulConsumption(card) {
  const content = card.querySelector(".card-content");
  const actionGlyph = content?.querySelector(".action-glyph");
  if (!content || !actionGlyph) return;

  content.innerHTML = content.innerHTML.replace("Activate", "Careful Consumption");
  const twoActionGlyph = content.querySelector(".action-glyph");
  if (!twoActionGlyph) return;
  twoActionGlyph.textContent = "2";
  twoActionGlyph.dataset.tooltip = "PF2E.ActionsNumber.Two";
}

async function carefulHealingFormula(item, { chirurgeon = false } = {}) {
  const formula = item.system.damage.formula;
  const maximum = await new Roll(formula, item.actor?.getRollData?.() ?? {}).evaluate({ maximize: true });
  const healed = chirurgeon ? `(${maximum.total} + ${formula})` : `${maximum.total}`;
  return `${healed}[${item.system.damage.type},${item.system.damage.kind}]`;
}

async function consumeCarefully(item, { chirurgeon = false } = {}) {
  const actor = item.actor;
  const speaker = ChatMessage.getSpeaker({ actor });
  const flags = { [MODULE_ID]: { origin: { sourceId: item.sourceId, uuid: item.uuid, type: item.type } } };
  const card = document.createElement("div");
  card.innerHTML = (await item.toMessage(null, { create: false }))?.content ?? "";
  card.querySelector("footer")?.remove();
  card.querySelector("button[data-action='consume']")?.remove();
  labelCarefulConsumption(card);

  const formula = await carefulHealingFormula(item, { chirurgeon });
  const DamageRoll = damageRollClass();
  const roll = new DamageRoll(formula);
  await roll.toMessage({
    speaker,
    flavor: `<p><strong>Careful Consumption</strong></p>${card.innerHTML}`,
    flags,
  });

  const uses = item.uses;
  if (item.system.uses.autoDestroy && uses.value <= 1) {
    const quantity = Math.max(item.quantity - 1, 0);
    if (quantity <= 0) await item.delete();
    else await item.update({ "system.quantity": quantity, "system.uses.value": uses.max });
  } else {
    await item.update({ "system.uses.value": Math.max(uses.value - 1, 0) });
  }
}

async function promptCarefulConsumption({ cancel, item, use }) {
  const chirurgeonEnabled = game.settings.get(MODULE_ID, "chirurgeonFieldDiscovery");
  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: "Careful Consumption" },
    content: `
      <p><strong>${item.name}</strong></p>
      <p>Choose how to consume this healing item.</p>
      <label class="checkbox"><input type="checkbox" name="chirurgeon" ${chirurgeonEnabled ? "" : "disabled"}> Apply Chirurgeon Greater Field Discovery</label>
      ${chirurgeonEnabled ? "" : "<p class=\"hint\">Enable the Chirurgeon setting if a character has Greater Field Discovery.</p>"}
    `,
    buttons: [
      { action: "regular", default: true, icon: "fa-solid fa-flask", label: "Regular Consumption", callback: () => "regular" },
      { action: "careful", icon: "fa-solid fa-hand-sparkles", label: "Careful Consumption", callback: (_event, button) => ({ careful: true, chirurgeon: button.form.elements.chirurgeon?.checked ?? false }) },
      { action: "cancel", icon: "fa-solid fa-xmark", label: "Cancel", callback: () => "cancel" },
    ],
  });
  if (choice === "regular") return use();
  if (choice?.careful) return consumeCarefully(item, choice);
  return cancel();
}

class AwardPanel extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-award-panel`,
    classes: [MODULE_ID],
    position: { width: 900, height: 620 },
    window: { title: "Lex's Variant Rules", icon: "fa-solid fa-sliders", resizable: true },
    actions: {
      "toggle-all": AwardPanel.#toggleAll,
      "fill-opening": AwardPanel.#fillOpening,
      "apply-awards": AwardPanel.#applyAwards,
      "award-break": AwardPanel.#awardBreak,
      "award-mid-game-break": AwardPanel.#awardMidGameBreak,
      "change-mythic": AwardPanel.#changeMythic
    }
  };

  static PARTS = { panel: { template: `modules/${MODULE_ID}/templates/award-panel.hbs`, root: true, scrollable: [".award-grid"] } };

  get title() { return "Lex's Variant Rules"; }

  async _prepareContext(options) {
    const actors = partyMembers().map((actor) => {
      const hero = actor.system.resources?.heroPoints ?? { value: 0 };
      const mythic = mythicResource(actor);
      return {
        id: actor.id,
        name: actor.name,
        img: actor.img,
        bonusDie: heldDie(actor),
        dieOptions: [
          { value: "", label: "No change", selected: !heldDie(actor) },
          { value: "clear", label: "Clear", selected: false },
          ...DIE_SIZES.map((value) => ({ value, label: `d${value}`, selected: value === heldDie(actor) }))
        ],
        hero: { value: clamp(Number(hero.value) || 0, 0, 3) },
        mythic: { enabled: !!mythic, value: mythic?.value ?? 0, max: mythic?.max ?? 0 }
      };
    });
    return {
      ...await super._prepareContext(options),
      actors,
      dieSizes: DIE_SIZES,
      bonusDiceEnabled: bonusDiceEnabled(),
      midGameBreakEnabled: game.settings.get(MODULE_ID, "midGameBreakHeroPoints")
    };
  }

  selectedRows() {
    return [...this.element.querySelectorAll(".award-row[data-actor-id]")]
      .filter((row) => row.querySelector(".award-selected")?.checked);
  }

  static #toggleAll(event, target) {
    this.element.querySelectorAll(".award-selected").forEach((input) => { input.checked = target.checked; });
  }

  static #fillOpening(event, target) {
    const value = clamp(Number(target.dataset.value) || 0, 0, 3);
    this.selectedRows().forEach((row) => { row.querySelector(".opening-hero").value = value; });
  }

  static async #applyAwards() {
    const updates = this.selectedRows().map((row) => {
      const actor = game.actors.get(row.dataset.actorId);
      const heroPoints = clamp(Number(row.querySelector(".opening-hero")?.value) || 0, 0, 3);
      const bonusDie = bonusDiceEnabled() ? (row.querySelector(".bonus-die")?.value ?? "") : "";
      return actor ? { actor, heroPoints, bonusDie } : null;
    }).filter(Boolean);
    if (!updates.length) return ui.notifications.warn("Select at least one character.");
    const applied = await Promise.all(updates.map(async ({ actor, heroPoints, bonusDie }) => {
      const currentHeroPoints = Number(actor.system.resources?.heroPoints?.value) || 0;
      const currentDie = heldDie(actor);
      const heroChanged = currentHeroPoints !== heroPoints;
      const dieChanged = bonusDiceEnabled() && (
        (bonusDie === "clear" && Boolean(currentDie))
        || (DIE_SIZES.includes(Number(bonusDie)) && currentDie !== Number(bonusDie))
      );
      if (heroChanged) await actor.update({ "system.resources.heroPoints.value": heroPoints });
      if (bonusDie === "clear" && currentDie) await actor.unsetFlag(MODULE_ID, "bonusDie");
      else if (DIE_SIZES.includes(Number(bonusDie)) && currentDie !== Number(bonusDie)) await actor.setFlag(MODULE_ID, "bonusDie", Number(bonusDie));
      return { actor, heroPoints, bonusDie, heroChanged, dieChanged };
    }));
    const changed = applied.filter((award) => award.heroChanged || award.dieChanged);
    if (!changed.length) return ui.notifications.info("No selected awards changed.");
    const heroSummary = applied.filter(({ heroChanged }) => heroChanged)
      .map(({ actor, heroPoints }) => `${actor.name} (${heroPoints})`).join(", ");
    const dieSummary = applied.filter(({ dieChanged, bonusDie }) => dieChanged && bonusDie && bonusDie !== "clear")
      .map(({ actor, bonusDie }) => `${actor.name} (d${bonusDie})`).join(", ");
    const cleared = applied.filter(({ dieChanged, bonusDie }) => dieChanged && bonusDie === "clear")
      .map(({ actor }) => actor.name).join(", ");
    const summaries = [
      heroSummary && `Hero Points — ${heroSummary}.`,
      dieSummary && `Bonus dice — ${dieSummary}.`,
      cleared && `Bonus dice cleared — ${cleared}.`,
    ].filter(Boolean);
    await announce(`<p><strong>Session awards applied:</strong> ${summaries.join(" ")}</p>`);
    this.render({ force: true });
  }

  static async #awardBreak() {
    const actors = this.selectedRows().map((row) => game.actors.get(row.dataset.actorId)).filter(Boolean);
    if (!actors.length) return ui.notifications.warn("Select at least one character.");
    const awarded = [];
    const capped = [];
    await Promise.all(actors.map(async (actor) => {
      const current = Number(actor.system.resources?.heroPoints?.value) || 0;
      if (current >= 3) return capped.push(actor.name);
      await actor.update({ "system.resources.heroPoints.value": current + 1 });
      awarded.push(actor.name);
    }));
    if (awarded.length) await announce(`<p><strong>Mid-session Hero Point award:</strong> ${awarded.join(", ")} each gain 1 Hero Point.</p>`);
    if (capped.length) ui.notifications.info(`${capped.join(", ")} ${capped.length === 1 ? "is" : "are"} already at the 3-point cap.`);
    this.render({ force: true });
  }

  static async #awardMidGameBreak() {
    await awardMidGameBreakHeroPoints();
    this.render({ force: true });
  }

  static async #changeMythic(event, target) {
    const actor = game.actors.get(target.dataset.actorId);
    const resource = mythicResource(actor);
    if (!actor || !resource) return;
    const delta = Number(target.dataset.delta) || 0;
    const value = clamp((Number(resource.value) || 0) + delta, 0, resource.max);
    if (value === resource.value) return;
    await actor.update({ "system.resources.mythicPoints.value": value });
    await announce(`<p><strong>Mythic Points:</strong> ${actor.name} ${delta > 0 ? "gains" : "spends"} 1 Mythic Point (${value} / ${resource.max}).</p>`);
    this.render({ force: true });
  }

}

function injectBonusReadout(app, element) {
  const actor = app.actor ?? app.document;
  if (!actor?.isOwner || actor.type !== "character") return;
  const root = element instanceof HTMLElement ? element : element?.[0];
  if (!root) return;
  const window = root.closest(".app, .application") ?? root;
  window.querySelectorAll(".hero-bonus-die-readout").forEach((element) => element.remove());
  if (!bonusDiceEnabled()) return;
  const die = heldDie(actor);
  if (!die) return;

  const anchor = root.querySelector('[data-resource="hero-points"], [data-resource="mythic-points"]');
  if (!anchor) return;

  const readout = document.createElement("span");
  const badge = document.createElement("span");
  readout.className = "hero-bonus-die-readout";
  badge.className = "hero-bonus-die-badge";
  badge.textContent = `d${die}`;
  badge.dataset.tooltip = `Bonus d${die}. Add it to an eligible d20 roll.`;
  badge.setAttribute("aria-label", `Bonus d${die}`);
  readout.append(badge);
  anchor.insertAdjacentElement("afterend", readout);
}

function actorFromMessage(message) {
  return message?.speakerActor ?? (message?.speaker?.actor ? game.actors.get(message.speaker.actor) : null);
}

function hasD20(message) {
  return (message?.rolls ?? []).some((roll) => roll.dice?.some((die) => die.faces === 20));
}

function alreadyFolded(message) {
  return (message?.flags?.pf2e?.modifiers ?? []).some((modifier) => modifier?.slug === MODULE_ID);
}

function fortuneSpent(message) {
  const roll = message?.rolls?.[0];
  return typeof roll?.isRerollable === "boolean" && !roll.isRerollable;
}

function canSpend(message) {
  const actor = actorFromMessage(message);
  return !!(message && (message.isAuthor || game.user.isGM) && actor?.isOwner && heldDie(actor) && hasD20(message) && !alreadyFolded(message) && !fortuneSpent(message));
}

function naturalD20(roll) {
  for (const die of roll?.dice ?? []) {
    if (die.faces !== 20 || !die.results?.length) continue;
    const active = die.results.find((result) => result.active) ?? die.results[0];
    if (Number.isFinite(active?.result)) return active.result;
  }
  return null;
}

const DEGREES = ["criticalFailure", "failure", "success", "criticalSuccess"];

function degreeAt(total, dc, natural) {
  const delta = total - dc;
  let degree = delta >= 10 ? 3 : delta >= 0 ? 2 : delta > -10 ? 1 : 0;
  if (natural === 20) degree = Math.min(3, degree + 1);
  else if (natural === 1) degree = Math.max(0, degree - 1);
  return degree;
}

function degreeLabel(degree, context) {
  const kind = context?.type === "attack-roll" ? "Attack" : "Check";
  const key = `PF2E.Check.Result.Degree.${kind}.${DEGREES[degree]}`;
  const label = game.i18n.localize(key);
  return label === key ? DEGREES[degree].replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase()) : label;
}

function checkContext(message) {
  const check = game.pf2e?.Check;
  const terms = foundry.dice?.terms;
  const context = message?.flags?.pf2e?.context;
  const roll = message?.rolls?.[0];
  if (
    typeof check?.renderReroll !== "function" ||
    typeof terms?.OperatorTerm !== "function" ||
    typeof terms?.NumericTerm !== "function" ||
    !Number.isFinite(context?.dc?.value) ||
    Object.keys(context.dosAdjustments ?? {}).length > 0 ||
    !Number.isFinite(roll?.total) ||
    roll.constructor?.name !== "CheckRoll" ||
    typeof roll.constructor.fromTerms !== "function" ||
    !Array.isArray(roll.terms) ||
    !roll.terms.length
  ) return null;
  return { context, dc: context.dc.value, roll, natural: naturalD20(roll) };
}

function restyleFlavor(flavor, degree, delta, context) {
  if (!flavor) return null;
  const label = degreeLabel(degree, context);
  const signed = delta >= 0 ? `+${delta}` : `${delta}`;
  const rewritten = flavor.replace(
    /(<div class="result degree-of-success">[\s\S]*?<span class=")[^"]*("[^>]*>)[^<]*(<\/span>)([\s\S]*?<span data-visibility="gm"[^>]*>)[^<]*(<\/span>)/,
    (_match, head, middle, close, deltaOpen, deltaClose) => `${head}${DEGREES[degree]}${middle}${label}${close}${deltaOpen}by ${signed}${deltaClose}`
  );
  return rewritten === flavor ? null : rewritten;
}

/**
 * Compatibility path adapted from Jacob's Bonus Die source with permission.
 * PF2e has no public "add a modifier to a completed check" API, so this
 * intentionally uses guarded PF2e internals and returns null on any mismatch.
 */
async function foldBonusIntoCheck(message, bonusRoll) {
  const found = checkContext(message);
  if (!found) return null;
  const { context: oldContext, dc, roll: oldRoll, natural } = found;
  const { OperatorTerm, NumericTerm } = foundry.dice.terms;
  const evaluated = (Term, config) => {
    const term = new Term(config);
    term._evaluated = true;
    return term;
  };
  const value = bonusRoll.total;
  const options = { ...oldRoll.options, totalModifier: (oldRoll.options.totalModifier ?? 0) + value };
  const rebuilt = (terms) => oldRoll.constructor.fromTerms(terms, options);
  const newRoll = rebuilt([...oldRoll.terms, evaluated(OperatorTerm, { operator: "+" }), evaluated(NumericTerm, { number: value })]);
  const shownRoll = rebuilt([...oldRoll.terms, evaluated(OperatorTerm, { operator: "+" }), ...bonusRoll.terms]);
  const degree = degreeAt(newRoll.total, dc, natural);
  newRoll.options.degreeOfSuccess = degree;
  newRoll.options.isReroll = true;
  shownRoll.options.degreeOfSuccess = degree;

  const context = foundry.utils.deepClone(oldContext);
  context.outcome = DEGREES[degree];
  context.isReroll = true;
  const flavor = restyleFlavor(message.flavor, degree, newRoll.total - dc, context);
  if (flavor === null) return null;

  const modifiers = foundry.utils.deepClone(message.flags.pf2e.modifiers ?? []);
  modifiers.push({ slug: MODULE_ID, label: `Bonus Die d${bonusRoll.dice?.[0]?.faces ?? "?"}`, modifier: value, type: "untyped", enabled: true, ignored: false, hideIfDisabled: false });
  const [oldHtml, newHtml] = await Promise.all([
    game.pf2e.Check.renderReroll(oldRoll, { isOld: true }),
    game.pf2e.Check.renderReroll(shownRoll, { isOld: false })
  ]);
  await message.update({
    content: `<div class="reroll-discard">${oldHtml}</div><div class="reroll-second">${newHtml}</div>`,
    rolls: [newRoll],
    flavor,
    "flags.pf2e.context": context,
    "flags.pf2e.modifiers": modifiers
  });
  return { total: newRoll.total, outcome: degreeLabel(degree, context) };
}

async function spendBonusDie(message) {
  const actor = actorFromMessage(message);
  const die = heldDie(actor);
  if (!actor || !die || spending.has(actor.id) || !canSpend(message)) return;
  spending.add(actor.id);
  try {
    const roll = await (new Roll(`1d${die}`)).evaluate();
    let folded = null;
    try {
      folded = await foldBonusIntoCheck(message, roll);
    } catch (error) {
      console.error(`${MODULE_ID} | could not fold bonus die into check`, error);
    }
    if (!folded) {
      const total = message.rolls?.[0]?.total;
      await roll.toMessage({
        speaker: message.speaker,
        flavor: Number.isFinite(total)
          ? `<strong>Bonus Die d${die}:</strong> ${actor.name}'s check gains +${roll.total} (total ${total + roll.total}).`
          : `<strong>Bonus Die d${die}:</strong> ${actor.name} gains +${roll.total}.`
      });
    }
    await actor.unsetFlag(MODULE_ID, "bonusDie");
  } finally {
    spending.delete(actor.id);
  }
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "bonusDice", {
    name: "Enable Bonus Dice",
    hint: "Shows bonus-die controls and lets characters spend held bonus dice on eligible d20 rolls.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    requiresReload: true,
  });
  game.settings.register(MODULE_ID, "carefulConsumption", {
    name: "Enable Careful Consumption",
    hint: "Lets players choose Regular or Careful Consumption when using a healing consumable through PF2e Toolbelt's Use button.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    requiresReload: true,
  });
  game.settings.register(MODULE_ID, "chirurgeonFieldDiscovery", {
    name: "Campaign Has a Chirurgeon with Greater Field Discovery",
    hint: "Adds the Greater Field Discovery option to the Careful Consumption dialog.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });
  game.settings.register(MODULE_ID, "dynamicStride", {
    name: "Add Dynamic Stride",
    hint: "Adds the two-action Dynamic Stride activity to the world's Items directory when enabled.",
    scope: "world",
    config: game.system.id === "pf2e",
    type: Boolean,
    default: false,
    onChange: (enabled) => { if (enabled) void ensureDynamicStride(); }
  });
  game.settings.register(MODULE_ID, "criticalInitiative", {
    name: "Enable Critical Initiative",
    hint: "A natural 20 on initiative grants Quickened through the end of the combatant's first turn. A natural 1 applies Off-Guard until the start of that turn.",
    scope: "world",
    config: game.system.id === "pf2e",
    type: Boolean,
    default: false,
  });
  game.settings.register(MODULE_ID, "midGameBreakHeroPoints", {
    name: "Enable Mid-Game Break Hero Point Awards",
    hint: "Adds a deliberate award button to the Break Time window and Award Panel. It awards 1 Hero Point to every party character below the 3-point cap.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });
  game.settings.registerMenu(MODULE_ID, "awardPanel", {
    name: "Hero Points, Mythic Points, and Bonus Dice",
    label: "Open Award Panel",
    hint: "Set session Hero Points and award Hero, Mythic, and bonus-die resources.",
    icon: "fa-solid fa-star",
    type: AwardPanel,
    restricted: true
  });
});

function injectBreakTimeAwardControl(app) {
  if (!game.user.isGM || !game.settings.get(MODULE_ID, "midGameBreakHeroPoints")) return;
  const root = app?.element;
  if (!(root instanceof HTMLElement) || root.querySelector(`[data-${MODULE_ID}-mid-game-break]`)) return;
  const footer = root.querySelector(".sheet-footer");
  if (!footer) return;
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute(`data-${MODULE_ID}-mid-game-break`, "true");
  button.setAttribute("aria-label", "Award Mid-Game Hero Points");
  button.setAttribute("data-tooltip", "Award Mid-Game Hero Points");
  button.style.whiteSpace = "nowrap";
  button.innerHTML = '<i class="fa-solid fa-star"></i> Award HP';
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await awardMidGameBreakHeroPoints();
    } finally {
      button.disabled = false;
    }
  });
  footer.prepend(button);
}

function attachBreakTimeAwardControl(app) {
  if (!app) return;
  if (!breaktimeRenderListeners.has(app)) {
    app.addEventListener("render", () => injectBreakTimeAwardControl(app));
    breaktimeRenderListeners.add(app);
  }
  injectBreakTimeAwardControl(app);
}

function registerBreakTimeIntegration() {
  if (!game.modules.get("breaktime")?.active || !game.BreakTime) return;
  attachBreakTimeAwardControl(game.BreakTime.app);
  Hooks.on("updateSetting", (setting, changes) => {
    if (setting.key !== "breaktime.paused" || !changes.value) return;
    window.setTimeout(() => attachBreakTimeAwardControl(game.BreakTime.app), 100);
  });
  if (!globalThis.libWrapper || !game.BreakTime.showApp) return;
  libWrapper.register(MODULE_ID, "game.BreakTime.showApp", async function (wrapped, ...args) {
    const result = await wrapped(...args);
    attachBreakTimeAwardControl(game.BreakTime.app);
    return result;
  }, "WRAPPER");
}

Hooks.once("ready", () => {
  game.modules.get(MODULE_ID).api = { open: () => new AwardPanel().render({ force: true }) };
  registerBreakTimeIntegration();
  void removeLegacyCriticalInitiativeEffects();
  if (game.settings.get(MODULE_ID, "dynamicStride")) void ensureDynamicStride();
});

Hooks.on("pf2e-toolbelt.preUsePhysicalItem", (context) => {
  if (!carefulConsumptionEnabled() || !isHealingConsumable(context.item)) return;
  void promptCarefulConsumption(context);
  return false;
});

Hooks.on("renderActorSheetV2", injectBonusReadout);
Hooks.on("renderActorSheet", injectBonusReadout);
Hooks.on("createChatMessage", (message) => {
  if (!criticalInitiativeEnabled() || !isActiveGM()) return;
  const natural = initiativeNatural(message);
  const actor = actorFromMessage(message);
  if (!actor || ![1, 20].includes(natural)) return;
  pendingInitiatives.set(actor.uuid, { natural, messageId: message.id });
});
Hooks.on("updateCombatant", (combatant, changed) => {
  if (!criticalInitiativeEnabled() || !isActiveGM() || !("initiative" in changed)) return;
  const pending = combatant.actor ? pendingInitiatives.get(combatant.actor.uuid) : null;
  if (!pending) return;
  pendingInitiatives.delete(combatant.actor.uuid);
  void applyCriticalInitiative(combatant, pending);
});
Hooks.on("updateCombat", (combat, changed) => {
  void resolveCriticalInitiativeEffects(combat, changed);
});
Hooks.on("getChatMessageContextOptions", (_application, menuItems) => {
  menuItems.push({
    name: "Add Bonus Die to Roll",
    icon: '<i class="fa-solid fa-dice-d20"></i>',
    condition: (li) => canSpend(game.messages.get(li.dataset.messageId)),
    callback: (li) => spendBonusDie(game.messages.get(li.dataset.messageId))
  });
});
