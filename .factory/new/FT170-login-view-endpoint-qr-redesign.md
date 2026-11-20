# Redesign the login view: password alignment and clearer endpoint setup with QR scanning

## factory · 2026-11-21 08:10
The owner requested: "The login page, the password entry, the mask button, is not aligned yet. And the login page, the entry to update endpoint is not so clear to understand, and there need a scan qr code button to fill the endpoint url easily. So please redesign the login view and fix issues. Add to new/"

### Requirements
- Redesign the login view for a clear, cohesive layout, prioritizing mobile while keeping desktop usable and consistent with the existing Console design.
- Fix alignment of the password field and its show/hide (mask) button. Keep the control vertically centered, with a comfortable touch target and no overlap with input text; toggling visibility must not shift the layout or lose the entered password.
- Make the currently selected server endpoint and the action to change it easy to find and understand. Use explicit labels and short explanatory text rather than an ambiguous icon-only entry. Keep manual URL entry available.
- Add a clearly labeled scan-QR-code button to endpoint setup. On supported devices, open a camera scanner, read an endpoint URL from a QR code, and fill the endpoint field for the user to review and save through the normal endpoint-update flow. Scanning alone must not automatically log in or send credentials to the scanned endpoint.
- Validate scanned input using the same endpoint URL rules as manual input. Explain invalid or unsupported QR contents without replacing the existing valid endpoint. Support cancel, permission denied, unavailable camera, unsupported browser, and retry without blocking manual entry. Stop camera access when the scanner closes or the view is left.
- Preserve existing authentication and endpoint persistence behavior. Provide accessible labels and keyboard operation, and prevent narrow-screen clipping or horizontal overflow.

### Acceptance checks
- Visually verify mobile and desktop login layouts, including password masked/unmasked, focus, validation errors, and long endpoint URLs.
- Verify the endpoint change action is understandable without guessing what an icon means; both manual entry and a valid QR scan can populate and save an endpoint.
- Add regression tests for password-control alignment/layout where practical, endpoint editing and validation, QR success/invalid content/cancellation/error handling, and camera cleanup. Record any camera/device checks that cannot be performed automatically.
