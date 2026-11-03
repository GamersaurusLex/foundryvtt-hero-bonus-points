# Hero & Bonus Points

A Foundry VTT v14 module for PF2e and SF2e that gives the GM one native award panel for Hero Points, Mythic Points, and bonus dice.

## What it does

- Set each selected PC's opening Hero Points for a session, from 0 to 3.
- Award one mid-session Hero Point to selected PCs without exceeding the normal cap of 3.
- Adjust each character's native Mythic Points when that resource is enabled by the active system.
- Award one held d4, d6, d8, d10, or d12 bonus die to a PC; a new award replaces an unspent die.
- Let an eligible player right-click their PF2e check card and choose **Add Bonus Die to Roll**.
- Optionally enable **Careful Consumption** for healing consumables used through PF2e Toolbelt's inventory **Use** button. Players choose normal healing or maximum healing at a 2-action cost. Campaigns with a chirurgeon using Greater Field Discovery can enable its additional normal-healing roll in the same dialog.

For a supported PF2e check with a DC, the bonus die is folded into the original chat card and its degree of success recalculates. The die is a Fortune effect, so it cannot be combined with a Hero Point reroll on that check.

## Use

Open **Game Settings → Hero & Bonus Points → Open Award Panel**. The panel is GM-only; award announcements are public. Players see a read-only held-bonus-die indicator on their character sheet.

Enable **Careful Consumption** from the module settings after installing the companion Gamersaurus Lex fork of PF2e Toolbelt. The Toolbelt hook preserves its normal consumption workflow when a player selects **Regular Consumption**.

## Compatibility note

Foundry VTT does not expose a public API for adding a modifier to an already-resolved PF2e check. The card-rebuild behavior therefore uses a deliberately guarded PF2e compatibility layer adapted with permission from Jacob Heider's Bonus Die module. If that system integration changes, the module falls back to posting the bonus die as a separate result rather than damaging the original card.

## Credits

The bonus-die card integration is adapted from Jacob Heider's Bonus Die source with his permission. See [NOTICE.md](NOTICE.md).
