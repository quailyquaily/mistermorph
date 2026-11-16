# Console UI: no caret on the compact agent switcher, icon-only buttons, rounded voice bar

## factory · 2026-11-16 20:45

Owner request:
> here are some UI issues:
> 1. Agent switcher's compact mode, do not show the caret.
> 2. I don't like button with both label and icon. remove the button with label and icon in ui-component. if in the UI there are button with both label and icon, replace it with icon only.
> 3. the voice bar in the composer should be radius corner as well, just like composer itself.

Scope and acceptance:

1. **Agent switcher, compact mode.** `web/console-nsh/components/frame/AgentSwitcher.tsx` (`compact` prop, used by the collapsed sidebar): in compact mode the trigger shows no caret, also while its popover is open. The full-width switcher keeps its caret.
2. **No button with both a label and an icon.**
   - Remove the label-and-icon button examples from the UI component gallery (`web/console-nsh/pages/ui-components/demos/`), and keep `pages/ui-components/inventory.js`, `docs/console/ui-components.md` and the gallery tests in step.
   - Find every button in the Console that shows a label and an icon together, and make it icon-only. An icon-only button keeps its meaning for people who cannot see the icon: the former label becomes its `accessibilityLabel` and its tooltip.
   - A loading spinner inside a button is its busy state, not an icon; leave it.
   - Menu rows, list rows, tabs, chips and navigation entries are not buttons; leave them.
3. **Voice bar in the composer.** The bar the composer shows while recording voice has the same corner radius as the composer itself, in every place the composer is shown (conversation, landing, mobile).

Checking: `nsh check` and `web/console-nsh/scripts/test.sh` pass, with tests updated where they find a button by its label text; look at `/ui-components` (frame, controls and chat sections) for all three changes.
