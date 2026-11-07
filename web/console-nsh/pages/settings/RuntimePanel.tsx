// Settings › Runtime (the Vue console's RuntimeView, mounted as RuntimePanel): the selected agent's
// health, its model, its channels, process metrics and technical details, refreshed every minute,
// and Poke, which wakes the agent's awareness loop with a message.
import type { JSX } from "nsh";
import { batch, cleanup, computed, effect, Image, signal, Text, untracked, View } from "nsh";
import {
  endpointState,
  formatBytes,
  formatShortTime,
  loadEndpoints,
  runtimeApiFetchForEndpoint,
  runtimeEndpointByRef,
  toBool,
  toInt,
} from "../../lib/core/context.js";
import { endpointChannelLabel, endpointDisplayItem } from "../../lib/core/endpoints.js";
import { useNotice } from "../../lib/core/notices.js";
import { reactiveRecord } from "../../lib/stores/reactive-record.js";
import { Button, Icon, StatusMark } from "../../components/ui";
import { Button as BaseButton, Collapsible } from "nsh/base";
import { isMobile } from "../../lib/shell";
import { SettingsCard } from "../../components/settings-page/parts";
import { PokeDialog } from "../../components/settings-page/PokeDialog";
import { CHANNEL_LOGOS } from "./constants";
import { t } from "./i18n";

const POKE_BODY_LIMIT = 10 * 1024;
const CHANNELS = ["telegram", "slack", "line", "lark", "mixin", "discord", "wechat", "whatsapp", "bluesky", "x"];
// The account channels report their connection status.
const STATUS_CHANNELS = new Set(["wechat", "whatsapp", "bluesky", "x"]);

function stringValue(value: unknown, fallback = "-") {
  const text = String(value || "").trim();
  return text || fallback;
}

export function formatUptime(seconds: unknown) {
  const total = Number(seconds || 0);
  if (!Number.isFinite(total) || total < 0) return "-";
  const whole = Math.trunc(total);
  const days = Math.floor(whole / 86400);
  const hours = Math.floor((whole % 86400) / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function utf8ByteLength(value: unknown) {
  return new TextEncoder().encode(String(value || "")).length;
}

function emptyOverview() {
  const channels: Record<string, unknown> = {};
  for (const id of CHANNELS) {
    channels[`channel_${id}_configured`] = false;
    channels[`channel_running_${id}`] = false;
    channels[`channel_status_${id}`] = "";
  }
  return {
    version: "-",
    started_at: "",
    uptime_sec: 0,
    health: "",
    mode: "",
    agent_name: "",
    poke_enabled: false,
    awareness_running: false,
    instance_id: "",
    last_poke_at: "",
    llm_provider: "-",
    llm_model: "-",
    runtime_go_version: "-",
    runtime_goroutines: 0,
    runtime_heap_alloc_bytes: 0,
    runtime_heap_sys_bytes: 0,
    runtime_heap_objects: 0,
    runtime_gc_cycles: 0,
    ...channels,
  } as Record<string, any>;
}

type Tone = "healthy" | "stale" | "error" | "unknown";
const MARK: Record<Tone, "on" | "pending" | "error" | "off"> = { healthy: "on", stale: "pending", error: "error", unknown: "off" };

function StatusLabel(props: { tone: Tone; text: string; testID?: string; small?: boolean }) {
  return (
    <View class="flex-row items-center gap-2" testID={props.testID}>
      <StatusMark state={MARK[props.tone]} />
      <Text class={`${props.small ? "text-xs" : "text-sm"} text-foreground`}>{props.text}</Text>
    </View>
  );
}

/**
 * Label and value rows (`.runtime-ledger`): the label in the panel's grey, the value in mono, a third
 * and two thirds of the row (two fifths and three on phones), 10pt apart on hairlines. `columns`
 * lays the rows out two to a line (`.runtime-metrics`, 32pt apart).
 */
function Ledger(props: { rows: { key: string; label: string; value: string }[]; columns?: 2; testID?: string }) {
  const two = () => props.columns === 2 && !isMobile();
  return (
    <View testID={props.testID} class={two() ? "grid grid-cols-2 gap-x-8" : ""}>
      <Each of={props.rows} key={(row) => row.key}>
        {(row, index) => (
          <View
            class={`flex-row items-baseline gap-4 py-2.5 ${index() === props.rows.length - 1 ? "" : "border-b border-line-soft"}`}
          >
            <Text class={`min-w-0 ${isMobile() ? "flex-[2]" : "flex-1"} text-sm leading-normal text-subtle`}>{row().label}</Text>
            <View selectable class={`min-w-0 ${isMobile() ? "flex-[3]" : "flex-[2]"}`}>
              <Text class="font-mono text-sm leading-normal tabular-nums text-foreground">{row().value}</Text>
            </View>
          </View>
        )}
      </Each>
    </View>
  );
}

/** A line that folds the rest away (`.runtime-panel summary`): the text, a chevron at the right that turns over. */
function RuntimeFold(props: { open: boolean; onToggle: () => void; title: string; children?: JSX.Element; testID?: string }) {
  return (
    <Collapsible open={props.open} content={<View class="gap-3 pb-1">{props.children}</View>}>
      <View
        role="button"
        accessibilityLabel={props.title}
        accessibilityState={{ expanded: props.open }}
        onPress={() => props.onToggle()}
        testID={props.testID}
        class="min-h-11 flex-row items-center justify-between gap-3 py-[11px]"
      >
        <Text class="text-sm leading-normal text-subtle">{props.title}</Text>
        <View class="transition-transform duration-160" style={{ transform: [{ rotate: props.open ? "180deg" : "0deg" }] }}>
          <Icon name="PhCaretDown" size={16} color="subtle" />
        </View>
      </View>
    </Collapsible>
  );
}

export function RuntimePanel(): JSX.Element {
  const notice = useNotice();
  const technicalOpen = signal(false);
  const unconfiguredOpen = signal(false);
  const err = signal("");
  const loading = signal(true);
  const loadedEndpointRef = signal("");
  const lastUpdated = signal("");
  let loadSequence = 0;
  const poking = signal(false);
  const pokeDialogOpen = signal(false);
  const pokeBody = signal("");
  const pokeError = signal("");
  const overview = reactiveRecord(emptyOverview()) as Record<string, any>;

  const selectedEndpoint = computed(() => runtimeEndpointByRef(endpointState.selectedRef) as any);
  const endpointMeta = computed(() => {
    const item = selectedEndpoint();
    return item ? (endpointDisplayItem(item, t) as any) : null;
  });
  const hasData = computed(() => loadedEndpointRef() === endpointState.selectedRef && !!lastUpdated());
  const modeLabel = computed(() => endpointChannelLabel((hasData() && overview.mode) || selectedEndpoint()?.mode || "", t));
  const heroTitle = computed(() => {
    const name = hasData() ? String(overview.agent_name || "").trim() : "";
    return name || endpointMeta()?.title || t("runtime_title");
  });
  const statusTone = computed<Tone>(() => {
    if (!hasData()) return "unknown";
    if (err()) return "stale";
    const health = String(overview.health || "").trim().toLowerCase();
    if (["ok", "healthy", "ready"].includes(health)) return "healthy";
    if (["warn", "warning", "degraded"].includes(health)) return "stale";
    return health ? "error" : "unknown";
  });
  const statusLabel = computed(() => {
    if (!hasData()) return t(loading() ? "runtime_loading" : "runtime_unavailable");
    if (err()) return t("runtime_stale");
    if (statusTone() === "healthy") return t("runtime_healthy");
    return overview.health || t("runtime_unknown");
  });
  const statusRows = computed(() => [
    { key: "uptime", label: t("stat_uptime"), value: formatUptime(overview.uptime_sec) },
    { key: "started", label: t("stat_started"), value: formatShortTime(overview.started_at) },
    {
      key: "poke",
      label: t("runtime_field_last_poke"),
      value: overview.last_poke_at ? formatShortTime(overview.last_poke_at) : t("runtime_status_never"),
    },
  ]);
  const technicalRows = computed(() => [
    { key: "endpoint", label: t("runtime_field_endpoint"), value: endpointMeta()?.title || "-" },
    { key: "reference", label: t("runtime_endpoint_reference"), value: String(endpointState.selectedRef || "") },
    { key: "location", label: t("runtime_field_location"), value: endpointMeta()?.location || "-" },
    { key: "instance", label: t("runtime_field_instance"), value: stringValue(overview.instance_id) },
    { key: "version", label: t("stat_version"), value: stringValue(overview.version) },
    { key: "go", label: t("stat_go_version"), value: stringValue(overview.runtime_go_version) },
  ]);
  const routeRows = computed(() => [
    { key: "provider", label: t("stat_llm_provider"), value: stringValue(overview.llm_provider) },
    { key: "model", label: t("stat_llm_model"), value: stringValue(overview.llm_model) },
  ]);
  const runtimeMetrics = computed(() => [
    { key: "goroutines", label: t("stat_goroutines"), value: String(overview.runtime_goroutines || 0) },
    { key: "heap_alloc", label: t("stat_heap_alloc"), value: formatBytes(overview.runtime_heap_alloc_bytes) },
    { key: "heap_sys", label: t("stat_heap_sys"), value: formatBytes(overview.runtime_heap_sys_bytes) },
    { key: "heap_objects", label: t("stat_heap_objects"), value: String(overview.runtime_heap_objects || 0) },
    { key: "gc", label: t("stat_gc_cycles"), value: String(overview.runtime_gc_cycles || 0) },
  ]);
  const channelRows = computed(() =>
    CHANNELS.map((id) => ({
      key: id,
      title: t(`endpoint_channel_${id}`),
      configured: !!overview[`channel_${id}_configured`],
      running: !!overview[`channel_running_${id}`],
      status: STATUS_CHANNELS.has(id) ? String(overview[`channel_status_${id}`] || "") : "",
    })),
  );
  // The account channels report their connection: a lost session needs a new login, and X can run
  // out of API credits.
  function channelTone(item: { running: boolean; status: string }): Tone {
    if (!item.running) return "unknown";
    if (item.status === "reauth_needed" || item.status === "out_of_credits") return "error";
    if (item.status === "disconnected" || item.status === "connecting") return "stale";
    return "healthy";
  }
  function channelStatusText(item: { running: boolean; status: string }) {
    if (!item.running) return t("runtime_not_running");
    if (item.status === "reauth_needed") return t("runtime_channel_reauth_needed");
    if (item.status === "out_of_credits") return t("runtime_channel_out_of_credits");
    if (item.status === "disconnected") return t("runtime_channel_reconnecting");
    if (item.status === "connecting") return t("runtime_channel_connecting");
    return t("runtime_status_running");
  }
  const configuredChannels = computed(() => channelRows().filter((item) => item.configured));
  const unconfiguredChannels = computed(() => channelRows().filter((item) => !item.configured));
  const canPoke = computed(() => hasData() && toBool(overview.poke_enabled, false));
  const awarenessRunning = computed(() => toBool(overview.awareness_running, false));
  const pokeDisabled = computed(() => !hasData() || !!err() || poking() || awarenessRunning());
  const pokeBodyTooLarge = computed(() => utf8ByteLength(pokeBody()) > POKE_BODY_LIMIT);
  const pokeSubmitDisabled = computed(() => pokeDisabled() || !String(pokeBody() || "").trim() || pokeBodyTooLarge());

  async function load() {
    const sequence = ++loadSequence;
    loading.set(true);
    try {
      await loadEndpoints();
      if (sequence !== loadSequence) return;
      const endpointRef = endpointState.selectedRef;
      if (!endpointRef) throw new Error(t("msg_select_endpoint"));
      const data: any = await runtimeApiFetchForEndpoint(endpointRef, "/overview");
      if (sequence !== loadSequence || endpointRef !== endpointState.selectedRef) return;
      const llm = data && typeof data.llm === "object" ? data.llm : {};
      const channel = data && typeof data.channel === "object" ? data.channel : {};
      const rt = data && typeof data.runtime === "object" ? data.runtime : {};
      const runningChannel = String(channel.running || "").trim();
      batch(() => {
        overview.version = data.version || "-";
        overview.started_at = data.started_at || "";
        overview.uptime_sec = toInt(data.uptime_sec, 0);
        overview.health = data.health || "";
        overview.mode = data.mode || "";
        overview.agent_name = data.agent_name || "";
        overview.poke_enabled = toBool(data.poke_enabled, false);
        overview.awareness_running = toBool(data.awareness_running, false);
        overview.instance_id = data.instance_id || "";
        overview.last_poke_at = data.last_poke_at || "";
        overview.llm_provider = llm.provider || "-";
        overview.llm_model = llm.model || "-";
        for (const id of CHANNELS) {
          const running = toBool(channel[`${id}_running`], false) || runningChannel === id;
          overview[`channel_running_${id}`] = running;
          overview[`channel_${id}_configured`] = toBool(channel[`${id}_configured`], false) || running;
          if (STATUS_CHANNELS.has(id)) overview[`channel_status_${id}`] = String(channel[`${id}_status`] || "").trim();
        }
        overview.runtime_go_version = rt.go_version || "-";
        overview.runtime_goroutines = toInt(rt.goroutines, 0);
        overview.runtime_heap_alloc_bytes = toInt(rt.heap_alloc_bytes, 0);
        overview.runtime_heap_sys_bytes = toInt(rt.heap_sys_bytes, 0);
        overview.runtime_heap_objects = toInt(rt.heap_objects, 0);
        overview.runtime_gc_cycles = toInt(rt.gc_cycles, 0);
        loadedEndpointRef.set(endpointRef);
        lastUpdated.set(new Date().toISOString());
        err.set("");
      });
    } catch (e: any) {
      if (sequence === loadSequence) err.set(e?.message || t("msg_load_failed"));
    } finally {
      if (sequence === loadSequence) loading.set(false);
    }
  }

  function openPokeDialog() {
    if (untracked(pokeDisabled)) return;
    batch(() => {
      pokeBody.set("");
      pokeError.set("");
      pokeDialogOpen.set(true);
    });
  }

  function closePokeDialog() {
    if (untracked(poking)) return;
    batch(() => {
      pokeDialogOpen.set(false);
      pokeError.set("");
    });
  }

  function updatePokeBody(value: string) {
    batch(() => {
      pokeBody.set(String(value || ""));
      if (untracked(pokeError)) pokeError.set("");
    });
  }

  async function submitPoke() {
    if (untracked(pokeDisabled)) return;
    const endpointRef = endpointState.selectedRef;
    const body = String(untracked(pokeBody) || "").trim();
    if (!body) {
      pokeError.set(t("runtime_poke_empty"));
      return;
    }
    if (utf8ByteLength(body) > POKE_BODY_LIMIT) {
      pokeError.set(t("runtime_poke_too_large"));
      return;
    }
    poking.set(true);
    try {
      const data: any = await runtimeApiFetchForEndpoint(endpointRef, "/poke", {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body,
      });
      if (endpointRef !== endpointState.selectedRef) return;
      batch(() => {
        if (typeof data?.poked_at === "string") overview.last_poke_at = data.poked_at;
        pokeDialogOpen.set(false);
        pokeBody.set("");
        pokeError.set("");
      });
      notice.success(t("runtime_poke_ok"));
    } catch (e: any) {
      const message = e?.message || t("msg_load_failed");
      if (e?.status === 400 || e?.status === 413) pokeError.set(message);
      else notice.error(message);
    } finally {
      poking.set(false);
    }
  }

  // Load now, then every minute; another endpoint starts over.
  let previousRef: string | undefined;
  effect(() => {
    const ref = endpointState.selectedRef;
    untracked(() => {
      if (previousRef !== undefined && previousRef !== ref) {
        batch(() => {
          loadedEndpointRef.set("");
          lastUpdated.set("");
          err.set("");
          pokeDialogOpen.set(false);
          pokeError.set("");
        });
      }
      previousRef = ref;
      void load();
    });
  });
  const refreshTimer = setInterval(() => void load(), 60000);
  cleanup(() => {
    loadSequence += 1;
    clearInterval(refreshTimer);
  });

  return (
    <View class="gap-[18px] pb-6" testID="runtime-panel">
      <SettingsCard
        title={heroTitle()}
        literal
        metaLead={
          <View class="flex-row items-center gap-3.5">
            <Text class="text-xs text-muted-foreground">{modeLabel()}</Text>
            <StatusLabel small tone={statusTone()} text={statusLabel()} testID="runtime-status" />
          </View>
        }
        actions={
          <If when={canPoke()}>
            <Button variant="plain" size="xs" label={t("runtime_action_poke")} loading={poking()} disabled={pokeDisabled()} onPress={openPokeDialog} testID="runtime-poke" />
          </If>
        }
      >
        <If when={canPoke() && awarenessRunning()}>
          <Text class="text-sm leading-normal text-subtle">{t("runtime_poke_busy")}</Text>
        </If>
        <Text class="min-h-[21px] text-sm leading-normal text-subtle" testID="runtime-update">
          {loading()
            ? t("runtime_loading")
            : hasData()
              ? t("runtime_updated", { time: formatShortTime(lastUpdated()) })
              : t("runtime_no_data")}
        </Text>
        <If when={err()}>
          <View role="alert" class="gap-1" testID="runtime-error">
            <Text class="text-sm text-danger">{err()}</Text>
            <If when={hasData()}>
              <Text class="text-xs text-muted-foreground">{t("runtime_stale_hint")}</Text>
            </If>
          </View>
        </If>
        <If when={hasData()}>
          <Ledger rows={statusRows()} testID="runtime-status-rows" />
        </If>
      </SettingsCard>

      <If when={hasData()}>
        <View class={isMobile() ? "gap-[18px]" : "flex-row items-start gap-[18px]"}>
          <SettingsCard title={t("runtime_current_model")} class="min-w-0 flex-1" list>
            <Ledger rows={routeRows()} testID="runtime-model" />
          </SettingsCard>
          <SettingsCard title={t("group_channels")} class="min-w-0 flex-1" testID="runtime-channels" bodyClass="gap-3">
            <Each of={configuredChannels()} key={(item) => item.key}>
              {(item) => (
                <View class="flex-row flex-wrap items-center justify-between gap-2">
                  <View class="flex-row items-center gap-2">
                    <Image src={CHANNEL_LOGOS[item().key]} accessibilityElementsHidden style={{ width: 20, height: 20 }} />
                    <Text class="text-sm text-foreground">{item().title}</Text>
                  </View>
                  <StatusLabel tone={channelTone(item())} text={channelStatusText(item())} />
                </View>
              )}
            </Each>
            <If when={unconfiguredChannels().length}>
              <RuntimeFold
                open={unconfiguredOpen()}
                onToggle={() => unconfiguredOpen.update((open) => !open)}
                title={t(configuredChannels().length ? "runtime_status_not_configured" : "runtime_no_channels")}
                testID="runtime-unconfigured"
              >
                <View class="flex-row flex-wrap gap-3">
                  <Each of={unconfiguredChannels()} key={(item) => item.key}>
                    {(item) => (
                      <View class="flex-row items-center gap-2">
                        <Image src={CHANNEL_LOGOS[item().key]} accessibilityElementsHidden style={{ width: 20, height: 20 }} />
                        <Text class="text-sm text-subtle">{item().title}</Text>
                      </View>
                    )}
                  </Each>
                </View>
              </RuntimeFold>
            </If>
          </SettingsCard>
        </View>

        <SettingsCard title={t("group_runtime")} list>
          <Ledger rows={runtimeMetrics()} columns={2} testID="runtime-metrics" />
        </SettingsCard>

        <SettingsCard
          title={t("runtime_technical_details")}
          actions={
            <BaseButton
              onPress={() => technicalOpen.update((open) => !open)}
              accessibilityLabel={t("runtime_technical_details")}
              testID="runtime-technical-toggle"
              class="size-8 items-center justify-center rounded-(--radius) hover:bg-hover"
            >
              <View class="transition-transform duration-160" style={{ transform: [{ rotate: technicalOpen() ? "180deg" : "0deg" }] }}>
                <Icon name="PhCaretDown" size={16} color="subtle" />
              </View>
            </BaseButton>
          }
          headOnly={!technicalOpen()}
          list
        >
          <If when={technicalOpen()}>
            <Ledger rows={technicalRows()} testID="runtime-technical" />
          </If>
        </SettingsCard>
      </If>

      <PokeDialog
        open={pokeDialogOpen()}
        onClose={closePokeDialog}
        body={pokeBody()}
        onBodyChange={updatePokeBody}
        bodyTooLarge={pokeBodyTooLarge()}
        disabled={poking()}
        error={pokeError()}
        submitDisabled={pokeSubmitDisabled()}
        submitting={poking()}
        onSubmit={() => void submitPoke()}
      />
    </View>
  );
}
