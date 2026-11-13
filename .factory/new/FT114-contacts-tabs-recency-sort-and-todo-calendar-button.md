# Contacts: Agents/Humans tabs and recent-interaction sorting; circular Todo calendar toggle

## factory · 2026-11-14 07:03
Owner request from Console:

> The contacts page, use a tab like topics page to distinguish the agents and human contacts.
> And sort them by last interaction by default.
> And the calendar toggle button on the Todo page should be circle.
> Add it to new/

### Required behavior
- Split the Contacts page into Agents and Humans tabs, using icon-only tab buttons (an agent icon and a human/person icon), with no visible text labels. Retain the Topics page's tab layout and interaction conventions, with a clear selected state. Give each button an accessible name (Agents or Humans), keyboard support, and a usable touch target. Each tab shows only contacts of that kind, retaining existing contact actions and applicable filters.
- Default to last-interaction order, newest first, within each tab. Use actual recorded interaction timestamps rather than contact creation or profile-update times. Contacts without an interaction timestamp go after dated contacts; use a deterministic secondary order for ties and undated contacts.
- Keep the active tab's ordering correct after interaction data refreshes. Handle empty tabs and missing timestamps without errors.
- Make the Todo page's calendar toggle button circular, with equal width and height, centered icon, and a fully rounded border in both active and inactive states. Preserve its toggle behavior, accessible label, focus indicator, and usable touch target.

### Acceptance checks
- Agents and Humans are separated by icon-only tab buttons on desktop and mobile, with no visible text labels, distinct icons, accessible names, and a clear selected state; switching tabs does not mix contact kinds or break contact actions.
- Initial contact lists are sorted newest-interaction first, including correct handling of ties, no-interaction contacts, and refreshed interaction timestamps.
- Empty contact kinds display an appropriate empty state.
- The Todo calendar toggle remains circular at supported viewport sizes in both states, with no icon clipping or layout overflow; mouse, touch, and keyboard toggling still work.
- Add or update regression tests for icon-only tabs and their accessible names, contact-kind filtering, default ordering and missing timestamps, plus the calendar toggle's shape and behavior. State any browser checks that could not be performed.

## factory · 2026-11-14 07:05
Owner clarification: Agents/Humans tabs must use icon buttons, with no visible labels.

Status: requested only; not implemented yet.
