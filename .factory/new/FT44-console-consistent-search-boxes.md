# Consistent search boxes on Topics and Contacts pages

## factory · 2026-11-09 19:06
Owner request: "New UI fix: the search box on the topic page and contact page should be the same style, size, and position"

Queue this UI fix in new/.

Acceptance criteria:
- Topics and Contacts search boxes use the same visual style, including typography, colors, border, radius, icon treatment, and internal spacing.
- At matching viewport sizes, use the same height and width rules, and the same placement and spacing relative to the page header and content.
- Keep the layout consistent on desktop and mobile without overflow or overlap; preserve existing search behavior, accessible labels, focus handling, and clear controls.
- Reuse a shared component or styling where practical; do not redesign unrelated page content.
- Add regression coverage for the shared appearance/layout contract and confirm both pages visually at desktop and mobile sizes. Record any visual checks that cannot be performed.
