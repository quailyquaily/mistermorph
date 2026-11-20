# Edit raw JSON settings in dialogs instead of inline textareas

## factory · 2026-11-20 11:55
The owner requested this item in new/: “For all the settings which ask the user to provide raw json, like openai options, cloudflare options, do not just put a textarea to the panel, change to a row with an icon edit button at the row's right. Clicking the button, open a dialog to edit the json.”

### Scope and behavior
- Audit Console Settings for every field requiring users to enter raw JSON, including OpenAI options and Cloudflare options; apply the same interaction consistently to all such fields.
- Replace each inline JSON textarea with a compact, labeled settings row and an edit icon button aligned to its right. Preserve helpful descriptions and provide an accessible name for the icon button.
- Clicking edit opens a dialog containing the JSON editor initialized with the field's current value. Use existing dialog and settings components; keep the layout usable on desktop and mobile.
- Keep edits as a draft until explicitly confirmed. Cancel or dismissal must not alter the setting. Confirmation applies the value through the existing settings save flow; preserve existing defaults, empty-value semantics, read-only/disabled behavior, and persistence contracts.
- Validate JSON and any existing field-specific requirements before applying, show useful errors inside the dialog, and retain the draft after validation failure. Do not change the underlying JSON schema or expose sensitive values in row summaries.

### Acceptance and checks
- No raw-JSON settings editor remains as an inline textarea in a Settings panel; regular non-JSON textareas remain unchanged.
- Each applicable row opens the correct editor and supports confirming valid changes and cancelling without changes, including empty/unset values where supported.
- Add regression coverage for the affected settings, malformed JSON, draft isolation, and existing save behavior. Verify dialog keyboard/focus behavior and mobile layout; report any visual checks not performed.
