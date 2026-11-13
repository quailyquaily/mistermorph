// The Usage page's Coding agents block: the subscription quota of each local coding CLI the coder
// tool runs (Codex, Claude Code), as each last reported it: a bar per window (5 hours, 7 days),
// how much is used and when it starts again. Claude Code reports its quota during a coder run;
// Codex's is read after each Codex run and on Refresh. The block shows only the coders installed
// where the agent runs or that reported a quota, and is not there when neither is, nor for an agent
// built before the quota routes (they answer 404).
import { batch, effect, signal, Text, untracked, View } from "nsh";
import { endpointState, formatShortTime, runtimeApiFetch } from "../../lib/core/context.js";
import { Button, ProgressBar } from "../ui";
import {
  normalizeCoderQuota,
  shownCoders,
  untilText,
  windowExpired,
  windowLabel,
  windowTone,
  type CoderQuotaPayload,
  type QuotaWindow,
} from "./coder-quota";
import { AuditBadge, hint, ObserveSection, t } from "./parts";

const EMPTY: CoderQuotaPayload = { quotas: [], available: {}, errors: {} };

export function CoderQuotaPanel(props: { padding?: number }) {
  const payload = signal<CoderQuotaPayload>(EMPTY);
  const loading = signal(false);
  const refreshing = signal(false);
  const err = signal("");

  async function load(refresh: boolean) {
    batch(() => {
      (refresh ? refreshing : loading).set(true);
      err.set("");
    });
    try {
      const data = refresh
        ? await runtimeApiFetch("/stats/coder/quota/refresh", { method: "POST" })
        : await runtimeApiFetch("/stats/coder/quota");
      payload.set(normalizeCoderQuota(data));
    } catch (e: any) {
      // Agents built before the quota routes answer 404: no block, no error.
      if (e?.status === 404 && !refresh) payload.set(EMPTY);
      else err.set(e?.message || t("msg_load_failed"));
    } finally {
      (refresh ? refreshing : loading).set(false);
    }
  }

  effect(() => {
    const ref = String(endpointState.selectedRef || "").trim();
    untracked(() => {
      if (ref) {
        payload.set(EMPTY);
        void load(false);
      }
    });
  });

  const coders = () => shownCoders(payload());
  const canRefresh = () => payload().available.codex === true;

  return (
    <If when={coders().length > 0 || err()}>
      <ObserveSection
        variant="boxed"
        title={t("stats_coders_title")}
        padding={props.padding}
        gap={14}
        testID="stats-coders"
        actions={
          <If when={canRefresh()}>
            <Button
              variant="plain"
              size="xs"
              iconOnly
              icon="PhArrowClockwise"
              title={t("stats_coders_refresh")}
              loading={refreshing()}
              disabled={refreshing() || loading()}
              onPress={() => void load(true)}
              testID="stats-coders-refresh"
            />
          </If>
        }
      >
        <If when={err()}>
          <Text class="text-sm text-danger" testID="stats-coders-error">
            {err()}
          </Text>
        </If>
        <Each of={coders()} key={(coder) => coder.backend}>
          {(coder) => (
            <View class="gap-2.5" testID={`stats-coder-${coder().backend}`}>
              <View class="flex-row flex-wrap items-center gap-x-2.5 gap-y-1">
                <Text class="text-sm font-semibold text-foreground">{coder().title}</Text>
                <If when={coder().quota?.plan}>
                  <Text class="font-mono text-xs uppercase tracking-[0.08em] text-subtle">{coder().quota?.plan ?? ""}</Text>
                </If>
                <If when={coder().quota?.status === "rejected" || coder().quota?.status === "allowed_warning"}>
                  <AuditBadge
                    badge={{ type: coder().quota?.status === "rejected" ? "danger" : "warning", variant: "outlined" }}
                    label={coder().quota?.status === "rejected" ? t("stats_coders_limit_reached") : t("stats_coders_near_limit")}
                    testID={`stats-coder-${coder().backend}-status`}
                  />
                </If>
                <View class="flex-1" />
                <If when={coder().quota?.observed_at}>
                  <Text
                    class="font-mono text-xs text-subtle tabular-nums"
                    tooltip={hint(t("stats_coders_observed", { time: formatShortTime(coder().quota?.observed_at ?? "") }))}
                  >
                    {formatShortTime(coder().quota?.observed_at ?? "")}
                  </Text>
                </If>
              </View>
              <If
                when={(coder().quota?.windows.length ?? 0) > 0}
                else={
                  <Text class="text-sm text-subtle" testID={`stats-coder-${coder().backend}-empty`}>
                    {coder().backend === "claude" ? t("stats_coders_empty_claude") : t("stats_coders_empty_codex")}
                  </Text>
                }
              >
                <Each of={coder().quota?.windows ?? []} key={(w) => w.kind}>
                  {(w) => <WindowRow window={w()} testID={`stats-coder-${coder().backend}-${w().kind}`} />}
                </Each>
              </If>
              <If when={coder().error}>
                <Text class="text-xs text-danger" testID={`stats-coder-${coder().backend}-error`}>
                  {coder().error}
                </Text>
              </If>
            </View>
          )}
        </Each>
      </ObserveSection>
    </If>
  );
}

/** One window: its length, a bar of how much is used, the share and when it starts again. */
function WindowRow(props: { window: QuotaWindow; testID: string }) {
  const used = () => props.window.used_percent;
  // A window whose reset has passed started again: what it said is no longer what is used.
  const expired = () => windowExpired(props.window);
  const detail = () => {
    if (expired()) return t("stats_coders_reset_passed");
    const parts = [] as string[];
    if (used() !== undefined) parts.push(t("stats_coders_used", { percent: Math.round(used()!) }));
    const until = untilText(props.window.resets_at);
    if (until) parts.push(t("stats_coders_resets_in", { time: until }));
    return parts.join(" · ");
  };
  return (
    <View class="flex-row items-center gap-3" testID={props.testID}>
      <Text class="w-14 font-mono text-xs text-subtle">{windowLabel(props.window)}</Text>
      <View class="flex-1">
        <ProgressBar
          value={expired() ? 0 : (used() ?? 0)}
          tone={expired() ? undefined : windowTone(props.window)}
          label={`${windowLabel(props.window)}: ${detail()}`}
        />
      </View>
      <Text class="min-w-36 text-right font-mono text-xs text-subtle tabular-nums" testID={`${props.testID}-detail`}>
        {detail()}
      </Text>
    </View>
  );
}
