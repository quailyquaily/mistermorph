// A topic's context window (web/console/src/views/ContextView.js): its last main request as a grid
// of cells filled by its parts (system prompt, skills, tools, history, current message, this run's
// steps), each part's share of the cells matching its share of the tokens, with a ring of the
// window around the total. Beside it, the selected part's sections or messages, and the selected
// one's text. Phones (≤ 720 points) show one level at a time: the overview, a part's items, an
// item's text; Back steps up a level before it leaves for the topic.
import { batch, Canvas, computed, effect, Scroll, signal, Text, token, untracked, View, windowSize } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Button, Icon, Page, Spinner } from "../../components/ui";
import { t } from "../../components/chat/i18n";
import { contextCellGrid, contextRing } from "../../lib/core/context-inspector.js";
import { currentLocale, endpointState, runtimeApiFetch } from "../../lib/core/context.js";
import { endpointRoutePath } from "../../lib/core/endpoint-routes.js";
import { currentRoute, router } from "../../lib/router";

const RING_RADIUS = 40;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const PHONE_WIDTH = 720;
const GRID_COLUMNS = 20;

type TokenName = Parameters<typeof token>[0];

// Each part's color, from the theme: the Vue console's --context-* roles.
const PART_COLOR: Record<string, TokenName> = {
  system: "blue",
  skills: "ok",
  tools: "warn",
  history: "blue-light",
  current: "danger",
  steps: "subtle",
};
const PART_BG: Record<string, string> = {
  system: "bg-blue",
  skills: "bg-ok",
  tools: "bg-warn",
  history: "bg-blue-light",
  current: "bg-danger",
  steps: "bg-subtle",
};

const partBg = (kind: string) => PART_BG[kind] ?? "bg-muted";

function formatTokens(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n).toLocaleString(currentLocale()) : "0";
}

function formatShare(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${(n * 100).toFixed(n > 0 && n < 0.1 ? 1 : 0)}%`;
}

const partLabel = (kind: string) => t(`context_inspector_part_${kind}`);

// An item's label: a prompt section's heading, a tool's name, or what a message is.
function itemLabel(part: any) {
  if (!part) return "";
  if (part.kind === "section") return part.label || t("context_inspector_item_preamble");
  if (part.kind === "tool") return part.tool || part.label;
  if (part.kind === "summary") return t("context_inspector_item_summary");
  if (part.kind === "meta") return t("context_inspector_item_meta");
  if (part.kind === "context") return part.label || t("context_inspector_item_context");
  if (part.role === "tool") return t("context_inspector_item_tool_result", { tool: part.tool || "?" });
  if (part.role === "assistant" && part.tool) return t("context_inspector_item_tool_call", { tool: part.tool });
  if (part.role === "assistant") return t("context_inspector_item_agent");
  if (part.role === "user") return t("context_inspector_item_user");
  return partLabel(part.kind);
}

// The first line of an item's text that is not a heading, as a preview in the item list.
function snippet(part: any) {
  const lines = String(part?.content || "")
    .split("\n")
    .map((text) => text.trim())
    .filter(Boolean);
  const heading = /^(#{1,6}\s|\[\[.*\]\]$)/;
  const line = lines.find((text) => !heading.test(text)) || lines[0] || "";
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

const cacheLabel = (cache: any) => (cache?.ttl ? t("context_inspector_cache_ttl", { ttl: cache.ttl }) : t("context_inspector_cache"));

function Swatch(props: { kind: string }) {
  return <View class={`size-2.5 ${partBg(props.kind)}`} />;
}

function CacheBadge(props: { cache: any }) {
  return (
    <View class="rounded-(--radius) border border-line px-1" tooltip={<Text class="text-xs">{t("context_inspector_cache_key")}</Text>}>
      <Text class="font-mono text-xs text-subtle">{cacheLabel(props.cache)}</Text>
    </View>
  );
}

function Ring(props: { ring: any; ratio: unknown }) {
  return (
    <View class="size-24 items-center justify-center">
      <Canvas
        class="absolute inset-0"
        accessibilityElementsHidden
        draw={(cx, size) => {
          const scale = Math.min(size.width, size.height) / 100;
          cx.save();
          cx.scale(scale, scale);
          cx.lineWidth = 9;
          cx.strokeStyle = token("muted") as string;
          cx.beginPath();
          cx.arc(50, 50, RING_RADIUS, 0, Math.PI * 2);
          cx.stroke();
          // Arcs start at the top and run clockwise, as the SVG's dash offsets did.
          for (const arc of props.ring?.arcs ?? []) {
            const start = -Math.PI / 2 + (arc.offset / RING_CIRCUMFERENCE) * Math.PI * 2;
            const end = start + (arc.length / RING_CIRCUMFERENCE) * Math.PI * 2;
            cx.strokeStyle = token(PART_COLOR[arc.kind] ?? "muted-foreground") as string;
            cx.beginPath();
            cx.arc(50, 50, RING_RADIUS, start, end);
            cx.stroke();
          }
          if (props.ring?.triggerAngle !== null && props.ring?.triggerAngle !== undefined) {
            const angle = -Math.PI / 2 + (props.ring.triggerAngle / 360) * Math.PI * 2;
            cx.strokeStyle = token("foreground") as string;
            cx.lineWidth = 1.5;
            cx.beginPath();
            cx.moveTo(50 + Math.cos(angle) * (RING_RADIUS - 8), 50 + Math.sin(angle) * (RING_RADIUS - 8));
            cx.lineTo(50 + Math.cos(angle) * (RING_RADIUS + 8), 50 + Math.sin(angle) * (RING_RADIUS + 8));
            cx.stroke();
          }
          cx.restore();
        }}
      />
      <Text class="text-sm font-semibold text-foreground" testID="context-ring-value">
        {formatShare(props.ratio)}
      </Text>
    </View>
  );
}

export function ContextPage() {
  const loading = signal(false);
  const error = signal("");
  const snapshot = signal<any>(null);
  const selectedKind = signal("");
  const selectedItem = signal("");
  const phoneStep = signal(0);
  let request = 0;

  const isPhone = () => windowSize().width <= PHONE_WIDTH;
  const topicID = () => String(currentRoute().params.topic_id || "").trim();
  const grid = computed(() => contextCellGrid(snapshot()) as any);
  const selected = () => (grid()?.groups || []).find((group: any) => group.kind === selectedKind()) || null;
  const ring = () => contextRing(grid(), RING_CIRCUMFERENCE);
  const item = () => selected()?.items.find((entry: any) => entry.key === selectedItem()) || null;

  function selectPart(kind: string) {
    const group = (untracked(grid)?.groups || []).find((entry: any) => entry.kind === kind);
    const largest = [...(group?.items || [])].sort((a: any, b: any) => b.tokens - a.tokens)[0];
    batch(() => {
      selectedKind.set(kind);
      selectedItem.set(largest ? largest.key : "");
    });
  }

  // Opens on the largest part and its largest item, so the page is never empty.
  function selectDefault() {
    const largest = [...(untracked(grid)?.groups || [])].sort((a: any, b: any) => b.tokens - a.tokens)[0];
    if (largest) selectPart(largest.kind);
  }

  async function load(id: string) {
    if (!id) return;
    const current = ++request;
    batch(() => {
      loading.set(true);
      error.set("");
    });
    try {
      const data = await runtimeApiFetch(`/topic/${encodeURIComponent(id)}/context`);
      if (current !== request) return;
      batch(() => {
        snapshot.set(data);
        selectedKind.set("");
        selectedItem.set("");
        phoneStep.set(0);
      });
      if (!untracked(isPhone)) selectDefault();
    } catch (e) {
      if (current !== request) return;
      batch(() => {
        error.set((e as { status?: number })?.status === 404 ? t("context_inspector_unsupported") : (e as Error)?.message || t("msg_load_failed"));
        snapshot.set(null);
      });
    } finally {
      if (current === request) loading.set(false);
    }
  }

  effect(() => {
    const id = topicID();
    void endpointState.selectedRef;
    untracked(() => void load(id));
  });

  // Switching between the phone and the wide layout starts again at the overview.
  let lastPhone: boolean | undefined;
  effect(() => {
    const phone = isPhone();
    untracked(() => {
      if (lastPhone !== undefined && lastPhone !== phone) phoneStep.set(0);
      lastPhone = phone;
    });
  });

  function goPhoneStep(step: number) {
    batch(() => {
      phoneStep.set(step);
      if (step === 0) {
        selectedKind.set("");
        selectedItem.set("");
      }
    });
  }

  function back() {
    if (untracked(isPhone) && untracked(phoneStep) > 0) {
      goPhoneStep(untracked(phoneStep) - 1);
      return;
    }
    const id = untracked(topicID);
    void router.push(endpointRoutePath(endpointState.selectedRef, id ? `/chat/${encodeURIComponent(id)}` : "/chat"));
  }

  // Selecting the selected part again clears the selection.
  function togglePart(kind: string) {
    if (untracked(isPhone)) {
      selectPart(kind);
      goPhoneStep(1);
      return;
    }
    if (untracked(selectedKind) === kind) {
      batch(() => {
        selectedKind.set("");
        selectedItem.set("");
      });
      return;
    }
    selectPart(kind);
  }

  function selectItem(key: string) {
    selectedItem.set(key);
    if (untracked(isPhone)) goPhoneStep(2);
  }

  const entryLabel = (entry: any) => (selected() && selected().items.length > 1 ? itemLabel(entry.part) : partLabel(selectedKind()));
  const barTitle = () => {
    if (isPhone() && phoneStep() === 2 && item()) return entryLabel(item());
    if (isPhone() && phoneStep() >= 1 && selected()) return partLabel(selected().kind);
    return t("context_inspector_title");
  };
  const showOverview = () => !isPhone() || phoneStep() === 0;
  const showItems = () => !isPhone() || phoneStep() === 1;
  const showText = () => !isPhone() || phoneStep() === 2;
  const methodNote = () => {
    const data = snapshot() || {};
    if (data.method === "provider") return t("context_inspector_method_provider");
    if (data.count_note === "model_changed") return t("context_inspector_method_model_changed");
    if (data.count_note === "count_failed") return t("context_inspector_method_failed");
    if (data.count_unsupported) return t("context_inspector_method_unsupported");
    return t("context_inspector_estimate_note");
  };
  // The grid's cells, as wide as fits: 20 to a row.
  const cellSize = () => (isPhone() ? Math.max(8, Math.floor((windowSize().width - 40 - (GRID_COLUMNS - 1) * 2) / GRID_COLUMNS)) : 14);
  const gridRows = () => {
    const cells = grid()?.cells || [];
    const rows: any[][] = [];
    for (let i = 0; i < cells.length; i += GRID_COLUMNS) rows.push(cells.slice(i, i + GRID_COLUMNS).map((cell: any, j: number) => ({ ...cell, index: i + j })));
    return rows;
  };

  const overview = () => (
    <View class={`gap-4 ${isPhone() ? "" : "w-80"}`} testID="context-overview">
      <View class="flex-row items-center gap-4">
        <If when={ring()}>{(value) => <Ring ring={value()} ratio={grid()?.ratio} />}</If>
        <View class="flex-1 gap-1">
          <Text class="text-foreground" testID="context-total">
            <Text class="text-2xl font-semibold">{formatTokens(grid()?.used)}</Text>
            <Text class="text-xs text-muted-foreground"> {t("context_inspector_tokens")}</Text>
          </Text>
          <If when={grid()?.window}>
            <Text class="text-xs text-muted-foreground">{t("context_inspector_of_window", { tokens: formatTokens(grid()?.window) })}</Text>
          </If>
          <If when={grid()?.trigger}>
            <View class="self-start rounded-(--radius) border border-line px-1.5 py-px">
              <Text class="font-mono text-xs text-subtle">{t("context_inspector_trigger", { tokens: formatTokens(grid()?.trigger) })}</Text>
            </View>
          </If>
        </View>
      </View>
      <View class="gap-0.5" role="group" accessibilityLabel={t("context_inspector_bar_label")} testID="context-grid">
        <Each of={gridRows()} key={(_row, index) => `row:${index}`}>
          {(row) => (
            <View class="flex-row gap-0.5">
              <Each of={row()} key={(cell) => cell.key}>
                {(cell) => (
                  <View
                    onPress={() => togglePart(cell().kind)}
                    accessibilityLabel={cell().cache ? `${partLabel(cell().kind)} · ${cacheLabel(cell().cache)}` : partLabel(cell().kind)}
                    tooltip={<Text class="text-xs">{cell().cache ? `${partLabel(cell().kind)} · ${cacheLabel(cell().cache)}` : partLabel(cell().kind)}</Text>}
                    class={`${partBg(cell().kind)} ${selectedKind() && selectedKind() !== cell().kind ? "opacity-25" : ""} ${
                      cell().cache ? "border-2 border-foreground" : ""
                    }`}
                    style={{ width: cellSize(), height: cellSize() }}
                  />
                )}
              </Each>
            </View>
          )}
        </Each>
      </View>
      <If when={(grid()?.caches || []).length}>
        <View class="flex-row items-center gap-1.5">
          <View class="size-2.5 border-2 border-foreground" />
          <Text class="text-xs text-muted-foreground">{t("context_inspector_cache_key")}</Text>
        </View>
      </If>
      <View class="gap-0.5">
        <Each of={(grid()?.groups || []) as any[]} key={(group) => group.key}>
          {(group) => (
            <BaseButton
              selected={selectedKind() === group().kind}
              onPress={() => togglePart(group().kind)}
              accessibilityLabel={partLabel(group().kind)}
              testID={`context-part-${group().kind}`}
              class="flex-row items-center gap-2 rounded-(--radius) px-2 py-1.5 hover:bg-hover selected:bg-selection"
            >
              <Swatch kind={group().kind} />
              <Text class="flex-1 text-sm text-foreground">{partLabel(group().kind)}</Text>
              <Text class="font-mono text-xs tabular-nums text-subtle">{formatTokens(group().tokens)}</Text>
              <Text class="w-12 text-right font-mono text-xs tabular-nums text-muted-foreground">{formatShare(group().share)}</Text>
              <If when={isPhone()}>
                <Icon name="PhCaretRight" size={12} color="muted-foreground" />
              </If>
            </BaseButton>
          )}
        </Each>
      </View>
      <View class="gap-1">
        <Text class="text-xs text-muted-foreground">{t("context_inspector_cell", { tokens: formatTokens(grid()?.cellTokens) })}</Text>
        <Text class="text-xs text-muted-foreground">{methodNote()}</Text>
      </View>
    </View>
  );

  const items = (group: () => any) => (
    <View class={`gap-1 ${isPhone() ? "" : "w-80"}`} accessibilityLabel={partLabel(group().kind)} testID="context-items">
      <View class="flex-row items-center gap-2 border-b border-line-faint pb-2">
        <Swatch kind={group().kind} />
        <Text class="flex-1 text-sm font-semibold text-foreground">{partLabel(group().kind)}</Text>
        <Text class="text-xs text-muted-foreground">{t("context_inspector_items", { count: group().items.length })}</Text>
        <Text class="font-mono text-xs tabular-nums text-subtle">
          {formatTokens(group().tokens)} {t("context_inspector_tokens")}
        </Text>
      </View>
      <Each of={group().items as any[]} key={(entry) => entry.key}>
        {(entry) => (
          <BaseButton
            selected={selectedItem() === entry().key}
            onPress={() => selectItem(entry().key)}
            accessibilityLabel={entryLabel(entry())}
            testID={`context-item-${entry().key}`}
            class="gap-1 rounded-(--radius) px-2 py-1.5 hover:bg-hover selected:bg-selection"
          >
            <View class="flex-row items-center gap-2">
              <Text class="flex-1 text-sm text-foreground line-clamp-1">{entryLabel(entry())}</Text>
              <If when={entry().cache && isPhone()}>
                <View class="size-2 border-2 border-foreground" accessibilityLabel={cacheLabel(entry().cache)} />
              </If>
              <If when={entry().cache && !isPhone()}>
                <CacheBadge cache={entry().cache} />
              </If>
              <View class="h-1 w-14 overflow-hidden rounded-full bg-muted">
                <View class={`h-1 ${partBg(group().kind)}`} style={{ width: `${entry().share * 100}%` }} />
              </View>
              <Text class="w-14 text-right font-mono text-xs tabular-nums text-subtle">{formatTokens(entry().tokens)}</Text>
              <If when={isPhone()}>
                <Icon name="PhCaretRight" size={12} color="muted-foreground" />
              </If>
            </View>
            <If when={isPhone() && snippet(entry().part)}>
              <Text class="text-xs text-muted-foreground line-clamp-2">{snippet(entry().part)}</Text>
            </If>
          </BaseButton>
        )}
      </Each>
    </View>
  );

  const text = (entry: () => any) => (
    <View class="flex-1 gap-2" testID="context-text">
      <View class="flex-row items-center gap-2 border-b border-line-faint pb-2">
        <Text class="flex-1 text-sm font-semibold text-foreground">{entryLabel(entry())}</Text>
        <If when={entry().cache}>
          <CacheBadge cache={entry().cache} />
        </If>
        <Text class="font-mono text-xs tabular-nums text-subtle">
          {formatTokens(entry().tokens)} {t("context_inspector_tokens")}
        </Text>
      </View>
      <Scroll horizontal class="rounded-(--radius) border border-line-faint bg-paper" contentClass="p-3">
        <View selectable>
          <Text class="font-mono text-xs text-foreground" testID="context-text-body">
            {entry().part?.content || t("context_inspector_no_text")}
          </Text>
        </View>
      </Scroll>
      <If when={entry().part?.truncated}>
        <Text class="text-xs text-muted-foreground">{t("context_inspector_truncated")}</Text>
      </If>
    </View>
  );

  return (
    <Page
      title={t("context_inspector_title")}
      testID="context-page"
      leading={
        <View class="flex-1 flex-row items-center gap-2">
          <Button variant="plain" size="xs" iconOnly icon="PhArrowLeft" title={t("context_inspector_back")} onPress={back} testID="context-back" />
          <Text class="flex-1 text-lg font-semibold text-foreground line-clamp-1" role="header" testID="context-bar-title">
            {barTitle()}
          </Text>
        </View>
      }
    >
      <If when={loading() && !grid()}>
        <Spinner class="items-center py-6" />
      </If>
      <If when={!(loading() && !grid()) && error()}>
        <View role="alert" class="flex-row items-start gap-2 rounded-(--radius) border-l-2 border-danger bg-card px-3 py-2" testID="context-error">
          <Icon name="PhWarningCircle" size={16} color="danger" />
          <Text class="flex-1 text-sm text-foreground">{error()}</Text>
        </View>
      </If>
      <If when={!(loading() && !grid()) && !error() && snapshot() && !snapshot().available}>
        <Text class="text-sm text-muted-foreground" testID="context-empty">
          {t("context_inspector_empty")}
        </Text>
      </If>
      <If when={!(loading() && !grid()) && !error() && grid()}>
        <View class={isPhone() ? "gap-5" : "flex-row items-start gap-6"}>
          <If when={showOverview()}>{overview()}</If>
          <If
            when={selected()}
            else={
              <If when={!isPhone()}>
                <Text class="w-80 text-sm text-muted-foreground">{t("context_inspector_pick")}</Text>
              </If>
            }
          >
            {(group) => <If when={showItems()}>{items(group)}</If>}
          </If>
          <If when={item()}>{(entry) => <If when={showText()}>{text(entry)}</If>}</If>
        </View>
      </If>
    </Page>
  );
}
