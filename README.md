# Lex's Variant Rules

A Foundry VTT v14 module for PF2e and SF2e that gives the GM one native award panel for Hero Points, Mythic Points, and optional bonus dice. It also hosts GM-selectable PF2e variant rules.

## What it does

- **Session Start:** set every PC to 1 Hero Point and select one MVP to receive 2, or set every PC to 3 Mythic Points.
- **Custom Add:** add 1–3 Hero or Mythic Points to all PCs or only selected PCs, respecting the 3-point cap.
- **Mid-Game Break:** add 1 Hero Point to every PC below 3. This is available only in Hero Point games.
- Award one held d4, d6, d8, d10, or d12 bonus die to a PC; a new award replaces an unspent die.
- Let an eligible player right-click their PF2e check card and choose **Add Bonus Die to Roll**.
- Provide a scene-aware **Recall Knowledge** picker and GM review queue when run from Lex's Macro Library.
- Batch-adjudicate successful Recall Knowledge checks into PF2E Bestiary Tracking, revealing individual saves, immunities, resistances, or weaknesses and optionally posting the approved facts to public chat.
- Optionally enable **Careful Consumption** for healing consumables used through PF2e Toolbelt's inventory **Use** button. Players choose normal healing or maximum healing at a 2-action cost. Campaigns with a chirurgeon using Greater Field Discovery can enable its additional normal-healing roll in the same dialog.

For a supported PF2e check with a DC, the bonus die is folded into the original chat card and its degree of success recalculates. The die is a Fortune effect, so it cannot be combined with a Hero Point reroll on that check.

## Use

Open **Game Settings → Lex's Variant Rules → Open Award Panel**. The panel is GM-only; award announcements are public. Players see a read-only held-bonus-die indicator on their character sheet when Bonus Dice are enabled.

The panel opens on **Session Start**. Use the tabs for Custom Add, Mid-Game Break, and Bonus Dice; each function has its own commit button, so a Mythic award cannot accidentally alter Hero Points or bonus dice.

## Variant rules

- **Careful Consumption:** eligible healing consumables can be consumed normally or carefully for maximum healing.
- **Dynamic Stride:** adds the two-action activity to the world Items directory when enabled.
- **Critical Initiative:** a natural 20 applies **Critical Initiative Success** (Quickened through the end of the actor's first turn); a natural 1 applies **Critical Initiative Failure** (Off-Guard until that turn begins).
- **Mid-Game Break Hero Points:** adds a deliberate **Award HP** button to Break Time that opens the same Mid-Game Break function.
- **Bestiary Tracker Recall Knowledge:** when PF2E Bestiary Tracking is active, the GM queue can resolve a success into one revealed fact or a critical success into two. Enable Tracker's **Vague Descriptions → Saves** and **Comparative Save Descriptions** to keep player-facing save knowledge qualitative rather than numeric.

Enable **Careful Consumption** from the module settings after installing the companion Gamersaurus Lex fork of PF2e Toolbelt. The Toolbelt hook preserves its normal consumption workflow when a player selects **Regular Consumption**.

## Compatibility note

Foundry VTT does not expose a public API for adding a modifier to an already-resolved PF2e check. The card-rebuild behavior therefore uses a deliberately guarded PF2e compatibility layer adapted with permission from Jacob Heider's Bonus Die module. If that system integration changes, the module falls back to posting the bonus die as a separate result rather than damaging the original card.

## Credits

The bonus-die card integration is adapted from Jacob Heider's Bonus Die source with his permission. See [NOTICE.md](NOTICE.md).
