// The Vue console's development-only performance probes (long tasks, route timing, API timing),
// which read browser observers. nsh traces with `nsh run --trace` instead; these stay as no-ops
// so the logic copied from the Vue console keeps its calls.
export function installConsolePerformanceObservers() {}
export function markRouteInteractive() {}
export function markRouteStart() {}
export function recordApiRequest() {}
export function recordComponentUpdate() {}
export function recordMarkdownMount() {}
export function recordMarkdownUpdate() {}
export function recordSnapshotBuild() {}
