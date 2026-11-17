# Replace the Todo detail Markdown editor with a regular textarea, keeping the toolbar

## factory · 2026-11-17 23:49
Owner request: "New UI request: replace the markdown editor in the Todo detail page with a regular textarea. But the toolbar should remain and so I can still use them to insert. Put to new/"

Requirements:
- In the Console Todo detail page, replace the Markdown editor with a regular plain-text textarea.
- Keep the existing formatting/insertion toolbar visible and usable. Its actions must insert the corresponding Markdown or content into the textarea at the cursor, or apply to the selected text where appropriate.
- Keep textarea focus and cursor/selection behavior usable after toolbar actions; do not lose existing text.
- Preserve existing Todo detail loading, editing, saving, and stored Markdown content. This is an editing UI change, not a content migration.
- Preserve applicable read-only/disabled behavior and keyboard accessibility.
- Add regression coverage for textarea editing and saving, toolbar insertion at the cursor, formatting selected text, and preservation of surrounding text. Check the UI manually where possible and record any unchecked behavior.

Requested status: new. Implementation is pending.
