import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import "./AuditView.css";

import AppPage from "../components/AppPage";
import RawJsonDialog from "../components/RawJsonDialog";
import { openRawJsonDesktopWindow } from "../core/desktop-windows";
import { endpointChannelLabel } from "../core/endpoints";
import { endpointRoutePath } from "../core/endpoint-routes";
import { loadResource, resourceKey, useResource } from "../core/resources";
import {
  TASK_STATUS_META,
  endpointState,
  formatShortTime,
  formatTime,
  runtimeApiFetchFirstForEndpoints,
  runtimeApiFetchForEndpoint,
  runtimeEndpointByRef,
  safeJSON,
  taskEndpointRefsForSelection,
  toBool,
  translate,
} from "../core/context";

const AUDIT_ITEMS_PER_PAGE = 50;
const TASKS_PAGE_SIZE = 20;
const AUDIT_STREAM_VALUE = "audit";
const TASKS_STREAM_VALUE = "tasks";

function normalizeAuditText(value, fallback = "-") {
  if (typeof value === "string") {
    const s = value.trim();
    return s === "" ? fallback : s;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return fallback;
}

function normalizeAuditList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((it) => {
      if (typeof it === "string") {
        return it.trim();
      }
      if (it === null || it === undefined) {
        return "";
      }
      return String(it).trim();
    })
    .filter((it) => it !== "");
}

function humanizeAuditToken(raw) {
  const text = normalizeAuditText(raw, "");
  if (!text) {
    return "-";
  }
  return text.replaceAll("_", " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

// Badge weight follows attention, not colour alone: routine states are quiet outlined grey,
// notable ones are outlined in their colour, and only states that need action are filled.
function auditBadge(level, type = "default") {
  if (level === "alert") {
    return { type, variant: "filled" };
  }
  if (level === "notable") {
    return { type, variant: "outlined" };
  }
  return { type: "default", variant: "outlined" };
}

function decisionBadge(raw) {
  switch (String(raw || "").trim().toLowerCase()) {
    case "allow_with_redaction":
      return auditBadge("notable", "warning");
    case "require_approval":
      return auditBadge("alert", "warning");
    case "deny":
      return auditBadge("alert", "danger");
    default:
      return auditBadge("quiet");
  }
}

function approvalBadge(status) {
  switch (status) {
    case "pending":
      return auditBadge("alert", "warning");
    case "denied":
      return auditBadge("alert", "danger");
    default:
      return auditBadge("quiet");
  }
}

function riskBadgeType(raw) {
  switch (String(raw || "").trim().toLowerCase()) {
    case "low":
      return "success";
    case "medium":
      return "warning";
    case "high":
      return "danger";
    case "critical":
      return "danger";
    default:
      return "default";
  }
}

function decisionLabel(t, raw) {
  switch (String(raw || "").trim().toLowerCase()) {
    case "allow":
      return t("audit_decision_allow");
    case "allow_with_redaction":
      return t("audit_decision_redact");
    case "require_approval":
      return t("audit_decision_require_approval");
    case "deny":
      return t("audit_decision_deny");
    default:
      return humanizeAuditToken(raw);
  }
}

function riskLabel(t, raw) {
  switch (String(raw || "").trim().toLowerCase()) {
    case "low":
      return t("audit_risk_low");
    case "medium":
      return t("audit_risk_medium");
    case "high":
      return t("audit_risk_high");
    case "critical":
      return t("audit_risk_critical");
    default:
      return humanizeAuditToken(raw);
  }
}

function auditReasonLabel(t, raw) {
  const text = String(raw || "").trim().toLowerCase();
  switch (text) {
    case "bash_requires_approval":
      return t("audit_reason_bash_requires_approval");
    case "url_fetch_not_allowlisted":
      return t("audit_reason_url_fetch_not_allowlisted");
    case "invalid_url":
      return t("audit_reason_invalid_url");
    case "private_ip":
      return t("audit_reason_private_ip");
    case "non_allowlisted_domain":
      return t("audit_reason_non_allowlisted_domain");
    case "sensitive_content_redacted":
      return t("audit_reason_sensitive_content_redacted");
    case "redacted_private_key_block":
      return t("audit_reason_redacted_private_key_block");
    case "redacted_jwt":
      return t("audit_reason_redacted_jwt");
    case "redacted_bearer_token":
      return t("audit_reason_redacted_bearer_token");
    case "redacted_mister_morph_env":
      return t("audit_reason_redacted_mister_morph_env");
    case "redacted_secret_value":
      return t("audit_reason_redacted_secret_value");
    case "redacted_custom_pattern":
      return t("audit_reason_redacted_custom_pattern");
    default:
      if (text.startsWith("redacted_custom_pattern_")) {
        return t("audit_reason_redacted_custom_pattern_named", {
          name: humanizeAuditToken(text.slice("redacted_custom_pattern_".length)),
        });
      }
      return humanizeAuditToken(raw);
  }
}

function isOutputPublishSummaryPlaceholder(actionTypeRaw, summary) {
  return (
    String(actionTypeRaw || "").trim().toLowerCase() === "outputpublish" &&
    String(summary || "").trim() === "OutputPublish content=[redacted_summary]"
  );
}

function isBodyOmittedFromAudit(parsed, actionTypeRaw, summary) {
  return (
    toBool(parsed?.body_omitted_from_audit, false) ||
    isOutputPublishSummaryPlaceholder(actionTypeRaw, summary)
  );
}

function auditFamilyTitle(t, name) {
  const value = String(name || "").trim();
  if (!value) {
    return t("audit_stream_other");
  }
  if (value.startsWith("guard_audit.allow_with_redaction.jsonl")) {
    return t("audit_stream_allow_with_redaction");
  }
  if (value.startsWith("guard_audit.require_approval.jsonl")) {
    return t("audit_stream_require_approval");
  }
  if (value.startsWith("guard_audit.deny.jsonl")) {
    return t("audit_stream_deny");
  }
  if (value.startsWith("guard_audit.jsonl")) {
    return t("audit_stream_all");
  }
  return t("audit_stream_other");
}

function auditFamilyOrder(name) {
  const value = String(name || "").trim();
  if (value.startsWith("guard_audit.jsonl")) {
    return 0;
  }
  if (value.startsWith("guard_audit.require_approval.jsonl")) {
    return 1;
  }
  if (value.startsWith("guard_audit.allow_with_redaction.jsonl")) {
    return 2;
  }
  if (value.startsWith("guard_audit.deny.jsonl")) {
    return 3;
  }
  return 4;
}

function toAuditFileItem(t, item) {
  const name = String(item?.name || "").trim();
  const suffix = name.match(/\.jsonl\.(.+)$/)?.[1] || "";
  const timestamp = suffix.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  const archivedAt = timestamp
    ? formatShortTime(`${timestamp[1]}-${timestamp[2]}-${timestamp[3]}T${timestamp[4]}:${timestamp[5]}:${timestamp[6]}Z`)
    : suffix;
  return {
    key: name,
    value: name,
    name,
    title: auditFamilyOrder(name) === 4 ? name : auditFamilyTitle(t, name),
    archived: Boolean(suffix),
    subtitle: archivedAt ? t("audit_archived_at", { value: archivedAt }) : "",
  };
}

function taskTextPreview(task) {
  const text = String(task?.task || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  if (text.length <= 180) {
    return text;
  }
  return `${text.slice(0, 177)}...`;
}

function normalizeTaskStatus(raw) {
  return String(raw || "").trim().toLowerCase();
}

function shortenTaskID(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    return "-";
  }
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

const AuditView = {
  components: {
    AppPage,
    RawJsonDialog,
  },
  setup() {
    const t = translate;
    const router = useRouter();
    const loading = ref(false);
    const err = ref("");
    const isMobile = ref(false);
    const mobileLedgerVisible = ref(false);
    const selectedStream = ref(AUDIT_STREAM_VALUE);
    const pageValue = ref(1);
    const auditPageCursors = ref([""]);
    const auditFiles = ref([]);
    const fileItems = computed(() => auditFiles.value
      .map((item) => toAuditFileItem(t, item))
      .filter((item) => item.value !== "")
      .sort((left, right) => Number(left.archived) - Number(right.archived) ||
        auditFamilyOrder(left.name) - auditFamilyOrder(right.name) || right.name.localeCompare(left.name)));
    const selectedFile = ref("");
    const lines = ref([]);
    const filterText = ref("");
    const updatedAt = ref("");
    const rawDialogOpen = ref(false);
    const rawDialogJSON = ref("");
    let initEndpointRef = "";
    let initPromise = null;
    let initToken = null;
    let refreshTimer = null;
    let chunkSequence = 0;
    const meta = reactive({
      exists: null,
      has_next: false,
      next_cursor: "",
    });

    const selectedFileItem = computed(
      () => fileItems.value.find((item) => item.value === selectedFile.value) || fileItems.value[0] || null
    );
    const isTasksStreamSelected = computed(() => selectedStream.value === TASKS_STREAM_VALUE);
    const pageText = computed(() => {
      return `${pageValue.value}`;
    });
    const selectedFileTitle = computed(() => String(selectedFileItem.value?.title || "").trim() || t("audit_title"));
    const showIndexPane = computed(() => !isMobile.value || !mobileLedgerVisible.value);
    const showLedgerPane = computed(() => !isMobile.value || mobileLedgerVisible.value);
    const mobileShowBack = computed(() => isMobile.value && mobileLedgerVisible.value);
    const pageClass = computed(() => (isMobile.value ? "audit-page audit-page-mobile-split" : "audit-page"));
    const selectedEndpoint = computed(() => runtimeEndpointByRef(endpointState.selectedRef));
    const taskFeedEndpointRef = computed(() => {
      const selected = selectedEndpoint.value;
      if (!selected) {
        return "";
      }
      const mapped = String(selected.submit_endpoint_ref || "").trim();
      if (mapped) {
        return mapped;
      }
      return String(selected.endpoint_ref || "").trim();
    });
    const taskPageIndex = ref(0);
    const taskPageCursors = ref([""]);
    const taskNextCursor = ref("");
    const taskItems = ref([]);
    const taskErr = ref("");
    const tasksPageText = computed(() => `${taskPageIndex.value + 1}`);
    const currentTaskCursor = computed(() => String(taskPageCursors.value[taskPageIndex.value] || "").trim());
    const taskStatusTitleMap = computed(() => {
      const map = new Map();
      for (const item of TASK_STATUS_META) {
        map.set(item.value, t(item.titleKey));
      }
      return map;
    });
    function refreshMobileMode() {
      isMobile.value = typeof window !== "undefined" && window.innerWidth <= 920;
    }

    function showIndexView() {
      mobileLedgerVisible.value = false;
    }

    function isSelectedFileItem(item) {
      return (
        selectedStream.value === AUDIT_STREAM_VALUE &&
        String(item?.value || "") === selectedFile.value
      );
    }

    function auditFileClass(item) {
      const classes = ["audit-index-item", "workspace-sidebar-item"];
      if (isSelectedFileItem(item)) {
        classes.push("is-active");
      }
      return classes.join(" ");
    }

    function taskStreamClass() {
      const classes = ["audit-index-item", "workspace-sidebar-item"];
      if (isTasksStreamSelected.value) {
        classes.push("is-active");
      }
      return classes.join(" ");
    }

    function parseAuditLine(line) {
      const raw = typeof line === "string" ? line : String(line ?? "");
      const parsed = safeJSON(raw, null);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
          key: raw,
          parsed: false,
          raw,
          rawPretty: raw,
        };
      }

      const eventID = normalizeAuditText(parsed.event_id);
      const tsRaw = normalizeAuditText(parsed.ts);
      const stepText = Number(parsed.step) < 0 ? "-" : normalizeAuditText(parsed.step);
      const actionTypeRaw = normalizeAuditText(parsed.action_type);
      const actionLabels = {
        ToolCallPre: "audit_action_tool_pre", ToolCallPost: "audit_action_tool_post",
        OutputPublish: "audit_action_output", SkillInstall: "audit_action_skill",
      };
      const actionType = actionLabels[actionTypeRaw] ? t(actionLabels[actionTypeRaw]) : humanizeAuditToken(actionTypeRaw);
      const toolName = normalizeAuditText(parsed.tool_name);
      const runID = normalizeAuditText(parsed.run_id);
      const actor = normalizeAuditText(parsed.actor);
      const approvalStatus = normalizeAuditText(parsed.approval_status);
      const summaryRaw = normalizeAuditText(parsed.action_summary_redacted);
      const reasons = normalizeAuditList(parsed.reasons);
      const decisionRaw = normalizeAuditText(parsed.decision, "");
      const riskRaw = normalizeAuditText(parsed.risk_level, "");
      const bodyOmittedFromAudit = isBodyOmittedFromAudit(parsed, actionTypeRaw, summaryRaw);
      const summary = isOutputPublishSummaryPlaceholder(actionTypeRaw, summaryRaw)
        ? t("audit_output_publish_summary") : summaryRaw;
      let reasonsText = reasons.length > 0 ? reasons.map((reason) => auditReasonLabel(t, reason)).join(" | ") : "-";
      if (bodyOmittedFromAudit && reasonsText === "-") {
        reasonsText = t("audit_output_publish_reason");
      }
      const hasTool = toolName !== "-";
      const primaryTitle = hasTool ? toolName : actionType;
      const approval = approvalStatus.toLowerCase();
      const knownApproval = ["pending", "approved", "denied", "expired"].includes(approval);

      return {
        key: raw,
        parsed: true,
        raw,
        rawPretty: JSON.stringify(parsed, null, 2),
        eventID,
        tsRaw,
        tsText: tsRaw === "-" ? "-" : formatShortTime(tsRaw),
        tsFull: tsRaw === "-" ? "" : formatTime(tsRaw),
        actionType,
        toolName,
        runID,
        stepText,
        actor,
        approvalLabel: knownApproval ? t(`audit_approval_${approval}`) : humanizeAuditToken(approvalStatus),
        approvalBadge: approvalBadge(approval),
        approvalRequestID: normalizeAuditText(parsed.approval_request_id),
        summary,
        reasonsText,
        hasReasons: reasons.length > 0,
        primaryTitle,
        decisionLabel: decisionLabel(t, decisionRaw),
        decisionBadge: decisionBadge(decisionRaw),
        riskLabel: riskLabel(t, riskRaw),
        riskType: riskBadgeType(riskRaw),
      };
    }

    const auditItems = computed(() => {
      const occurrences = new Map();
      return lines.value.map((line) => {
        const item = parseAuditLine(line);
        const count = occurrences.get(item.key) || 0;
        occurrences.set(item.key, count + 1);
        item.key = `${item.key}:${count}`;
        return item;
      }).reverse();
    });
    const filteredAuditItems = computed(() => {
      const query = filterText.value.trim().toLowerCase();
      if (!query) return auditItems.value;
      return auditItems.value.filter((item) => [
        item.raw, item.summary, item.reasonsText, item.decisionLabel, item.riskLabel, item.approvalLabel,
      ].join(" ").toLowerCase().includes(query));
    });
    const auditGroups = computed(() => {
      const groups = [];
      const byRunID = new Map();
      for (const item of filteredAuditItems.value) {
        const runID = item.parsed ? item.runID : "-";
        const groupKey = `run:${runID}`;
        let group = byRunID.get(groupKey);
        if (!group) {
          group = {
            key: groupKey,
            runID,
            title: runID === "-" ? t("audit_run_unknown") : runID,
            items: [],
          };
          byRunID.set(groupKey, group);
          groups.push(group);
        }
        group.items.push(item);
      }
      return groups;
    });

    async function openRawDialog(item) {
      if (!item) {
        return;
      }
      const json = String(item.rawPretty || item.raw || "").trim();
      if (await openRawJsonDesktopWindow({ title: "RAW JSON", json }).catch(() => false)) {
        return;
      }
      rawDialogJSON.value = json;
      rawDialogOpen.value = true;
    }

    function closeRawDialog() {
      rawDialogOpen.value = false;
    }

    function currentEndpointRef() {
      return String(endpointState.selectedRef || "").trim();
    }

    function acceptsAuditLoad(token) {
      return !token || initToken === token;
    }

    function resetTaskPagination() {
      taskPageIndex.value = 0;
      taskPageCursors.value = [""];
      taskNextCursor.value = "";
    }

    watch(
      () => taskFeedEndpointRef.value,
      () => {
        resetTaskPagination();
        taskItems.value = [];
        taskErr.value = "";
      },
      { flush: "sync" }
    );

    watch(currentTaskCursor, () => {
      taskItems.value = [];
      taskNextCursor.value = "";
      taskErr.value = "";
    }, { flush: "sync" });

    const taskListResource = useResource({
      key: computed(() => resourceKey("tasks", "list", taskFeedEndpointRef.value, currentTaskCursor.value)),
      enabled: computed(() => isTasksStreamSelected.value && Boolean(taskFeedEndpointRef.value)),
      initialData: null,
      load: async () => {
        const endpointRef = String(taskFeedEndpointRef.value || "").trim();
        const cursor = currentTaskCursor.value;
        const q = new URLSearchParams();
        q.set("limit", String(TASKS_PAGE_SIZE));
        if (cursor) {
          q.set("cursor", cursor);
        }
        const endpoint = runtimeEndpointByRef(endpointRef);
        const data = await runtimeApiFetchForEndpoint(endpointRef, `/tasks?${q.toString()}`);
        return {
          endpoint,
          endpointRef,
          items: Array.isArray(data?.items) ? data.items : [],
          nextCursor: String(data?.next_cursor || "").trim(),
        };
      },
    });
    const taskLoading = taskListResource.loading;

    watch(
      () => taskListResource.data.value,
      (payload) => {
        if (!payload) {
          if (!taskFeedEndpointRef.value) {
            taskItems.value = [];
            taskNextCursor.value = "";
          }
          return;
        }
        const endpoint = payload.endpoint;
        const endpointRef = String(payload.endpointRef || "").trim();
        const sourceLabel = endpointChannelLabel(endpoint?.mode, t);
        taskItems.value = payload.items.map((item) => ({
          ...item,
          source_label: sourceLabel,
          source_mode: endpoint?.mode || "",
          source_name: String(endpoint?.name || "").trim(),
          source_endpoint_ref: endpointRef,
        }));
        taskNextCursor.value = payload.nextCursor;
      },
      { immediate: true }
    );

    watch(
      () => taskListResource.error.value,
      (error) => {
        taskErr.value = error ? error.message || t("msg_load_failed") : "";
      }
    );

    function selectTaskStream() {
      selectedStream.value = TASKS_STREAM_VALUE;
      if (isMobile.value) {
        mobileLedgerVisible.value = true;
      }
    }

    async function loadTaskStream() {
      taskErr.value = "";
      return taskListResource.refresh({ force: true });
    }

    function prevTaskPage() {
      if (taskLoading.value || taskPageIndex.value <= 0) {
        return;
      }
      taskPageIndex.value -= 1;
    }

    function nextTaskPage() {
      const cursor = String(taskNextCursor.value || "").trim();
      if (taskLoading.value || !cursor) {
        return;
      }
      const nextPageIndex = taskPageIndex.value + 1;
      const nextHistory = taskPageCursors.value.slice(0, nextPageIndex);
      nextHistory[nextPageIndex] = cursor;
      taskPageCursors.value = nextHistory;
      taskPageIndex.value = nextPageIndex;
    }

    function taskStatusLabel(task) {
      const value = normalizeTaskStatus(task?.status);
      return taskStatusTitleMap.value.get(value) || String(task?.status || "").trim() || "-";
    }

    function taskStatusBadge(task) {
      switch (normalizeTaskStatus(task?.status)) {
        case "failed":
          return auditBadge("alert", "danger");
        case "pending":
          return auditBadge("alert", "warning");
        case "running":
          return auditBadge("notable", "success");
        default:
          return auditBadge("quiet");
      }
    }

    function taskSourceLabel(task) {
      const current = String(task?.source_label || "").trim();
      if (current) {
        return current;
      }
      const mode = String(task?.source_mode || "").trim();
      if (mode) {
        return endpointChannelLabel(mode, t);
      }
      return t("tasks_runtime_fallback");
    }

    function taskRuntimeMeta(task) {
      const name = String(task?.source_name || "").trim();
      if (name) {
        return name;
      }
      const ref = String(task?.source_endpoint_ref || "").trim();
      if (ref) {
        return ref;
      }
      return taskSourceLabel(task);
    }

    function taskModelMeta(task) {
      const model = String(task?.model || "").trim();
      return model || "default";
    }

    function taskTitle(task) {
      return taskTextPreview(task) || String(task?.task || "").trim() || shortenTaskID(task?.id);
    }

    async function openTask(item) {
      const id = String(item?.id || "").trim();
      if (!id) {
        return;
      }
      taskErr.value = "";
      try {
        let data;
        const endpointRef = String(item?.source_endpoint_ref || "").trim();
        if (endpointRef) {
          data = await runtimeApiFetchForEndpoint(endpointRef, `/tasks/${encodeURIComponent(id)}`);
        } else {
          data = await runtimeApiFetchFirstForEndpoints(
            taskEndpointRefsForSelection(),
            `/tasks/${encodeURIComponent(id)}`
          );
        }
        const json = JSON.stringify(data, null, 2);
        if (await openRawJsonDesktopWindow({ title: "RAW JSON", json }).catch(() => false)) {
          return;
        }
        rawDialogJSON.value = json;
        rawDialogOpen.value = rawDialogJSON.value !== "";
      } catch (e) {
        rawDialogJSON.value = "";
        rawDialogOpen.value = false;
        taskErr.value = e.message || t("msg_load_failed");
      }
    }

    function goChat() {
      router.push(endpointRoutePath(endpointState.selectedRef, "/chat"));
    }

    async function loadFiles(endpointRef = currentEndpointRef(), token = null) {
      const data = await loadResource(resourceKey("audit", "files", endpointRef), () =>
        runtimeApiFetchForEndpoint(endpointRef, "/audit/files")
      );
      if (!acceptsAuditLoad(token)) {
        return false;
      }
      auditFiles.value = Array.isArray(data.items) ? data.items : [];

      const preferred = typeof data.default_file === "string" ? data.default_file.trim() : "";
      if (fileItems.value.length === 0) {
        selectedFile.value = preferred;
        return true;
      }
      if (fileItems.value.find((it) => it.value === selectedFile.value)) {
        return true;
      }
      if (preferred && fileItems.value.find((it) => it.value === preferred)) {
        selectedFile.value = preferred;
        return true;
      }
      selectedFile.value = fileItems.value[0].value;
      return true;
    }

    async function loadChunk(cursor = "", endpointRef = currentEndpointRef(), token = initToken) {
      const sequence = ++chunkSequence;
      const file = selectedFile.value;
      const isCurrent = () => sequence === chunkSequence && acceptsAuditLoad(token) &&
        endpointRef === currentEndpointRef() && file === selectedFile.value;
      loading.value = true;
      err.value = "";
      try {
        const q = new URLSearchParams();
        if (file) {
          q.set("file", file);
        }
        q.set("limit", String(AUDIT_ITEMS_PER_PAGE));
        const normalizedCursor = String(cursor || "").trim();
        if (normalizedCursor) {
          q.set("cursor", normalizedCursor);
        }
        const path = `/audit/logs?${q.toString()}`;
        const data = await loadResource(resourceKey("audit", "logs", endpointRef, path), () =>
          runtimeApiFetchForEndpoint(endpointRef, path)
        );
        if (!isCurrent()) {
          return;
        }
        meta.exists = toBool(data.exists, false);
        meta.has_next = toBool(data.has_next, false);
        meta.next_cursor = String(data.next_cursor || "").trim();
        const fetchedLines = Array.isArray(data.items) ? data.items : [];
        lines.value = fetchedLines.slice(-AUDIT_ITEMS_PER_PAGE);
        updatedAt.value = formatShortTime(new Date().toISOString());
        return true;
      } catch (e) {
        if (isCurrent()) {
          err.value = e.message || t("msg_load_failed");
        }
        return false;
      } finally {
        if (sequence === chunkSequence && acceptsAuditLoad(token)) {
          loading.value = false;
        }
      }
    }

    function resetAuditPage() {
      chunkSequence += 1;
      lines.value = [];
      updatedAt.value = "";
      filterText.value = "";
      meta.exists = null;
      meta.has_next = false;
      meta.next_cursor = "";
      auditPageCursors.value = [""];
      pageValue.value = 1;
    }

    async function goPrev() {
      if (loading.value || pageValue.value <= 1) {
        return;
      }
      const target = pageValue.value - 1;
      const cursor = auditPageCursors.value[target - 1] || "";
      if (await loadChunk(cursor)) {
        pageValue.value = target;
      }
    }

    async function goNext() {
      const cursor = String(meta.next_cursor || "").trim();
      if (loading.value || !meta.has_next || !cursor) {
        return;
      }
      if (await loadChunk(cursor)) {
        auditPageCursors.value = auditPageCursors.value.slice(0, pageValue.value);
        auditPageCursors.value.push(cursor);
        pageValue.value += 1;
      }
    }

    async function onFileChange(item) {
      if (!item || typeof item !== "object" || typeof item.value !== "string") {
        return;
      }
      selectedStream.value = AUDIT_STREAM_VALUE;
      if (item.value === selectedFile.value) {
        if (isMobile.value) {
          mobileLedgerVisible.value = true;
        }
        return;
      }
      selectedFile.value = item.value;
      initToken = {};
      resetAuditPage();
      if (isMobile.value) {
        mobileLedgerVisible.value = true;
      }
      await loadChunk();
    }

    async function refreshAudit({ latest = false } = {}) {
      const endpointRef = currentEndpointRef();
      if (initPromise && initEndpointRef === endpointRef) {
        return initPromise;
      }
      initEndpointRef = endpointRef;
      const token = {};
      initToken = token;
      loading.value = true;
      err.value = "";
      const promise = (async () => {
        try {
          const previousFile = selectedFile.value;
          const loaded = await loadFiles(endpointRef, token);
          if (!loaded) {
            return;
          }
          if (previousFile !== selectedFile.value) resetAuditPage();
          const cursor = latest ? "" : auditPageCursors.value[pageValue.value - 1] || "";
          if (await loadChunk(cursor, endpointRef, token) && latest) {
            auditPageCursors.value = [""];
            pageValue.value = 1;
          }
        } catch (e) {
          if (acceptsAuditLoad(token)) {
            err.value = e.message || t("msg_load_failed");
          }
        } finally {
          if (acceptsAuditLoad(token)) loading.value = false;
        }
      })();
      initPromise = promise;
      try {
        return await promise;
      } finally {
        if (initPromise === promise) {
          initPromise = null;
        }
      }
    }

    onMounted(() => {
      window.addEventListener("resize", refreshMobileMode);
      refreshMobileMode();
      void refreshAudit();
      refreshTimer = window.setInterval(() => {
        if (document.hidden || initPromise || loading.value || taskLoading.value) return;
        if (document.querySelector(".audit-event[open], .audit-task[open]")) return;
        if (isTasksStreamSelected.value) {
          if (taskPageIndex.value === 0) void loadTaskStream();
        } else if (pageValue.value === 1) {
          if (!fileItems.value.length) void refreshAudit();
          else void loadChunk("", currentEndpointRef(), initToken);
        }
      }, 15000);
    });
    onUnmounted(() => {
      window.clearInterval(refreshTimer);
      initToken = {};
      window.removeEventListener("resize", refreshMobileMode);
    });
    watch(
      () => endpointState.selectedRef,
      () => {
        selectedFile.value = "";
        auditFiles.value = [];
        resetAuditPage();
        void refreshAudit();
      }
    );

    return {
      t,
      formatShortTime,
      formatTime,
      loading,
      err,
      isMobile,
      mobileShowBack,
      pageClass,
      fileItems,
      currentFiles: computed(() => fileItems.value.filter((item) => !item.archived)),
      archivedFiles: computed(() => fileItems.value.filter((item) => item.archived)),
      filterText,
      updatedAt,
      auditItemCount: computed(() => auditItems.value.length),
      filteredItemCount: computed(() => filteredAuditItems.value.length),
      refreshAudit,
      loadTaskStream,
      selectedFileItem,
      isTasksStreamSelected,
      auditGroups,
      selectedFileTitle,
      meta,
      pageValue,
      pageText,
      showIndexPane,
      showLedgerPane,
      isSelectedFileItem,
      auditFileClass,
      taskStreamClass,
      selectTaskStream,
      showIndexView,
      goPrev,
      goNext,
      onFileChange,
      taskItems,
      taskErr,
      taskLoading,
      prevTaskPage,
      nextTaskPage,
      openTask,
      goChat,
      taskStatusLabel,
      taskStatusBadge,
      taskSourceLabel,
      taskRuntimeMeta,
      taskModelMeta,
      taskTitle,
      tasksPageText,
      hasPrevTaskPage: computed(() => taskPageIndex.value > 0),
      hasNextTaskPage: computed(() => String(taskNextCursor.value || "").trim() !== ""),
      rawDialogOpen,
      rawDialogJSON,
      openRawDialog,
      closeRawDialog,
    };
  },
  template: `
    <AppPage :title="t('audit_title')" :class="pageClass" :hideDesktopBar="true" :hideMobileBar="true">
      <div class="audit-workbench">
        <aside v-if="showIndexPane" class="audit-index workspace-sidebar-section" :aria-label="t('audit_title')">
          <div class="audit-index-head workspace-sidebar-head">
            <h3 class="workspace-section-title">{{ t('audit_title') }}</h3>
          </div>
          <div class="audit-index-scroll">
            <QProgress v-if="loading && fileItems.length === 0" :infinite="true" />
            <QFence v-if="err && isMobile && !showLedgerPane" class="audit-index-error" type="danger" :text="err" />
            <div class="workspace-sidebar-list">
              <button v-for="item in currentFiles" :key="item.key" type="button" :class="auditFileClass(item)"
                :aria-pressed="isSelectedFileItem(item)" @click="onFileChange(item)">
                <span class="workspace-sidebar-item-copy">
                  <span class="workspace-sidebar-item-title">{{ item.title }}</span>
                </span>
                <span class="workspace-sidebar-item-marker" aria-hidden="true">
                  <QBadge v-if="isSelectedFileItem(item)" dot type="primary" size="sm" />
                </span>
              </button>
              <p v-if="!loading && !err && fileItems.length === 0" class="audit-index-note">{{ t('audit_no_file') }}</p>
            </div>
            <details v-if="archivedFiles.length" class="audit-archives">
              <summary class="audit-archives-heading">
                <PhCaretRight class="icon" />
                <span>{{ t('audit_archives') }}</span>
                <span class="audit-archives-count">{{ archivedFiles.length }}</span>
              </summary>
              <div class="workspace-sidebar-list">
                <button v-for="item in archivedFiles" :key="item.key" type="button" :class="auditFileClass(item)"
                  :aria-pressed="isSelectedFileItem(item)" :title="item.name" @click="onFileChange(item)">
                  <span class="workspace-sidebar-item-copy">
                    <span class="workspace-sidebar-item-title">{{ item.title }}</span>
                    <span class="workspace-sidebar-item-meta">{{ item.subtitle }}</span>
                  </span>
                  <span class="workspace-sidebar-item-marker" aria-hidden="true">
                    <QBadge v-if="isSelectedFileItem(item)" dot type="primary" size="sm" />
                  </span>
                </button>
              </div>
            </details>
            <div class="audit-task-nav workspace-sidebar-list">
              <button type="button" :class="taskStreamClass()" :aria-pressed="isTasksStreamSelected" @click="selectTaskStream">
                <span class="workspace-sidebar-item-copy"><span class="workspace-sidebar-item-title">{{ t('tasks_title') }}</span></span>
                <span class="workspace-sidebar-item-marker" aria-hidden="true">
                  <QBadge v-if="isTasksStreamSelected" dot type="primary" size="sm" />
                </span>
              </button>
            </div>
          </div>
        </aside>

        <QCard v-if="showLedgerPane" class="audit-ledger" variant="default">
          <header class="audit-ledger-head">
            <QButton v-if="mobileShowBack" class="plain sm icon audit-ledger-back" :aria-label="t('audit_title')" @click="showIndexView">
              <PhArrowLeft class="icon" />
            </QButton>
            <div class="audit-ledger-copy">
              <h3 class="workspace-document-title">{{ isTasksStreamSelected ? t('tasks_title') : selectedFileTitle }}</h3>
              <p v-if="!isTasksStreamSelected && selectedFileItem?.subtitle" class="audit-ledger-subtitle">{{ selectedFileItem.subtitle }}</p>
            </div>
            <div class="audit-ledger-actions">
              <QButton v-if="!isTasksStreamSelected && pageValue > 1" class="plain sm" :disabled="loading" @click="refreshAudit({ latest: true })">{{ t('audit_latest') }}</QButton>
            </div>
          </header>
          <div class="audit-toolbar">
            <div v-if="!isTasksStreamSelected" class="audit-filter">
              <QInput v-model="filterText" class="xs audit-filter-input" :placeholder="t('audit_filter_placeholder')" :aria-label="t('audit_filter_placeholder')" />
              <span class="audit-filter-scope">{{ t('audit_filter_scope') }}</span>
            </div>
            <span v-else class="audit-page-count">{{ t('audit_page_count', { count: taskItems.length }) }}</span>
            <nav class="audit-pagination" :aria-label="t('audit_pagination')">
              <QButton class="plain sm icon" :disabled="isTasksStreamSelected ? taskLoading || !hasPrevTaskPage : loading || pageValue <= 1"
                :title="t('audit_newer')" :aria-label="t('audit_newer')" @click="isTasksStreamSelected ? prevTaskPage() : goPrev()">
                <PhArrowLeft class="icon" />
              </QButton>
              <span class="audit-page-indicator">{{ t('audit_page_number', { page: isTasksStreamSelected ? tasksPageText : pageText }) }}</span>
              <QButton class="plain sm icon" :disabled="isTasksStreamSelected ? taskLoading || !hasNextTaskPage : loading || !meta.has_next || !meta.next_cursor"
                :title="t('audit_older')" :aria-label="t('audit_older')" @click="isTasksStreamSelected ? nextTaskPage() : goNext()">
                <PhArrowRight class="icon" />
              </QButton>
            </nav>
          </div>
          <div class="audit-load-progress" :aria-label="t('runtime_loading')" v-if="isTasksStreamSelected ? taskLoading : loading">
            <QProgress :infinite="true" />
          </div>
          <div class="audit-ledger-content" :aria-busy="isTasksStreamSelected ? taskLoading : loading">
            <template v-if="!isTasksStreamSelected">
              <QFence v-if="err" type="danger" icon="PhXCircle" :text="err" />
              <div v-if="updatedAt" class="audit-feed-meta">
                <span>{{ filterText ? t('audit_filtered_count', { count: filteredItemCount, total: auditItemCount }) : t('audit_page_count', { count: auditItemCount }) }}</span>
                <span>{{ t('audit_updated', { value: updatedAt }) }}</span>
              </div>
              <div v-if="meta.exists" class="audit-feed">
                <section v-for="group in auditGroups" :key="group.key" class="audit-group">
                  <header class="audit-group-head">
                    <span class="audit-group-identity"><span class="audit-group-label">{{ t('audit_run') }}</span><code :title="group.title">{{ group.title }}</code></span>
                    <span class="audit-group-count">{{ t('audit_page_count', { count: group.items.length }) }}</span>
                  </header>
                  <details v-for="item in group.items" :key="item.key" class="audit-event">
                    <summary class="audit-event-summary">
                      <span class="audit-event-copy">
                        <span class="audit-event-heading">
                          <strong>{{ item.parsed ? item.primaryTitle : t('audit_raw') }}</strong>
                          <template v-if="item.parsed">
                            <QBadge v-if="item.approvalLabel !== '-'" v-bind="item.approvalBadge" size="sm">{{ item.approvalLabel }}</QBadge>
                            <QBadge v-else-if="item.decisionLabel !== '-'" v-bind="item.decisionBadge" size="sm">{{ item.decisionLabel }}</QBadge>
                            <span v-if="item.riskLabel !== '-'" class="audit-event-risk" :class="'is-' + item.riskType">{{ t('audit_risk') }} · {{ item.riskLabel }}</span>
                          </template>
                        </span>
                        <span v-if="!item.parsed || item.summary !== '-'" class="audit-event-preview">{{ item.parsed ? item.summary : item.raw }}</span>
                        <span v-if="item.hasReasons" class="audit-event-reason">{{ item.reasonsText }}</span>
                        <span v-if="item.parsed" class="audit-event-meta">
                          <time v-if="item.tsText !== '-'" class="audit-time" :datetime="item.tsRaw" :title="item.tsFull">{{ item.tsText }}</time>
                          <span v-if="item.toolName !== '-' && item.actionType !== '-'">{{ item.actionType }}</span>
                          <span v-if="item.stepText !== '-'">{{ t('audit_step') }} {{ item.stepText }}</span>
                        </span>
                      </span>
                      <PhCaretRight class="icon audit-event-chevron" />
                    </summary>
                    <div class="audit-event-detail">
                      <template v-if="item.parsed">
                        <dl class="audit-detail-grid">
                          <div v-if="item.eventID !== '-'"><dt>{{ t('audit_event_id') }}</dt><dd><code>{{ item.eventID }}</code></dd></div>
                          <div v-if="item.runID !== '-'"><dt>{{ t('audit_run') }}</dt><dd><code>{{ item.runID }}</code></dd></div>
                          <div><dt>{{ t('audit_decision') }}</dt><dd>{{ item.decisionLabel }}</dd></div>
                          <div><dt>{{ t('audit_risk') }}</dt><dd>{{ item.riskLabel }}</dd></div>
                          <div v-if="item.approvalLabel !== '-'"><dt>{{ t('audit_approval') }}</dt><dd>{{ item.approvalLabel }}</dd></div>
                          <div v-if="item.actor !== '-'"><dt>{{ t('audit_actor') }}</dt><dd>{{ item.actor }}</dd></div>
                          <div v-if="item.approvalRequestID !== '-'" class="audit-detail-wide"><dt>{{ t('audit_approval_request') }}</dt><dd><code>{{ item.approvalRequestID }}</code></dd></div>
                        </dl>
                        <div v-if="item.summary !== '-'" class="audit-detail-section">
                          <h4>{{ t('audit_summary') }}</h4><p>{{ item.summary }}</p>
                        </div>
                        <div v-if="item.reasonsText !== '-'" class="audit-detail-section">
                          <h4>{{ t('audit_reasons') }}</h4><p>{{ item.reasonsText }}</p>
                        </div>
                      </template>
                      <pre v-else class="audit-raw-line">{{ item.raw }}</pre>
                      <QButton class="outlined sm audit-raw-action" @click="openRawDialog(item)"><PhCode class="icon" />{{ t('chat_action_show_raw') }}</QButton>
                    </div>
                  </details>
                </section>
                <div v-if="!loading && !err && auditGroups.length === 0" class="audit-empty">
                  <h3>{{ filterText ? t('audit_filter_empty') : t('audit_empty_title') }}</h3>
                  <p>{{ filterText ? t('audit_filter_empty_hint') : t('audit_empty') }}</p>
                  <QButton v-if="filterText" class="plain sm" @click="filterText = ''">{{ t('audit_clear_filter') }}</QButton>
                </div>
              </div>
              <div v-else-if="!loading && !err" class="audit-empty">
                <h3>{{ t('audit_missing_title') }}</h3><p>{{ t('audit_no_file') }}</p>
              </div>
            </template>
            <template v-else>
              <QFence v-if="taskErr" type="danger" icon="PhXCircle" :text="taskErr" />
              <div class="audit-task-stream">
                <details v-for="item in taskItems" :key="item.id" class="audit-task">
                  <summary class="audit-event-summary">
                    <span class="audit-event-copy">
                      <span class="audit-event-heading"><strong class="audit-task-title">{{ taskTitle(item) }}</strong></span>
                      <span class="audit-event-meta">
                        <QBadge v-bind="taskStatusBadge(item)" size="sm">{{ taskStatusLabel(item) }}</QBadge>
                        <span>{{ taskSourceLabel(item) }}</span>
                        <time class="audit-time" :datetime="item.created_at" :title="formatTime(item.created_at)">{{ formatShortTime(item.created_at) }}</time>
                      </span>
                    </span>
                    <PhCaretRight class="icon audit-event-chevron" />
                  </summary>
                  <div class="audit-event-detail">
                    <p class="audit-task-text">{{ item.task }}</p>
                    <dl class="audit-detail-grid">
                      <div class="audit-detail-wide"><dt>{{ t('tasks_task_id_label') }}</dt><dd><code>{{ item.id }}</code></dd></div>
                      <div><dt>{{ t('stats_model') }}</dt><dd>{{ taskModelMeta(item) }}</dd></div>
                      <div><dt>{{ t('tasks_runtime_label') }}</dt><dd>{{ taskRuntimeMeta(item) }}</dd></div>
                    </dl>
                    <QButton class="outlined sm audit-raw-action" @click="openTask(item)"><PhCode class="icon" />{{ t('chat_action_show_raw') }}</QButton>
                  </div>
                </details>
                <div v-if="taskItems.length === 0 && !taskLoading && !taskErr" class="audit-empty">
                  <h3>{{ t('tasks_empty_title') }}</h3><p>{{ t('tasks_empty_hint') }}</p>
                  <QButton class="plain sm" @click="goChat">{{ t('tasks_empty_action') }}</QButton>
                </div>
              </div>
            </template>
          </div>
        </QCard>
        <RawJsonDialog :open="rawDialogOpen" :json="rawDialogJSON" @close="closeRawDialog" />
      </div>
    </AppPage>
  `,
};

export default AuditView;
