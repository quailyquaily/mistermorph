# Restore adding topic tags from the right-side panel

## factory · 2026-11-10 08:42
Registered from the owner’s request.

User report: "Can't click to add tags for the topic at the right panel."

Restore the right-side topic panel's add-tag interaction. Clicking/tapping the control should open the tag picker and allow assigning a tag to the current topic. Persist the assignment and update the panel and relevant topic lists without a reload. Preserve existing tags, prevent duplicate assignments, and surface failures rather than silently doing nothing.

Check pointer and touch interaction and add regression coverage for opening the picker and successfully assigning a tag.
