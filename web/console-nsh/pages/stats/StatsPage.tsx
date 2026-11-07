// Usage (the Vue console's StatsView): the summary sheet (total cost, tokens, requests and their
// breakdowns), the daily chart, and the usage by API host or by model.
import { batch, effect, signal, Text, untracked, View } from "nsh";
import { endpointState, formatShortTime, runtimeApiFetch } from "../../lib/core/context.js";
import { isMobile } from "../../lib/shell";
import { RollingNumber } from "../../components/shared/RollingNumber";
import { DailyUsagePanel } from "../../components/observe/DailyUsagePanel";
import { ModelLedger } from "../../components/observe/ModelLedger";
import { hint, t, wholeNumber } from "../../components/observe/parts";
import { costMetrics, summaryHeroMetrics, tokenMetrics, type Metric, type Totals } from "../../components/observe/usage-metrics";
import { Icon, type IconName, Page, ProgressBar, Tabs } from "../../components/ui";

interface UsagePayload {
  updated_at: string;
  projected_records: number;
  skipped_records: number;
  summary: Totals;
  api_hosts: Totals[];
  models: Totals[];
}

const EMPTY: UsagePayload = { updated_at: "", projected_records: 0, skipped_records: 0, summary: {}, api_hosts: [], models: [] };

export function StatsPage() {
  const loading = signal(false);
  const err = signal("");
  const activeTab = signal<"api_hosts" | "models">("api_hosts");
  const payload = signal<UsagePayload>(EMPTY);

  const hero = () => summaryHeroMetrics(payload().summary || {});
  const summaryCosts = () => costMetrics(payload().summary || {}).filter((item) => item.key !== "total_cost" && !item.unavailable);
  const summaryTokens = () => tokenMetrics(payload().summary || {}).filter((item) => item.key !== "total_tokens" && !item.unavailable);
  const metaItems = () => {
    const items: { key: string; icon?: IconName; text: string; label: string }[] = [];
    const data = payload();
    if (data.updated_at) {
      const value = formatShortTime(data.updated_at);
      items.push({ key: "updated", icon: "PhClockCounterClockwise", text: value, label: `${t("stats_updated_at")}: ${value}` });
    }
    const projected = wholeNumber(data.projected_records);
    items.push({ key: "projected_records", icon: "PhChartLineUp", text: projected, label: `${t("stats_projected_records")}: ${projected}` });
    if (Number(data.skipped_records || 0) > 0) {
      const text = `${t("stats_skipped_records")}: ${wholeNumber(data.skipped_records)}`;
      items.push({ key: "skipped_records", text, label: text });
    }
    return items;
  };

  async function load() {
    batch(() => {
      loading.set(true);
      err.set("");
    });
    try {
      const data: any = await runtimeApiFetch("/stats/llm/usage");
      payload.set({
        updated_at: typeof data?.updated_at === "string" ? data.updated_at : "",
        projected_records: Number(data?.projected_records || 0),
        skipped_records: Number(data?.skipped_records || 0),
        summary: data?.summary && typeof data.summary === "object" ? data.summary : {},
        api_hosts: Array.isArray(data?.api_hosts) ? data.api_hosts : [],
        models: Array.isArray(data?.models) ? data.models : [],
      });
    } catch (e: any) {
      err.set(e?.message || t("msg_load_failed"));
    } finally {
      loading.set(false);
    }
  }

  // Loads for the selected agent, and again when it changes.
  effect(() => {
    const ref = String(endpointState.selectedRef || "").trim();
    untracked(() => {
      if (ref) void load();
    });
  });

  return (
    <Page title={t("stats_title")} error={err()} testID="stats-page">
      <If when={loading()}>
        <ProgressBar indeterminate label={t("runtime_loading")} />
      </If>

      <View
        class={`gap-6 rounded-(--radius) border border-line-faint bg-card p-5 ${isMobile() ? "" : "flex-row"}`}
        testID="stats-hero"
      >
        <View class="flex-1 gap-4">
          <If when={metaItems().length > 0}>
            <View class="flex-row flex-wrap gap-x-4 gap-y-1">
              <Each of={metaItems()} key={(item) => item.key}>
                {(item) => (
                  <View class="flex-row items-center gap-1.5" accessibilityLabel={item().label} tooltip={hint(item().label)}>
                    <If when={item().icon}>
                      <Icon name={item().icon!} size={13} color="muted-foreground" />
                    </If>
                    <Text class="text-xs text-muted-foreground tabular-nums">{item().text}</Text>
                  </View>
                )}
              </Each>
            </View>
          </If>
          <View class="gap-1">
            <Text class="font-mono text-xs uppercase tracking-wide text-muted-foreground">{hero().primary.label}</Text>
            <View class="self-start" tooltip={hint(hero().primary.title)}>
              <RollingNumber
                value={hero().primary.value}
                class={`text-4xl font-semibold ${hero().primary.unavailable ? "text-muted-foreground" : "text-foreground"}`}
                testID="stats-total-cost"
              />
            </View>
          </View>
          <View class="flex-row flex-wrap gap-8">
            <Each of={hero().secondary} key={(item) => item.key}>
              {(item) => (
                <View class="gap-0.5">
                  <Text class="font-mono text-xs uppercase tracking-wide text-muted-foreground">{item().label}</Text>
                  <Text class={`text-lg font-medium tabular-nums ${item().unavailable ? "text-muted-foreground" : "text-foreground"}`}>
                    {item().value}
                  </Text>
                </View>
              )}
            </Each>
          </View>
        </View>

        <If when={summaryCosts().length > 0 || summaryTokens().length > 0}>
          <View class={`flex-1 gap-4 ${isMobile() ? "border-t border-line-faint pt-4" : "border-l border-dashed border-line pl-6"}`}>
            <If when={summaryCosts().length > 0}>
              <SummaryGroup icon="PhWallet" title={t("stats_costs")} items={summaryCosts()} />
            </If>
            <If when={summaryTokens().length > 0}>
              <SummaryGroup icon="PhChartBar" title={t("stats_tokens")} items={summaryTokens()} />
            </If>
          </View>
        </If>
      </View>

      <DailyUsagePanel />

      <View class="gap-4">
        <Tabs
          items={[
            { id: "api_hosts", label: t("stats_group_api_hosts") },
            { id: "models", label: t("stats_group_models") },
          ]}
          value={activeTab()}
          onChange={(id) => activeTab.set(id === "models" ? "models" : "api_hosts")}
        />
        <If
          when={activeTab() === "api_hosts"}
          else={
            <If when={payload().models.length > 0} else={<EmptyUsage />}>
              <View class="gap-4 rounded-(--radius) border border-line-faint bg-card p-4" testID="stats-models">
                <Text class="text-base font-semibold text-foreground">{t("stats_group_models")}</Text>
                <ModelLedger models={payload().models} scope="models" />
              </View>
            </If>
          }
        >
          <If when={payload().api_hosts.length > 0} else={<EmptyUsage />}>
            <View class="gap-4" testID="stats-hosts">
              <Each of={payload().api_hosts} key={(host) => String(host.api_host)}>
                {(host) => <HostBlock host={host()} />}
              </Each>
            </View>
          </If>
        </If>
      </View>
    </Page>
  );
}

function EmptyUsage() {
  return (
    <View class="items-center rounded-(--radius) border border-dashed border-line py-10">
      <Text class="text-sm text-muted-foreground">{t("stats_no_data")}</Text>
    </View>
  );
}

function SummaryGroup(props: { icon: IconName; title: string; items: Metric[] }) {
  return (
    <View class="gap-2">
      <View class="flex-row items-center gap-1.5">
        <Icon name={props.icon} size={14} color="subtle" />
        <Text class="font-mono text-xs uppercase tracking-wide text-subtle">{props.title}</Text>
      </View>
      <View class="flex-row flex-wrap gap-x-6 gap-y-2">
        <Each of={props.items} key={(item) => item.key}>
          {(item) => (
            <View class="gap-0.5">
              <Text class="text-xs text-muted-foreground">{item().label}</Text>
              <View class="self-start" tooltip={hint(item().title)}>
                <RollingNumber value={item().value} class="text-base font-medium text-foreground" />
              </View>
            </View>
          )}
        </Each>
      </View>
    </View>
  );
}

function MetricBand(props: { icon: IconName; title: string; items: Metric[] }) {
  return (
    <View class="gap-2 border-t border-line-faint pt-3">
      <View class="flex-row items-center gap-1.5">
        <Icon name={props.icon} size={14} color="subtle" />
        <Text class="font-mono text-xs uppercase tracking-wide text-subtle">{props.title}</Text>
      </View>
      <View class="flex-row flex-wrap gap-x-6 gap-y-2">
        <Each of={props.items} key={(item) => item.key}>
          {(item) => (
            <View class="min-w-24 gap-0.5">
              <Text class="text-xs text-muted-foreground">{item().label}</Text>
              <View class="self-start" tooltip={hint(item().title)}>
                <RollingNumber
                  value={item().value}
                  class={`text-base font-medium ${item().unavailable ? "text-muted-foreground" : "text-foreground"}`}
                />
              </View>
            </View>
          )}
        </Each>
      </View>
    </View>
  );
}

function HostBlock(props: { host: Totals }) {
  return (
    <View class="gap-3 rounded-(--radius) border border-line-faint bg-card p-4" testID={`stats-host-${props.host.api_host}`}>
      <View class="flex-row flex-wrap items-center justify-between gap-2">
        <View class="flex-1 gap-0.5">
          <Text class="text-base font-semibold text-foreground">{t("stats_api_host")}</Text>
          <Text class="font-mono text-xs text-muted-foreground">{String(props.host.api_host ?? "")}</Text>
        </View>
        <View class="flex-row items-center gap-1.5 rounded-(--radius) border border-line-faint px-2 py-0.5">
          <Text class="text-xs text-muted-foreground">{t("stats_requests")}</Text>
          <Text class="text-xs font-medium text-foreground tabular-nums">{wholeNumber(props.host.requests)}</Text>
        </View>
      </View>
      <MetricBand icon="PhWallet" title={t("stats_costs")} items={costMetrics(props.host || {})} />
      <MetricBand icon="PhChartBar" title={t("stats_tokens")} items={tokenMetrics(props.host || {})} />
      <If when={Array.isArray(props.host.models) && props.host.models.length > 0}>
        <View class="border-t border-line-faint pt-3">
          <ModelLedger models={props.host.models} scope={String(props.host.api_host)} />
        </View>
      </If>
    </View>
  );
}
