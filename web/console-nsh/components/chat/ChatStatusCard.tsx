// A running or finished task's plan, activity and reasoning as foldable columns of one summary line
// (the time or duration before them). One panel opens at a time; which one is the page's state,
// keyed by the message. Ported from web/console/src/components/ChatStatusCard.js.
import type { JSX } from "nsh";
import { Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Icon } from "../ui";
import { localeState } from "../../lib/core/context.js";
import { t } from "./i18n";
import { activityWorkerLabel } from "../../lib/core/chat-task-history.js";
import { PinnedScroll } from "./PinnedScroll";

export const PANEL_PLAN = "plan";
export const PANEL_ACTIVITY = "activity";
export const PANEL_REASONING = "reasoning";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeTaskStatus(raw: unknown) {
  const value = cleanText(raw).toLowerCase();
  return ["queued", "running", "pending", "done", "failed", "canceled"].includes(value) ? value : "queued";
}

function normalizePlanStatus(raw: unknown) {
  const value = cleanText(raw).toLowerCase();
  return ["completed", "in_progress", "pending"].includes(value) ? value : "pending";
}

function normalizeActivityKind(raw: unknown) {
  const value = cleanText(raw).toLowerCase();
  return value === "tool" || value === "subtask" ? value : "";
}

function activityEntries(activity: any): any[] {
  const history = Array.isArray(activity?.history) ? activity.history.filter(Boolean) : [];
  const current = activity ? activity.current || history[history.length - 1] || null : null;
  if (!current) return history;
  if (history.length === 0) return [current];
  const last = history[history.length - 1];
  if (last === current || (cleanText(last?.id) && cleanText(last?.id) === cleanText(current?.id))) return history;
  return [...history, current];
}

function entryKey(entry: any, index: number) {
  return cleanText(entry?.id) || `${cleanText(entry?.kind) || "activity"}:${index}`;
}

function kindLabel(entry: any) {
  switch (normalizeActivityKind(entry?.kind)) {
    case "tool":
      return t("chat_activity_kind_tool");
    case "subtask":
      return t("chat_activity_kind_subtask");
    default:
      return "";
  }
}

function entryTitle(entry: any) {
  return cleanText(entry?.name) || normalizeActivityKind(entry?.kind) || "activity";
}

function entryTime(entry: any) {
  const raw = cleanText(entry?.at || entry?.time || entry?.timestamp || entry?.updated_at || entry?.updatedAt || entry?.created_at || entry?.createdAt);
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function paramValueText(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(raw: string) {
  const text = cleanText(raw);
  return text.length <= 120 ? text : `${text.slice(0, 117)}...`;
}

function activityParams(entry: any) {
  const items: { key: string; value: string }[] = [];
  if (entry?.args && typeof entry.args === "object" && !Array.isArray(entry.args)) {
    for (const key of Object.keys(entry.args).sort()) {
      const value = truncate(paramValueText(entry.args[key]));
      if (value) items.push({ key, value });
    }
  }
  if (normalizeActivityKind(entry?.kind) === "subtask") {
    const extras: [string, unknown][] = [
      ["task_id", entry?.taskId],
      ["mode", entry?.mode],
      ["profile", entry?.profile],
      ["output", entry?.outputKind],
    ];
    for (const [key, raw] of extras) {
      const value = truncate(paramValueText(raw));
      if (value) items.push({ key, value });
    }
  }
  return items;
}

function children(entry: any): any[] {
  return Array.isArray(entry?.children) ? entry.children.filter(Boolean) : [];
}

function childCount(entry: any) {
  return children(entry).length + (Number(entry?.childrenOmitted) || 0);
}

function entryNote(entry: any) {
  const error = cleanText(entry?.error);
  if (error) return error;
  const output = String(entry?.output || "");
  if (output.trim()) return output;
  return cleanText(entry?.summary);
}

function dotClass(status: string) {
  switch (status) {
    case "done":
    case "completed":
      return "bg-status-on border-status-on";
    case "failed":
    case "canceled":
      return "bg-status-error border-status-error";
    case "running":
    case "in_progress":
      return "bg-status-pending border-status-pending";
    default:
      return "border-status-off";
  }
}

function planProgress(plan: any) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  return `${steps.filter((step: any) => step.status === "completed").length}/${steps.length}`;
}

function Column(props: { label: string; value?: string; expanded: boolean; onPress: () => void; testID?: string }) {
  return (
    <BaseButton
      onPress={props.onPress}
      selected={props.expanded}
      accessibilityLabel={props.label}
      testID={props.testID}
      class="flex-row items-center gap-1 rounded-(--radius) px-1.5 py-0.5 hover:bg-hover selected:bg-selection"
    >
      <Text class="font-mono text-xs uppercase text-muted-foreground">{props.label}</Text>
      <If when={props.value}>
        <Text class="font-mono text-xs text-foreground">{props.value}</Text>
      </If>
      <Icon name={props.expanded ? "PhCaretUp" : "PhCaretDown"} size={11} color="muted-foreground" />
    </BaseButton>
  );
}

export function ChatStatusCard(props: {
  itemID: string;
  plan: any;
  activity: any;
  hasReasoning: boolean;
  status: string;
  expandedPanel: string;
  onToggle: (panel: string) => void;
  summaryPrefix?: JSX.Element;
}) {
  const panel = () => {
    const value = cleanText(props.expandedPanel);
    return value === PANEL_PLAN || value === PANEL_ACTIVITY || value === PANEL_REASONING ? value : "";
  };
  const steps = (): any[] => (Array.isArray(props.plan?.steps) ? props.plan.steps : []);
  const items = () => activityEntries(props.activity);

  return (
    <View class="gap-1.5" testID="chat-status-card">
      <View class="flex-row flex-wrap items-center gap-2">
        {props.summaryPrefix}
        <If when={props.plan}>
          <Column
            label={t("chat_plan_title")}
            value={planProgress(props.plan)}
            expanded={panel() === PANEL_PLAN}
            onPress={() => props.onToggle(PANEL_PLAN)}
            testID="chat-status-plan"
          />
        </If>
        <If when={props.activity}>
          <Column
            label={t("chat_activity_title")}
            expanded={panel() === PANEL_ACTIVITY}
            onPress={() => props.onToggle(PANEL_ACTIVITY)}
            testID="chat-status-activity"
          />
        </If>
        <If when={props.hasReasoning}>
          <Column
            label={t("chat_reasoning_title")}
            expanded={panel() === PANEL_REASONING}
            onPress={() => props.onToggle(PANEL_REASONING)}
            testID="chat-status-reasoning"
          />
        </If>
      </View>
      <If when={(panel() === PANEL_PLAN && props.plan) || (panel() === PANEL_ACTIVITY && props.activity)}>
        <PinnedScroll
          resetKey={`${props.itemID}:${panel()}`}
          maxHeight={280}
          class="rounded-(--radius) border border-line-faint bg-paper"
          contentClass="gap-2 p-3"
        >
          <If when={panel() === PANEL_PLAN}>
            <Each of={steps()} key={(_step, index) => `${props.itemID}:plan:${index}`}>
              {(step) => (
                <View class="flex-row items-start gap-2">
                  <View class={`mt-1.5 size-2 border ${dotClass(normalizePlanStatus(step()?.status))}`} />
                  <Text
                    class={`flex-1 text-sm ${normalizePlanStatus(step()?.status) === "completed" ? "text-muted-foreground" : "text-foreground"}`}
                  >
                    {String(step()?.step ?? "")}
                  </Text>
                </View>
              )}
            </Each>
          </If>
          <If when={panel() === PANEL_ACTIVITY}>
            <Each of={items()} key={(entry, index) => `${props.itemID}:activity:${entryKey(entry, index)}`}>
              {(entry) => (
                <View class="flex-row items-start gap-2">
                  <View class={`mt-1.5 size-2 border ${dotClass(normalizeTaskStatus(entry()?.status))}`} />
                  <View class="flex-1 gap-1">
                    <View class="flex-row flex-wrap items-baseline gap-1.5">
                      <If when={kindLabel(entry())}>
                        <Text class="font-mono text-xs uppercase text-muted-foreground">{kindLabel(entry())}</Text>
                      </If>
                      <Text class="text-sm font-medium text-foreground">
                        {entryTitle(entry())}
                        {activityWorkerLabel(entry(), localeState.lang) ? ` · ${activityWorkerLabel(entry(), localeState.lang)}` : ""}
                      </Text>
                      <If when={childCount(entry()) > 0}>
                        <Text class="text-xs text-muted-foreground">{t("chat_activity_calls", { count: childCount(entry()) })}</Text>
                      </If>
                      <View class="flex-1" />
                      <If when={entryTime(entry())}>
                        <Text class="font-mono text-xs text-muted-foreground">{entryTime(entry())}</Text>
                      </If>
                    </View>
                    <If when={activityParams(entry()).length > 0}>
                      <View class="flex-row flex-wrap gap-1.5">
                        <Each of={activityParams(entry())} key={(param) => param.key}>
                          {(param) => (
                            <View class="flex-row gap-1 rounded-(--radius) bg-muted px-1.5 py-px">
                              <Text class="font-mono text-xs text-muted-foreground">{param().key}</Text>
                              <Text class="font-mono text-xs text-foreground line-clamp-2">{param().value}</Text>
                            </View>
                          )}
                        </Each>
                      </View>
                    </If>
                    <If when={entryNote(entry()) && children(entry()).length === 0}>
                      <View selectable>
                        <Text class={`text-xs ${cleanText(entry()?.error) ? "text-danger" : "text-subtle"} line-clamp-6`}>
                          {entryNote(entry())}
                        </Text>
                      </View>
                    </If>
                    <If when={children(entry()).length > 0}>
                      <View class="gap-1 border-l border-line-faint pl-2">
                        <If when={Number(entry()?.childrenOmitted) > 0}>
                          <Text class="text-xs text-muted-foreground">
                            {t("chat_activity_calls_omitted", { count: entry()?.childrenOmitted })}
                          </Text>
                        </If>
                        <Each of={children(entry())} key={(child, index) => `${props.itemID}:activity:child:${entryKey(child, index)}`}>
                          {(child) => (
                            <View class="gap-0.5">
                              <View class="flex-row items-center gap-1.5">
                                <View class={`size-1.5 border ${dotClass(normalizeTaskStatus(child()?.status))}`} />
                                <Text class="text-xs text-foreground">
                                  {entryTitle(child())}
                                  {activityWorkerLabel(child(), localeState.lang) ? ` · ${activityWorkerLabel(child(), localeState.lang)}` : ""}
                                </Text>
                                <If when={activityParams(child())[0]?.value}>
                                  <Text class="flex-1 font-mono text-xs text-muted-foreground line-clamp-1">
                                    {activityParams(child())[0]?.value}
                                  </Text>
                                </If>
                              </View>
                              <If when={child()?.error}>
                                <Text class="text-xs text-danger">{String(child()?.error ?? "")}</Text>
                              </If>
                            </View>
                          )}
                        </Each>
                      </View>
                    </If>
                  </View>
                </View>
              )}
            </Each>
          </If>
        </PinnedScroll>
      </If>
    </View>
  );
}
