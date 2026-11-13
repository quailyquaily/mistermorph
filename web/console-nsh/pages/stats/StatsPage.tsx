// Usage (the Vue console's StatsView): the summary sheet (total cost, tokens, requests and their
// breakdowns), the coding agents' quotas, the daily chart, and the usage by API host or by model.
import { batch, Canvas, effect, pixelRatio, signal, Text, token, untracked, View, windowSize } from "nsh";
import type { CanvasRenderingContext2D } from "nsh";
import { endpointState, formatShortTime, runtimeApiFetch } from "../../lib/core/context.js";
import { RollingNumber } from "../../components/shared/RollingNumber";
import { CoderQuotaPanel } from "../../components/observe/CoderQuotaPanel";
import { DailyUsagePanel } from "../../components/observe/DailyUsagePanel";
import { ModelLedger } from "../../components/observe/ModelLedger";
import { hint, ObserveSection, t, wholeNumber } from "../../components/observe/parts";
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

  // Vue's breakpoints are the window's: the sheet stacks at 1080, band cells pair up at 560.
  const wide = () => windowSize().width > 1080;
  const narrow = () => windowSize().width <= 560;
  // clamp(20px, 2.6vw, 34px) between the page's blocks; clamp(18px, 2vw, 24px) inside the sheet.
  const pageGap = () => Math.round(Math.min(34, Math.max(20, windowSize().width * 0.026)));
  const sheetPad = () => Math.round(Math.min(24, Math.max(18, windowSize().width * 0.02)));
  // --font-size-hero: clamp(2.5rem, 2rem + 2vw, 4rem).
  const heroSize = () => Math.round(Math.min(64, Math.max(40, 32 + windowSize().width * 0.02)));

  return (
    <Page title={t("stats_title")} error={err()} testID="stats-page">
      <View style={{ rowGap: pageGap() }} class="pb-6">
        <If when={loading()}>
          <ProgressBar indeterminate label={t("runtime_loading")} />
        </If>

        {/* The summary sheet: a boxed section without a head. */}
        <ObserveSection variant="boxed" padding={sheetPad()} testID="stats-hero">
          <View class={wide() ? "flex-row" : ""} style={wide() ? { columnGap: sheetPad() + 10 } : { rowGap: 18 }}>
            <View
              class="justify-between"
              style={{ rowGap: Math.round(Math.min(34, Math.max(18, windowSize().width * 0.024))), ...(wide() ? { flexGrow: 0.92, flexShrink: 1, flexBasis: 0 } : {}) }}
            >

              <If when={metaItems().length > 0}>
                <View class="flex-row flex-wrap gap-x-3.5 gap-y-1.5">
                  <Each of={metaItems()} key={(item) => item.key}>
                    {(item) => (
                      <View class="flex-row items-center gap-1.25" accessibilityLabel={item().label} tooltip={hint(item().label)}>
                        <If when={item().icon}>
                          <Icon name={item().icon!} size={14} color="subtle" />
                        </If>
                        <Text class="font-mono text-xs leading-normal text-subtle tabular-nums">{item().text}</Text>
                      </View>
                    )}
                  </Each>
                </View>
              </If>
              {/* The spotlight: the total cost, large, and the totals under a rule. */}
              <View class="justify-end gap-1.5" style={{ minHeight: Math.round(Math.min(108, Math.max(76, windowSize().width * 0.09))) }}>
                <Text class={LABEL}>{hero().primary.label}</Text>
                <View class="self-start" tooltip={hint(hero().primary.title)}>
                  <RollingNumber
                    value={hero().primary.value}
                    class={`font-semibold tracking-[-0.055em] ${hero().primary.unavailable ? "text-subtle" : "text-foreground"}`}
                    style={{ fontSize: heroSize(), lineHeight: Math.round(heroSize() * 0.9) }}
                    testID="stats-total-cost"
                  />
                </View>
                <View class="mt-3.5 flex-row gap-4.5 border-t border-line-soft pt-3.5">
                  <Each of={hero().secondary} key={(item) => item.key}>
                    {(item) => (
                      <View class="flex-1 gap-1" tooltip={hint(item().title)}>
                        <Text class={LABEL}>{item().label}</Text>
                        <Text
                          class={`text-base leading-[17.3px] tabular-nums ${item().unavailable ? "font-medium text-subtle" : "font-semibold text-foreground"}`}
                        >
                          {item().value}
                        </Text>
                      </View>
                    )}
                  </Each>
                </View>
              </View>
            </View>

            <If when={summaryCosts().length > 0 || summaryTokens().length > 0}>
              <View
                class={`relative justify-end gap-4 ${wide() ? "pt-0.5" : "border-t border-line-soft pt-4"}`}
                style={wide() ? { flexGrow: 1.08, flexShrink: 1, flexBasis: 0, minWidth: 320, paddingLeft: sheetPad() } : undefined}
              >
                <If when={wide()}>
                  {/* Vue's faint dashed divider, inset at the ends and faded into them. */}
                  <Canvas accessibilityElementsHidden class="absolute bottom-1 left-0 top-0.5 w-px" style={{ pointerEvents: "none" }} draw={drawSideRule} />
                </If>
                <If when={summaryCosts().length > 0}>
                  <SummaryGroup icon="PhWallet" title={t("stats_costs")} items={summaryCosts()} columns={wide() ? 4 : 2} />
                </If>
                <If when={summaryTokens().length > 0}>
                  <SummaryGroup icon="PhChartBar" title={t("stats_tokens")} items={summaryTokens()} columns={wide() ? 4 : 2} />
                </If>
              </View>
            </If>
          </View>
        </ObserveSection>

        <CoderQuotaPanel padding={sheetPad()} />

        <DailyUsagePanel />

        <View class="gap-3">
          <Tabs
            items={[
              { id: "api_hosts", label: t("stats_group_api_hosts") },
              { id: "models", label: t("stats_group_models") },
            ]}
            value={activeTab()}
            onChange={(id) => activeTab.set(id === "models" ? "models" : "api_hosts")}
            class="self-start"
          />
          <If
            when={activeTab() === "api_hosts"}
            else={
              <If when={payload().models.length > 0} else={<EmptyUsage />}>
                <ObserveSection title={t("stats_group_models")} gap={14} testID="stats-models">
                  <ModelLedger models={payload().models} scope="models" />
                </ObserveSection>
              </If>
            }
          >
            <If when={payload().api_hosts.length > 0} else={<EmptyUsage />}>
              <View style={{ rowGap: Math.round(Math.min(40, Math.max(28, windowSize().width * 0.03))) }} testID="stats-hosts">
                <Each of={payload().api_hosts} key={(host) => String(host.api_host)}>
                  {(host) => <HostBlock host={host()} narrow={narrow()} />}
                </Each>
              </View>
            </If>
          </If>
        </View>
      </View>
    </Page>
  );
}

// Vue's .stats-*-label: mono meta caps, tracked.
const LABEL = "font-mono text-xs font-medium uppercase leading-normal tracking-[0.12em] text-subtle";

function EmptyUsage() {
  return <Text class={`pt-1.5 ${LABEL}`}>{t("stats_no_data")}</Text>;
}

/** Splits a list into rows of `size`. */
function rowsOf<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

function BandHead(props: { icon: IconName; title: string }) {
  return (
    <View class="flex-row items-center gap-2">
      <Icon name={props.icon} size={15} color="ink" />
      <Text class="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-foreground">{props.title}</Text>
    </View>
  );
}

/** A group of the sheet's side: its head, then label over value in columns. */
function SummaryGroup(props: { icon: IconName; title: string; items: Metric[]; columns: number }) {
  return (
    <View class="gap-2.25">
      <BandHead icon={props.icon} title={props.title} />
      <View class="gap-2.5 pt-0.5">
        <Each of={rowsOf(props.items, props.columns)}>
          {(row) => (
            <View class="flex-row gap-4.5">
              <Each of={Array.from({ length: props.columns }, (_, i) => row()[i] ?? null)}>
                {(item) => (
                  <View class="flex-1 gap-1">
                    <If when={item()}>
                      {(metric) => (
                        <>
                          <Text class={LABEL}>{metric().label}</Text>
                          <View class="self-start" tooltip={hint(metric().title)}>
                            <RollingNumber value={metric().value} class="text-xs leading-[17.4px] text-subtle" />
                          </View>
                        </>
                      )}
                    </If>
                  </View>
                )}
              </Each>
            </View>
          )}
        </Each>
      </View>
    </View>
  );
}

/** Costs or tokens of a host: its head, then a datasheet row of cells between hairlines. */
function MetricBand(props: { icon: IconName; title: string; items: Metric[]; narrow: boolean }) {
  return (
    <View class="gap-2.5">
      <BandHead icon={props.icon} title={props.title} />
      <View class="border-y border-line-soft">
        <Each of={rowsOf(props.items, props.narrow ? 2 : props.items.length)}>
          {(row, rowIndex) => (
            <View class={`flex-row ${rowIndex() > 0 ? "border-t border-line-soft" : ""}`}>
              <Each of={row()}>
                {(item, index) => (
                  <View
                    class={`flex-1 gap-1.5 px-3.5 pb-2.75 pt-3 ${index() > 0 ? "border-l border-line-soft" : ""}`}
                    style={{ minWidth: props.narrow ? 0 : 132 }}
                  >
                    <Text class={LABEL}>{item().label}</Text>
                    <View class="self-start" tooltip={hint(item().title)}>
                      <RollingNumber
                        value={item().value}
                        class={`text-base leading-[17.3px] ${item().unavailable ? "font-medium text-subtle" : "font-semibold text-foreground"}`}
                      />
                    </View>
                  </View>
                )}
              </Each>
            </View>
          )}
        </Each>
      </View>
    </View>
  );
}

function HostBlock(props: { host: Totals; narrow: boolean }) {
  return (
    <ObserveSection
      title={t("stats_api_host")}
      gap={14}
      testID={`stats-host-${props.host.api_host}`}
      meta={
        <View class="flex-1 flex-row items-baseline">
          <Text class="shrink font-mono text-sm font-semibold text-foreground line-clamp-1">{String(props.host.api_host ?? "")}</Text>
          <View class="ml-4 flex-row items-baseline gap-2">
            <Text class={LABEL}>{t("stats_requests")}</Text>
            <Text class="text-base font-semibold leading-none text-foreground tabular-nums">{wholeNumber(props.host.requests)}</Text>
          </View>
        </View>
      }
    >
      <MetricBand icon="PhWallet" title={t("stats_costs")} items={costMetrics(props.host || {})} narrow={props.narrow} />
      <MetricBand icon="PhChartBar" title={t("stats_tokens")} items={tokenMetrics(props.host || {})} narrow={props.narrow} />
      <If when={Array.isArray(props.host.models) && props.host.models.length > 0}>
        <ModelLedger models={props.host.models} scope={String(props.host.api_host)} />
      </If>
    </ObserveSection>
  );
}

// Vue .stats-hero-side::before: a 1px rule of soft dashes (repeating 180deg: the colour 0-3px,
// fading out 3-6px, clear 6-9px) in the stats accent at 20%, under a mask that fades it in over
// the top 8% and out over the bottom 16% (0.92 between), at opacity .72. Drawn a device pixel row
// at a time, each row's alpha the product of the three, so it is the same on every platform.
function drawSideRule(cx: CanvasRenderingContext2D, size: { width: number; height: number }) {
  const { height } = size;
  if (height <= 0) return;
  // --stats-accent: color-mix(in srgb, accent-1 68%, text-0 32%).
  const accent = mixHex(token("blue") as string, token("foreground") as string, 0.68);
  cx.fillStyle = accent;
  const step = 1 / Math.max(1, pixelRatio());
  for (let y = 0; y < height; y += step) {
    const mid = y + step / 2;
    const at = mid % 9;
    const dash = at < 3 ? 1 : at < 6 ? (6 - at) / 3 : 0;
    if (dash <= 0) continue;
    const f = mid / height;
    const mask = f < 0.08 ? (f / 0.08) * 0.92 : f <= 0.84 ? 0.92 : ((1 - f) / 0.16) * 0.92;
    cx.globalAlpha = 0.2 * dash * mask * 0.72;
    cx.fillRect(0, y, 1, step);
  }
  cx.globalAlpha = 1;
}

/** `color-mix(in srgb, a share, b)` of two `#rrggbb[aa]` colours, as `#rrggbb`. */
function mixHex(a: string, b: string, share: number) {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const out = [0, 1, 2].map((i) => Math.round(channel(a, i) * share + channel(b, i) * (1 - share)));
  return `#${out.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}
