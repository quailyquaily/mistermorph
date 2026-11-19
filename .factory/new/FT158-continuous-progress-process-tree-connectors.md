# Keep Progress and Processes tree connectors continuous

## factory · 2026-11-19 19:24
Owner reports that the lines on the left of progress output break into multiple pieces and requests this fix in new/ after reviewing the diagnosis with Claude Code.

### Problem and scope
- The prior investigation found text-based tree prefixes (`│`, `├─`, `└─`) in `ChatProcessTree.tsx` and `ChatStatusCard.tsx` (`ActivityCallTree`). A one-line glyph cannot span wrapped command text, expanded content, nested children, or row gaps. Verify the current implementation before changing it.
- Fix both the Processes sheet and the Progress panel; preserve their existing content, hierarchy, status indicators, expansion behavior and interactions.

### Requirements and checking
- Replace character-based connector segments with layout-based strokes (borders, positioned views, or an equivalent simple approach) that follow each node's actual height and nesting.
- Keep vertical trunks continuous across wrapped commands, expanded details, child nodes and spacing. Align horizontal branches with node headers, and terminate the last sibling's trunk at its branch without a dangling line.
- Decorative connectors must not intercept input or enter the accessibility tree. Preserve readable indentation and existing light/dark styling.
- Add regression coverage for multiline commands, nested children, expanded content, single-child and last-sibling cases, including narrow layouts. Check desktop web, mobile web and Android rendering where available; report visual checks that could not be performed.
- This is a focused connector-rendering fix, not a redesign of either panel or a change to process/progress data handling.
