const MODULE_ID = "hero-bonus-points";
const DIE_SIZES = [4, 6, 8, 10, 12];
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const spending = new Set();

function heldDie(actor) {
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

class AwardPanel extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-award-panel`,
    classes: [MODULE_ID],
    position: { width: 900, height: 620 },
    window: { title: "Hero & Bonus Points", icon: "fa-solid fa-star", resizable: true },
    actions: {
      "toggle-all": AwardPanel.#toggleAll,
      "fill-opening": AwardPanel.#fillOpening,
      "apply-opening": AwardPanel.#applyOpening,
      "award-break": AwardPanel.#awardBreak,
      "change-mythic": AwardPanel.#changeMythic,
      "apply-die": AwardPanel.#applyDie
    }
  };

  static PARTS = { panel: { template: `modules/${MODULE_ID}/templates/award-panel.hbs`, root: true, scrollable: [".award-grid"] } };

  get title() { return "Hero & Bonus Points"; }

  async _prepareContext(options) {
    const actors = partyMembers().map((actor) => {
      const hero = actor.system.resources?.heroPoints ?? { value: 0 };
      const mythic = mythicResource(actor);
      return {
        id: actor.id,
        name: actor.name,
        img: actor.img,
        bonusDie: heldDie(actor),
        dieOptions: DIE_SIZES.map((value) => ({ value, selected: value === heldDie(actor) })),
        hero: { value: clamp(Number(hero.value) || 0, 0, 3) },
        mythic: { enabled: !!mythic, value: mythic?.value ?? 0, max: mythic?.max ?? 0 }
      };
    });
    return { ...await super._prepareContext(options), actors, dieSizes: DIE_SIZES };
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

  static async #applyOpening() {
    const updates = this.selectedRows().map((row) => {
      const actor = game.actors.get(row.dataset.actorId);
      const value = clamp(Number(row.querySelector(".opening-hero")?.value) || 0, 0, 3);
      return actor ? { actor, value } : null;
    }).filter(Boolean);
    if (!updates.length) return ui.notifications.warn("Select at least one character.");
    await Promise.all(updates.map(({ actor, value }) => actor.update({ "system.resources.heroPoints.value": value })));
    await announce(`<p><strong>Session Hero Points set:</strong> ${updates.map(({ actor, value }) => `${actor.name} (${value})`).join(", ")}.</p>`);
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

  static async #applyDie(event, target) {
    const actor = game.actors.get(target.dataset.actorId);
    const row = target.closest(".award-row");
    const die = Number(row?.querySelector(".bonus-die")?.value) || null;
    if (!actor) return;
    if (die) await actor.setFlag(MODULE_ID, "bonusDie", die);
    else await actor.unsetFlag(MODULE_ID, "bonusDie");
    await announce(`<p><strong>Bonus Die:</strong> ${actor.name} ${die ? `receives a d${die} bonus die` : "has their bonus die cleared"}.</p>`);
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
  const readout = document.createElement("span");
  const die = heldDie(actor);
  readout.className = "hero-bonus-die-readout";
  readout.textContent = die ? `Bonus Die: d${die}` : "Bonus Die: —";
  readout.dataset.tooltip = die ? `You may add this d${die} to one eligible d20 check.` : "No bonus die held.";
  const anchor = root.querySelector('[data-resource="hero-points"]');
  (anchor ?? root.querySelector(".sheet-header") ?? root).insertAdjacentElement(anchor ? "afterend" : "afterbegin", readout);
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
  game.settings.registerMenu(MODULE_ID, "awardPanel", {
    name: "Hero & Bonus Points",
    label: "Open Award Panel",
    hint: "Set session Hero Points and award Hero, Mythic, and bonus-die resources.",
    icon: "fa-solid fa-star",
    type: AwardPanel,
    restricted: true
  });
});

Hooks.once("ready", () => {
  game.modules.get(MODULE_ID).api = { open: () => new AwardPanel().render({ force: true }) };
});

Hooks.on("renderActorSheetV2", injectBonusReadout);
Hooks.on("renderActorSheet", injectBonusReadout);
Hooks.on("updateActor", (actor, changes) => {
  if (Object.hasOwn(changes.flags ?? {}, MODULE_ID) || Object.hasOwn(changes.flags ?? {}, `-=${MODULE_ID}`)) actor.sheet?.render({ force: false });
});
Hooks.on("getChatMessageContextOptions", (_application, menuItems) => {
  menuItems.push({
    name: "Add Bonus Die to Roll",
    icon: '<i class="fa-solid fa-dice-d20"></i>',
    condition: (li) => canSpend(game.messages.get(li.dataset.messageId)),
    callback: (li) => spendBonusDie(game.messages.get(li.dataset.messageId))
  });
});
