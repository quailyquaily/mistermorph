# Keep the skill install preview card's long values inside it on phones

## factory · 2026-11-24 15:51
Owner request: “on mobile view, the output panel of the skill preview, the content may overflow the panel. please check if this issue exists or not.” → checked, confirmed → “add to factory new/”

The skill install approval card in chat (`components/chat/ChatSkillInstallPreview.tsx`, the "Approval required" card of a `skill_install` call) lets long values run past its right border on a phone. Checked on the web Console built from master (a92d51f4), 390×844, with a real GitHub skill (anthropics/skills, `skills/pdf`) and review findings with long values. Card's right edge at x=351:

- **Source** row (`:143`, link + `@commit`): ran to x=700. A GitHub source URL carries the full 40-character commit (`…/tree/<commit>/skills/pdf`), so this happens on nearly every GitHub install.
- Finding summary row (`:84`, severity, title, `file:line`): ran to x=565 for a long file path, x=842 for a title with a URL.
- Note row (`:266`, title, file, evidence): ran to x=1007 for a long evidence string.
- Coverage gaps row (`:209`, path, status, note) uses the same pattern; not triggered in the check, likely the same.

The page itself did not scroll sideways (document width stayed 390); the content spilled over the card's border.

Likely cause: each of these rows puts several `Text` pieces side by side in a `flex-row flex-wrap` view. On the web a piece wider than the row keeps its whole width instead of wrapping inside it, so `flex-wrap` only moves it to its own line. Text on its own line already wraps correctly in the same card (description, evidence boxes, review summary).

Not affected (checked at 390pt): the Skills page's SKILL.md view and its file preview; long links and lines wrap inside the box, code blocks and tables scroll inside it.

Acceptance criteria:
- At phone widths (360 and 390pt) and in the desktop layout, nothing in the card is drawn past its border: the source URL and commit, finding titles, `file:line`, note titles and evidence, and gap paths wrap inside the card (breaking inside long unbroken runs where needed).
- Short values keep today's look: severity, title and file on one line when they fit.
- The source link stays one pressable link; copying or opening it still gives the whole URL.
- Same behaviour on the desktop app and Android (one TSX source).
- A test covers the long-value cases (long source URL with commit, long file path, long title with a URL, long note evidence, long gap path) and asserts they stay inside the card at a phone width.
