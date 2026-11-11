# Upgrade CI actions away from deprecated Node.js 20 runtimes

## factory · 2026-11-11 14:22
Recorded from the owner's request to put this CI fix in new.

Reported GitHub CI warning:
> Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: actions/checkout@v4, actions/setup-go@v5, actions/setup-node@v4.

Acceptance criteria:
- Audit repository workflows and local composite actions for the reported action versions and other affected Node.js 20 action runtimes.
- Upgrade affected actions to supported releases that natively target Node.js 24, checking upstream migration notes and runner-version requirements before selecting versions.
- Preserve checkout behavior, permissions, caching, Go/Node toolchain selection, build/test jobs, and release behavior. The actions' runtime is separate from the application's Node.js version; do not upgrade application dependencies or toolchains just to silence this warning.
- Do not suppress the warning or rely on forced-runtime environment overrides as the fix.
- Validate workflow syntax and affected build/test paths. Verify a GitHub Actions run no longer reports the deprecated runtime warning for the migrated actions; explicitly record any remote validation not performed.

Execution constraint:
- Current factory.toml lists `.github/workflows/` in `never`. This task is registered in new at the owner's request, but the factory must not bypass that restriction or edit its own configuration. Before implementation, the owner must adjust the restriction or arrange a separately authorized workflow change outside the factory build process.

Implementation: Claude Code only; do not use Codex.
