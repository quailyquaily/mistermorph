# Fix drag-and-drop tag assignment in the topic list

## factory · 2026-11-10 08:42
Registered from the owner’s request.

User report: "Can't drag and drop at the tag topic list to assign tags to the topic item"

Restore drag-and-drop tag assignment in the tag/topic list. Inspect the existing UI to identify its intended drag source and drop target; make that interaction assign the intended tag to the intended topic. Give clear valid-drop feedback, persist the assignment, and refresh the affected list and topic tag display without a reload. Preserve other tags and avoid duplicate assignments. Cancelled or invalid drops must not change tags; report persistence failures.

Add regression coverage for a successful assignment, duplicate assignment, and invalid/cancelled drops. Preserve click/tap tag assignment on touch devices.
