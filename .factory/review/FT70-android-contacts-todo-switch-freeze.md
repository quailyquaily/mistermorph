---
branch: factory/FT70-android-contacts-todo-switch-freeze
round: 1
---
# Android freezes after repeated Contacts / Todo switching

## factory · 2026-11-10 20:08
Owner report:
> new UI issue: Android version, switch from contacts and Todo and switch back 14 times, the app froze up and can switch anymore

Interpretation: after repeatedly switching between Contacts and Todo (reported at 14 repetitions), the Android app freezes and further navigation no longer works.

Reproduction:
1. Open the Android app and navigate to Contacts.
2. Switch to Todo and back to Contacts repeatedly, around 14 repetitions.
3. Observe whether the UI freezes and navigation stops responding.

Expected: switching remains responsive regardless of the number of repetitions.

Scope and acceptance:
- Investigate and fix the cause of the repeated-navigation freeze; do not assume a cause before reproducing or collecting evidence.
- Verify at least 50 Contacts → Todo → Contacts cycles without a freeze; both views and navigation must remain interactive.
- Add regression coverage for the identified cause where practical.
- Record the tested Android/device/app version and distinguish automated checks from actual Android verification. Device, Android version, app build, and logs were not supplied; the report has not yet been independently reproduced.

## factory · plan · 2026-11-10 21:27

Behaviour: repeatedly switching Contacts → Todo → Contacts must keep routing and both pages interactive, including empty data, delayed responses, errors and initial load. Collect reproduction or concrete lifecycle evidence before selecting a fix; do not claim the Android symptom is reproduced without a device.
Scope: inspect page mount/unmount ownership, store subscriptions, effects, pending requests and renderer resources; fix only the demonstrated cause and add focused regression coverage. No unrelated UI redesign or runtime upgrade.
Decisions: use the current master and existing nsh test harness, including at least 50 complete navigation cycles, testing interactions as well as route state. Where native hardware is unavailable, record that limitation and separate headless evidence from Android validation. Avoid speculative patches; report if no actionable cause is found.
Checking: add regression tests that fail for the evidenced cause; exercise populated and empty views and cleanup of resources. Run the configured Go gate plus nsh check and nsh test --web-host tests/noHost.js. Record actual device, Android and app version only when tested.

## factory · 2026-11-10 21:27

Built in abde50e77399c19a57fded2a7eeedd470af931af and pushed after the owner requested a retry. The retry supplied the repository path to the gh credential helper using command-local credential.useHttpPath=true.

Fixed Contacts empty-view ownership to avoid leaked reactive scopes from the nsh List function slot. Added lifecycle regression coverage and documented the slot limitation. The coder reported reproducing the hang in the headless phone layout and passing three 50-round-trip scenarios (populated, empty, and slow/failing loads).

Checks from the completed build: manager Go gate passed; coder reported nsh check and all 407 nsh tests passed. This retry reused the unchanged commit and did not rerun tests. No new installs. No physical Android device or visual UI verification was performed; actual device/Android/app-version validation remains outstanding.

Moved new → review.
