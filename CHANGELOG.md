# Changelog

## Unreleased

- Rebuilt the GM award panel around four focused functions: **Session Start**,
  **Custom Add**, **Mid-Game Break**, and **Bonus Dice**.
- Session Start sets every Hero Point character to 1 and one selected MVP to 2;
  Mythic Session Start sets every character to 3 Mythic Points.
- Custom Add applies a chosen 1–3 point award to all or selected characters
  without exceeding the 3-point cap. Mid-Game Break remains Hero Point-only.
- Bonus Dice now has a dedicated tab, leaving routine point awards compact and
  easy to confirm.

## 0.2.0

- Added GM-batched **Bestiary Tracker** adjudication for checks launched from
  Lex's Recall Knowledge macro. The GM marks each result as a failure, success,
  or critical success, then selects one or two facts to reveal.
- Supports individual Fortitude, Reflex, and Will reveals using Tracker's
  comparative save descriptions, plus individual immunities, resistances, and
  weaknesses. Absent IWR categories can be recorded as a deliberate discovery.
- Revealed facts persist in PF2E Bestiary Tracking, are shared party-wide, and
  can be posted as a public Recall Knowledge chat card. Already known facts are
  visibly marked and cannot spend another selection.
- Warns the GM when Bestiary Tracker needs **Vague Descriptions → Saves** and
  **Comparative Save Descriptions** enabled for qualitative save reveals.

## 0.1.9

- Recall Knowledge now reliably controls the selected subject token and updates
  the user's target before invoking PF2e Workbench's standard workflow.

## 0.1.8

- Added a scene-aware **Recall Knowledge** picker that lets the user choose the
  subject and target before invoking PF2e Workbench's standard Recall Knowledge
  workflow.
- Players can select only tokens they own; the GM can select any eligible scene
  token. A new world setting can exclude Dead or Unconscious actors.
- Added a GM-only Recall Knowledge Queue that records player-selected subjects
  and targets for quick review and focus.

## 0.1.7

- Mythic Point changes in the award panel now stage alongside Hero Points and bonus dice, then apply in one batch with a single public session-award summary.
- Relies on PF2e and SF2e's native **Rewrite Fate** chat-card reroll control, which spends a Mythic Point and rerolls with Mythic Proficiency.

## 0.1.6

- Retributive Strike now uses the targeted enemy's latest unresolved PF2e damage roll regardless of its age, so the reaction survives breaks, reloads, and resumed combats.

## 0.1.5

- Adds optional **Retributive Strike** automation for PF2e champions.
- Validates the selected protected ally and triggering enemy against the Champion's Aura, applies the native Champion's Resistance effect to the triggering damage, and rolls the champion's ready melee Strike when the enemy is within reach.
- Adds **Oracular Warning** to the module feature list.

## 0.1.3

- Renamed the module to **Lex's Variant Rules** while retaining the existing module ID for installed-world compatibility.
- Added settings for Bonus Dice, Dynamic Stride, Critical Initiative, and deliberate Mid-Game Break Hero Point awards.
- Critical Initiative now applies exactly one named, native PF2e condition and removes obsolete duplicate wrapper effects from prior versions.
- Adds the deliberate **Award HP** button to Break Time, alongside the existing Award Panel control.

- Adds the Careful Consumption variant-rule hook for PF2e Toolbelt's inventory **Use** control.
- Healing consumables now offer Regular Consumption or **Careful Consumption (2 actions)**, which posts maximum healing and expends one use.
- Adds the optional Greater Field Discovery checkbox for campaigns with a chirurgeon.

## 0.1.2

- Lets the GM set selected PCs' opening Hero Points and bonus dice together with one bulk apply action.
- Adds explicit **No change** and **Clear** states for bonus dice, preventing accidental loss of an unspent die.
- Stops award updates from opening character sheets.
- Displays the held bonus-die badge beside either Hero Points or Mythic Points.

## 0.1.1

- Replaces the hard-to-read die glyph in PF2e character-sheet headers with a compact `dX` badge and tooltip.

## 0.1.0

- Initial release of the GM award panel for session Hero Points, Mythic Points, and held bonus dice.
- Adds the native chat-card action **Add Bonus Die to Roll** for supported PF2e checks.
- Bonus dice are Fortune effects: one die per character, and a spent die cannot stack with a Hero Point reroll on the same check.
