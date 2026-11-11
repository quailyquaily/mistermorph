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

## factory · review · 2026-11-10 22:21
head: abde50e77399c19a57fded2a7eeedd470af931af
verdict: pass
notes:
- Claude Code reviewed all five changed files against origin/master (c89e4e1430a6c50049aebb34cb8feb17ea22217c); no actionable findings. Branch merges cleanly and worktree stayed clean.
- Verified nsh 0.4.0 empty-slot lifecycle ownership against its implementation: the element slot removes leaked reactive subscriptions on Contacts unmount. The upstream inert-cell allocation remains; this change does not repair the runtime itself.
- Required Go gate passed (gofmt, go vet, go test); nsh check passed; nsh test --web-host tests/noHost.js passed, 407 tests, zero failures. Tests used a throwaway HOME. No installs.
- All three 50-round-trip headless scenarios passed. Replacing ContactsPage with the baseline version in a scratch copy caused the empty-contacts regression test to hang until the external 600-second timeout, corroborating the regression coverage.
- Physical Android and visual verification remain outstanding: no device, Android version or app build was tested. Owner should verify repeated navigation on the affected Android device before shipping.
- Residual test limits: the per-test timeout cannot stop this baseline hang, so CI needs an outer timeout; the lifecycle fixture intentionally asserts the current nsh bug and will need updating after an upstream fix.

Moved review → ready.

## factory · 2026-11-11 14:11

Owner-authorized ship with tag. Merge: e1aafbac1298ba41c56e118b30318dfaf47c22cd. Released in v0.3.96 at e41edbcf46a0969cc5e1f3500240ca9c96e69ffd; manager atomic push and remote master/tag verification succeeded.

Resolved ContactsPage conflict preserving the current shared phone/desktop page and lifecycle ownership. Read-only ship review found a P2 loading-to-empty regression; fixed in 3f82298dfaa73b45f43c1fa367d5948842700662. Deterministic new tests failed 12/12 before correction and passed after; phone/desktop immediate/delayed reload cases pass. Three 50-round-trip navigation scenarios pass.

Final read-only review: no P0–P3 findings. Combined validation: gofmt/vet/go test passed (162 packages), nsh check passed, full nsh suite 621/621, core Node tests 262/262 and manifest tests 6/6, steer race checks 220/220 and runtimecontrol race x3, web build passed. Scripted tests isolated HOME/XDG/TMP/cache. No installs. Initial Node PATH failure corrected using existing install.

No physical Android/emulator/native app or visual validation; Android build/host tests not run. No live model/channel verification. Console late notices still need history refresh; simultaneous replies may not preserve arrival order. Underlying nsh lifecycle limitation remains. No deployment.

Linked issues/PRs: none declared in header or owner sections; none closed. FT80 unchanged. Moved ready/ → done/.
