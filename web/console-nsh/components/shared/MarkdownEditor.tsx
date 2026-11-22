// A Markdown source editor (the Vue console's MarkdownEditor and AppMarkdownEditor). The Vue editor
// (overtype) styled the Markdown in place; here the source is in nsh/base's Editor with Markdown
// highlighting, and an Edit / Preview switch shows it rendered (TextView). A hint goes below.
//
// AppMarkdownEditor adds the toolbar that inserts, at the caret, a mention of a contact
// ("[Alice](tg:42)"), a reference to a conversation ("[Team](tg:-100)") or a reference to a
// scheduled job ("[Morning report](job:job-1234)"), each picked from a filterable list;
// conversations split into a tab per channel once there are several. A job reference is keyed by
// the job's ID: the label is the job's title when it was picked, and may be edited freely.
//
// The Editor's rows take presses only over the text: a press beside it (the padding, the room below
// the last line, the 8pt over the caret the console's scroll bars take on the desktops) reaches the
// view around the Editor, which places the caret where the rows would have (`editorPresses.ts`).
//
// `plainText` swaps the Editor for a regular textarea (a multiline `Input`): the source unstyled, no
// Edit / Preview switch, the same toolbar. Its insertions keep the textarea's last selection
// (`textInsert.ts`).
//
// Vue to nsh: `modelValue` is `value`, `update:modelValue` is `onChange(value)`, `ariaLabel` is
// `accessibilityLabel`, the `toolbar` slot is the `toolbar` prop, the `height` CSS string may also be
// points, and the exposed `insertAtCursor` comes through `editorRef`.
import type { EditorDecoration, EditorRef, EditorSelection } from "nsh/base";
import type { InputRef, JSX } from "nsh";
import { batch, effect, Image, platform, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton, Editor, Input } from "nsh/base";
import { activeChannelTab, channelTabs, itemsForChannelTab } from "../../lib/core/channel-tabs.js";
import { endpointState, runtimeApiFetchForEndpoint, translate } from "../../lib/core/context.js";
import { useContactsStore } from "../../lib/stores/contactsStore.js";
import { Icon, Markdown, Modal, TextField, Tip, TipButton, type IconName } from "../ui";
import { CONTROL_CORNERS, cornersClass, nestedRadius, RADIUS } from "../corners";

/** The toolbar's buttons and tabs (in its 4pt padding, on the field's hairline): the field's corners nested (8 - 5: 3pt). */
const TOOLBAR_CORNERS = cornersClass(nestedRadius(RADIUS.control, 1 + 4));
/** A row of the mention and conversation pickers (in their dialog): a pressable row with the controls' continuous corners. */
export const PICKER_ROW_CLASS = `flex-row items-center gap-3 ${CONTROL_CORNERS} px-2 py-1.5 hover:bg-hover active:bg-selection`;
import { ContactAvatar } from "./ContactAvatar";
import { createBesidePresses } from "./editorPresses";
import { createTextareaInsert, insertIntoText } from "./textInsert";
import discordLogo from "../../assets/images/channels/discord.svg";
import larkLogo from "../../assets/images/channels/lark.svg";
import lineLogo from "../../assets/images/channels/line.svg";
import mixinLogo from "../../assets/images/channels/mixin.svg";
import slackLogo from "../../assets/images/channels/slack.svg";
import telegramLogo from "../../assets/images/channels/telegram.svg";
import wechatLogo from "../../assets/images/channels/wechat.svg";
import whatsappLogo from "../../assets/images/channels/whatsapp.svg";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

/** What `editorRef` hands over. */
export interface MarkdownEditorApi {
  /** Types `text` at the caret (or the last caret, or the end); `spacing` adds a space on a side that touches text. */
  insertAtCursor(text: string, options?: { spacing?: boolean }): Promise<boolean>;
  focus(): void;
  /**
   * Called before a toolbar dialog opens: the textarea (`plainText`) takes the focus at its last
   * selection, so the dialog gives it back there as it closes (`textInsert.ts`). Open the dialog once
   * the promise settles: when the field has the focus, or after 200 ms. Nothing in the Editor.
   */
  holdCaret(): Promise<void> | void;
}

export interface MarkdownEditorProps {
  value: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  hint?: string;
  /** Points, a percentage ("100%"), or CSS-like "460px" / "clamp(320px, 60vh, 760px)". */
  height?: number | string;
  disabled?: boolean;
  /** Can be read and selected, not changed. */
  readOnly?: boolean;
  accessibilityLabel?: string;
  /** Show the Edit / Preview switch (default true; never with `plainText`). */
  preview?: boolean;
  /** A regular textarea in place of the highlighted Editor: the text as it is, no preview. */
  plainText?: boolean;
  /**
   * Which document the value is (a TODO item's key): a new one drops the remembered caret even
   * when its text is the same, so an insertion never lands at the last document's caret.
   */
  documentKey?: string | number;
  /** Controls at the start of the toolbar. */
  toolbar?: JSX.Element;
  editorRef?: (api: MarkdownEditorApi) => void;
  /** Styles over the Markdown highlighting (ranges of the source), passed to the Editor. */
  decorations?: EditorDecoration[];
  class?: string;
  testID?: string;
}

/** The editor's height style from the Vue `height` (a CSS length) or points. */
function heightStyle(height: number | string | undefined): Record<string, number | string> {
  if (typeof height === "number") return { height };
  const text = String(height || "").trim();
  if (!text) return { height: 320 };
  if (/^\d+(\.\d+)?%$/.test(text)) return { height: text, flexGrow: 1 };
  const px = /^(\d+(?:\.\d+)?)px$/.exec(text);
  if (px) return { height: Number(px[1]) };
  // clamp(min, preferred, max): the smallest and largest lengths in points, the larger as height.
  const lengths = [...text.matchAll(/(\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
  if (lengths.length >= 2) return { minHeight: Math.min(...lengths), height: Math.max(...lengths) };
  if (lengths.length === 1) return { height: lengths[0] };
  return { height: 320 };
}

function textOffset(text: string, position: { line: number; column: number }) {
  const lines = text.split("\n");
  let offset = 0;
  for (let line = 0; line < Math.min(position.line, lines.length); line += 1) offset += lines[line].length + 1;
  return Math.min(text.length, offset + position.column);
}

function textPosition(text: string, offset: number) {
  const before = text.slice(0, offset).split("\n");
  return { line: before.length - 1, column: before[before.length - 1].length };
}

export function MarkdownEditor(props: MarkdownEditorProps) {
  let editor: EditorRef | undefined;
  let field: InputRef | undefined;
  const mode = signal<"edit" | "preview">("edit");
  const focused = signal(false);
  // `holdCaret`s waiting for the textarea to have the focus.
  let focusWaiters: (() => void)[] = [];
  // The last selections, so a toolbar press (which takes the focus) still inserts at the caret.
  let lastSelections: EditorSelection[] = [];

  const label = () => String(props.accessibilityLabel || "").trim() || "Markdown editor";
  const locked = () => Boolean(props.disabled || props.readOnly);
  const plain = () => Boolean(props.plainText);
  const showTabs = () => !plain() && props.preview !== false;

  // The textarea's insertions (`plainText`): its last selection, and the focus and caret after.
  const textarea = createTextareaInsert({
    value: () => String(untracked(() => props.value) ?? ""),
    onChange: (value) => props.onChange?.(value),
    locked: () => untracked(locked),
    field: () => field,
  });

  const api: MarkdownEditorApi = {
    async insertAtCursor(raw, options = {}) {
      if (untracked(plain)) return textarea.insert(raw, options);
      const text = typeof raw === "string" ? raw : String(raw ?? "");
      if (!editor || !text || untracked(locked)) return false;
      if (untracked(mode) !== "edit") mode.set("edit");
      const current = String(untracked(() => props.value) ?? "");
      const selection = lastSelections[lastSelections.length - 1];
      const range = selection ? { start: textOffset(current, selection.anchor), end: textOffset(current, selection.head) } : null;
      const next = insertIntoText(current, range, text, options);
      // The app's value is the source of truth: say the new text, and put the caret after it.
      lastValue = next.value;
      props.onChange?.(next.value);
      const caret = textPosition(next.value, next.caret);
      lastSelections = [{ anchor: caret, head: caret }];
      queueMicrotask(() => {
        editor?.focus();
        editor?.setSelections(lastSelections);
      });
      return true;
    },
    focus() {
      if (untracked(plain)) field?.focus();
      else editor?.focus();
    },
    holdCaret() {
      if (!untracked(plain) || untracked(locked)) return;
      textarea.hold();
      if (untracked(focused)) return;
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          focusWaiters = focusWaiters.filter((waiter) => waiter !== done);
          resolve();
        };
        const timer = setTimeout(done, 200);
        focusWaiters.push(done);
      });
    },
  };
  props.editorRef?.(api);

  // Presses beside the rows (see the top of the file): on the desktops as the mouse goes down, on
  // touch screens as a tap (not the start of a scroll).
  const desktop = platform.desktop;
  const beside = createBesidePresses({ editor: () => editor, desktop, active: () => untracked(mode) === "edit" });

  // A new value from outside (another document) drops the remembered caret, and so does another
  // document with the same text.
  let lastValue = untracked(() => props.value);
  let lastDocument = untracked(() => props.documentKey);
  effect(() => {
    const value = props.value;
    const document = props.documentKey;
    untracked(() => textarea.follow(String(value ?? ""), document));
    if (value !== lastValue || document !== lastDocument) {
      lastValue = value;
      lastDocument = document;
      lastSelections = [];
    }
  });

  const tab = (id: "edit" | "preview", text: string, icon: IconName) => (
    <BaseButton
      role="tab"
      selected={mode() === id}
      onPress={() => mode.set(id)}
      accessibilityLabel={text}
      testID={props.testID ? `${props.testID}-${id}` : undefined}
      class={`flex-row items-center gap-1 ${TOOLBAR_CORNERS} px-2 py-1 hover:bg-hover selected:bg-selection`}
    >
      <Icon name={icon} size={13} color={mode() === id ? "foreground" : "muted-foreground"} />
      <Text class={`text-xs ${mode() === id ? "font-medium text-foreground" : "text-subtle"}`}>{text}</Text>
    </BaseButton>
  );

  return (
    <View class={`gap-1.5 ${props.class ?? ""}`} testID={props.testID}>
      <View
        class={`overflow-hidden ${CONTROL_CORNERS} border bg-card transition-colors duration-200 ${focused() ? "border-ring" : "border-input"} ${
          props.disabled ? "opacity-60" : ""
        }`}
        style={heightStyle(props.height)}
      >
        <If when={props.toolbar || showTabs()}>
          <View class="min-h-11 flex-row items-center gap-1 p-1" role="toolbar" accessibilityLabel={`${label()} toolbar`}>
            {props.toolbar}
            <View class="flex-1" />
            <If when={showTabs()}>
              <View class="flex-row gap-0.5" role="tablist">
                {tab("edit", t("action_edit"), "PhPencilSimple")}
                {tab("preview", t("markdown_editor_preview"), "PhEye")}
              </View>
            </If>
          </View>
        </If>
        <If
          when={!plain()}
          else={
            // A regular textarea: the text as it is, scrolling inside the box.
            <Input
              ref={(node: InputRef) => {
                field = node;
              }}
              value={props.value ?? ""}
              multiline
              placeholder={props.placeholder || undefined}
              readonly={locked()}
              accessibilityLabel={label()}
              testID={props.testID ? `${props.testID}-source` : undefined}
              class="min-h-0 flex-1 self-stretch px-4 py-3 text-sm leading-[21.7px] text-foreground placeholder:text-placeholder caret-blue selection:bg-blue/22"
              onFocus={() => {
                focused.set(true);
                for (const done of focusWaiters.slice()) done();
              }}
              onBlur={() => focused.set(false)}
              onChange={({ value }) => {
                if (untracked(locked)) return;
                textarea.edited(value);
                props.onChange?.(value);
              }}
              onSelectionChange={(range) => textarea.selected(range)}
            />
          }
        >
          <If
            when={mode() === "edit"}
            else={
              <View class="flex-1 overflow-hidden">
                <If
                  when={String(props.value || "").trim()}
                  else={<Text class="px-4 py-3 text-sm text-placeholder">{props.placeholder || ""}</Text>}
                >
                  <View class="flex-1 px-4 py-3">
                    <Markdown source={props.value || ""} />
                  </View>
                </If>
              </View>
            }
          >
            <View
              class="flex-1 cursor-text"
              // Not a control of its own: the Editor in it is (pressables are buttons by default).
              role="group"
              focusable={false}
              onLayout={({ bounds }) => beside.layout(bounds.size.width)}
              onPressDown={desktop ? (e) => void beside.pressDown(e) : undefined}
              onPress={(e) => void beside.press(e)}
              onMouseMove={desktop ? (e) => void beside.mouseMove(e) : undefined}
              onMouseLeave={desktop ? (e) => void beside.mouseLeave(e) : undefined}
              testID={props.testID ? `${props.testID}-frame` : undefined}
            >
              <Editor
                ref={(node: EditorRef) => {
                  editor = node;
                }}
                value={props.value ?? ""}
                language="markdown"
                decorations={props.decorations}
                placeholder={props.placeholder || null}
                readOnly={locked()}
                lineNumbers={false}
                softWrap
                folding={false}
                indentGuides={false}
                activeLine={false}
                autoClose={false}
                scrollBeyondLastLine={false}
                fontSize={14}
                lineHeight={24}
                accessibilityLabel={label()}
                testID={props.testID ? `${props.testID}-source` : undefined}
                class="flex-1"
                classes={{ content: "px-4 py-3", placeholder: "text-placeholder" }}
                onFocus={() => focused.set(true)}
                onBlur={() => focused.set(false)}
                onChange={({ value }) => {
                  if (untracked(locked)) return;
                  lastValue = value;
                  props.onChange?.(value);
                }}
                onSelectionChange={({ selections }) => {
                  lastSelections = selections;
                }}
              />
            </View>
          </If>
        </If>
      </View>
      <If when={String(props.hint || "").trim()}>
        <Text class="text-xs text-muted-foreground">{String(props.hint || "").trim()}</Text>
      </If>
    </View>
  );
}

/* ---------- AppMarkdownEditor: mention, conversation and job pickers ---------- */

const CHANNEL_LOGOS: Record<string, any> = {
  discord: discordLogo,
  lark: larkLogo,
  line: lineLogo,
  mixin: mixinLogo,
  slack: slackLogo,
  telegram: telegramLogo,
  wechat: wechatLogo,
  whatsapp: whatsappLogo,
};

function trimText(value: unknown) {
  return String(value || "").trim();
}

function platformFromReferenceID(referenceID: unknown) {
  const protocol = trimText(referenceID).split(":", 1)[0].toLowerCase();
  if (protocol === "tg") return "telegram";
  if (protocol === "line_user") return "line";
  if (protocol === "lark_user") return "lark";
  return protocol;
}

function conversationPlatform(conversation: any) {
  return trimText(conversation?.platform).toLowerCase() || platformFromReferenceID(conversation?.chat_id);
}

function safeMentionLabel(value: unknown) {
  return trimText(value)
    .replace(/[[\]\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface PickerItem {
  id: string;
  title: string;
  subtitle: string;
  value: string;
  channel?: string;
  contact?: any;
}

export function mentionItemsForContacts(contacts: any[]): PickerItem[] {
  const items: PickerItem[] = [];
  for (const contact of Array.isArray(contacts) ? contacts : []) {
    const contactID = trimText(contact?.contact_id);
    const channel = trimText(contact?.channel).toLowerCase();
    const status = trimText(contact?.status).toLowerCase();
    if (!contactID || channel === "console" || status === "inactive") continue;
    const title = trimText(contact?.nickname) || contactID || t("contacts_unnamed");
    const label = safeMentionLabel(title) || t("contacts_unnamed");
    items.push({ id: `mention-${contactID}`, title, subtitle: channel.toUpperCase(), value: `[${label}](${contactID})`, contact });
  }
  return items;
}

export function conversationItemsForProfiles(profiles: any[]): PickerItem[] {
  const items: PickerItem[] = [];
  const seen = new Set<string>();
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    const chatID = trimText(profile?.chat_id);
    if (!chatID) continue;
    const key = chatID.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const title = trimText(profile?.name) || chatID;
    const label = safeMentionLabel(title) || chatID;
    const platform = conversationPlatform(profile);
    const type = trimText(profile?.type);
    items.push({
      id: `conversation-${chatID}`,
      title,
      subtitle: [platform, type]
        .filter(Boolean)
        .map((value) => value.toUpperCase())
        .join(" · "),
      value: `[${label}](${chatID})`,
      channel: platform,
    });
  }
  return items.sort((left, right) => left.title.localeCompare(right.title));
}

/** A job ID that fits in a reference: "(job:<id>)" ends at the first space or parenthesis. */
function referenceableJobID(value: unknown) {
  const id = trimText(value);
  return id && !/[\s()]/.test(id) ? id : "";
}

/**
 * The saved jobs as picker items, in the list's order: "[title](job:<id>)". The ID is what the
 * reference means, so two jobs with one title stay apart, and the ID shows under each title.
 */
export function jobItemsForTasks(tasks: any[]): PickerItem[] {
  const items: PickerItem[] = [];
  const seen = new Set<string>();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const jobID = referenceableJobID(task?.id);
    if (!jobID || seen.has(jobID)) continue;
    seen.add(jobID);
    const title = trimText(task?.title) || t("markdown_editor_job_untitled");
    const label = safeMentionLabel(title) || jobID;
    const schedule = trimText(task?.at) || trimText(task?.cron);
    const disabled = task?.enabled === false ? t("markdown_editor_job_disabled") : "";
    items.push({
      id: `job-${jobID}`,
      title,
      subtitle: [schedule, disabled, jobID].filter(Boolean).join(" · "),
      value: `[${label}](job:${jobID})`,
    });
  }
  return items;
}

/** A toolbar button that opens a filterable list in a dialog and inserts the chosen item. */
function PickerButton(props: {
  icon: IconName;
  title: string;
  placeholder: string;
  empty: string;
  items: PickerItem[];
  loading?: boolean;
  disabled?: boolean;
  header?: JSX.Element;
  avatar: (item: PickerItem) => JSX.Element;
  testID: string;
  /** Before the dialog opens; a promise it returns holds the dialog until it settles. */
  onOpen?: () => Promise<void> | void;
  onPick: (item: PickerItem) => void;
}) {
  const open = signal(false);
  const filter = signal("");
  const shown = () => {
    const query = filter().trim().toLowerCase();
    if (!query) return props.items;
    return props.items.filter((item) => [item.title, item.subtitle].some((text) => text.toLowerCase().includes(query)));
  };
  return (
    <>
      <TipButton
        disabled={props.disabled}
        onPress={() => {
          const show = () =>
            batch(() => {
              filter.set("");
              open.set(true);
            });
          const ready = props.onOpen?.();
          if (ready) void ready.then(show);
          else show();
        }}
        accessibilityLabel={props.title}
        testID={props.testID}
        tooltip={
          <Tip text={props.title} />
        }
        class={`size-9 items-center justify-center ${TOOLBAR_CORNERS} transition-colors duration-120 hover:bg-blue/6 active:bg-blue/10 disabled:opacity-45`}
      >
        <Icon name={props.icon} size={18} color="subtle" />
      </TipButton>
      <Modal open={open()} onClose={() => open.set(false)} title={props.title} size="sm" testID={`${props.testID}-dialog`}>
        {props.header}
        <TextField value={filter()} onChange={(value) => filter.set(value)} placeholder={props.placeholder} leadingIcon="PhMagnifyingGlass" autoFocus />
        <If when={!props.loading} else={<Text class="py-4 text-center text-sm text-muted-foreground">…</Text>}>
          <If when={shown().length > 0} else={<Text class="py-4 text-center text-sm text-muted-foreground">{props.empty}</Text>}>
            <View class="gap-0.5">
              <Each of={shown()} key={(item) => item.id}>
                {(item) => (
                  <BaseButton
                    onPress={() => {
                      open.set(false);
                      props.onPick(item());
                    }}
                    accessibilityLabel={item().title}
                    class={PICKER_ROW_CLASS}
                  >
                    {props.avatar(item())}
                    <View class="flex-1 min-w-0">
                      <Text class="text-sm text-foreground" style={{ numberOfLines: 1 }}>
                        {item().title}
                      </Text>
                      <If when={item().subtitle}>
                        <Text class="font-mono text-xs text-muted-foreground">{item().subtitle}</Text>
                      </If>
                    </View>
                  </BaseButton>
                )}
              </Each>
            </View>
          </If>
        </If>
      </Modal>
    </>
  );
}

export type AppMarkdownEditorProps = MarkdownEditorProps;

/** The MarkdownEditor with the mention, conversation and job pickers in its toolbar. */
export function AppMarkdownEditor(props: AppMarkdownEditorProps) {
  let inner: MarkdownEditorApi | undefined;
  const contactsStore = useContactsStore();
  const conversationItems = signal<PickerItem[]>([]);
  const conversationsError = signal("");
  const conversationsLoading = signal(false);
  // The chosen channel tab is kept while the editor lives, so the next pick starts there.
  const conversationTabID = signal("");
  let conversationsSeq = 0;
  const jobItems = signal<PickerItem[]>([]);
  const jobsError = signal("");
  const jobsLoading = signal(false);
  let jobsSeq = 0;

  const endpointRef = () => trimText(endpointState.selectedRef);
  const mentionItems = () => mentionItemsForContacts(contactsStore.items);
  const conversationTabs = () => channelTabs(conversationItems()) as { id: string; title: string }[];
  const conversationTab = () => activeChannelTab(conversationTabs(), conversationTabID()) as { id: string; title: string } | null;
  const visibleConversations = () => itemsForChannelTab(conversationItems(), conversationTab()?.id) as PickerItem[];
  const locked = () => Boolean(props.disabled || props.readOnly);

  const loadContacts = () => {
    void (contactsStore.load({ perfSource: "markdown-editor-toolbar" }) as Promise<unknown>).catch((error: unknown) =>
      console.warn("[AppMarkdownEditor] contacts load failed", error),
    );
  };

  const loadConversations = async () => {
    if (conversationsLoading()) return;
    const ref = endpointRef();
    const seq = ++conversationsSeq;
    conversationsError.set("");
    if (!ref) {
      batch(() => {
        conversationItems.set([]);
        conversationsLoading.set(false);
      });
      return;
    }
    conversationsLoading.set(true);
    try {
      const data: any = await runtimeApiFetchForEndpoint(ref, "/contacts/chat-profile", { perfSource: "markdown-editor-toolbar" });
      if (seq !== conversationsSeq) return;
      conversationItems.set(conversationItemsForProfiles(data?.items));
    } catch (error: any) {
      if (seq !== conversationsSeq) return;
      console.warn("[AppMarkdownEditor] conversations load failed", error);
      batch(() => {
        conversationItems.set([]);
        conversationsError.set(error?.message || "failed to load conversations");
      });
    } finally {
      if (seq === conversationsSeq) conversationsLoading.set(false);
    }
  };

  // The saved jobs, read each time the list opens: a job added or renamed since shows as it is now.
  const loadJobs = async () => {
    if (jobsLoading()) return;
    const ref = endpointRef();
    const seq = ++jobsSeq;
    jobsError.set("");
    if (!ref) {
      batch(() => {
        jobItems.set([]);
        jobsLoading.set(false);
      });
      return;
    }
    jobsLoading.set(true);
    try {
      const data: any = await runtimeApiFetchForEndpoint(ref, "/todo/tasks", { perfSource: "markdown-editor-toolbar" });
      if (seq !== jobsSeq) return;
      jobItems.set(jobItemsForTasks(data?.tasks));
    } catch (error: any) {
      if (seq !== jobsSeq) return;
      console.warn("[AppMarkdownEditor] jobs load failed", error);
      batch(() => {
        jobItems.set([]);
        jobsError.set(error?.message || "failed to load jobs");
      });
    } finally {
      if (seq === jobsSeq) jobsLoading.set(false);
    }
  };

  // A new agent: its contacts, and no conversations or jobs until their list is opened.
  effect(() => {
    void endpointRef();
    untracked(() => {
      loadContacts();
      conversationsSeq += 1;
      jobsSeq += 1;
      batch(() => {
        conversationItems.set([]);
        conversationsError.set("");
        conversationsLoading.set(false);
        jobItems.set([]);
        jobsError.set("");
        jobsLoading.set(false);
      });
    });
  });

  const insertReference = (item: PickerItem) => {
    const reference = trimText(item?.value);
    if (reference) void inner?.insertAtCursor(reference, { spacing: true });
  };

  return (
    <MarkdownEditor
      {...props}
      editorRef={(api) => {
        inner = api;
        props.editorRef?.(api);
      }}
      toolbar={
        <>
          <PickerButton
            icon="PhUserCircle"
            title={t("markdown_editor_mention")}
            placeholder={t("markdown_editor_mention_placeholder")}
            empty={contactsStore.error ? t("markdown_editor_mention_load_failed") : t("markdown_editor_mention_empty")}
            items={mentionItems()}
            loading={contactsStore.loading && mentionItems().length === 0}
            disabled={locked()}
            testID="markdown-editor-mention"
            onOpen={() => inner?.holdCaret()}
            avatar={(item) => <ContactAvatar item={item.contact} name={item.title} endpointRef={endpointRef()} class="size-7" />}
            onPick={insertReference}
          />
          <PickerButton
            icon="PhChat"
            title={t("markdown_editor_conversation")}
            placeholder={t("markdown_editor_conversation_placeholder")}
            empty={conversationsError() ? t("markdown_editor_conversation_load_failed") : t("markdown_editor_conversation_empty")}
            items={visibleConversations()}
            loading={conversationsLoading() && conversationItems().length === 0}
            disabled={locked()}
            testID="markdown-editor-conversation"
            onOpen={() => {
              void loadConversations();
              return inner?.holdCaret();
            }}
            header={
              <If when={conversationTabs().length > 0}>
                <View class="flex-row gap-1 border-b border-line-faint" role="tablist" accessibilityLabel={t("markdown_editor_conversation_channels")}>
                  <Each of={conversationTabs()} key={(tab) => tab.id}>
                    {(tab) => (
                      <BaseButton
                        role="tab"
                        selected={conversationTab()?.id === tab().id}
                        onPress={() => conversationTabID.set(tab().id)}
                        accessibilityLabel={tab().title}
                        class="-mb-px flex-1 items-center border-b-2 border-transparent py-2 hover:bg-hover selected:border-blue"
                      >
                        <If when={CHANNEL_LOGOS[tab().id]} else={<Text class="text-xs text-subtle">{tab().title}</Text>}>
                          <Image src={CHANNEL_LOGOS[tab().id]} style={{ width: 18, height: 18 }} />
                        </If>
                      </BaseButton>
                    )}
                  </Each>
                </View>
              </If>
            }
            avatar={(item) => (
              <View class="size-7 items-center justify-center overflow-hidden rounded-full bg-paper">
                <If
                  when={item.channel && CHANNEL_LOGOS[item.channel]}
                  else={<Text class="text-xs font-semibold text-blue">{Array.from(item.title)[0]?.toUpperCase() || "?"}</Text>}
                >
                  <Image src={CHANNEL_LOGOS[item.channel || ""]} style={{ width: 18, height: 18 }} />
                </If>
              </View>
            )}
            onPick={insertReference}
          />
          <PickerButton
            icon="PhListChecks"
            title={t("markdown_editor_job")}
            placeholder={t("markdown_editor_job_placeholder")}
            empty={jobsError() ? t("markdown_editor_job_load_failed") : t("markdown_editor_job_empty")}
            items={jobItems()}
            loading={jobsLoading() && jobItems().length === 0}
            disabled={locked()}
            testID="markdown-editor-job"
            onOpen={() => {
              void loadJobs();
              return inner?.holdCaret();
            }}
            avatar={() => (
              <View class="size-7 items-center justify-center overflow-hidden rounded-full bg-paper">
                <Icon name="PhListChecks" size={16} color="blue" />
              </View>
            )}
            onPick={insertReference}
          />
          {props.toolbar}
        </>
      }
    />
  );
}
