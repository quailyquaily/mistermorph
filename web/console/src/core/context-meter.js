// The topic panel's context window meter: how much of the window the last run's input used, split
// into the part served from the prompt cache and the rest, with the point where the next run
// compacts the context marked.

// Within this share of the compaction point, the meter warns that compaction is near.
const NEAR_COMPACTION = 0.9;

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function share(part, whole) {
  return whole > 0 ? Math.min(1, Math.max(0, part / whole)) : 0;
}

// Returns null when the window size is unknown. Providers count cached tokens differently: some
// include them in the input total, some report them apart. The cached part is shown inside the
// used total and never beyond it.
export function contextMeter(context) {
  const window = positive(context?.context_window_tokens);
  if (!window) return null;
  const used = positive(context?.used_input_tokens);
  const cached = Math.min(positive(context?.cached_input_tokens), used);
  const trigger = Math.min(positive(context?.compaction_trigger_tokens), window);
  let state = "ok";
  if (trigger > 0 && used >= trigger) state = "over";
  else if (trigger > 0 && used >= trigger * NEAR_COMPACTION) state = "near";
  return {
    window,
    used,
    cached,
    fresh: used - cached,
    free: Math.max(0, window - used),
    trigger,
    ratio: used / window,
    cachedShare: share(cached, window),
    freshShare: share(used - cached, window),
    triggerShare: trigger > 0 ? share(trigger, window) : null,
    state,
  };
}
