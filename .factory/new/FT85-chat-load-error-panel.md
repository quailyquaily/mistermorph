# Chat loading failure: centered error panel with refresh

## factory · 2026-11-11 13:08
Recorded from the owner’s UI fix request.

Request:
> On chat view, if loading failed, for example the network issues, show the error message panel in the view, with an icon, a text and a refresh button on it, all center aligned.

Acceptance criteria:
- When loading the chat view fails (including network errors), render an error panel inside the chat view rather than leaving a blank view or endless loading indicator.
- Show an error icon, readable error text, and a Refresh button as a centered group; center-align the contents.
- Refresh retries loading the current chat without requiring a full application restart. Prevent duplicate retries while loading; clear the error on success and keep a usable retry state on another failure.
- Preserve distinct loading, empty, successful, and error states; do not turn message-send failures into full-view load failures or discard already loaded messages unnecessarily.
- Add regression tests for failure, retry success, and repeated failure. Check layout and retry interaction in web and Android app; explicitly record any platform not actually checked.

Implementation: Claude Code only; do not use Codex.
