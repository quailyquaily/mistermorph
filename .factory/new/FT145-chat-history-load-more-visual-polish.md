# Polish the chat history “load more” control

## factory · 2026-11-17 18:59
Owner request from Console: the chat history “load more” button looks arbitrarily placed on the page. Polish its visual design and add this work to new/.

Scope and acceptance:
- Integrate the “load older messages” control into the top boundary of the conversation history with deliberate alignment, spacing, and visual hierarchy; it should read as part of the history, not a detached page action.
- Follow the Console's existing visual language; keep the control secondary to the conversation and composer rather than introducing an unrelated style.
- Make the layout and touch target work on desktop, mobile web, and Android, including light and dark themes.
- Provide coherent idle, loading, and disabled states without duplicate requests or distracting layout jumps; hide the control when no older history remains.
- Preserve cursor-based pagination, message order, and scroll-position anchoring when older messages are prepended. Do not change backend pagination or turn this into a broader chat redesign.
- Add suitable regression coverage and visually inspect the control in desktop and narrow layouts; record what was and was not verified.
