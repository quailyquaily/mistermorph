# Console mobile app: file downloads with an icon button

## factory · 2026-11-17 18:53

Owner request:
> Console in the mobile app must support file downloads. Use an icon button for the download action.

Context:
- A Console `send_file` text attachment was delivered successfully, but saving it in the phone app reported "Saving files is not available in the phone app yet."
- The prior investigation reported an explicit unsupported `morph.file.save` handler in `web/console-nsh/lib/mobileHost.ts`. Verify the current implementation and mobile host APIs before choosing a solution; do not assume ChatView is an embedded WebView or that blob downloads are the cause.

Scope and acceptance:
- Implement saving/downloading received Console attachments in the mobile app, including Android, through the supported mobile/native file-saving APIs. The user must be able to choose an appropriate destination and receive the original file contents with the correct filename.
- Use an icon button for the attachment download action, consistent with existing Console controls, with an accessible label and a usable mobile touch target.
- Handle in-progress state, user cancellation, unavailable capabilities, and actual download/save failures accurately. Do not report success before saving has completed or leave the current unconditional unsupported error on supported mobile paths.
- Preserve existing desktop/browser attachment downloads and existing attachment access checks. Do not introduce public file URLs or expose credentials.
- Add regression coverage for mobile host save handling, the download icon button and its states, cancellation/failure, and existing browser behavior. Run the required Console checks/tests; document whether Android/mobile end-to-end saving was actually verified and any platform limitations.

Requested status: new. Investigation and implementation are pending.
