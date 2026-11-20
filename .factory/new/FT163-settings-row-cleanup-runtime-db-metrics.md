# Clean up Settings rows and show database metrics in Runtime metrics

## factory · 2026-11-20 09:16
Owner clarifies that only the informational Config row should be removed, not the configuration editors. Also requests rounded corners for the Advanced settings row and database file size plus record counts in Runtime metrics.

### Requirements
- Remove the informational Config row under Settings → System (configuration storage location/export-import hint). Keep the actual configuration forms, persistence, and import/export functionality intact.
- Give the Advanced settings row rounded corners consistent with neighboring Settings rows/cards. Preserve its navigation, interaction, and accessibility behavior.
- Add database file size and record counts to Runtime metrics. Identify the relevant runtime database(s) and clearly label the database and counted records/tables; do not present an ambiguous total as a specific record type.
- Use human-readable size units and readable counts. Treat unavailable metrics distinctly from zero, and handle missing/inaccessible database files without breaking the metrics view.
- Obtain metrics through the appropriate backend boundary; do not expose sensitive database contents or add expensive full scans to frequent metrics refreshes.

### Acceptance and regression coverage
- Verify the Config row is absent, configuration editors still work, and the Advanced settings row has correct rounded corners on desktop, mobile web, and Android.
- Verify Runtime metrics displays accurate database size and record counts, including empty and unavailable states, without regressing existing metrics or refresh behavior.
- Add focused regression tests for the Settings changes and metrics retrieval/display.
