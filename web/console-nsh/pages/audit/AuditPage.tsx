// Audit (the Vue console's AuditView): the guard's audit files and the task feed of the selected
// agent. The index at the left picks a file (current ones, then archives) or the tasks; the ledger
// lists a page of the file's events, newest first and grouped by run, or a page of tasks; the side
// pane shows the one opened with its raw JSON. Pages move by cursor; the first page refreshes every
// 15 seconds while the window shows it, and what arrives flashes.
import type { JSX } from "nsh";
import { batch, cleanup, computed, effect, List, Scroll, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import {
  TASK_STATUS_META,
  endpointState,
  formatShortTime,
  formatTime,
  runtimeApiFetchFirstForEndpoints,
  runtimeApiFetchForEndpoint,
  runtimeEndpointByRef,
  taskEndpointRefsForSelection,
  toBool,
} from "../../lib/core/context.js";
import { endpointChannelLabel } from "../../lib/core/endpoints.js";
import { endpointRoutePath } from "../../lib/core/endpoint-routes.js";
import { loadResource, resourceKey } from "../../lib/core/resources.js";
import { createArrivalTracker, createChangeTracker, createHighlightWindow } from "../../lib/core/arrivals.js";
import { isVisible } from "../../lib/platform";
import { navigate } from "../../lib/router";
import { isMobile } from "../../lib/shell";
import { RawJsonDialogContent } from "../../components/shared/RawJsonDialog";
import {
  auditEntries,
  filterAuditEntries,
  groupAuditEntries,
  sortAuditFiles,
  taskModelMeta,
  taskStatusBadge,
  taskTitle,
  type AuditEntry,
  type AuditFileItem,
  type AuditGroup,
  type RiskType,
} from "../../components/observe/audit-entries";
import { AuditBadge, hint, t } from "../../components/observe/parts";
import { Button, EmptyState, Icon, Page, ProgressBar, SidePane, Skeleton, StatusMark, TextField } from "../../components/ui";

const AUDIT_ITEMS_PER_PAGE = 50;
const TASKS_PAGE_SIZE = 20;
const REFRESH_MS = 15000;
const HIGHLIGHT_MS = 1800;

type Stream = "audit" | "tasks";
type PaneEntry = { kind: "audit"; key: string; item: AuditEntry } | { kind: "task"; key: string; item: any };
type LedgerRow = { type: "group"; key: string; group: AuditGroup } | { type: "event"; key: string; item: AuditEntry };

const RISK_TEXT: Record<RiskType, string> = {
  success: "text-ok",
  warning: "text-warn-dark",
  danger: "text-danger",
  default: "text-muted-foreground",
};

export function AuditPage() {
  const loading = signal(false);
  const err = signal("");
  const mobileLedgerVisible = signal(false);
  const selectedStream = signal<Stream>("audit");
  const pageValue = signal(1);
  const auditPageCursors = signal<string[]>([""]);
  const auditFiles = signal<unknown[]>([]);
  const selectedFile = signal("");
  const lines = signal<unknown[]>([]);
  const filterText = signal("");
  const updatedAt = signal("");
  const archivesOpen = signal(false);
  const meta = signal({ exists: null as boolean | null, has_next: false, next_cursor: "" });
  // The entry or task open in the side pane, with its raw JSON. A task's JSON is fetched when it
  // opens; an entry carries its own.
  const pane = signal<PaneEntry | null>(null);
  const paneJSON = signal("");
  const paneLoading = signal(false);
  const paneErr = signal("");
  let paneToken: object | null = null;
  let initEndpointRef = "";
  let initPromise: Promise<unknown> | null = null;
  let initToken: object | null = null;
  let chunkSequence = 0;
  let disposed = false;

  const fileItems = computed(() => sortAuditFiles(auditFiles()));
  const currentFiles = () => fileItems().filter((item) => !item.archived);
  const archivedFiles = () => fileItems().filter((item) => item.archived);
  const selectedFileItem = () => fileItems().find((item) => item.value === selectedFile()) || fileItems()[0] || null;
  const isTasks = () => selectedStream() === "tasks";
  const selectedFileTitle = () => String(selectedFileItem()?.title || "").trim() || t("audit_title");
  const showIndexPane = () => !isMobile() || !mobileLedgerVisible();
  const showLedgerPane = () => !isMobile() || mobileLedgerVisible();
  const mobileShowBack = () => isMobile() && mobileLedgerVisible();
  const currentEndpointRef = () => String(endpointState.selectedRef || "").trim();
  const taskFeedEndpointRef = computed(() => {
    const selected: any = runtimeEndpointByRef(endpointState.selectedRef);
    if (!selected) return "";
    return String(selected.submit_endpoint_ref || "").trim() || String(selected.endpoint_ref || "").trim();
  });

  // Tasks.
  const taskPageIndex = signal(0);
  const taskPageCursors = signal<string[]>([""]);
  const taskNextCursor = signal("");
  const taskItems = signal<any[]>([]);
  const taskErr = signal("");
  const taskLoading = signal(false);
  const currentTaskCursor = computed(() => String(taskPageCursors()[taskPageIndex()] || "").trim());
  const taskStatusTitles = new Map<string, string>(TASK_STATUS_META.map((item: any) => [item.value, t(item.titleKey)]));
  const taskStatusLabel = (task: any) => {
    const value = String(task?.status || "").trim().toLowerCase();
    return taskStatusTitles.get(value) || String(task?.status || "").trim() || "-";
  };
  const taskSourceLabel = (task: any) => {
    const current = String(task?.source_label || "").trim();
    if (current) return current;
    const mode = String(task?.source_mode || "").trim();
    return mode ? endpointChannelLabel(mode, t) : t("tasks_runtime_fallback");
  };
  const taskRuntimeMeta = (task: any) =>
    String(task?.source_name || "").trim() || String(task?.source_endpoint_ref || "").trim() || taskSourceLabel(task);

  const auditItems = computed(() => auditEntries(lines()));
  const filteredItems = computed(() => filterAuditEntries(auditItems(), filterText()));
  const auditGroups = computed(() => groupAuditEntries(filteredItems()));
  const ledgerRows = computed<LedgerRow[]>(() => {
    const rows: LedgerRow[] = [];
    for (const group of auditGroups()) {
      rows.push({ type: "group", key: `g:${group.key}`, group });
      for (const item of group.items) rows.push({ type: "event", key: `e:${item.key}`, item });
    }
    return rows;
  });
  const groupHeaderIndices = () => ledgerRows().flatMap((row, index) => (row.type === "group" ? [index] : []));

  // Events and tasks that appear at the top on a refresh flash briefly, as do tasks whose status
  // changed; the first load, other files, pages and agents do not.
  const eventArrivals = createArrivalTracker({ edge: "start" });
  const taskArrivals = createArrivalTracker({ edge: "start" });
  const taskChanges = createChangeTracker();
  const arrivedRows = createHighlightWindow(HIGHLIGHT_MS);
  const arrivedTick = signal(0);
  const highlightTimers = new Set<ReturnType<typeof setTimeout>>();
  const markArrived = (keys: Set<string>) => {
    if (keys.size === 0) return;
    arrivedRows.add(keys);
    arrivedTick.update((n) => n + 1);
    const id = setTimeout(() => {
      highlightTimers.delete(id);
      if (!disposed) arrivedTick.update((n) => n + 1);
    }, HIGHLIGHT_MS + 50);
    highlightTimers.add(id);
  };
  const isArrived = (key: string) => arrivedTick() >= 0 && arrivedRows.has(key);
  effect(() => {
    const items = auditItems();
    untracked(() => {
      const scope = `${currentEndpointRef()}|${selectedFile()}|${pageValue()}`;
      markArrived(eventArrivals.update(items.map((item) => item.key), scope));
    });
  });
  effect(() => {
    const items = taskItems();
    untracked(() => {
      const scope = `${taskFeedEndpointRef()}|${currentTaskCursor()}`;
      const arrived = taskArrivals.update(items.map((item) => item.id), scope);
      const changed = taskChanges.update(items.map((item) => ({ id: item.id, signature: item.status })), scope);
      markArrived(new Set([...arrived, ...changed].map((id) => `task:${id}`)));
    });
  });

  // Another log, page or endpoint lists other entries: the pane closes with the one it showed.
  effect(() => {
    selectedStream();
    selectedFile();
    pageValue();
    taskPageIndex();
    void endpointState.selectedRef;
    untracked(closePane);
  });

  const isPaneEntry = (kind: PaneEntry["kind"], key: string) => pane()?.kind === kind && pane()?.key === key;

  function closePane() {
    paneToken = null;
    batch(() => {
      pane.set(null);
      paneLoading.set(false);
      paneErr.set("");
    });
  }

  function openEntry(item: AuditEntry) {
    if (untracked(() => isPaneEntry("audit", item.key))) {
      closePane();
      return;
    }
    paneToken = null;
    batch(() => {
      paneLoading.set(false);
      paneErr.set("");
      pane.set({ kind: "audit", key: item.key, item });
      paneJSON.set(String(item.rawPretty || item.raw || "").trim());
    });
  }

  async function openTask(item: any) {
    const id = String(item?.id || "").trim();
    if (!id) return;
    if (untracked(() => isPaneEntry("task", id))) {
      closePane();
      return;
    }
    const token = {};
    paneToken = token;
    batch(() => {
      pane.set({ kind: "task", key: id, item });
      paneJSON.set("");
      paneErr.set("");
      paneLoading.set(true);
    });
    try {
      const endpointRef = String(item?.source_endpoint_ref || "").trim();
      const path = `/tasks/${encodeURIComponent(id)}`;
      const data = endpointRef
        ? await runtimeApiFetchForEndpoint(endpointRef, path)
        : await runtimeApiFetchFirstForEndpoints(taskEndpointRefsForSelection(), path);
      if (paneToken !== token) return;
      paneJSON.set(JSON.stringify(data, null, 2));
    } catch (e: any) {
      if (paneToken !== token) return;
      paneErr.set(e?.message || t("msg_load_failed"));
    } finally {
      if (paneToken === token) paneLoading.set(false);
    }
  }

  /* ---------- tasks ---------- */

  let taskToken: object | null = null;

  async function loadTasks({ force = false } = {}) {
    const endpointRef = untracked(taskFeedEndpointRef);
    if (!endpointRef) return;
    const cursor = untracked(currentTaskCursor);
    const token = {};
    taskToken = token;
    taskLoading.set(true);
    try {
      const q = new URLSearchParams();
      q.set("limit", String(TASKS_PAGE_SIZE));
      if (cursor) q.set("cursor", cursor);
      const endpoint: any = runtimeEndpointByRef(endpointRef);
      const path = `/tasks?${q.toString()}`;
      const data: any = await loadResource(
        resourceKey("tasks", "list", endpointRef, cursor),
        () => runtimeApiFetchForEndpoint(endpointRef, path),
        { force },
      );
      if (taskToken !== token || disposed) return;
      const sourceLabel = endpointChannelLabel(endpoint?.mode, t);
      batch(() => {
        taskItems.set(
          (Array.isArray(data?.items) ? data.items : []).map((item: any) => ({
            ...item,
            source_label: sourceLabel,
            source_mode: endpoint?.mode || "",
            source_name: String(endpoint?.name || "").trim(),
            source_endpoint_ref: endpointRef,
          })),
        );
        taskNextCursor.set(String(data?.next_cursor || "").trim());
        taskErr.set("");
      });
    } catch (e: any) {
      if (taskToken !== token || disposed) return;
      taskErr.set(e?.message || t("msg_load_failed"));
    } finally {
      if (taskToken === token) taskLoading.set(false);
    }
  }

  // The feed's agent changed: back to its first page.
  let lastTaskFeed: string | null = null;
  effect(() => {
    const ref = taskFeedEndpointRef();
    untracked(() => {
      if (lastTaskFeed !== null && lastTaskFeed !== ref) {
        batch(() => {
          taskPageIndex.set(0);
          taskPageCursors.set([""]);
          taskNextCursor.set("");
          taskItems.set([]);
          taskErr.set("");
        });
      }
      lastTaskFeed = ref;
    });
  });
  // Another page (or the tasks shown again) loads it; the old page's rows go at once.
  let lastTaskCursor: string | null = null;
  effect(() => {
    const cursor = currentTaskCursor();
    const shown = isTasks();
    const ref = taskFeedEndpointRef();
    untracked(() => {
      if (lastTaskCursor !== null && lastTaskCursor !== cursor) {
        batch(() => {
          taskItems.set([]);
          taskNextCursor.set("");
          taskErr.set("");
        });
      }
      lastTaskCursor = cursor;
      if (!shown || !ref) {
        taskToken = null;
        taskLoading.set(false);
        return;
      }
      void loadTasks();
    });
  });

  function selectTaskStream() {
    batch(() => {
      selectedStream.set("tasks");
      if (untracked(isMobile)) mobileLedgerVisible.set(true);
    });
  }

  function prevTaskPage() {
    if (untracked(taskLoading) || untracked(taskPageIndex) <= 0) return;
    taskPageIndex.update((n) => n - 1);
  }

  function nextTaskPage() {
    const cursor = String(untracked(taskNextCursor) || "").trim();
    if (untracked(taskLoading) || !cursor) return;
    const next = untracked(taskPageIndex) + 1;
    batch(() => {
      taskPageCursors.update((list) => {
        const history = list.slice(0, next);
        history[next] = cursor;
        return history;
      });
      taskPageIndex.set(next);
    });
  }

  /* ---------- audit files and pages ---------- */

  const acceptsAuditLoad = (token: object | null) => !disposed && (!token || initToken === token);

  async function loadFiles(endpointRef: string, token: object | null) {
    const data: any = await loadResource(resourceKey("audit", "files", endpointRef), () =>
      runtimeApiFetchForEndpoint(endpointRef, "/audit/files"),
    );
    if (!acceptsAuditLoad(token)) return false;
    auditFiles.set(Array.isArray(data?.items) ? data.items : []);
    const items = untracked(fileItems);
    const preferred = typeof data?.default_file === "string" ? data.default_file.trim() : "";
    const current = untracked(selectedFile);
    if (items.length === 0) selectedFile.set(preferred);
    else if (items.find((it) => it.value === current)) {
      // The file shown stays.
    } else if (preferred && items.find((it) => it.value === preferred)) selectedFile.set(preferred);
    else selectedFile.set(items[0].value);
    return true;
  }

  async function loadChunk(cursor = "", endpointRef = untracked(currentEndpointRef), token: object | null = initToken) {
    const sequence = ++chunkSequence;
    const file = untracked(selectedFile);
    const isCurrent = () =>
      sequence === chunkSequence && acceptsAuditLoad(token) && endpointRef === untracked(currentEndpointRef) && file === untracked(selectedFile);
    batch(() => {
      loading.set(true);
      err.set("");
    });
    try {
      const q = new URLSearchParams();
      if (file) q.set("file", file);
      q.set("limit", String(AUDIT_ITEMS_PER_PAGE));
      const normalizedCursor = String(cursor || "").trim();
      if (normalizedCursor) q.set("cursor", normalizedCursor);
      const path = `/audit/logs?${q.toString()}`;
      const data: any = await loadResource(resourceKey("audit", "logs", endpointRef, path), () =>
        runtimeApiFetchForEndpoint(endpointRef, path),
      );
      if (!isCurrent()) return false;
      batch(() => {
        meta.set({
          exists: toBool(data?.exists, false),
          has_next: toBool(data?.has_next, false),
          next_cursor: String(data?.next_cursor || "").trim(),
        });
        const fetched = Array.isArray(data?.items) ? data.items : [];
        lines.set(fetched.slice(-AUDIT_ITEMS_PER_PAGE));
        updatedAt.set(formatShortTime(new Date().toISOString()));
      });
      return true;
    } catch (e: any) {
      if (isCurrent()) err.set(e?.message || t("msg_load_failed"));
      return false;
    } finally {
      if (sequence === chunkSequence && acceptsAuditLoad(token)) loading.set(false);
    }
  }

  function resetAuditPage() {
    chunkSequence += 1;
    batch(() => {
      lines.set([]);
      updatedAt.set("");
      filterText.set("");
      meta.set({ exists: null, has_next: false, next_cursor: "" });
      auditPageCursors.set([""]);
      pageValue.set(1);
    });
  }

  async function goPrev() {
    if (untracked(loading) || untracked(pageValue) <= 1) return;
    const target = untracked(pageValue) - 1;
    const cursor = untracked(auditPageCursors)[target - 1] || "";
    if (await loadChunk(cursor)) pageValue.set(target);
  }

  async function goNext() {
    const { has_next, next_cursor } = untracked(meta);
    const cursor = String(next_cursor || "").trim();
    if (untracked(loading) || !has_next || !cursor) return;
    if (await loadChunk(cursor)) {
      batch(() => {
        auditPageCursors.update((list) => [...list.slice(0, untracked(pageValue)), cursor]);
        pageValue.update((n) => n + 1);
      });
    }
  }

  async function onFileChange(item: AuditFileItem) {
    if (!item || typeof item.value !== "string") return;
    selectedStream.set("audit");
    if (item.value === untracked(selectedFile)) {
      if (untracked(isMobile)) mobileLedgerVisible.set(true);
      return;
    }
    selectedFile.set(item.value);
    initToken = {};
    resetAuditPage();
    if (untracked(isMobile)) mobileLedgerVisible.set(true);
    await loadChunk();
  }

  async function refreshAudit({ latest = false } = {}) {
    const endpointRef = untracked(currentEndpointRef);
    if (initPromise && initEndpointRef === endpointRef) return initPromise;
    initEndpointRef = endpointRef;
    const token = {};
    initToken = token;
    batch(() => {
      loading.set(true);
      err.set("");
    });
    const promise = (async () => {
      try {
        const previousFile = untracked(selectedFile);
        const loaded = await loadFiles(endpointRef, token);
        if (!loaded) return;
        if (previousFile !== untracked(selectedFile)) resetAuditPage();
        const cursor = latest ? "" : untracked(auditPageCursors)[untracked(pageValue) - 1] || "";
        if ((await loadChunk(cursor, endpointRef, token)) && latest) {
          batch(() => {
            auditPageCursors.set([""]);
            pageValue.set(1);
          });
        }
      } catch (e: any) {
        if (acceptsAuditLoad(token)) err.set(e?.message || t("msg_load_failed"));
      } finally {
        if (acceptsAuditLoad(token)) loading.set(false);
      }
    })();
    initPromise = promise;
    try {
      return await promise;
    } finally {
      if (initPromise === promise) initPromise = null;
    }
  }

  // The selected agent: everything of the one before goes, and its files load.
  effect(() => {
    const ref = String(endpointState.selectedRef || "").trim();
    untracked(() => {
      batch(() => {
        selectedFile.set("");
        auditFiles.set([]);
      });
      resetAuditPage();
      if (ref) void refreshAudit();
    });
  });

  const timer = setInterval(() => {
    if (disposed || !isVisible() || initPromise || untracked(loading) || untracked(taskLoading)) return;
    if (untracked(isTasks)) {
      if (untracked(taskPageIndex) === 0) void loadTasks({ force: true });
    } else if (untracked(pageValue) === 1) {
      if (!untracked(fileItems).length) void refreshAudit();
      else void loadChunk("", untracked(currentEndpointRef), initToken);
    }
  }, REFRESH_MS);
  cleanup(() => {
    disposed = true;
    clearInterval(timer);
    highlightTimers.forEach((id) => clearTimeout(id));
    initToken = {};
    paneToken = null;
    taskToken = null;
  });

  const goChat = () => void navigate(endpointRoutePath(endpointState.selectedRef, "/chat"));

  const paneLabel = () => {
    const entry = pane();
    if (!entry) return "";
    if (entry.kind === "task") return taskTitle(entry.item);
    return entry.item.parsed ? entry.item.primaryTitle : t("audit_raw");
  };

  /* ---------- view ---------- */

  function IndexItem(props: { title: string; subtitle?: string; selected: boolean; hint?: string; onPress: () => void; testID?: string }) {
    return (
      <BaseButton
        selected={props.selected}
        onPress={() => props.onPress()}
        accessibilityLabel={props.title}
        tooltip={hint(props.hint)}
        testID={props.testID}
        class="flex-row items-center gap-2 rounded-(--radius) px-2.5 py-1.5 hover:bg-hover selected:bg-selection"
      >
        <View class="flex-1 gap-0.5">
          <Text class={`text-sm line-clamp-1 ${props.selected ? "font-medium text-foreground" : "text-subtle"}`}>{props.title}</Text>
          <If when={props.subtitle}>
            <Text class="text-xs text-muted-foreground line-clamp-1">{props.subtitle}</Text>
          </If>
        </View>
        <If when={props.selected}>
          <StatusMark state="on" />
        </If>
      </BaseButton>
    );
  }

  function EventBadges(props: { item: AuditEntry }) {
    return (
      <>
        <If
          when={props.item.approvalLabel !== "-"}
          else={
            <If when={props.item.decisionLabel !== "-"}>
              <AuditBadge badge={props.item.decisionBadge} label={props.item.decisionLabel} />
            </If>
          }
        >
          <AuditBadge badge={props.item.approvalBadge} label={props.item.approvalLabel} />
        </If>
        <If when={props.item.riskLabel !== "-"}>
          <Text class={`text-xs ${RISK_TEXT[props.item.riskType]}`}>
            {t("audit_risk")} · {props.item.riskLabel}
          </Text>
        </If>
      </>
    );
  }

  function ErrorNotice(props: { text: string }) {
    return (
      <View class="flex-row items-start gap-2 rounded-(--radius) border-l-2 border-danger bg-card px-3 py-2" role="alert">
        <Icon name="PhWarningCircle" size={16} color="danger" />
        <Text class="flex-1 text-sm text-foreground">{props.text}</Text>
      </View>
    );
  }

  function GroupHeader(props: { group: AuditGroup }) {
    return (
      <View class="flex-row items-center justify-between gap-3 border-b border-line-faint bg-background px-1 py-1.5">
        <View class="flex-1 flex-row items-center gap-2">
          <Text class="font-mono text-xs uppercase tracking-wide text-muted-foreground">{t("audit_run")}</Text>
          <Text class="flex-1 font-mono text-xs text-foreground line-clamp-1" tooltip={hint(props.group.title)}>
            {props.group.title}
          </Text>
        </View>
        <Text class="text-xs text-muted-foreground tabular-nums">{t("audit_page_count", { count: props.group.items.length })}</Text>
      </View>
    );
  }

  function EventRow(props: { item: AuditEntry }) {
    return (
      <BaseButton
        selected={isPaneEntry("audit", props.item.key)}
        onPress={() => openEntry(props.item)}
        accessibilityLabel={props.item.parsed ? props.item.primaryTitle : t("audit_raw")}
        class={`flex-row items-center gap-2 border-b border-line-faint px-1 py-2 hover:bg-hover selected:bg-selection ${
          isArrived(props.item.key) ? "bg-selection" : ""
        }`}
        style={{ transitionProperty: "colors", transitionDuration: 600 }}
      >
        <View class="flex-1 gap-1">
          <View class="flex-row flex-wrap items-center gap-2">
            <Text class="text-sm font-semibold text-foreground">{props.item.parsed ? props.item.primaryTitle : t("audit_raw")}</Text>
            <If when={props.item.parsed}>
              <EventBadges item={props.item} />
            </If>
          </View>
          <If when={!props.item.parsed || props.item.summary !== "-"}>
            <Text class="text-sm text-subtle line-clamp-2">{props.item.parsed ? props.item.summary : props.item.raw}</Text>
          </If>
          <If when={props.item.hasReasons}>
            <Text class="text-xs text-warn-dark line-clamp-2">{props.item.reasonsText}</Text>
          </If>
          <If when={props.item.parsed}>
            <View class="flex-row flex-wrap items-center gap-x-3 gap-y-0.5">
              <If when={props.item.tsText !== "-"}>
                <Text class="text-xs text-muted-foreground tabular-nums" tooltip={hint(props.item.tsFull)}>
                  {props.item.tsText}
                </Text>
              </If>
              <If when={props.item.toolName !== "-" && props.item.actionType !== "-"}>
                <Text class="text-xs text-muted-foreground">{props.item.actionType}</Text>
              </If>
              <If when={props.item.stepText !== "-"}>
                <Text class="text-xs text-muted-foreground tabular-nums">
                  {t("audit_step")} {props.item.stepText}
                </Text>
              </If>
            </View>
          </If>
        </View>
        <Icon name="PhCaretRight" size={14} color="muted-foreground" />
      </BaseButton>
    );
  }

  function AuditLedger() {
    return (
      <View class="flex-1 gap-2">
        <If when={err()}>
          <ErrorNotice text={err()} />
        </If>
        <If when={updatedAt()}>
          <View class="flex-row flex-wrap justify-between gap-2">
            <Text class="text-xs text-muted-foreground tabular-nums">
              {filterText()
                ? t("audit_filtered_count", { count: filteredItems().length, total: auditItems().length })
                : t("audit_page_count", { count: auditItems().length })}
            </Text>
            <Text class="text-xs text-muted-foreground tabular-nums">{t("audit_updated", { value: updatedAt() })}</Text>
          </View>
        </If>
        <If when={loading() && auditItems().length === 0}>
          <Skeleton rows={6} label={t("runtime_loading")} />
        </If>
        <If
          when={meta().exists}
          else={
            <If when={!loading() && !err()}>
              <EmptyState title={t("audit_missing_title")} text={t("audit_no_file")} icon="PhFileText" />
            </If>
          }
        >
          <If
            when={ledgerRows().length > 0}
            else={
              <If when={!loading() && !err()}>
                <EmptyState
                  title={filterText() ? t("audit_filter_empty") : t("audit_empty_title")}
                  text={filterText() ? t("audit_filter_empty_hint") : t("audit_empty")}
                  action={
                    <If when={filterText()}>
                      <Button variant="plain" size="sm" label={t("audit_clear_filter")} onPress={() => filterText.set("")} />
                    </If>
                  }
                />
              </If>
            }
          >
            <List
              each={ledgerRows()}
              keyExtractor={(row) => row.key}
              estimatedItemSize={72}
              stickyHeaderIndices={groupHeaderIndices()}
              class="flex-1"
              contentClass="pb-4"
              testID="audit-feed"
            >
              {(row) => (
                <If
                  when={row().type === "group"}
                  else={<EventRow item={(row() as Extract<LedgerRow, { type: "event" }>).item} />}
                >
                  <GroupHeader group={(row() as Extract<LedgerRow, { type: "group" }>).group} />
                </If>
              )}
            </List>
          </If>
        </If>
      </View>
    );
  }

  function TaskLedger() {
    return (
      <View class="flex-1 gap-2">
        <If when={taskErr()}>
          <ErrorNotice text={taskErr()} />
        </If>
        <Scroll class="flex-1" contentClass="pb-4" testID="audit-task-feed">
          <Each of={taskItems()} key={(item) => String(item.id)}>
            {(item) => (
              <BaseButton
                selected={isPaneEntry("task", String(item().id))}
                onPress={() => void openTask(item())}
                accessibilityLabel={taskTitle(item())}
                class={`flex-row items-center gap-2 border-b border-line-faint px-1 py-2 hover:bg-hover selected:bg-selection ${
                  isArrived(`task:${item().id}`) ? "bg-selection" : ""
                }`}
              >
                <View class="flex-1 gap-1">
                  <Text class="text-sm font-semibold text-foreground line-clamp-2">{taskTitle(item())}</Text>
                  <View class="flex-row flex-wrap items-center gap-x-3 gap-y-0.5">
                    <AuditBadge badge={taskStatusBadge(item())} label={taskStatusLabel(item())} />
                    <Text class="text-xs text-muted-foreground">{taskSourceLabel(item())}</Text>
                    <Text class="text-xs text-muted-foreground tabular-nums" tooltip={hint(formatTime(item().created_at))}>
                      {formatShortTime(item().created_at)}
                    </Text>
                  </View>
                </View>
                <Icon name="PhCaretRight" size={14} color="muted-foreground" />
              </BaseButton>
            )}
          </Each>
          <If when={taskItems().length === 0 && !taskLoading() && !taskErr()}>
            <EmptyState
              title={t("tasks_empty_title")}
              text={t("tasks_empty_hint")}
              action={<Button variant="plain" size="sm" label={t("tasks_empty_action")} onPress={goChat} />}
            />
          </If>
        </Scroll>
      </View>
    );
  }

  function DetailField(props: { label: string; value: string; mono?: boolean; wide?: boolean }) {
    return (
      <View class={`gap-0.5 ${props.wide ? "w-full" : "min-w-28 flex-1"}`}>
        <Text class="font-mono text-xs uppercase tracking-wide text-muted-foreground">{props.label}</Text>
        <View selectable>
          <Text class={`text-sm text-foreground ${props.mono ? "font-mono" : ""}`}>{props.value}</Text>
        </View>
      </View>
    );
  }

  function DetailSection(props: { title: string; children?: JSX.Element }) {
    return (
      <View class="gap-1.5">
        <Text class="text-xs font-semibold uppercase tracking-wide text-subtle">{props.title}</Text>
        {props.children}
      </View>
    );
  }

  function PaneHeader(props: { title: string; meta?: string }) {
    return (
      <View class="flex-row items-start gap-2 border-b border-line-faint px-4 py-3">
        <View class="flex-1 gap-0.5">
          <Text class="text-base font-semibold text-foreground line-clamp-2" role="header">
            {props.title}
          </Text>
          <If when={props.meta}>
            <Text class="text-xs text-muted-foreground tabular-nums">{props.meta}</Text>
          </If>
        </View>
        <Button variant="plain" size="xs" iconOnly icon="PhX" title={t("action_close")} onPress={closePane} testID="audit-pane-close" />
      </View>
    );
  }

  function AuditPane(props: { item: AuditEntry }) {
    return (
      <View class="flex-1" testID="audit-pane">
        <PaneHeader
          title={props.item.parsed ? props.item.primaryTitle : t("audit_raw")}
          meta={props.item.parsed && props.item.tsText !== "-" ? props.item.tsFull || props.item.tsText : ""}
        />
        <Scroll class="flex-1" contentClass="gap-4 p-4">
          <If when={props.item.parsed}>
            <If when={props.item.approvalLabel !== "-" || props.item.decisionLabel !== "-" || props.item.riskLabel !== "-"}>
              <View class="flex-row flex-wrap items-center gap-2">
                <EventBadges item={props.item} />
              </View>
            </If>
            <View class="flex-row flex-wrap gap-x-4 gap-y-3">
              <If when={props.item.eventID !== "-"}>
                <DetailField label={t("audit_event_id")} value={props.item.eventID} mono wide />
              </If>
              <If when={props.item.runID !== "-"}>
                <DetailField label={t("audit_run")} value={props.item.runID} mono wide />
              </If>
              <DetailField label={t("audit_decision")} value={props.item.decisionLabel} />
              <DetailField label={t("audit_risk")} value={props.item.riskLabel} />
              <If when={props.item.approvalLabel !== "-"}>
                <DetailField label={t("audit_approval")} value={props.item.approvalLabel} />
              </If>
              <If when={props.item.actor !== "-"}>
                <DetailField label={t("audit_actor")} value={props.item.actor} />
              </If>
              <If when={props.item.toolName !== "-" && props.item.actionType !== "-"}>
                <DetailField label={t("audit_action")} value={props.item.actionType} />
              </If>
              <If when={props.item.stepText !== "-"}>
                <DetailField label={t("audit_step")} value={props.item.stepText} />
              </If>
              <If when={props.item.approvalRequestID !== "-"}>
                <DetailField label={t("audit_approval_request")} value={props.item.approvalRequestID} mono wide />
              </If>
            </View>
            <If when={props.item.summary !== "-"}>
              <DetailSection title={t("audit_summary")}>
                <View selectable>
                  <Text class="text-sm text-foreground">{props.item.summary}</Text>
                </View>
              </DetailSection>
            </If>
            <If when={props.item.reasonsText !== "-"}>
              <DetailSection title={t("audit_reasons")}>
                <Text class="text-sm text-foreground">{props.item.reasonsText}</Text>
              </DetailSection>
            </If>
          </If>
          <If when={paneJSON()}>
            <DetailSection title={t("audit_raw")}>
              <RawJsonDialogContent json={paneJSON()} testID="audit-pane-json" />
            </DetailSection>
          </If>
        </Scroll>
      </View>
    );
  }

  function TaskPane(props: { item: any }) {
    return (
      <View class="flex-1" testID="audit-pane">
        <PaneHeader title={taskTitle(props.item)} meta={formatTime(props.item.created_at)} />
        <Scroll class="flex-1" contentClass="gap-4 p-4">
          <View class="flex-row flex-wrap items-center gap-2">
            <AuditBadge badge={taskStatusBadge(props.item)} label={taskStatusLabel(props.item)} />
            <Text class="text-xs text-muted-foreground">{taskSourceLabel(props.item)}</Text>
          </View>
          <View selectable>
            <Text class="text-sm text-foreground">{String(props.item.task ?? "")}</Text>
          </View>
          <View class="flex-row flex-wrap gap-x-4 gap-y-3">
            <DetailField label={t("tasks_task_id_label")} value={String(props.item.id ?? "")} mono wide />
            <DetailField label={t("stats_model")} value={taskModelMeta(props.item)} />
            <DetailField label={t("tasks_runtime_label")} value={taskRuntimeMeta(props.item)} />
          </View>
          <DetailSection title={t("audit_raw")}>
            <If when={!paneLoading()} else={<Skeleton rows={4} label={t("runtime_loading")} />}>
              <If when={!paneErr()} else={<ErrorNotice text={paneErr()} />}>
                <If when={paneJSON()}>
                  <RawJsonDialogContent json={paneJSON()} testID="audit-pane-json" />
                </If>
              </If>
            </If>
          </DetailSection>
        </Scroll>
      </View>
    );
  }

  return (
    <Page title={t("audit_title")} hideBar scroll={false} testID="audit-page">
      <View class="flex-1 flex-row">
        <If when={showIndexPane()}>
          <View
            class={`${isMobile() ? "flex-1" : "w-60 border-r border-line-faint"} bg-sidebar`}
            accessibilityLabel={t("audit_title")}
            testID="audit-index"
          >
            <View class="border-b border-line-faint px-4 py-3">
              <Text class="font-mono text-xs uppercase tracking-wide text-muted-foreground" role="header">
                {t("audit_title")}
              </Text>
            </View>
            <Scroll class="flex-1" contentClass="gap-1 p-2">
              <If when={loading() && fileItems().length === 0}>
                <ProgressBar indeterminate label={t("runtime_loading")} />
              </If>
              <If when={err() && isMobile() && !showLedgerPane()}>
                <ErrorNotice text={err()} />
              </If>
              <Each of={currentFiles()} key={(item) => item.key}>
                {(item) => (
                  <IndexItem
                    title={item().title}
                    selected={selectedStream() === "audit" && item().value === selectedFile()}
                    onPress={() => void onFileChange(item())}
                    testID={`audit-file-${item().name}`}
                  />
                )}
              </Each>
              <If when={!loading() && !err() && fileItems().length === 0}>
                <Text class="px-2.5 py-1.5 text-xs text-muted-foreground">{t("audit_no_file")}</Text>
              </If>
              <If when={archivedFiles().length > 0}>
                <BaseButton
                  onPress={() => archivesOpen.update((open) => !open)}
                  accessibilityLabel={t("audit_archives")}
                  selected={archivesOpen()}
                  testID="audit-archives"
                  class="mt-2 flex-row items-center gap-1.5 rounded-(--radius) px-2 py-1 hover:bg-hover"
                >
                  <View style={{ transform: [{ rotate: archivesOpen() ? 90 : 0 }], transitionProperty: "transform", transitionDuration: 150 }}>
                    <Icon name="PhCaretRight" size={12} color="muted-foreground" />
                  </View>
                  <Text class="flex-1 font-mono text-xs uppercase tracking-wide text-muted-foreground">{t("audit_archives")}</Text>
                  <Text class="text-xs text-muted-foreground tabular-nums">{String(archivedFiles().length)}</Text>
                </BaseButton>
                <If when={archivesOpen()}>
                  <Each of={archivedFiles()} key={(item) => item.key}>
                    {(item) => (
                      <IndexItem
                        title={item().title}
                        subtitle={item().subtitle}
                        hint={item().name}
                        selected={selectedStream() === "audit" && item().value === selectedFile()}
                        onPress={() => void onFileChange(item())}
                        testID={`audit-file-${item().name}`}
                      />
                    )}
                  </Each>
                </If>
              </If>
              <View class="my-2 h-px bg-line-faint" />
              <IndexItem title={t("tasks_title")} selected={isTasks()} onPress={selectTaskStream} testID="audit-tasks" />
            </Scroll>
          </View>
        </If>

        <If when={showLedgerPane()}>
          <View class="flex-1 gap-3 p-4" testID="audit-ledger">
            <View class="flex-row items-center gap-2">
              <If when={mobileShowBack()}>
                <Button variant="plain" size="xs" iconOnly icon="PhArrowLeft" title={t("audit_title")} onPress={() => mobileLedgerVisible.set(false)} />
              </If>
              <View class="flex-1 gap-0.5">
                <Text class="text-lg font-semibold text-foreground line-clamp-1" role="header">
                  {isTasks() ? t("tasks_title") : selectedFileTitle()}
                </Text>
                <If when={!isTasks() && selectedFileItem()?.subtitle}>
                  <Text class="text-xs text-muted-foreground">{selectedFileItem()?.subtitle}</Text>
                </If>
              </View>
              <If when={!isTasks() && pageValue() > 1}>
                <Button
                  variant="plain"
                  size="xs"
                  label={t("audit_latest")}
                  disabled={loading()}
                  onPress={() => void refreshAudit({ latest: true })}
                  testID="audit-latest"
                />
              </If>
            </View>
            <View class="flex-row flex-wrap items-center justify-between gap-2">
              <If
                when={!isTasks()}
                else={<Text class="text-xs text-muted-foreground tabular-nums">{t("audit_page_count", { count: taskItems().length })}</Text>}
              >
                <View class="min-w-48 flex-1 flex-row items-center gap-2">
                  <TextField
                    value={filterText()}
                    onChange={(value) => filterText.set(value)}
                    placeholder={t("audit_filter_placeholder")}
                    accessibilityLabel={t("audit_filter_placeholder")}
                    leadingIcon="PhMagnifyingGlass"
                    class="max-w-md flex-1"
                    testID="audit-filter"
                  />
                  <Text class="text-xs text-muted-foreground">{t("audit_filter_scope")}</Text>
                </View>
              </If>
              <View class="flex-row items-center gap-1" accessibilityLabel={t("audit_pagination")}>
                <Button
                  variant="plain"
                  size="sm"
                  iconOnly
                  icon="PhArrowLeft"
                  title={t("audit_newer")}
                  disabled={isTasks() ? taskLoading() || taskPageIndex() <= 0 : loading() || pageValue() <= 1}
                  onPress={() => (untracked(isTasks) ? prevTaskPage() : void goPrev())}
                  testID="audit-newer"
                />
                <Text class="text-xs text-muted-foreground tabular-nums">
                  {t("audit_page_number", { page: isTasks() ? taskPageIndex() + 1 : pageValue() })}
                </Text>
                <Button
                  variant="plain"
                  size="sm"
                  iconOnly
                  icon="PhArrowRight"
                  title={t("audit_older")}
                  disabled={isTasks() ? taskLoading() || !taskNextCursor() : loading() || !meta().has_next || !meta().next_cursor}
                  onPress={() => (untracked(isTasks) ? nextTaskPage() : void goNext())}
                  testID="audit-older"
                />
              </View>
            </View>
            <If when={isTasks() ? taskLoading() : loading()}>
              <ProgressBar indeterminate label={t("runtime_loading")} />
            </If>
            <If when={!isTasks()} else={<TaskLedger />}>
              <AuditLedger />
            </If>
          </View>
        </If>

        <SidePane open={pane() !== null} onClose={closePane} sheet={isMobile()} label={paneLabel()}>
          <If when={pane()}>
            {(entry) => (
              <If when={entry().kind === "audit"} else={<TaskPane item={entry().item} />}>
                <AuditPane item={entry().item as AuditEntry} />
              </If>
            )}
          </If>
        </SidePane>
      </View>
    </Page>
  );
}
