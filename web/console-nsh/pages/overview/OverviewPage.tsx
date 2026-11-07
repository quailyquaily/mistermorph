// The overview of every agent this console reaches (the Vue console's OverviewView): the console
// itself on top, its agents below, each joined to it by a line drawn in like a pen plotter, with
// traffic running along the lines of the online ones. Each online agent has a small datasheet:
// model, running channels, cost, requests, tokens, uptime and the prompt-cache hit rate. Addresses
// are masked until the eye button shows them (remembered). Pressing an online agent opens its chat;
// the last node adds an agent in the console's settings. The list refreshes every minute.
import type { AnimatedNode, AnimatedValue, CanvasRenderingContext2D, ImageAsset, ViewRef } from "nsh";
import {
  batch,
  Canvas,
  cleanup,
  computed,
  createAnimatedValue,
  Easing,
  effect,
  Image,
  Path2D,
  reduceMotion,
  Scroll,
  signal,
  Text,
  token,
  untracked,
  View,
} from "nsh";
import { Tooltip } from "nsh/base";
import { Button, Icon, ProgressBar, usePageError } from "../../components/ui";
import { RollingNumber } from "../../components/shared/RollingNumber";
import { summarizeAgentReadout } from "../../lib/core/agent-readout.js";
import { formatCompactCost, formatExactCost } from "../../lib/core/cost-format.js";
import {
  currentLocale,
  endpointState,
  ensureEndpointsLoaded,
  loadEndpoints,
  runtimeApiFetchForEndpoint,
  toBool,
  translate,
} from "../../lib/core/context.js";
import { endpointDisplayItem, isConsoleLocalEndpoint, visibleEndpoints } from "../../lib/core/endpoints.js";
import { endpointRoutePath } from "../../lib/core/endpoint-routes.js";
import { localStore } from "../../lib/platform";
import { locationOf, navigate } from "../../lib/router";
import logoURL from "../../assets/images/app_logo_current.svg";
import telegramLogo from "../../assets/images/channels/telegram.svg";
import slackLogo from "../../assets/images/channels/slack.svg";
import lineLogo from "../../assets/images/channels/line.svg";
import larkLogo from "../../assets/images/channels/lark.svg";
import mixinLogo from "../../assets/images/channels/mixin.svg";
import discordLogo from "../../assets/images/channels/discord.svg";
import wechatLogo from "../../assets/images/channels/wechat.svg";
import whatsappLogo from "../../assets/images/channels/whatsapp.svg";
import blueskyLogo from "../../assets/images/channels/bluesky.svg";
import xLogo from "../../assets/images/channels/x.svg";

const t = translate as (key: string, vars?: Record<string, unknown>) => string;

const SHOW_ADDRESSES_STORAGE_KEY = "mistermorph_console_overview_show_addresses";
const CHANNEL_LOGOS: Record<string, ImageAsset> = {
  telegram: telegramLogo,
  slack: slackLogo,
  line: lineLogo,
  lark: larkLogo,
  mixin: mixinLogo,
  discord: discordLogo,
  wechat: wechatLogo,
  whatsapp: whatsappLogo,
  bluesky: blueskyLogo,
  x: xLogo,
};
const METER_SEGMENTS = 16;
const REFRESH_MS = 60000;
const ADD_KEY = "add-console";
// The draw-in: nodes appear in order, then each line is drawn along its path.
const NODE_STEP_MS = 110;
const PLOT_START_MS = 380;
const PLOT_STEP_MS = 150;
const PLOT_MS = 900;
const TRAFFIC_START_MS = 1600;
const TRAFFIC_PERIOD_MS = 3000;
// The length of a quarter turn drawn as a quadratic curve, per unit of its radius.
const QUAD_CORNER = 1.6232;

export interface EndpointRow {
  endpoint_ref: string;
  local: boolean;
  title: string;
  maskTitle: boolean;
  maskDetail: boolean;
  detail: string;
  avatar_url: string;
  connected: boolean;
  pending: boolean;
  statusLabel: string;
  route?: string;
}

/** The rows as the overview lists them: the console first, then online, checking, offline, by name. */
export function overviewRows(items: unknown[]): EndpointRow[] {
  return (visibleEndpoints(items) as Record<string, any>[])
    .map((item) => {
      const display = endpointDisplayItem(item, t);
      const connected = toBool(item.connected, false);
      const pending = !connected && toBool(item.health_pending, false);
      const local = isConsoleLocalEndpoint(item);
      const name = String(item.agent_name || "").trim() || String(item.name || "").trim();
      const hasAddress = !local && Boolean(String(item.url || "").trim());
      return {
        endpoint_ref: String(item.endpoint_ref),
        local,
        title: name || display.title,
        maskTitle: hasAddress && !name,
        maskDetail: hasAddress,
        detail: local ? t("overview_current_console") : display.meta,
        avatar_url: String(item.avatar_url || "").trim(),
        connected,
        pending,
        statusLabel: t(
          pending ? "overview_status_checking" : connected ? "endpoint_switcher_online" : "endpoint_switcher_offline",
        ),
        route: connected ? endpointRoutePath(item.endpoint_ref, "/chat") : undefined,
      };
    })
    .sort(
      (left, right) =>
        Number(right.local) - Number(left.local) ||
        Number(right.connected) - Number(left.connected) ||
        Number(right.pending) - Number(left.pending) ||
        left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: "base" }),
    );
}

interface Target {
  endpoint_ref: string;
  connected: boolean;
  pending: boolean;
  add: boolean;
  x: number;
  y: number;
  portraitY: number;
  radius: number;
}

export interface Connection extends Target {
  path: string;
  length: number;
}

/**
 * The lines from the console's portrait to the others: the first row branches from a bar halfway
 * down; later rows from an outer rail, clear of earlier avatars and labels. The lengths are exact
 * for the straight runs and the quadratic corners, for drawing them in.
 */
export function layoutConnections(source: { x: number; y: number }, targets: Target[]): Connection[] {
  if (targets.length === 0) return [];
  const sourceX = source.x;
  const sourceY = source.y;
  const firstRowY = Math.min(...targets.map((target) => target.y));
  const branchY = (sourceY + firstRowY) / 2;
  const railX = 8;
  return targets
    .map((target) => {
      let path: string;
      let length: number;
      if (Math.abs(target.y - firstRowY) < 1) {
        const direction = Math.sign(target.x - sourceX);
        const radius = Math.min(12, Math.abs(target.x - sourceX) / 2);
        if (direction === 0) {
          path = `M ${sourceX} ${sourceY} V ${target.y}`;
          length = Math.abs(target.y - sourceY);
        } else {
          path = `M ${sourceX} ${sourceY} V ${branchY - radius} Q ${sourceX} ${branchY} ${sourceX + direction * radius} ${branchY} H ${
            target.x - direction * radius
          } Q ${target.x} ${branchY} ${target.x} ${branchY + radius} V ${target.y}`;
          length =
            Math.abs(branchY - radius - sourceY) +
            2 * QUAD_CORNER * radius +
            Math.abs(target.x - sourceX - 2 * direction * radius) +
            Math.abs(target.y - branchY - radius);
        }
      } else {
        const rowY = target.y - 24;
        path = `M ${sourceX} ${sourceY} V ${branchY - 12} Q ${sourceX} ${branchY} ${sourceX - 12} ${branchY} H ${railX + 12} Q ${railX} ${branchY} ${railX} ${
          branchY + 12
        } V ${rowY - 12} Q ${railX} ${rowY} ${railX + 12} ${rowY} H ${target.x - 12} Q ${target.x} ${rowY} ${target.x} ${rowY + 12} V ${target.y}`;
        length =
          Math.abs(branchY - 12 - sourceY) +
          4 * QUAD_CORNER * 12 +
          Math.abs(sourceX - 12 - (railX + 12)) +
          Math.abs(rowY - 12 - (branchY + 12)) +
          Math.abs(target.x - 12 - (railX + 12)) +
          Math.abs(target.y - (rowY + 12));
      }
      return { ...target, path, length };
    })
    .sort((left, right) => Number(left.connected) - Number(right.connected));
}

interface Readout {
  model: string;
  cost: string;
  costExact: string;
  requests: string;
  tokens: string;
  tokensExact: string;
  uptime: string;
  cache: { percent: string; lit: number; value: number } | null;
  channels: { key: string; logo?: ImageAsset; title: string }[];
}

function color(name: Parameters<typeof token>[0]) {
  return token(name) as string;
}

/** The animated values of one line: its draw-in (0 to 1), and its traffic's phase (0 to 1, looping). */
interface LineMotion {
  plot: AnimatedValue;
  phase: AnimatedValue;
  started: boolean;
}

export function OverviewPage() {
  const err = signal("");
  const loading = signal(false);
  const readouts = signal<Map<string, ReturnType<typeof summarizeAgentReadout>>>(new Map());
  const hovered = signal("");
  const focused = signal("");
  const showAddresses = signal(localStore.getItem(SHOW_ADDRESSES_STORAGE_KEY) === "true");
  const failedAvatars = signal<Record<string, boolean>>({});
  usePageError(() => err());

  const endpointRows = computed(() => overviewRows(endpointState.items));
  const controller = () => endpointRows().find((item) => item.local) || null;
  const controllerSettingsLocation = () => {
    const local = controller();
    return local ? locationOf(endpointRoutePath(local.endpoint_ref, "/settings/console"), { add: "agent" }) : "";
  };

  /* ---------- live readings ---------- */

  async function loadReadouts() {
    const targets = untracked(endpointRows).filter((item) => item.connected);
    const results = await Promise.all(
      targets.map(async (item) => {
        const [overview, usage] = await Promise.allSettled([
          runtimeApiFetchForEndpoint(item.endpoint_ref, "/overview"),
          runtimeApiFetchForEndpoint(item.endpoint_ref, "/stats/llm/usage"),
        ]);
        return [
          item.endpoint_ref,
          summarizeAgentReadout(
            overview.status === "fulfilled" ? overview.value : null,
            usage.status === "fulfilled" ? usage.value : null,
          ),
        ] as const;
      }),
    );
    readouts.set(new Map(results));
  }

  const readoutFor = (item: EndpointRow): Readout | null => {
    const readout = item.connected ? readouts().get(item.endpoint_ref) : null;
    if (!readout) return null;
    const rate = readout.cacheRate;
    return {
      model: readout.model,
      cost: readout.cost === null ? "—" : formatCompactCost(readout.cost, readout.currency),
      costExact: readout.cost === null ? "" : formatExactCost(readout.cost, readout.currency),
      requests: readout.requests === null ? "—" : readout.requests.toLocaleString(),
      tokens:
        readout.tokens === null
          ? "—"
          : new Intl.NumberFormat(currentLocale(), { notation: "compact", maximumFractionDigits: 2 }).format(readout.tokens),
      tokensExact: readout.tokens === null ? "" : readout.tokens.toLocaleString(),
      uptime: readout.uptime || "—",
      cache:
        rate === null
          ? null
          : { percent: `${Math.round(rate * 100)}%`, lit: Math.round(rate * METER_SEGMENTS), value: Math.round(rate * 100) },
      channels: readout.channels.map((key: string) => ({ key, logo: CHANNEL_LOGOS[key], title: t(`endpoint_channel_${key}`) })),
    };
  };

  async function load(options: { force?: boolean } = {}) {
    if (untracked(loading)) return;
    batch(() => {
      loading.set(true);
      err.set("");
    });
    try {
      if (options.force === true) {
        await loadEndpoints();
      } else {
        await ensureEndpointsLoaded();
      }
    } catch (error) {
      err.set((error as Error)?.message || t("msg_load_failed"));
    } finally {
      loading.set(false);
    }
    void loadReadouts().catch((error: Error) => console.warn("overview readouts:", error?.message || error));
  }

  function toggleAddresses() {
    const next = !untracked(showAddresses);
    showAddresses.set(next);
    localStore.setItem(SHOW_ADDRESSES_STORAGE_KEY, String(next));
  }

  effect(() => untracked(() => void load()));
  const timer = setInterval(() => void load({ force: true }), REFRESH_MS);
  cleanup(() => clearInterval(timer));

  /* ---------- the connection map ---------- */

  let mapRef: ViewRef | undefined;
  const portraits = new Map<string, ViewRef>();
  const connections = signal<Connection[]>([]);
  let measureSeq = 0;
  let measureQueued = false;
  let disposed = false;
  cleanup(() => {
    disposed = true;
  });

  async function updateConnections() {
    measureQueued = false;
    if (disposed) return;
    const seq = ++measureSeq;
    const rows = untracked(endpointRows);
    const local = rows.find((item) => item.local);
    const controllerPortrait = local ? portraits.get(local.endpoint_ref) : undefined;
    const map = mapRef ? await mapRef.measure() : null;
    if (!map || !local || !controllerPortrait) {
      if (seq === measureSeq) connections.set([]);
      return;
    }
    const others: { endpoint_ref: string; connected: boolean; pending: boolean; add: boolean }[] = [
      ...rows.filter((item) => !item.local).map((item) => ({ ...item, add: false })),
      { endpoint_ref: ADD_KEY, connected: false, pending: false, add: true },
    ];
    const source = await controllerPortrait.measure();
    const measured = await Promise.all(others.map((item) => portraits.get(item.endpoint_ref)?.measure() ?? null));
    if (seq !== measureSeq || !source || disposed) return;
    const origin = map.pagePosition;
    const targets: Target[] = [];
    others.forEach((item, index) => {
      const box = measured[index];
      if (!box) return;
      const { width, height } = box.bounds.size;
      targets.push({
        endpoint_ref: item.endpoint_ref,
        connected: item.connected,
        pending: item.pending,
        add: item.add,
        x: box.pagePosition.x + width / 2 - origin.x,
        y: box.pagePosition.y - origin.y - 8,
        portraitY: box.pagePosition.y + height / 2 - origin.y,
        radius: width / 2 + 5,
      });
    });
    const { width, height } = source.bounds.size;
    connections.set(
      layoutConnections(
        { x: source.pagePosition.x + width / 2 - origin.x, y: source.pagePosition.y + height - origin.y + 10 },
        targets,
      ),
    );
  }

  function queueConnections() {
    if (measureQueued) return;
    measureQueued = true;
    setTimeout(() => void updateConnections(), 0);
  }

  // Readouts arrive after the first layout and can move the console's portrait.
  effect(() => {
    void endpointRows();
    void readouts();
    untracked(queueConnections);
  });

  const activeKey = () => hovered() || focused();

  // Each line keeps its animated values while it stays: the draw-in plays once, the traffic loops.
  const motions = new Map<string, LineMotion>();
  function motionFor(key: string, index: number): LineMotion {
    let motion = motions.get(key);
    if (!motion) {
      motion = { plot: createAnimatedValue(0), phase: createAnimatedValue(0), started: false };
      motions.set(key, motion);
    }
    if (!motion.started) {
      motion.started = true;
      if (untracked(reduceMotion)) {
        motion.plot.set(1);
      } else {
        void motion.plot.timing(1, {
          duration: PLOT_MS,
          delay: PLOT_START_MS + index * PLOT_STEP_MS,
          easing: Easing.bezier(0.55, 0, 0.25, 1),
        });
        // Traffic starts once the lines are drawn; each line's pulse runs a little behind the last.
        void motion.phase.keyframes([0, 1], {
          duration: TRAFFIC_PERIOD_MS,
          delay: TRAFFIC_START_MS + ((index * 450) % TRAFFIC_PERIOD_MS),
          easing: Easing.linear,
          iterations: "infinite",
        });
      }
    }
    return motion;
  }
  cleanup(() => {
    for (const motion of motions.values()) {
      void motion.plot.stop();
      void motion.phase.stop();
    }
  });

  function drawConnections(cx: CanvasRenderingContext2D) {
    const list = connections();
    const active = activeKey();
    const accent = color("primary");
    const soft = color("blue-lighter");
    const offline = color("muted-foreground");
    const pending = color("warn");
    list.forEach((connection, index) => {
      const motion = motionFor(connection.endpoint_ref, index);
      const path = new Path2D(connection.path);
      cx.save();
      cx.lineCap = "round";
      cx.lineJoin = "round";
      if (connection.add || (!connection.connected && !connection.pending)) {
        // Dashed lines keep their own dash pattern: they fade in instead.
        cx.globalAlpha = motion.plot;
        cx.strokeStyle = connection.add ? soft : offline;
        cx.lineWidth = connection.add ? 1.5 : 1;
        cx.setLineDash(connection.add ? [4, 6] : [3, 6]);
      } else if (connection.pending) {
        cx.globalAlpha = motion.plot;
        cx.strokeStyle = pending;
        cx.lineWidth = 1.5;
        cx.setLineDash([2, 5]);
      } else {
        cx.strokeStyle = soft;
        cx.lineWidth = 1.5;
        cx.setLineDash([connection.length, connection.length]);
        cx.lineDashOffset = motion.plot.interpolate({ inputRange: [0, 1], outputRange: [connection.length, 0] });
      }
      cx.stroke(path);
      cx.restore();
    });
    const highlighted = list.find((connection) => (connection.connected || connection.add) && connection.endpoint_ref === active);
    if (highlighted) {
      cx.save();
      cx.lineCap = "round";
      cx.lineJoin = "round";
      cx.strokeStyle = accent;
      cx.lineWidth = 1.5;
      if (highlighted.add) cx.setLineDash([4, 6]);
      cx.stroke(new Path2D(highlighted.path));
      cx.restore();
    }
    if (untracked(reduceMotion)) return;
    list.forEach((connection, index) => {
      if (!connection.connected) return;
      const motion = motionFor(connection.endpoint_ref, index);
      const path = new Path2D(connection.path);
      // A tapered pulse runs from the console to the agent, fading in and out at the ends.
      const visible: AnimatedNode = motion.phase.interpolate({ inputRange: [0, 0.05, 0.95, 1], outputRange: [0, 1, 1, 0] });
      for (let part = 1; part <= 6; part += 1) {
        const pulse = 19 - part * 3;
        cx.save();
        cx.lineCap = "round";
        cx.lineJoin = "round";
        cx.strokeStyle = accent;
        cx.lineWidth = 0.4 + part * 0.6;
        cx.globalAlpha = visible.mul(part / 6);
        cx.setLineDash([pulse, connection.length]);
        cx.lineDashOffset = motion.phase.interpolate({
          inputRange: [0, 1],
          outputRange: [pulse / 2, pulse / 2 - connection.length],
        });
        cx.stroke(path);
        cx.restore();
      }
      // Its arrival rings round the agent's portrait.
      cx.save();
      cx.strokeStyle = accent;
      cx.lineWidth = 1;
      cx.globalAlpha = motion.phase.interpolate({ inputRange: [0, 0.28, 1], outputRange: [0.5, 0, 0] });
      cx.beginPath();
      cx.arc(
        connection.x,
        connection.portraitY,
        motion.phase.interpolate({
          inputRange: [0, 0.28, 1],
          outputRange: [connection.radius * 0.96, connection.radius * 1.16, connection.radius * 1.16],
        }),
        0,
        Math.PI * 2,
      );
      cx.stroke();
      cx.restore();
    });
  }

  /* ---------- the nodes ---------- */

  const portraitRef = (key: string) => (node: ViewRef) => {
    portraits.set(key, node);
  };

  function Portrait(props: { row: EndpointRow; size: number }) {
    const src = () =>
      props.row.avatar_url && !failedAvatars()[props.row.avatar_url] ? props.row.avatar_url : (logoURL as ImageAsset | string);
    const offline = () => !props.row.connected && !props.row.pending;
    return (
      <View ref={portraitRef(props.row.endpoint_ref)} class="relative rounded-full">
        <Image
          src={src()}
          accessibilityElementsHidden
          onError={() => {
            if (props.row.avatar_url) failedAvatars.update((map) => ({ ...map, [props.row.avatar_url]: true }));
          }}
          class="rounded-full border border-line-faint bg-muted"
          style={{
            width: props.size,
            height: props.size,
            objectFit: "cover",
            filter: offline() ? "grayscale(1)" : undefined,
            opacity: offline() ? 0.65 : 1,
          }}
        />
        <View
          role="image"
          accessibilityLabel={props.row.statusLabel}
          tooltip={
            <Tooltip class="bg-foreground px-2 py-1">
              <Text class="text-xs text-background">{props.row.statusLabel}</Text>
            </Tooltip>
          }
          class="absolute bottom-0.5 right-0 items-center justify-center rounded-[3px] bg-background"
          style={{ width: 13, height: 13 }}
        >
          <View
            class={`size-2.25 rounded-[1px] border ${
              props.row.connected
                ? "border-status-on bg-status-on"
                : props.row.pending
                  ? "border-dashed border-status-pending"
                  : "border-status-off"
            }`}
          />
        </View>
      </View>
    );
  }

  function Identity(props: { row: EndpointRow }) {
    const titleMasked = () => !showAddresses() && props.row.maskTitle;
    const detailMasked = () => !showAddresses() && props.row.maskDetail;
    return (
      <View class="w-full items-center gap-1.5">
        <Text
          class={`text-center text-base font-semibold ${props.row.connected || props.row.pending ? "text-foreground" : "text-subtle"}`}
          accessibilityElementsHidden={titleMasked()}
          style={{ filter: titleMasked() ? "blur(6px)" : undefined }}
        >
          {props.row.title}
        </Text>
        <If when={props.row.detail}>
          <Text
            class={`text-center text-xs ${props.row.local ? "text-primary" : "text-subtle"}`}
            accessibilityElementsHidden={detailMasked()}
            style={{ filter: detailMasked() ? "blur(6px)" : undefined }}
          >
            {props.row.detail}
          </Text>
        </If>
      </View>
    );
  }

  function SpecRow(props: { label: string; value: string; exact?: string }) {
    return (
      <View
        class="flex-row items-end"
        tooltip={
          props.exact ? (
            <Tooltip class="bg-foreground px-2 py-1">
              <Text class="font-mono text-xs text-background">{props.exact}</Text>
            </Tooltip>
          ) : undefined
        }
      >
        <Text class="pr-1.5 font-mono text-xs uppercase tracking-widest text-muted-foreground">{props.label}</Text>
        <View class="mb-1 flex-1 border-b border-dotted border-muted-foreground" style={{ minWidth: 8 }} />
        <View class="pl-1.5">
          <RollingNumber value={props.value} class="font-mono text-xs text-foreground" />
        </View>
      </View>
    );
  }

  function ReadoutCard(props: { readout: Readout; leader: "top" | "left" }) {
    return (
      <View class="relative w-full rounded-(--radius) border border-line-soft bg-paper" testID="overview-readout">
        <View
          accessibilityElementsHidden
          class={
            props.leader === "top"
              ? "absolute -top-3.75 left-1/2 h-3.5 border-l border-dashed border-line"
              : "absolute bottom-10 -left-6.25 w-6 border-t border-dashed border-line"
          }
        />
        <View class="flex-row items-center gap-1.75 border-b border-line-soft px-2 py-1.5">
          <View class="size-1.5 rounded-[1px] bg-blue" />
          <If when={props.readout.model}>
            <View
              class="shrink flex-row"
              tooltip={
                <Tooltip class="bg-foreground px-2 py-1">
                  <Text class="font-mono text-xs text-background">{props.readout.model}</Text>
                </Tooltip>
              }
            >
              <Text class="font-mono text-xs text-blue opacity-55">[</Text>
              <Text class="shrink font-mono text-xs text-foreground line-clamp-1">{props.readout.model}</Text>
              <Text class="font-mono text-xs text-blue opacity-55">]</Text>
            </View>
          </If>
          <View class="ml-auto flex-row gap-1">
            <Each of={props.readout.channels} key={(channel) => channel.key}>
              {(channel) => (
                <If when={channel().logo}>
                  <Image
                    src={channel().logo}
                    accessibilityLabel={channel().title}
                    tooltip={
                      <Tooltip class="bg-foreground px-2 py-1">
                        <Text class="text-xs text-background">{channel().title}</Text>
                      </Tooltip>
                    }
                    style={{ width: 12, height: 12 }}
                  />
                </If>
              )}
            </Each>
          </View>
        </View>
        <View class="gap-0.75 px-2 pb-1.75 pt-2">
          <SpecRow label={t("overview_readout_cost")} value={props.readout.cost} exact={props.readout.costExact} />
          <SpecRow label={t("overview_readout_requests")} value={props.readout.requests} />
          <SpecRow label={t("overview_readout_tokens")} value={props.readout.tokens} exact={props.readout.tokensExact} />
          <SpecRow label={t("overview_readout_uptime_label")} value={props.readout.uptime} />
        </View>
        <If when={props.readout.cache}>
          {(cache) => (
            <View
              role="progressbar"
              accessibilityLabel={t("overview_readout_cache")}
              accessibilityValue={{ min: 0, max: 100, now: cache().value }}
              tooltip={
                <Tooltip class="bg-foreground px-2 py-1">
                  <Text class="text-xs text-background">{t("overview_readout_cache_hint")}</Text>
                </Tooltip>
              }
              class="flex-row items-center gap-1.5 border-t border-line-soft px-2 pb-2 pt-1.75"
            >
              <Text class="font-mono text-xs uppercase tracking-widest text-muted-foreground">{t("overview_readout_cache")}</Text>
              <View class="flex-1 flex-row gap-0.5" style={{ height: 7 }} accessibilityElementsHidden>
                <Each of={Array.from({ length: METER_SEGMENTS }, (_, i) => i + 1)}>
                  {(segment) => <View class={`flex-1 ${segment() <= cache().lit ? "bg-blue" : "bg-line-soft"}`} />}
                </Each>
              </View>
              <RollingNumber value={cache().percent} class="font-mono text-xs text-foreground" />
            </View>
          )}
        </If>
      </View>
    );
  }

  /** The press target of a node: portrait and identity; a plain node when it cannot be opened. */
  function NodeLink(props: { row: EndpointRow }) {
    const label = () => (!showAddresses() && props.row.maskTitle ? t("overview_address_hidden") : props.row.title);
    const open = () => {
      if (props.row.route) void navigate(props.row.route);
    };
    return (
      <View
        role={props.row.connected ? "link" : undefined}
        accessibilityLabel={label()}
        accessibilityState={props.row.connected ? undefined : { disabled: true }}
        onPress={props.row.connected ? open : undefined}
        focusable={props.row.connected}
        onFocus={() => focused.set(props.row.endpoint_ref)}
        onBlur={() => focused.set("")}
        onMouseEnter={() => hovered.set(props.row.endpoint_ref)}
        onMouseLeave={() => hovered.set("")}
        testID={`overview-node-${props.row.endpoint_ref}`}
        class={`items-center gap-4 rounded-lg px-2 py-4 ${props.row.local ? "flex-col-reverse" : ""} ${props.row.connected ? "group" : ""}`}
        style={{ cursor: props.row.connected ? "pointer" : "default" }}
      >
        <View
          class={`rounded-full p-1 ${props.row.local ? "border border-primary" : "border-2 border-transparent"} ${
            props.row.connected ? "group-hover:border-primary group-focus:border-primary group-active:border-primary" : ""
          }`}
        >
          <Portrait row={props.row} size={props.row.local ? 80 : 72} />
        </View>
        <Identity row={props.row} />
      </View>
    );
  }

  /** A node, with its readout below it, or beside it for the console. */
  function Node(props: { row: EndpointRow; index: number }) {
    const opacity = createAnimatedValue(untracked(reduceMotion) ? 1 : 0);
    if (!untracked(reduceMotion)) void opacity.timing(1, { duration: 420, delay: props.index * NODE_STEP_MS });
    return (
      <If
        when={props.row.local}
        else={
          <View
            style={{ opacity, width: 208, maxWidth: "45%" }}
            onLayout={queueConnections}
            testID={`overview-item-${props.row.endpoint_ref}`}
          >
            <NodeLink row={props.row} />
            <If when={readoutFor(props.row)}>{(readout) => <ReadoutCard readout={readout()} leader="top" />}</If>
          </View>
        }
      >
        <View
          class="w-full flex-row items-end justify-center gap-6"
          style={{ opacity }}
          onLayout={queueConnections}
          testID={`overview-item-${props.row.endpoint_ref}`}
        >
          <View class="flex-1" />
          <View style={{ maxWidth: 192 }}>
            <NodeLink row={props.row} />
          </View>
          <View class="flex-1 items-start pb-4">
            <If when={readoutFor(props.row)}>
              {(readout) => (
                <View style={{ width: 208, maxWidth: "100%" }}>
                  <ReadoutCard readout={readout()} leader="left" />
                </View>
              )}
            </If>
          </View>
        </View>
      </If>
    );
  }

  function AddNode(props: { index: number }) {
    const opacity = createAnimatedValue(untracked(reduceMotion) ? 1 : 0);
    if (!untracked(reduceMotion)) void opacity.timing(1, { duration: 420, delay: props.index * NODE_STEP_MS });
    return (
      <View style={{ opacity, width: 208, maxWidth: "45%" }} onLayout={queueConnections}>
        <View
          role="link"
          accessibilityLabel={t("overview_add_console")}
          onPress={() => void navigate(controllerSettingsLocation())}
          focusable
          onFocus={() => focused.set(ADD_KEY)}
          onBlur={() => focused.set("")}
          onMouseEnter={() => hovered.set(ADD_KEY)}
          onMouseLeave={() => hovered.set("")}
          testID="overview-add"
          class="group items-center gap-4 rounded-lg px-2 py-4"
          style={{ cursor: "pointer" }}
        >
          <View class="rounded-full border-2 border-transparent p-1 group-hover:border-primary group-focus:border-primary">
            <View
              ref={portraitRef(ADD_KEY)}
              class="items-center justify-center rounded-full border-[1.5px] border-dashed border-primary bg-background"
              style={{ width: 72, height: 72 }}
            >
              <Icon name="PhPlus" size={28} color="primary" />
            </View>
          </View>
          <View class="w-full items-center gap-1.5">
            <Text class="text-center text-base font-semibold text-foreground group-hover:text-primary">
              {t("overview_add_console")}
            </Text>
            <Text class="text-center text-xs text-subtle">{t("overview_add_console_hint")}</Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View class="relative flex-1 bg-background" testID="overview-page">
      <Scroll class="flex-1" contentClass="grow items-center justify-center px-6 pb-16 pt-16">
        <Text role="header" class="absolute size-px overflow-hidden opacity-0">
          {t("nav_overview")}
        </Text>
        <If when={loading() && endpointRows().length === 0}>
          <ProgressBar indeterminate class="w-full max-w-md" label={t("nav_overview")} />
        </If>
        <If
          when={endpointRows().length > 0}
          else={
            <If when={!loading() && !err()}>
              <Text class="text-center text-base text-subtle" testID="overview-empty">
                {t("no_endpoints")}
              </Text>
            </If>
          }
        >
          <View
            ref={(node: ViewRef) => {
              mapRef = node;
            }}
            class="relative w-full"
            style={{ maxWidth: 1152 }}
            onLayout={queueConnections}
          >
            <If when={connections().length > 0}>
              <Canvas
                class="absolute inset-0"
                accessibilityElementsHidden
                style={{ pointerEvents: "none" }}
                draw={(cx) => drawConnections(cx)}
              />
            </If>
            <View
              class="flex-row flex-wrap justify-center px-6"
              style={{ rowGap: 64, columnGap: 24 }}
              testID="overview-endpoints"
            >
              <Each of={endpointRows()} key={(row) => row.endpoint_ref}>
                {(row, index) => <Node row={row()} index={index()} />}
              </Each>
              <If when={controller()}>
                <AddNode index={endpointRows().length} />
              </If>
            </View>
          </View>
        </If>
      </Scroll>
      <If when={endpointRows().length > 0}>
        <View class="absolute right-5 top-3">
          <Button
            variant="plain"
            size="md"
            iconOnly
            icon={showAddresses() ? "PhEye" : "PhEyeSlash"}
            title={t(showAddresses() ? "overview_hide_addresses" : "overview_show_addresses")}
            selected={showAddresses()}
            testID="overview-address-toggle"
            onPress={toggleAddresses}
          />
        </View>
      </If>
    </View>
  );
}
