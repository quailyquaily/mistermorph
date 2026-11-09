// A running or finished task's plan, activity and reasoning as columns of one summary line (the
// time or duration before them). A column opens its panel in the temporary detail panel beside the
// conversation (pages/chat/ActivityDetailPanel.tsx), never inside the conversation: which one is
// open is the page's state (activityDetail.ts). The plan's steps and the activity's entries are
// drawn here, as a dark terminal, for that panel. Ported from
// web/console/src/components/ChatStatusCard.js.
import type { JSX, ViewRef } from "nsh";
import { effect, Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Icon, StatusMark } from "../ui";
import { localeState } from "../../lib/core/context.js";
import { t } from "./i18n";
import { activityWorkerLabel } from "../../lib/core/chat-task-history.js";

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

export function activityEntries(activity: any): any[] {
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

// The details panel is a dark terminal on every screen, as in the Vue console: its own ink (the
// page's foreground with a touch of blue), light text, and the theme's light accents for status.
export const TERMINAL_BG = "bg-[#1b1f3b]";
const TERMINAL_FG = "text-[#e8eef5]";
const TERMINAL_MUTED = "text-[#d5e0ecb2]";
const TERMINAL_NOTE = "text-[#e8eef5d1]";
const TERMINAL_VALUE = "text-[#d9e3ee]";
const TERMINAL_ERROR = "text-[#e08a9e]";

/** A status square's colour on the terminal. */
function dotColor(status: string) {
  switch (status) {
    case "done":
    case "completed":
      return "#5a8788";
    case "failed":
    case "canceled":
      return "#c06a80";
    case "running":
    case "in_progress":
      return "#eea03e";
    default:
      return "#ffffff4d";
  }
}

/** A plan step's or activity entry's status mark in the terminal's colours; running, the turning
 *  ring in its running orange. */
function StatusSquare(props: { status: string }) {
  return (
    <StatusMark
      state={props.status === "running" || props.status === "in_progress" ? "running" : "on"}
      color={dotColor(props.status)}
      ringColor={dotColor("running")}
      class="mt-1.5"
    />
  );
}

function dotClass(status: string) {
  switch (status) {
    case "done":
    case "completed":
      return "bg-[#5a8788] border-[#5a8788]";
    case "failed":
    case "canceled":
      return "bg-[#c06a80] border-[#c06a80]";
    case "running":
    case "in_progress":
      return "bg-[#eea03e] border-[#eea03e]";
    default:
      return "bg-[#ffffff4d] border-[#ffffff4d]";
  }
}

export function planProgress(plan: any) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  return `${steps.filter((step: any) => step.status === "completed").length}/${steps.length}`;
}

// A status column: mono 11 on a 16pt line in a 20pt box, 6pt each side, one baseline with the
// time beside it (design/ui-refresh.html §3). Its caret points to the side the panel opens on;
// selected, the panel shows it. `focus` hands it the keyboard focus back as its panel closes.
function Column(props: { label: string; value?: string; selected: boolean; focus?: boolean; onPress: () => void; testID?: string }) {
  let node: ViewRef | undefined;
  effect(() => {
    if (props.focus) node?.focus();
  });
  return (
    <BaseButton
      ref={(ref: ViewRef) => (node = ref)}
      onPress={props.onPress}
      selected={props.selected}
      accessibilityLabel={props.label}
      testID={props.testID}
      class="h-5 flex-row items-center gap-1 rounded-(--radius) px-1.5 hover:bg-hover selected:bg-selection"
    >
      <Text class="font-mono text-[11px] leading-4 uppercase text-muted-foreground">{props.label}</Text>
      <If when={props.value}>
        <Text class="font-mono text-[11px] leading-4 text-foreground">{props.value}</Text>
      </If>
      <Icon name="PhCaretRight" size={11} color={props.selected ? "blue" : "muted-foreground"} />
    </BaseButton>
  );
}

/** The plan's steps on the terminal, each with its status mark. */
export function ChatPlanSteps(props: { itemID: string; plan: any }) {
  const steps = (): any[] => (Array.isArray(props.plan?.steps) ? props.plan.steps : []);
  return (
    <Each of={steps()} key={(_step, index) => `${props.itemID}:plan:${index}`}>
      {(step) => (
        <View class="flex-row items-start gap-2">
          <StatusSquare status={normalizePlanStatus(step()?.status)} />
          <View selectable class="flex-1">
            <Text class={`text-sm ${normalizePlanStatus(step()?.status) === "completed" ? TERMINAL_MUTED : TERMINAL_FG}`}>
              {String(step()?.step ?? "")}
            </Text>
          </View>
        </View>
      )}
    </Each>
  );
}

/** The activity's entries on the terminal: tools and subtasks with their parameters, output and
 *  nested calls. */
export function ChatActivityEntries(props: { itemID: string; activity: any }) {
  const items = () => activityEntries(props.activity);
  return (
    <Each of={items()} key={(entry, index) => `${props.itemID}:activity:${entryKey(entry, index)}`}>
      {(entry) => (
        <View class="flex-row items-start gap-2">
          <StatusSquare status={normalizeTaskStatus(entry()?.status)} />
          <View class="flex-1 gap-1">
            <View class="flex-row flex-wrap items-baseline gap-1.5">
              <If when={kindLabel(entry())}>
                <Text class={`font-mono text-xs uppercase ${TERMINAL_MUTED}`}>{kindLabel(entry())}</Text>
              </If>
              <Text class={`text-sm font-medium ${TERMINAL_FG}`}>
                {entryTitle(entry())}
                {activityWorkerLabel(entry(), localeState.lang) ? ` · ${activityWorkerLabel(entry(), localeState.lang)}` : ""}
              </Text>
              <If when={childCount(entry()) > 0}>
                <Text class={`text-xs ${TERMINAL_MUTED}`}>{t("chat_activity_calls", { count: childCount(entry()) })}</Text>
              </If>
              <View class="flex-1" />
              <If when={entryTime(entry())}>
                <Text class={`font-mono text-xs ${TERMINAL_MUTED}`}>{entryTime(entry())}</Text>
              </If>
            </View>
            <If when={activityParams(entry()).length > 0}>
              <View class="flex-row flex-wrap gap-1.5">
                <Each of={activityParams(entry())} key={(param) => param.key}>
                  {(param) => (
                    <View class="flex-row gap-1">
                      <Text class={`font-mono text-xs ${TERMINAL_MUTED}`}>{param().key}</Text>
                      <Text class={`font-mono text-xs ${TERMINAL_VALUE} line-clamp-2`}>{param().value}</Text>
                    </View>
                  )}
                </Each>
              </View>
            </If>
            <If when={entryNote(entry()) && children(entry()).length === 0}>
              <View selectable>
                <Text class={`text-xs ${cleanText(entry()?.error) ? TERMINAL_ERROR : TERMINAL_NOTE}`}>{entryNote(entry())}</Text>
              </View>
            </If>
            <If when={children(entry()).length > 0}>
              <View class="gap-1 border-l border-[#ffffff26] pl-2">
                <If when={Number(entry()?.childrenOmitted) > 0}>
                  <Text class={`text-xs ${TERMINAL_MUTED}`}>{t("chat_activity_calls_omitted", { count: entry()?.childrenOmitted })}</Text>
                </If>
                <Each of={children(entry())} key={(child, index) => `${props.itemID}:activity:child:${entryKey(child, index)}`}>
                  {(child) => (
                    <View class="gap-0.5">
                      <View class="flex-row items-center gap-1.5">
                        <View class={`size-1.5 border ${dotClass(normalizeTaskStatus(child()?.status))}`} />
                        <Text class={`text-xs ${TERMINAL_FG}`}>
                          {entryTitle(child())}
                          {activityWorkerLabel(child(), localeState.lang) ? ` · ${activityWorkerLabel(child(), localeState.lang)}` : ""}
                        </Text>
                        <If when={activityParams(child())[0]?.value}>
                          <Text class={`flex-1 font-mono text-xs ${TERMINAL_MUTED} line-clamp-1`}>{activityParams(child())[0]?.value}</Text>
                        </If>
                      </View>
                      <If when={child()?.error}>
                        <Text class={`text-xs ${TERMINAL_ERROR}`}>{String(child()?.error ?? "")}</Text>
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
  );
}

export function ChatStatusCard(props: {
  itemID: string;
  plan: any;
  activity: any;
  hasReasoning: boolean;
  status: string;
  /** The panel of this reply the detail panel shows ("" for none of them). */
  selectedPanel: string;
  /** The panel whose column takes the focus back now (its panel just closed). */
  focusPanel?: string;
  onOpen: (panel: string) => void;
  summaryPrefix?: JSX.Element;
}) {
  const panel = () => {
    const value = cleanText(props.selectedPanel);
    return value === PANEL_PLAN || value === PANEL_ACTIVITY || value === PANEL_REASONING ? value : "";
  };
  const focus = (name: string) => cleanText(props.focusPanel) === name;

  return (
    <View class="flex-row flex-wrap items-center gap-2" testID="chat-status-card">
      {props.summaryPrefix}
      <If when={props.plan}>
        <Column
          label={t("chat_plan_title")}
          value={planProgress(props.plan)}
          selected={panel() === PANEL_PLAN}
          focus={focus(PANEL_PLAN)}
          onPress={() => props.onOpen(PANEL_PLAN)}
          testID="chat-status-plan"
        />
      </If>
      <If when={props.activity}>
        <Column
          label={t("chat_activity_title")}
          selected={panel() === PANEL_ACTIVITY}
          focus={focus(PANEL_ACTIVITY)}
          onPress={() => props.onOpen(PANEL_ACTIVITY)}
          testID="chat-status-activity"
        />
      </If>
      <If when={props.hasReasoning}>
        <Column
          label={t("chat_reasoning_title")}
          selected={panel() === PANEL_REASONING}
          focus={focus(PANEL_REASONING)}
          onPress={() => props.onOpen(PANEL_REASONING)}
          testID="chat-status-reasoning"
        />
      </If>
    </View>
  );
}
