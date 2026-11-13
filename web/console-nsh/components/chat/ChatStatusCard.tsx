// A running or finished task's plan, activity and reasoning as columns of one summary line (the
// time or duration before them). A column opens its panel in the temporary detail panel beside the
// conversation (pages/chat/ActivityDetailPanel.tsx), never inside the conversation: which one is
// open is the page's state (activityDetail.ts). The plan's steps and the activity's entries are
// drawn here, on its dark terminal (ChatTerminal.tsx), for that panel. Ported from
// web/console/src/components/ChatStatusCard.js.
import type { JSX, ViewRef } from "nsh";
import { effect, Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Icon } from "../ui";
import { localeState } from "../../lib/core/context.js";
import { t } from "./i18n";
import { OverflowLine } from "./OverflowLine";
import { createPartProbe, type PartLayoutListener } from "../shared/partProbe";
import { KindChip, NEON, StatusTag, statusTag, TerminalText } from "./TerminalText";
import { activityWorkerLabel } from "../../lib/core/chat-task-history.js";
import { TERMINAL_ERROR, TERMINAL_FG, TERMINAL_MUTED, TERMINAL_VALUE, terminalNoteClass } from "./ChatTerminal";

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

function activityParams(entry: any) {
  const items: { key: string; value: string }[] = [];
  if (entry?.args && typeof entry.args === "object" && !Array.isArray(entry.args)) {
    for (const key of Object.keys(entry.args).sort()) {
      // Whole: the terminal cuts what shows (PARAM_LIMIT), never inside a term worth copying.
      const value = cleanText(paramValueText(entry.args[key]));
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
      const value = cleanText(paramValueText(raw));
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

// The terminal's rows are a dashboard's readout (TerminalText.tsx): a bracketed state tag, the
// entry's kind as a chip, its name bright; its parameters as a key column and typed values (a
// command behind a `$` prompt); its output under a rule (red for an error), with the terms worth
// copying pressable; its nested calls as a tree.

/** The parameters that are a command line: their value shows behind a `$` prompt. */
const COMMAND_KEYS = new Set(["cmd", "command", "script", "shell"]);
/** How much of a parameter's value shows (cut by TerminalText, which keeps copyable terms whole). */
const PARAM_LIMIT = 120;

/** The plan's steps on the terminal: a two-digit number, the step's state and its text. */
export function ChatPlanSteps(props: { itemID: string; plan: any }) {
  const steps = (): any[] => (Array.isArray(props.plan?.steps) ? props.plan.steps : []);
  return (
    <Each of={steps()} key={(_step, index) => `${props.itemID}:plan:${index}`}>
      {(step, index) => (
        <View class="flex-row items-start gap-2">
          <Text class="font-mono text-[11px] leading-[18px]" style={{ color: NEON.idle }}>
            {String(index() + 1).padStart(2, "0")}
          </Text>
          <StatusTag status={normalizePlanStatus(step()?.status)} />
          <View selectable class="flex-1">
            <TerminalText
              text={String(step()?.step ?? "")}
              class={`text-sm leading-[18px] ${normalizePlanStatus(step()?.status) === "completed" ? TERMINAL_MUTED : TERMINAL_FG}`}
            />
          </View>
        </View>
      )}
    </Each>
  );
}

let paramProbe: PartLayoutListener | undefined;
/** Test fixtures hear where each parameter's parts and each nested call lie on the page (null to
 *  stop): `param:<key>=<value>` (the row), `prompt:…` (its `$`), `value:…`, `call:<title>=<value>`. */
export function probeActivityParams(listener: PartLayoutListener | null) {
  paramProbe = listener ?? undefined;
}
const params = createPartProbe(() => paramProbe);

/**
 * A parameter: its key in a fixed column, its value typed in the room left, where it wraps (at
 * spaces, and inside a word longer than the room, so no value widens the panel). Its line breaks
 * stay. A command's value has its `$` prompt in a column of its own beside it: always beside the
 * command's first line (as text before the value it could end a line of its own), and never part
 * of the value a press copies. `limit` is how much of the value shows (0: all of it).
 */
export function ParamRow(props: { name: string; value: string; class?: string; limit?: number; testID?: string }) {
  const command = () => COMMAND_KEYS.has(props.name.toLowerCase());
  return (
    <View
      class={`flex-row items-start gap-2 ${props.class ?? ""}`}
      testID={props.testID ?? "chat-activity-param"}
      {...params.probe(() => `param:${props.name}=${props.value}`)}
    >
      <Text class="w-[64px] shrink-0 font-mono text-[11px] leading-[18px] line-clamp-1" style={{ color: NEON.key }}>
        {props.name}
      </Text>
      <View class="min-w-0 flex-1 flex-row items-start gap-1">
        <If when={command()}>
          <View class="shrink-0" testID="chat-activity-prompt" {...params.probe(() => `prompt:${props.name}=${props.value}`)}>
            <Text class="font-mono text-xs leading-[18px]" style={{ color: NEON.ok }}>
              $
            </Text>
          </View>
        </If>
        <View class="min-w-0 flex-1" {...params.probe(() => `value:${props.name}=${props.value}`)}>
          <TerminalText
            text={props.value}
            limit={props.limit ?? PARAM_LIMIT}
            class={`font-mono text-xs leading-[18px] ${command() ? TERMINAL_FG : TERMINAL_VALUE}`}
            testID="chat-activity-param-value"
          />
        </View>
      </View>
    </View>
  );
}

/** The activity's entries on the terminal: tools and subtasks with their parameters, output and
 *  nested calls. */
export function ChatActivityEntries(props: { itemID: string; activity: any }) {
  const items = () => activityEntries(props.activity);
  return (
    <Each of={items()} key={(entry, index) => `${props.itemID}:activity:${entryKey(entry, index)}`}>
      {(entry) => (
        <View class="gap-1.5 pb-1" testID="chat-activity-entry">
          <View class="flex-row flex-wrap items-center gap-2">
            <StatusTag status={normalizeTaskStatus(entry()?.status)} testID="chat-activity-status" />
            <If when={kindLabel(entry())}>
              <KindChip label={kindLabel(entry())} tone={normalizeActivityKind(entry()?.kind) === "subtask" ? "violet" : "cyan"} />
            </If>
            <OverflowLine testID="chat-activity-title">
              {/* shrink: where lines wrap (OverflowWraps) the name takes the line's width and wraps. */}
              <Text class={`shrink font-mono text-[13px] font-medium leading-[18px] ${TERMINAL_FG}`}>
                {entryTitle(entry())}
                {activityWorkerLabel(entry(), localeState.lang) ? ` · ${activityWorkerLabel(entry(), localeState.lang)}` : ""}
              </Text>
            </OverflowLine>
            <If when={childCount(entry()) > 0}>
              <Text class={`font-mono text-[11px] ${TERMINAL_MUTED}`}>{t("chat_activity_calls", { count: childCount(entry()) })}</Text>
            </If>
            <View class="flex-1" />
            <If when={entryTime(entry())}>
              <Text class="font-mono text-[11px]" style={{ color: NEON.idle }}>
                {entryTime(entry())}
              </Text>
            </If>
          </View>
          <If when={activityParams(entry()).length > 0}>
            <View class="gap-0.5">
              <Each of={activityParams(entry())} key={(param) => param.key}>
                {/* The detail panel is where a parameter is read: its value whole (it wraps). */}
                {(param) => <ParamRow name={param().key} value={param().value} limit={0} />}
              </Each>
            </View>
          </If>
          <If when={entryNote(entry()) && children(entry()).length === 0}>
            <View
              selectable
              class="border-l-2 pl-2.5"
              style={{ borderColor: cleanText(entry()?.error) ? `${NEON.fail}99` : "#ffffff1f" }}
            >
              <TerminalText
                text={entryNote(entry())}
                copyOnly
                class={`font-mono leading-[18px] ${terminalNoteClass(Boolean(cleanText(entry()?.error)))}`}
              />
            </View>
          </If>
          <If when={children(entry()).length > 0}>
            <ActivityCallTree itemID={props.itemID} calls={children(entry())} omitted={Number(entry()?.childrenOmitted) || 0} />
          </If>
        </View>
      )}
    </Each>
  );
}

/** Nested calls (a subtask's, a subagent's) as a tree: `├─`/`└─`, a state dot, the call and its
 *  first value, an error under it. */
export function ActivityCallTree(props: { itemID: string; calls: any[]; omitted?: number }) {
  const omitted = () => Number(props.omitted) || 0;
  return (
    <View class="gap-0.5">
      <If when={omitted() > 0}>
        <Text class={`font-mono text-[11px] ${TERMINAL_MUTED}`}>
          {"┆  "}
          {t("chat_activity_calls_omitted", { count: omitted() })}
        </Text>
      </If>
      <Each of={props.calls} key={(child, index) => `${props.itemID}:activity:child:${entryKey(child, index)}`}>
        {(child, index) => (
          <View class="gap-0.5">
            <View class="flex-row items-start gap-1.5">
              <Text class="font-mono text-xs leading-[18px]" style={{ color: NEON.idle }}>
                {index() === props.calls.length - 1 ? "└─" : "├─"}
              </Text>
              <Text class="font-mono text-xs leading-[18px]" style={{ color: statusTag(normalizeTaskStatus(child()?.status)).color }}>
                ●
              </Text>
              {/* The call and its first value as one text that wraps in the room left, as a
                  parameter's value does (ParamRow). */}
              <View
                class="min-w-0 flex-1"
                testID="chat-activity-call"
                {...params.probe(() => `call:${entryTitle(child())}=${activityParams(child())[0]?.value ?? ""}`)}
              >
                <Text class={`font-mono text-xs leading-[18px] ${TERMINAL_FG}`}>
                  {entryTitle(child())}
                  {activityWorkerLabel(child(), localeState.lang) ? ` · ${activityWorkerLabel(child(), localeState.lang)}` : ""}
                  <If when={activityParams(child())[0]?.value}>
                    {" "}
                    <TerminalText
                      text={activityParams(child())[0]?.value ?? ""}
                      limit={PARAM_LIMIT}
                      class={TERMINAL_MUTED}
                      testID="chat-activity-call-value"
                    />
                  </If>
                </Text>
              </View>
            </View>
            <If when={child()?.error}>
              <View class="flex-row gap-1.5">
                <Text class="font-mono text-xs leading-[18px]" style={{ color: NEON.idle }}>
                  {index() === props.calls.length - 1 ? "  " : "│ "}
                </Text>
                <TerminalText text={String(child()?.error ?? "")} copyOnly class={`min-w-0 flex-1 font-mono text-xs leading-[18px] ${TERMINAL_ERROR}`} />
              </View>
            </If>
          </View>
        )}
      </Each>
    </View>
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
