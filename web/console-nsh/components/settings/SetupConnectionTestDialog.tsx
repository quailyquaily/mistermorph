// The LLM connection test (the Vue console's SetupConnectionTestDialog and
// SetupConnectionTestDialogContent): the target, each benchmark's result (its raw response opens
// below it), Retry and Close.
//
// Vue to nsh: `modelValue` is `open`, `update:modelValue` is `onOpenChange(open)`; `retry` and
// `close` are `onRetry()` and `onClose()`.
import { computed, effect, signal, Text, untracked, View } from "nsh";
import { Button, Icon, Spinner } from "../ui";
import { DialogShell, InlineNotice, t } from "./DialogShell";

const TEST_CONNECTION_BENCHMARK_IDS = ["text_reply", "json_response", "tool_calling", "evaluate"];
// Evaluate-only providers run just the judgment benchmark.
const EVALUATE_ONLY_PROVIDERS = new Set(["typesafe"]);

/** One benchmark's result (`/settings/agent/test` benchmarks). */
export interface ConnectionBenchmark {
  id: string;
  ok?: boolean;
  duration_ms?: number;
  detail?: string;
  error?: string;
  raw_response?: string;
  [key: string]: unknown;
}

export interface SetupConnectionTestDialogContentProps {
  loading?: boolean;
  error?: string;
  benchmarks?: ConnectionBenchmark[];
  provider?: string;
  /** An Evaluate-only profile runs only the Evaluate benchmark. */
  evaluateOnly?: boolean;
  /** The benchmarks the profile runs, shown while they run; empty: by provider and evaluateOnly. */
  benchmarkIds?: string[];
  apiBase?: string;
  model?: string;
  /** Default true. */
  showIntro?: boolean;
  onRetry?: () => void;
  onClose?: () => void;
}

type VisibleBenchmark = ConnectionBenchmark & { running: boolean };

/** "1.25s", "12.5s", "0s". */
export function formatBenchmarkSeconds(durationMS: unknown) {
  const ms = Number(durationMS || 0);
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = ms / 1000;
  const digits = seconds >= 10 ? 1 : 2;
  return `${seconds
    .toFixed(digits)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*[1-9])0+$/, "$1")}s`;
}

function benchmarkSummaryText(item: ConnectionBenchmark) {
  const id = String(item?.id || "").trim();
  const fallback = item?.ok ? String(item?.detail || "").trim() : String(item?.error || "").trim();
  if (!id) return fallback;
  const key = `setup_llm_test_benchmark_${id}_${item?.ok ? "ok" : "failed"}`;
  const translated = t(key);
  return translated && translated !== key ? translated : fallback;
}

export function SetupConnectionTestDialogContent(props: SetupConnectionTestDialogContentProps) {
  const expandedRawBenchmarkId = signal("");
  const targetHost = () => {
    const value = String(props.apiBase || "").trim();
    if (!value) return "";
    try {
      return String(new URL(value).host || "").trim() || value;
    } catch {
      return value;
    }
  };
  const targetModel = () => String(props.model || "").trim();
  const showTarget = () => targetHost() !== "" || targetModel() !== "";
  const benchmarks = () => (Array.isArray(props.benchmarks) ? props.benchmarks : []);
  const hasBenchmarks = () => benchmarks().length > 0;
  const visibleBenchmarks = computed<VisibleBenchmark[]>(() => {
    if (props.loading && !hasBenchmarks()) {
      const provider = String(props.provider || "").trim().toLowerCase();
      const requested = Array.isArray(props.benchmarkIds) ? props.benchmarkIds : [];
      const ids =
        requested.length > 0
          ? requested
          : props.evaluateOnly || EVALUATE_ONLY_PROVIDERS.has(provider)
            ? ["evaluate"]
            : TEST_CONNECTION_BENCHMARK_IDS;
      return ids.map((id) => ({ id, ok: false, running: true, duration_ms: 0, detail: "", error: "", raw_response: "" }));
    }
    return benchmarks().map((item) => ({ ...item, running: false }));
  });
  const showBenchmarks = () => props.loading || hasBenchmarks();

  // A new run, or results without the open one, close the raw response.
  effect(() => {
    if (props.loading) untracked(() => expandedRawBenchmarkId.set(""));
  });
  effect(() => {
    const list = benchmarks();
    untracked(() => {
      const open = expandedRawBenchmarkId();
      if (open && list.every((item) => String(item?.id || "").trim() !== open)) expandedRawBenchmarkId.set("");
    });
  });

  const isRawExpanded = (item: ConnectionBenchmark) =>
    String(item?.id || "").trim() !== "" && expandedRawBenchmarkId() === String(item.id).trim();
  const toggleRawResponse = (item: ConnectionBenchmark) => {
    const id = String(item?.id || "").trim();
    if (!id) return;
    expandedRawBenchmarkId.set(untracked(expandedRawBenchmarkId) === id ? "" : id);
  };
  const rawResponseText = (item: ConnectionBenchmark) => {
    const raw = String(item?.raw_response || "").trim();
    return raw === "" ? t("setup_llm_test_raw_empty") : raw;
  };

  const close = () => {
    expandedRawBenchmarkId.set("");
    props.onClose?.();
  };
  const retry = () => {
    expandedRawBenchmarkId.set("");
    props.onRetry?.();
  };

  return (
    <View class="gap-3" testID="connection-test">
      <View class="gap-1.5">
        <View class="flex-row items-center gap-2">
          <Icon name="PhCompass" size={15} color="muted-foreground" />
          <Text class="flex-1 font-mono text-sm text-foreground line-clamp-1">{targetHost() || t("setup_llm_test_target_loading")}</Text>
        </View>
        <View class="flex-row items-center gap-2">
          <Icon name="PhCpu" size={15} color="muted-foreground" />
          <Text class="flex-1 font-mono text-sm text-foreground line-clamp-1">{targetModel() || t("setup_llm_test_target_loading")}</Text>
        </View>
        <If when={!showTarget() && props.showIntro !== false}>
          <Text class="text-sm text-subtle">{t("setup_llm_test_intro")}</Text>
        </If>
      </View>

      <If when={props.error}>
        <InlineNotice type="error" text={props.error ?? ""} testID="connection-test-error" />
      </If>

      <If when={showBenchmarks()}>
        <View class="rounded-(--radius) border border-line-faint">
          <Each of={visibleBenchmarks()} key={(item) => `${item.id}:${item.running}`}>
            {(item, index) => (
              <View class={`gap-2 px-3 py-2.5 ${index() > 0 ? "border-t border-line-faint" : ""}`} testID={`connection-test-${item().id}`}>
                <View class="flex-row items-start gap-3">
                  <View class="flex-1 gap-0.5">
                    <Text class="text-sm font-medium text-foreground">{t(`setup_llm_test_benchmark_${item().id}`)}</Text>
                    <If
                      when={item().running}
                      else={
                        <If when={(item().ok && item().detail) || item().error}>
                          <View
                            role="button"
                            accessibilityState={{ expanded: isRawExpanded(item()) }}
                            onPress={() => toggleRawResponse(item())}
                            class="flex-row items-center gap-1 self-start active:opacity-70"
                            testID={`connection-test-toggle-${item().id}`}
                          >
                            <Text class={`text-xs ${item().ok ? "text-muted-foreground" : "text-danger"}`}>{benchmarkSummaryText(item())}</Text>
                            <Icon
                              name={isRawExpanded(item()) ? "PhCaretDown" : "PhArrowRight"}
                              size={12}
                              color={item().ok ? "muted-foreground" : "danger"}
                            />
                          </View>
                        </If>
                      }
                    >
                      <Text class="text-xs text-muted-foreground">{t("setup_llm_test_running")}</Text>
                    </If>
                  </View>
                  <View class="items-end gap-0.5">
                    <If
                      when={item().running}
                      else={
                        <Text class={`text-sm font-semibold ${item().ok ? "text-ok" : "text-danger"}`}>
                          {item().ok ? t("setup_llm_test_status_ok") : t("setup_llm_test_status_failed")}
                        </Text>
                      }
                    >
                      <Spinner size={16} />
                    </If>
                    <If when={!item().running}>
                      <Text class="font-mono text-xs text-muted-foreground">{formatBenchmarkSeconds(item().duration_ms)}</Text>
                    </If>
                  </View>
                </View>
                <If when={!item().running && isRawExpanded(item())}>
                  <View selectable class="rounded-(--radius) bg-muted px-2.5 py-2">
                    <Text class="font-mono text-xs text-foreground" testID={`connection-test-raw-${item().id}`}>
                      {rawResponseText(item())}
                    </Text>
                  </View>
                </If>
              </View>
            )}
          </Each>
        </View>
      </If>

      <View class="flex-row flex-wrap items-center justify-end gap-2">
        <Button
          variant="primary"
          loading={props.loading}
          label={props.loading ? t("setup_llm_test_running") : t("setup_llm_test_retry")}
          onPress={retry}
          testID="connection-test-retry"
        />
        <Button variant="outlined" label={t("action_close")} onPress={close} />
      </View>
    </View>
  );
}

export interface SetupConnectionTestDialogProps extends Omit<SetupConnectionTestDialogContentProps, "onClose"> {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function SetupConnectionTestDialog(props: SetupConnectionTestDialogProps) {
  const close = () => props.onOpenChange?.(false);
  return (
    <DialogShell open={props.open} title={t("setup_llm_test_title")} onClose={close} testID="connection-test-dialog">
      <SetupConnectionTestDialogContent
        loading={props.loading}
        error={props.error}
        benchmarks={props.benchmarks}
        provider={props.provider}
        evaluateOnly={props.evaluateOnly}
        benchmarkIds={props.benchmarkIds}
        apiBase={props.apiBase}
        model={props.model}
        showIntro={props.showIntro}
        onRetry={() => props.onRetry?.()}
        onClose={close}
      />
    </DialogShell>
  );
}
