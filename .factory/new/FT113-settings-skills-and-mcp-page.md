# Settings: combine Skills and MCP on one page

## factory · 2026-11-14 06:58
Owner request from Console:

> Rename settings -> MCP to "SKILLs & MCP", move the skill option from Tools to "Skills & MCP" page.
> Put to new/

### Required behavior
- Rename the existing Settings MCP navigation entry and page heading to "SKILLs & MCP". The request also uses "Skills & MCP" for the same destination; use "SKILLs & MCP" consistently as the explicitly requested label.
- Move the existing skill option and its associated controls from Settings → Tools to the renamed page, alongside the existing MCP settings.
- Preserve the skill option's current behavior, saved values, defaults, and persistence. This is a UI regrouping, not a configuration-key rename or behavior change.
- Keep existing MCP controls and functionality intact, and leave unrelated Tools options on the Tools page. Avoid duplicate skill controls on both pages.
- Update relevant navigation labels, localized strings, and help text. Preserve existing MCP settings links/routes where practical, or redirect them to the renamed destination.

### Acceptance checks
- Settings navigation and the destination heading show "SKILLs & MCP" on desktop and mobile without overflow.
- The skill option is available and functional on that page and no longer appears under Tools.
- Previously saved skill settings remain selected after the move; changing them still persists across reloads.
- Existing MCP configuration and unrelated Tools controls continue working; existing links to MCP settings still resolve.
- Add or update relevant UI regression tests; state any browser checks that could not be performed.

Status: requested only; not implemented yet.
