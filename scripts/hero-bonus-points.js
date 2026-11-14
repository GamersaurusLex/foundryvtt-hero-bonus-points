const MODULE_ID = "hero-bonus-points";
const DIE_SIZES = [4, 6, 8, 10, 12];
const CRITICAL_INITIATIVE_FLAG = "criticalInitiative";
const ORACULAR_WARNING_FLAG = "oracularWarning";
const RETRIBUTIVE_STRIKE_FLAG = "retributiveStrike";
const RETRIBUTIVE_STRIKE_SOCKET = `module.${MODULE_ID}`;
const RECALL_KNOWLEDGE_QUEUE_SETTING = "recallKnowledgeQueue";
const RECALL_KNOWLEDGE_USER_QUEUE_FLAG = "recallKnowledgeRequests";
const RECALL_KNOWLEDGE_PACK = "xdy-pf2e-workbench.asymonous-benefactor-macros-internal";
const RECALL_KNOWLEDGE_MACRO = "XDY DO_NOT_IMPORT Recall_Knowledge";
const ORACULAR_WARNING_UUIDS = {
  effect: "Compendium.pf2e.feat-effects.Item.7XxZ4YJ6c97D9Fc9",
  initiative: "Compendium.pf2e.feat-effects.Item.ETZHTCjlOUHHSE0Z"
};
const CHAMPIONS_RESISTANCE_UUID = "Compendium.pf2e.feat-effects.Item.DawVHfoPKbPJsz4k";
const CONDITION_UUIDS = {
  quickened: "Compendium.pf2e.conditionitems.Item.nlCjDvLMf2EkV2dl",
  offGuard: "Compendium.pf2e.conditionitems.Item.AJh5ex99aV6VTggg"
};
const pendingInitiatives = new Map();
const pendingOracularWarnings = new Map();
const breaktimeRenderListeners = new WeakSet();
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const spending = new Set();
let recallKnowledgeQueueApp = null;

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

function oracularWarningEnabled() {
  return game.system.id === "pf2e" && game.settings.get(MODULE_ID, "oracularWarning");
}

function isActiveGM() {
  return game.user.isGM && game.users.activeGM?.id === game.user.id;
}

function hasOracularWarning(actor) {
  return actor?.items?.some((item) => item.type === "feat" && item.slug === "oracular-warning");
}

function conditionValue(actor, slug) {
  const condition = actor?.items?.find((item) => item.type === "condition" && item.slug === slug);
  return Number(condition?.system?.value?.value) || 0;
}

function oracularWarningBonus(oracle) {
  const cursebound = conditionValue(oracle, "cursebound");
  return cursebound >= 3 ? 4 : cursebound >= 2 ? 3 : 2;
}

function isDeafened(actor) {
  return actor?.items?.some((item) => item.type === "condition" && item.slug === "deafened");
}

function isFriendlyToken(token) {
  return token?.actor?.type === "character" || token?.document?.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY;
}

function tokenDistance(origin, target) {
  return origin?.distanceTo?.(target) ?? canvas.grid.measurePath([origin.center, target.center]).distance;
}

function oracularWarningEffects(actor, combat, targetTokenId) {
  return actor.items.filter((item) => {
    const state = item.getFlag(MODULE_ID, ORACULAR_WARNING_FLAG);
    return state?.combatId === combat.id && state?.targetTokenId === targetTokenId;
  });
}

async function oracularWarningSources(oracle, combat, targetTokenId) {
  const [effect, initiative] = await Promise.all([
    fromUuid(ORACULAR_WARNING_UUIDS.effect),
    fromUuid(ORACULAR_WARNING_UUIDS.initiative)
  ]);
  if (effect?.type !== "effect" || initiative?.type !== "effect") return [];

  const bonus = oracularWarningBonus(oracle);
  const temporaryHP = Math.max(Math.floor((Number(oracle.level) || 0) / 2), 1);
  const createSource = (nativeEffect, kind, rules) => {
    const source = nativeEffect.toObject();
    delete source._id;
    source.name = kind === "initiative"
      ? `Oracular Warning (Initiative) — ${oracle.name}`
      : `Oracular Warning — ${oracle.name}`;
    source.system.description.value = kind === "initiative"
      ? `<p>${oracle.name}'s warning grants a +${bonus} status bonus to this initiative roll.</p>`
      : `<p>${oracle.name}'s warning grants ${temporaryHP} temporary Hit Points for 1 minute.</p>`;
    source.system.rules = rules;
    source.flags = foundry.utils.mergeObject(source.flags ?? {}, {
      [MODULE_ID]: {
        [ORACULAR_WARNING_FLAG]: {
          combatId: combat.id,
          targetTokenId,
          oracleActorId: oracle.id,
          kind,
          bonus,
          temporaryHP
        }
      }
    }, { inplace: false });
    return source;
  };

  return [
    createSource(effect, "temporary-hp", [{ key: "TempHP", value: temporaryHP }]),
    createSource(initiative, "initiative", [{
      key: "FlatModifier",
      removeAfterRoll: true,
      selector: "initiative",
      slug: `oracular-warning-${oracle.id}`,
      type: "status",
      value: bonus
    }])
  ];
}

async function applyOracularWarnings(combat) {
  const combatSceneId = combat?.scene?.id ?? combat?.sceneId;
  if (!oracularWarningEnabled() || !isActiveGM() || !combat || (combatSceneId && combatSceneId !== canvas.scene?.id)) return;
  const combatTokens = combat.combatants
    .map((combatant) => canvas.tokens.get(combatant.tokenId))
    .filter((token) => token?.actor);
  const oracles = combatTokens.filter((token) => hasOracularWarning(token.actor));
  if (!oracles.length) return;

  const applied = [];
  for (const oracleToken of oracles) {
    for (const targetToken of combatTokens) {
      if (targetToken === oracleToken || !isFriendlyToken(targetToken) || isDeafened(targetToken.actor)) continue;
      if (tokenDistance(oracleToken, targetToken) > 20) continue;
      const existing = oracularWarningEffects(targetToken.actor, combat, targetToken.id)
        .some((effect) => effect.getFlag(MODULE_ID, ORACULAR_WARNING_FLAG)?.oracleActorId === oracleToken.actor.id);
      if (existing) continue;
      const sources = await oracularWarningSources(oracleToken.actor, combat, targetToken.id);
      if (!sources.length) continue;
      await targetToken.actor.createEmbeddedDocuments("Item", sources);
      applied.push(`${targetToken.name} (+${oracularWarningBonus(oracleToken.actor)} initiative, ${Math.max(Math.floor((Number(oracleToken.actor.level) || 0) / 2), 1)} temporary HP)`);
    }
  }
  if (applied.length) {
    await announce(`<p><strong>Oracular Warning:</strong> ${applied.join(", ")}.</p>`);
  }
}

function scheduleOracularWarnings(combat) {
  if (!oracularWarningEnabled() || !combat?.id) return;
  const pending = pendingOracularWarnings.get(combat.id);
  if (pending) {
    pending.queued = true;
    return;
  }
  const state = { queued: false };
  const task = Promise.resolve()
    .then(async () => {
      do {
        state.queued = false;
        await applyOracularWarnings(combat);
      } while (state.queued);
    })
    .catch((error) => console.error(`${MODULE_ID} | could not apply Oracular Warning`, error))
    .finally(() => pendingOracularWarnings.delete(combat.id));
  state.task = task;
  pendingOracularWarnings.set(combat.id, state);
}

function retributiveStrikeEnabled() {
  return game.system.id === "pf2e" && game.settings.get(MODULE_ID, "retributiveStrike");
}

function isRetributiveStrike(item) {
  return item?.type === "action" && item.slug === "retributive-strike";
}

function championAuraRadius(actor) {
  const radius = Number(actor?.flags?.system?.champion?.aura) || 0;
  const options = actor?.getRollOptions?.(["all"]) ?? [];
  const auraActive = options instanceof Set
    ? options.has("champions-aura")
    : options.includes?.("champions-aura");
  return radius > 0 && auraActive ? radius : 0;
}

function tokenIsAllyOf(token) {
  const actor = token?.actor ?? token?.document?.actor;
  const friendly = token?.document?.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY;
  return !!actor && (actor.type === "character" || friendly);
}

function championTokenFor(message, actor) {
  return message?.token?.object
    ?? canvas.tokens.controlled.find((token) => token.actor === actor)
    ?? canvas.tokens.placeables.find((token) => token.actor === actor);
}

function retributiveTargets(champion, targets = game.user.targets) {
  const targetList = [...targets].map((token) => token.object ?? token);
  if (!champion?.actor) return { ally: null, enemy: null };
  return {
    ally: targetList.find((token) => token !== champion && tokenIsAllyOf(token)),
    enemy: targetList.find((token) => token !== champion && !tokenIsAllyOf(token))
  };
}

function damageRollFromMessage(message) {
  return message?.isDamageRoll ? message.rolls?.[0] ?? null : null;
}

function triggeringDamageMessage(enemy) {
  return game.messages.contents
    .filter((message) => message.actor?.id === enemy.actor?.id
      && !!damageRollFromMessage(message)
      && !message.getFlag(MODULE_ID, RETRIBUTIVE_STRIKE_FLAG)?.resolved)
    .sort((a, b) => b.timestamp - a.timestamp)[0] ?? null;
}

function selectedRetributiveStrike(actor) {
  const lastWeaponId = actor?.getFlag(MODULE_ID, "lastMeleeStrikeItemId");
  const meleeStrikes = (actor?.system?.actions ?? []).filter((strike) => strike.ready && strike.item?.isOfType?.("weapon") && strike.item.isMelee);
  return meleeStrikes.find((strike) => strike.item.id === lastWeaponId) ?? meleeStrikes[0] ?? null;
}

function retributiveStrikeInReach(champion, enemy, strike) {
  const reach = champion.actor.getReach?.({ action: "attack", weapon: strike.item }) ?? 5;
  return tokenDistance(champion, enemy) <= reach;
}

function retributiveValidation({ actor, champion, ally, enemy }) {
  if (!champion) return "Select the champion's token before using Retributive Strike.";
  if (!ally) return "Target the ally you want to protect, then use Retributive Strike.";
  if (!enemy) return "Target the enemy that dealt the damage, then use Retributive Strike.";
  const aura = championAuraRadius(actor);
  if (!aura) return `${actor.name}'s Champion's Aura is not active.`;
  const outside = [ally, enemy].filter((token) => tokenDistance(champion, token) > aura);
  if (outside.length) return `${outside.map((token) => token.name).join(" and ")} ${outside.length === 1 ? "is" : "are"} outside ${actor.name}'s ${aura}-foot Champion's Aura.`;
  return null;
}

function retributiveRequestIsValid(request) {
  const champion = canvas.tokens.get(request.championTokenId);
  const ally = canvas.tokens.get(request.allyTokenId);
  const enemy = canvas.tokens.get(request.enemyTokenId);
  const actor = game.actors.get(request.championActorId);
  const error = retributiveValidation({ actor, champion, ally, enemy });
  if (error) return { error };
  if (!isRetributiveStrike(actor.items.get(request.actionItemId))) return { error: "Retributive Strike is no longer available to that champion." };
  const damageMessage = game.messages.get(request.damageMessageId);
  if (!damageMessage || damageMessage.actor?.id !== enemy.actor?.id || !damageRollFromMessage(damageMessage)) return { error: "The triggering damage roll is no longer available." };
  if (damageMessage.getFlag(MODULE_ID, RETRIBUTIVE_STRIKE_FLAG)?.resolved) return { error: "That damage roll has already been protected by Retributive Strike." };
  const user = game.users.get(request.userId);
  if (!user || !actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) return { error: "The requesting user does not own this champion." };
  return { actor, champion, ally, enemy, damageMessage };
}

async function championResistanceSource(champion) {
  const nativeEffect = await fromUuid(CHAMPIONS_RESISTANCE_UUID);
  if (nativeEffect?.type !== "effect") return null;
  const source = nativeEffect.toObject();
  delete source._id;
  const resistance = Number(champion.level) + 2;
  source.name = `Champion's Resistance — ${champion.name}`;
  source.system.description.value = `<p>${champion.name}'s Retributive Strike grants resistance ${resistance} to the triggering damage.</p>`;
  source.system.rules = [{ key: "Resistance", type: "all-damage", value: resistance }];
  source.flags = foundry.utils.mergeObject(source.flags ?? {}, {
    [MODULE_ID]: { [RETRIBUTIVE_STRIKE_FLAG]: { championActorId: champion.id } }
  }, { inplace: false });
  return source;
}

async function resolveRetributiveStrike(request) {
  const validated = retributiveRequestIsValid(request);
  if (validated.error) return validated;
  const { actor, champion, ally, enemy, damageMessage } = validated;
  const effectSource = await championResistanceSource(actor);
  if (!effectSource) return { error: "PF2e's Champion's Resistance effect could not be found." };
  const [effect] = await ally.actor.createEmbeddedDocuments("Item", [effectSource]);
  try {
    await ally.actor.applyDamage({
      damage: damageRollFromMessage(damageMessage),
      token: ally,
      item: damageMessage.item,
      rollOptions: new Set(),
      outcome: damageMessage.flags.pf2e?.context?.outcome
    });
    await damageMessage.setFlag(MODULE_ID, RETRIBUTIVE_STRIKE_FLAG, { resolved: true, championActorId: actor.id, allyTokenId: ally.id });
  } finally {
    await effect?.delete();
  }
  const strike = selectedRetributiveStrike(actor);
  const strikeInReach = !!strike && retributiveStrikeInReach(champion, enemy, strike);
  await announce(`<p><strong>Retributive Strike:</strong> ${actor.name} protects ${ally.name} from ${enemy.name} with resistance ${Number(actor.level) + 2}.${strikeInReach ? ` ${actor.name} follows with ${strike.item.name}.` : " The enemy is outside the champion's melee reach."}</p>`);
  return { requestId: request.requestId, strike: strikeInReach, strikeItemId: strike?.item?.id ?? null, enemyTokenId: enemy.id };
}

async function rollRetributiveStrike(response) {
  if (!response?.strike) return;
  const actor = game.actors.get(response.championActorId);
  const enemy = canvas.tokens.get(response.enemyTokenId);
  const strike = (actor?.system?.actions ?? []).find((candidate) => candidate.item?.id === response.strikeItemId);
  if (!actor || !enemy || !strike) return;
  await strike.variants[0].roll({ target: enemy });
}

async function beginRetributiveStrike(message) {
  if (!retributiveStrikeEnabled() || !message.isAuthor || !isRetributiveStrike(message.item)) return;
  const actor = message.actor;
  const champion = championTokenFor(message, actor);
  const { ally, enemy } = retributiveTargets(champion);
  const error = retributiveValidation({ actor, champion, ally, enemy });
  if (error) return ui.notifications.warn(error);
  const damageMessage = triggeringDamageMessage(enemy);
  if (!damageMessage) return ui.notifications.warn(`No unresolved damage roll from ${enemy.name} was found.`);
  const strike = selectedRetributiveStrike(actor);
  const strikeText = strike && retributiveStrikeInReach(champion, enemy, strike)
    ? ` Then strike ${enemy.name} with ${strike.item.name}.`
    : ` ${enemy.name} is outside your current melee reach, so this will only protect ${ally.name}.`;
  const confirm = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Retributive Strike" },
    content: `<p>Protect <strong>${ally.name}</strong> from <strong>${enemy.name}</strong> with Retributive Strike?${strikeText}</p>`,
    yes: { label: `Protect ${ally.name}` },
    no: { label: "Cancel" }
  });
  if (!confirm) return;
  const request = {
    type: "retributive-strike-request",
    requestId: foundry.utils.randomID(),
    userId: game.user.id,
    championActorId: actor.id,
    championTokenId: champion.id,
    allyTokenId: ally.id,
    enemyTokenId: enemy.id,
    actionItemId: message.item.id,
    damageMessageId: damageMessage.id
  };
  if (isActiveGM()) {
    const response = await resolveRetributiveStrike(request);
    if (response.error) return ui.notifications.warn(response.error);
    return rollRetributiveStrike({ ...response, championActorId: actor.id });
  }
  game.socket.emit(RETRIBUTIVE_STRIKE_SOCKET, request);
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
    position: { width: 1000, height: 620 },
    window: { title: "Lex's Variant Rules", icon: "fa-solid fa-sliders", resizable: true },
    actions: {
      "toggle-all": AwardPanel.#toggleAll,
      "fill-opening": AwardPanel.#fillOpening,
      "apply-awards": AwardPanel.#applyAwards,
      "award-break": AwardPanel.#awardBreak,
      "award-mid-game-break": AwardPanel.#awardMidGameBreak
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
      const mythic = mythicResource(actor);
      const mythicSet = mythic
        ? clamp(Number(row.querySelector(".mythic-set")?.value) || 0, 0, mythic.max)
        : null;
      const mythicAdd = mythic
        ? clamp(Number(row.querySelector(".mythic-add")?.value) || 0, 0, 3)
        : 0;
      return actor ? { actor, heroPoints, bonusDie, mythic, mythicSet, mythicAdd } : null;
    }).filter(Boolean);
    if (!updates.length) return ui.notifications.warn("Select at least one character.");
    const applied = await Promise.all(updates.map(async ({ actor, heroPoints, bonusDie, mythic, mythicSet, mythicAdd }) => {
      const currentHeroPoints = Number(actor.system.resources?.heroPoints?.value) || 0;
      const currentDie = heldDie(actor);
      const heroChanged = currentHeroPoints !== heroPoints;
      const mythicPoints = mythic ? clamp(mythicSet + mythicAdd, 0, mythic.max) : null;
      const mythicChanged = Boolean(mythic) && Number(mythic.value) !== mythicPoints;
      const dieChanged = bonusDiceEnabled() && (
        (bonusDie === "clear" && Boolean(currentDie))
        || (DIE_SIZES.includes(Number(bonusDie)) && currentDie !== Number(bonusDie))
      );
      const resourceUpdate = {};
      if (heroChanged) resourceUpdate["system.resources.heroPoints.value"] = heroPoints;
      if (mythicChanged) resourceUpdate["system.resources.mythicPoints.value"] = mythicPoints;
      if (Object.keys(resourceUpdate).length) await actor.update(resourceUpdate);
      if (bonusDie === "clear" && currentDie) await actor.unsetFlag(MODULE_ID, "bonusDie");
      else if (DIE_SIZES.includes(Number(bonusDie)) && currentDie !== Number(bonusDie)) await actor.setFlag(MODULE_ID, "bonusDie", Number(bonusDie));
      return { actor, heroPoints, bonusDie, heroChanged, mythicChanged, mythicPoints, mythic, mythicSet, mythicAdd, dieChanged };
    }));
    const changed = applied.filter((award) => award.heroChanged || award.mythicChanged || award.dieChanged);
    if (!changed.length) return ui.notifications.info("No selected awards changed.");
    const heroSummary = applied.filter(({ heroChanged }) => heroChanged)
      .map(({ actor, heroPoints }) => `${actor.name} (${heroPoints})`).join(", ");
    const dieSummary = applied.filter(({ dieChanged, bonusDie }) => dieChanged && bonusDie && bonusDie !== "clear")
      .map(({ actor, bonusDie }) => `${actor.name} (d${bonusDie})`).join(", ");
    const cleared = applied.filter(({ dieChanged, bonusDie }) => dieChanged && bonusDie === "clear")
      .map(({ actor }) => actor.name).join(", ");
    const mythicSummary = applied.filter(({ mythicChanged }) => mythicChanged)
      .map(({ actor, mythicPoints, mythic, mythicSet, mythicAdd }) => {
        const operation = mythicAdd > 0 ? `set ${mythicSet}, add ${mythicAdd}` : `set ${mythicSet}`;
        return `${actor.name} (${operation}; ${mythicPoints} / ${mythic.max})`;
      }).join(", ");
    const summaries = [
      heroSummary && `Hero Points — ${heroSummary}.`,
      mythicSummary && `Mythic Points — ${mythicSummary}.`,
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

}

function recallKnowledgeExcludesIncapacitated() {
  return game.settings.get(MODULE_ID, "recallKnowledgeExcludeIncapacitated");
}

function isDeadOrUnconscious(actor) {
  return ["dead", "unconscious"].some((slug) => actor?.items?.some((item) => item.type === "condition" && item.slug === slug));
}

function recallKnowledgeSceneTokens() {
  if (!canvas?.ready || !canvas.scene) return [];
  return canvas.tokens.placeables.filter((token) => {
    if (!token.actor) return false;
    return !recallKnowledgeExcludesIncapacitated() || !isDeadOrUnconscious(token.actor);
  });
}

function canUseRecallKnowledgeSubject(token) {
  return game.user.isGM || token.actor?.isOwner;
}

function recallKnowledgeTokenData(token) {
  return {
    id: token.id,
    actorId: token.actor?.id ?? null,
    name: token.name || token.actor?.name || "Unnamed token",
    img: token.document?.texture?.src || token.actor?.img || "icons/svg/mystery-man.svg"
  };
}

function escapeRecallKnowledgeHTML(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function recallKnowledgeTokenOptions(tokens, selectedId, { includeNone = false } = {}) {
  const options = includeNone ? ['<option value="">No target selected</option>'] : [];
  options.push(...tokens.map((token) => {
    const selected = token.id === selectedId ? " selected" : "";
    return `<option value="${escapeRecallKnowledgeHTML(token.id)}"${selected}>${escapeRecallKnowledgeHTML(token.name || token.actor?.name || "Unnamed token")}</option>`;
  }));
  return options.join("");
}

function recallKnowledgePreview(token, label, { empty = false } = {}) {
  const name = empty ? "No target selected" : (token?.name || token?.actor?.name || "No token selected");
  const img = empty ? "icons/svg/book.svg" : (token?.document?.texture?.src || token?.actor?.img || "icons/svg/mystery-man.svg");
  return `
    <article class="recall-knowledge-preview" data-rk-preview="${label}">
      <img src="${escapeRecallKnowledgeHTML(img)}" alt="">
      <div>
        <span>${label === "subject" ? "Making the check" : "Checking knowledge about"}</span>
        <strong>${escapeRecallKnowledgeHTML(name)}</strong>
      </div>
    </article>`;
}

function selectedRecallKnowledgeSubject(subjects) {
  const controlled = canvas.tokens.controlled.find((token) => subjects.some((candidate) => candidate.id === token.id));
  return controlled ?? subjects[0] ?? null;
}

function selectedRecallKnowledgeTarget(targets) {
  const target = [...game.user.targets].find((token) => targets.some((candidate) => candidate.id === token.id));
  return target ?? null;
}

function updateRecallKnowledgePreviews(form, subjects, targets) {
  const refresh = () => {
    const subject = subjects.find((token) => token.id === form.elements.subjectTokenId?.value) ?? null;
    const target = targets.find((token) => token.id === form.elements.targetTokenId?.value) ?? null;
    for (const [kind, token] of [["subject", subject], ["target", target]]) {
      const preview = form.querySelector(`[data-rk-preview="${kind}"]`);
      if (!preview) continue;
      const image = preview.querySelector("img");
      const name = preview.querySelector("strong");
      if (image) image.src = token?.document?.texture?.src || token?.actor?.img || (kind === "target" ? "icons/svg/book.svg" : "icons/svg/mystery-man.svg");
      if (name) name.textContent = token?.name || token?.actor?.name || (kind === "target" ? "No target selected" : "No token selected");
    }
  };
  form.elements.subjectTokenId?.addEventListener("change", refresh);
  form.elements.targetTokenId?.addEventListener("change", refresh);
  refresh();
}

async function chooseRecallKnowledgeTokens() {
  const tokens = recallKnowledgeSceneTokens();
  const subjects = tokens.filter(canUseRecallKnowledgeSubject);
  if (!subjects.length) {
    return ui.notifications.warn(game.user.isGM
      ? "There are no eligible actor tokens on this scene."
      : "You do not own an eligible actor token on this scene.");
  }
  const subject = selectedRecallKnowledgeSubject(subjects);
  const target = selectedRecallKnowledgeTarget(tokens);
  return foundry.applications.api.DialogV2.wait({
    window: { title: "Recall Knowledge" },
    classes: [MODULE_ID, "recall-knowledge-dialog"],
    position: { width: 560 },
    content: `
      <p class="hint">Choose who is recalling knowledge and, when relevant, what they are recalling knowledge about.</p>
      <div class="recall-knowledge-previews">
        ${recallKnowledgePreview(subject, "subject")}
        ${recallKnowledgePreview(target, "target", { empty: !target })}
      </div>
      <div class="form-group">
        <label>Subject</label>
        <div class="form-fields"><select name="subjectTokenId">${recallKnowledgeTokenOptions(subjects, subject?.id)}</select></div>
      </div>
      <div class="form-group">
        <label>Target</label>
        <div class="form-fields"><select name="targetTokenId">${recallKnowledgeTokenOptions(tokens, target?.id, { includeNone: true })}</select></div>
      </div>`,
    buttons: [
      {
        action: "recall",
        label: "Recall Knowledge",
        icon: "fa-solid fa-book-open-reader",
        default: true,
        callback: (_event, button) => ({
          subjectTokenId: button.form.elements.subjectTokenId?.value,
          targetTokenId: button.form.elements.targetTokenId?.value || null
        })
      },
      { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark", callback: () => null }
    ],
    render: (_event, dialog) => updateRecallKnowledgePreviews(dialog.element.querySelector("form"), subjects, tokens)
  });
}

function recallKnowledgeRequests() {
  return game.settings.get(MODULE_ID, RECALL_KNOWLEDGE_QUEUE_SETTING) ?? [];
}

async function setRecallKnowledgeRequests(requests) {
  await game.settings.set(MODULE_ID, RECALL_KNOWLEDGE_QUEUE_SETTING, requests);
}

async function appendRecallKnowledgeRequest(request) {
  if (!isActiveGM()) return;
  await setRecallKnowledgeRequests([...recallKnowledgeRequests(), request]);
  if (!recallKnowledgeQueueApp?.rendered) recallKnowledgeQueueApp = new RecallKnowledgeQueue();
  recallKnowledgeQueueApp.render({ force: true });
}

async function queueRecallKnowledgeRequest(subject, target) {
  if (game.user.isGM) return;
  const request = {
    id: foundry.utils.randomID(),
    sceneId: canvas.scene?.id ?? null,
    createdAt: Date.now(),
    userId: game.user.id,
    userName: game.user.name,
    subject: recallKnowledgeTokenData(subject),
    target: target ? recallKnowledgeTokenData(target) : null
  };
  const requests = game.user.getFlag(MODULE_ID, RECALL_KNOWLEDGE_USER_QUEUE_FLAG) ?? [];
  await game.user.setFlag(MODULE_ID, RECALL_KNOWLEDGE_USER_QUEUE_FLAG, [...requests, request]);
}

async function collectRecallKnowledgeRequests(user, requests = user.getFlag(MODULE_ID, RECALL_KNOWLEDGE_USER_QUEUE_FLAG)) {
  if (!isActiveGM() || !Array.isArray(requests) || !requests.length) return;
  const existingIds = new Set(recallKnowledgeRequests().map((request) => request.id));
  const newRequests = requests.filter((request) => request?.id && !existingIds.has(request.id));
  for (const request of newRequests) await appendRecallKnowledgeRequest(request);
  const processedIds = new Set(requests.filter((request) => request?.id).map((request) => request.id));
  const current = user.getFlag(MODULE_ID, RECALL_KNOWLEDGE_USER_QUEUE_FLAG) ?? [];
  await user.setFlag(MODULE_ID, RECALL_KNOWLEDGE_USER_QUEUE_FLAG, current.filter((request) => !processedIds.has(request?.id)));
}

function setRecallKnowledgeTarget(target) {
  canvas.tokens.setTargets(target ? [target.id] : [], { mode: "replace" });
}

async function focusRecallKnowledgeRequest(request) {
  if (request.sceneId !== canvas.scene?.id) return ui.notifications.warn("Open the request's scene before focusing its tokens.");
  const subject = canvas.tokens.get(request.subject?.id);
  const target = request.target ? canvas.tokens.get(request.target.id) : null;
  subject?.control({ releaseOthers: true });
  setRecallKnowledgeTarget(target);
  if (subject) canvas.animatePan({ x: subject.center.x, y: subject.center.y, duration: 250 });
}

class RecallKnowledgeQueue extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-recall-knowledge-queue`,
    classes: [MODULE_ID],
    position: { width: 720, height: 520 },
    window: { title: "Recall Knowledge Queue", icon: "fa-solid fa-book-open-reader", resizable: true },
    actions: {
      "focus-request": RecallKnowledgeQueue.#focusRequest,
      "dismiss-request": RecallKnowledgeQueue.#dismissRequest,
      "clear-requests": RecallKnowledgeQueue.#clearRequests
    }
  };

  static PARTS = { queue: { template: `modules/${MODULE_ID}/templates/recall-knowledge-queue.hbs`, root: true, scrollable: [".recall-knowledge-request-list"] } };

  get title() { return "Recall Knowledge Queue"; }

  async _prepareContext(options) {
    const requests = recallKnowledgeRequests().map((request) => ({
      ...request,
      targetName: request.target?.name ?? "No target selected",
      targetImg: request.target?.img ?? "icons/svg/book.svg",
      createdAtLabel: new Date(request.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    }));
    return { ...await super._prepareContext(options), requests, hasRequests: requests.length > 0 };
  }

  static async #focusRequest(_event, target) {
    const request = recallKnowledgeRequests().find((entry) => entry.id === target.dataset.requestId);
    if (request) await focusRecallKnowledgeRequest(request);
  }

  static async #dismissRequest(_event, target) {
    await setRecallKnowledgeRequests(recallKnowledgeRequests().filter((entry) => entry.id !== target.dataset.requestId));
  }

  static async #clearRequests() {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Clear Recall Knowledge Queue" },
      content: "<p>Clear every pending Recall Knowledge request from this queue?</p>",
      yes: { label: "Clear Queue", icon: "fa-solid fa-trash" }
    });
    if (confirmed) await setRecallKnowledgeRequests([]);
  }
}

async function invokeWorkbenchRecallKnowledge() {
  const pack = game.packs.get(RECALL_KNOWLEDGE_PACK);
  if (!pack) return ui.notifications.error("PF2e Workbench's Recall Knowledge macro is unavailable. Enable PF2e Workbench first.");
  const [macro] = await pack.getDocuments({ name: RECALL_KNOWLEDGE_MACRO });
  if (!macro) return ui.notifications.error("PF2e Workbench's Recall Knowledge macro could not be found.");
  return macro.execute({ event: new Event("click") });
}

async function openRecallKnowledge() {
  const choice = await chooseRecallKnowledgeTokens();
  if (!choice?.subjectTokenId) return;
  const tokens = recallKnowledgeSceneTokens();
  const subject = tokens.find((token) => token.id === choice.subjectTokenId);
  const target = choice.targetTokenId ? tokens.find((token) => token.id === choice.targetTokenId) : null;
  if (!subject || !canUseRecallKnowledgeSubject(subject)) return ui.notifications.warn("That subject is no longer available for Recall Knowledge.");
  subject.control({ releaseOthers: true });
  setRecallKnowledgeTarget(target);
  await queueRecallKnowledgeRequest(subject, target);
  return invokeWorkbenchRecallKnowledge();
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
  game.settings.register(MODULE_ID, "oracularWarning", {
    name: "A PC Has Oracular Warning",
    hint: "When initiative begins, each non-deafened friendly combatant within 20 feet of an Oracle with Oracular Warning receives its initiative status bonus and temporary Hit Points.",
    scope: "world",
    config: game.system.id === "pf2e",
    type: Boolean,
    default: false,
  });
  game.settings.register(MODULE_ID, "retributiveStrike", {
    name: "A PC Has Retributive Strike",
    hint: "When the champion targets a damaged ally and the triggering enemy, using Retributive Strike validates the Champion's Aura, applies Champion's Resistance to the triggering damage, and rolls a melee Strike if the enemy is in reach.",
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
  game.settings.register(MODULE_ID, "recallKnowledgeExcludeIncapacitated", {
    name: "Recall Knowledge: Exclude Dead or Unconscious Tokens",
    hint: "Hides scene tokens with the Dead or Unconscious condition from Recall Knowledge's subject and target pickers.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, RECALL_KNOWLEDGE_QUEUE_SETTING, {
    scope: "world",
    config: false,
    type: Array,
    default: []
  });
  game.settings.registerMenu(MODULE_ID, "awardPanel", {
    name: "Hero Points, Mythic Points, and Bonus Dice",
    label: "Open Award Panel",
    hint: "Set session Hero Points and award Hero, Mythic, and bonus-die resources.",
    icon: "fa-solid fa-star",
    type: AwardPanel,
    restricted: true
  });
  game.settings.registerMenu(MODULE_ID, "recallKnowledgeQueue", {
    name: "Recall Knowledge Queue",
    label: "Open Recall Knowledge Queue",
    hint: "Review player-generated Recall Knowledge checks, including their selected subject and target.",
    icon: "fa-solid fa-book-open-reader",
    type: RecallKnowledgeQueue,
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
  game.modules.get(MODULE_ID).api = {
    open: () => new AwardPanel().render({ force: true }),
    recallKnowledge: () => openRecallKnowledge(),
    recallKnowledgeQueue: () => {
      recallKnowledgeQueueApp ??= new RecallKnowledgeQueue();
      return recallKnowledgeQueueApp.render({ force: true });
    }
  };
  game.socket.on(RETRIBUTIVE_STRIKE_SOCKET, async (payload) => {
    if (payload?.type === "retributive-strike-request" && isActiveGM()) {
      const response = await resolveRetributiveStrike(payload).catch((error) => ({ error: error.message ?? "Retributive Strike could not be resolved." }));
      game.socket.emit(RETRIBUTIVE_STRIKE_SOCKET, { type: "retributive-strike-response", userId: payload.userId, championActorId: payload.championActorId, ...response });
    } else if (payload?.type === "retributive-strike-response" && payload.userId === game.user.id) {
      if (payload.error) ui.notifications.warn(payload.error);
      else await rollRetributiveStrike(payload);
    }
  });
  registerBreakTimeIntegration();
  void removeLegacyCriticalInitiativeEffects();
  if (game.settings.get(MODULE_ID, "dynamicStride")) void ensureDynamicStride();
  if (isActiveGM()) void Promise.all(game.users.map((user) => collectRecallKnowledgeRequests(user)));
});

Hooks.on("updateUser", (user, changes) => {
  const requests = changes.flags?.[MODULE_ID]?.[RECALL_KNOWLEDGE_USER_QUEUE_FLAG];
  if (requests !== undefined) void collectRecallKnowledgeRequests(user, requests);
});

Hooks.on("updateSetting", (setting) => {
  if (setting.key !== `${MODULE_ID}.${RECALL_KNOWLEDGE_QUEUE_SETTING}` || !recallKnowledgeQueueApp?.rendered) return;
  recallKnowledgeQueueApp.render({ force: true });
});

Hooks.on("pf2e-toolbelt.preUsePhysicalItem", (context) => {
  if (!carefulConsumptionEnabled() || !isHealingConsumable(context.item)) return;
  void promptCarefulConsumption(context);
  return false;
});

Hooks.on("renderActorSheetV2", injectBonusReadout);
Hooks.on("renderActorSheet", injectBonusReadout);
Hooks.on("createChatMessage", (message) => {
  if (!message.isAuthor) return;
  if (message.flags.pf2e?.context?.type === "attack-roll" && message.item?.isOfType?.("weapon") && message.item.isMelee) {
    void message.actor?.setFlag(MODULE_ID, "lastMeleeStrikeItemId", message.item.id);
  }
  void beginRetributiveStrike(message);
});
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
Hooks.on("createCombat", (combat) => {
  scheduleOracularWarnings(combat);
});
Hooks.on("createCombatant", (combatant) => {
  scheduleOracularWarnings(combatant.combat ?? game.combats.get(combatant.combatId) ?? combatant.parent);
});
Hooks.on("getChatMessageContextOptions", (_application, menuItems) => {
  menuItems.push({
    name: "Add Bonus Die to Roll",
    icon: '<i class="fa-solid fa-dice-d20"></i>',
    condition: (li) => canSpend(game.messages.get(li.dataset.messageId)),
    callback: (li) => spendBonusDie(game.messages.get(li.dataset.messageId))
  });
});
