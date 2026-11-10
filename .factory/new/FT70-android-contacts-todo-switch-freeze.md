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
