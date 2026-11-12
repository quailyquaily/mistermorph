// What the agent remembers (web/console/src/views/MemoriesView.js). Laid out as Contacts and TODO
// are: the subjects in an index column, and what is picked beside them. A subject shows its rules and
// facts, with who may hear each one up front; Journal, after All memories, is the raw record,
// searched, or the events a memory came from. On a phone the index and the picked view take turns,
// with a back button.
import type { JSX } from "nsh";
import { batch, computed, effect, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton, DatePicker } from "nsh/base";
import {
  Blocks,
  DetailCard,
  gutterX,
  gutterY,
  IndexColumn,
  IndexDivider,
  IndexRow,
  InlineNotice,
  MobileBar,
  Note,
  RowCount,
  SearchField,
  t,
  TurnCaret,
} from "../../components/knowledge/parts";
import { createSlidingSelection, EdgeScroll, MOTION_EASE_CSS, MOTION_NORMAL, motionMs } from "../../components/motion";
import { bottomSheetStyle, Button, Icon, MessageDialog, Modal, Page, SelectField, TextField, type IconName } from "../../components/ui";
import { currentLocale, endpointState, formatShortTime, runtimeApiFetch } from "../../lib/core/context.js";
import { endpointRoutePath } from "../../lib/core/endpoint-routes.js";
import {
  isClaim,
  isRule,
  journalDays,
  matchesQuery,
  memorySections,
  subjectID,
  subjectKind,
  subjectsOf,
} from "../../lib/core/memories-view.js";
import { currentRoute, navigate } from "../../lib/router";
import { createPaneStack } from "../../components/motion/PaneStack";
import { isMobile, markMobileDetail } from "../../lib/shell";
import { useContactsStore } from "../../lib/stores/contactsStore.js";
import { MobileBarSpacer } from "../../components/frame/mobileBar";

const VISIBILITIES = ["private", "conversation", "public"] as const;
const TYPES = ["person", "feedback", "context", "reference"];

export interface Memory {
  id: string;
  name?: string;
  subject: string;
  type: string;
  visibility: string;
  description: string;
  body: string;
  told_by?: string;
  learned_in?: string;
  updated_at?: string;
  source_events?: string[];
}

interface JournalEvent {
  id: string;
  seq?: number | string;
  time: string;
  text?: string;
  audience?: string;
  trace?: { topic_id?: string; runtime?: string; task_id?: string };
}

interface Draft {
  type: string;
  description: string;
  body: string;
  visibility: string;
}

// The color of a visibility: private is plain, a conversation green, public orange.
const VISIBILITY_MARK: Record<string, string> = { private: "bg-subtle", conversation: "bg-ok", public: "bg-warn-dark" };
const AUDIENCE_MARK: Record<string, string> = { owner: "bg-blue", contact: "bg-blue-lighter", conversation: "bg-ok", general: "bg-blue" };

function kindIcon(kind: string): IconName {
  switch (kind) {
    case "all":
      return "PhListBullets";
    case "general":
      return "PhGlobe";
    case "conversation":
      return "PhHash";
    default:
      return "PhUserCircle";
  }
}

function safeFormat(options: Intl.DateTimeFormatOptions, value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  try {
    return new Intl.DateTimeFormat(currentLocale(), options).format(date);
  } catch {
    return date.toLocaleString();
  }
}

export function MemoriesPage() {
  const contactsStore = useContactsStore();
  const subjectQuery = computed(() => String(currentRoute().query.subject || ""));

  const err = signal("");
  const loading = signal(false);
  const loaded = signal(false);
  const items = signal<Memory[]>([]);
  const query = signal("");
  const subject = signal(untracked(subjectQuery));
  const expanded = signal("");

  const editTarget = signal<Memory | null>(null);
  const draft = signal<Draft>({ type: "", description: "", body: "", visibility: "" });
  const saving = signal(false);
  const editErr = signal("");
  const deleteTarget = signal<Memory | null>(null);
  const deleteDialogOpen = signal(false);
  const publicTarget = signal("");
  const visibilityBusy = signal("");

  const view = signal<"memories" | "journal">("memories");
  const onJournal = () => view() === "journal";

  // A link to one subject opens on it, on a phone too.
  const mobileDetailVisible = signal(Boolean(untracked(subjectQuery)));
  const showIndexPane = () => !isMobile() || !mobileDetailVisible();
  const showMainPane = () => !isMobile() || mobileDetailVisible();
  const mobileShowBack = () => isMobile() && mobileDetailVisible();
  // A subject or the journal is not the navigation's page: the bottom navigation steps aside.
  markMobileDetail(mobileShowBack);
  const mobileBarTitle = () => {
    if (!mobileShowBack()) return t("memories_title");
    if (onJournal()) return t("memories_tab_journal");
    return subject() ? subjectTitle(subject()) : t("memories_all_subjects");
  };

  effect(() => {
    if (!isMobile()) untracked(() => mobileDetailVisible.set(false));
  });
  // On phones the index (0) and a subject or the journal (1) are levels of the page that slide
  // (PaneStack); the detail keeps its bar while it goes out.
  const panes = createPaneStack(() => (isMobile() ? (mobileDetailVisible() ? 1 : 0) : null));
  const heldBarTitle = panes.held(1, mobileBarTitle);

  const showIndexView = () => mobileDetailVisible.set(false);
  function pickSubject(value: string) {
    batch(() => {
      view.set("memories");
      subject.set(value);
      mobileDetailVisible.set(true);
    });
  }
  function pickJournal() {
    batch(() => {
      view.set("journal");
      mobileDetailVisible.set(true);
    });
  }

  const journalQuery = signal("");
  const journalSince = signal("");
  const journalLoading = signal(false);
  const journalEvents = signal<JournalEvent[]>([]);
  const journalMore = signal(false);
  const journalSearched = signal(false);
  const sourcesOf = signal<Memory | null>(null);

  const contactNames = computed(() => {
    const names = new Map<string, string>();
    for (const contact of (contactsStore.items || []) as { contact_id?: string; nickname?: string }[]) {
      const id = String(contact?.contact_id || "").trim();
      const name = String(contact?.nickname || "").trim();
      if (id && name) names.set(id, name);
    }
    return names;
  });
  const contactName = (id: string) => contactNames().get(id) || id;

  function subjectTitle(value: string) {
    switch (subjectKind(value)) {
      case "owner":
        return t("memories_subject_owner");
      case "general":
        return t("memories_subject_general");
      case "contact":
        return contactNames().get(subjectID(value)) || subjectID(value);
      case "conversation":
        return subjectID(value);
    }
    return value || t("memories_all_subjects");
  }

  function subjectMeta(value: string) {
    switch (subjectKind(value)) {
      case "owner":
        return t("memories_meta_owner");
      case "general":
        return t("memories_meta_general");
      case "contact":
        return contactNames().has(subjectID(value)) ? subjectID(value) : t("memories_kind_contact");
      case "conversation":
        return t("memories_kind_conversation");
    }
    return t("memories_meta_all");
  }

  function subjectLine(value: string) {
    switch (subjectKind(value)) {
      case "owner":
        return t("memories_line_owner");
      case "general":
        return t("memories_line_general");
      case "contact":
        return t("memories_line_contact", { value: subjectTitle(value) });
      case "conversation":
        return t("memories_line_conversation");
    }
    return t("memories_owner_note");
  }

  // audienceLabel names where something was heard: you, someone's DM, or a conversation.
  function audienceLabel(value: string) {
    switch (subjectKind(value)) {
      case "contact":
        return t("memories_audience_contact", { value: contactName(subjectID(value)) });
      case "conversation":
        return subjectID(value);
    }
    return t("memories_learned_owner");
  }

  function learnedText(item: Memory) {
    if (item.told_by && !isClaim(item)) return t("memories_in_own_words", { value: contactName(item.told_by) });
    return t("memories_learned_in", { value: audienceLabel(item.learned_in || "") });
  }

  // countText picks the key's _one or _many form.
  const countText = (key: string, count: number) => t(count === 1 ? `${key}_one` : `${key}_many`, { count });

  const filtered = computed(() =>
    items().filter((item) => matchesQuery(item, query(), [subjectTitle(item.subject), contactName(item.told_by || "")])),
  );

  const indexItems = computed(() => {
    const all = filtered();
    const rows: { subject: string; kind: string; list: Memory[] }[] = [{ subject: "", kind: "all", list: all }];
    // You and General are listed before anything is saved about them.
    for (const entry of subjectsOf(items(), ["owner", "general"]) as { subject: string; kind: string }[]) {
      rows.push({ subject: entry.subject, kind: entry.kind, list: all.filter((item) => item.subject === entry.subject) });
    }
    if (subject() && !rows.some((row) => row.subject === subject())) {
      rows.push({ subject: subject(), kind: subjectKind(subject()), list: [] });
    }
    let lastGroup = "";
    return rows.map((row) => {
      const group =
        row.kind === "owner" || row.kind === "general" ? "owner" : row.kind === "contact" ? "contacts" : row.kind === "conversation" ? "groups" : "";
      const divider = group && group !== lastGroup ? t(`memories_index_${group}`) : "";
      if (group) lastGroup = group;
      return {
        key: row.subject || "all",
        subject: row.subject,
        kind: row.kind,
        divider,
        title: subjectTitle(row.subject),
        meta: subjectMeta(row.subject),
        count: String(row.list.length),
        active: row.subject === subject(),
      };
    });
  });

  const sections = computed(() =>
    (memorySections(filtered(), subject()) as { key: string; subject?: string; items: Memory[] }[]).map((section) => {
      if (section.subject !== undefined) {
        const rules = section.items.filter(isRule).length;
        const count = [countText("memories_count_memory", section.items.length), rules ? countText("memories_count_rule", rules) : ""]
          .filter(Boolean)
          .join(", ");
        const kind = subjectKind(section.subject);
        return {
          ...section,
          title: subjectTitle(section.subject),
          meta: `${subjectMeta(section.subject)} · ${count}`,
          literal: kind !== "owner" && kind !== "general",
        };
      }
      return { ...section, title: t(`memories_section_${section.key}`), meta: t(`memories_section_${section.key}_meta`), literal: false };
    }),
  );
  const filterActive = () => Boolean(query().trim() || subject());

  const typeOptions = () => TYPES.map((value) => ({ value, label: t(`memories_type_${value}`) }));
  const visibilityOptions = () => VISIBILITIES.map((value) => ({ value, label: t(`memories_visibility_${value}`) }));
  const editValid = () => draft().description.trim() !== "" && !/[\r\n]/.test(draft().description) && draft().body.trim() !== "";

  async function load() {
    if (!endpointState.selectedRef) {
      items.set([]);
      return;
    }
    batch(() => {
      loading.set(true);
      err.set("");
    });
    try {
      const data = await runtimeApiFetch("/memories");
      items.set(Array.isArray(data?.items) ? data.items : []);
    } catch (e: any) {
      err.set(e?.message || t("msg_load_failed"));
    } finally {
      batch(() => {
        loading.set(false);
        loaded.set(true);
      });
    }
    // Names for contact subjects; the page works without them.
    contactsStore.load({ endpointRef: endpointState.selectedRef }).catch((e: any) => console.warn("contacts for memories:", e?.message));
  }

  function toggle(item: Memory) {
    batch(() => {
      expanded.update((id) => (id === item.id ? "" : item.id));
      publicTarget.set("");
    });
  }

  function replaceItem(next: Memory | undefined) {
    if (next) items.update((list) => list.map((item) => (item.id === next.id ? next : item)));
  }

  async function setVisibility(item: Memory, visibility: string) {
    if (item.visibility === visibility || untracked(visibilityBusy)) return;
    // Public reaches every DM and group: it is confirmed first.
    if (visibility === "public" && untracked(publicTarget) !== item.id) {
      publicTarget.set(item.id);
      return;
    }
    batch(() => {
      publicTarget.set("");
      visibilityBusy.set(item.id);
      err.set("");
    });
    try {
      const data = await runtimeApiFetch("/memories", { method: "PUT", body: { id: item.id, visibility } });
      replaceItem(data?.item);
    } catch (e: any) {
      err.set(e?.message || t("msg_save_failed"));
    } finally {
      visibilityBusy.set("");
    }
  }

  function startEdit(item: Memory) {
    batch(() => {
      editTarget.set(item);
      editErr.set("");
      draft.set({ type: item.type, description: item.description, body: item.body, visibility: item.visibility });
    });
  }

  function closeEdit() {
    if (!untracked(saving)) editTarget.set(null);
  }

  async function saveEdit() {
    const id = untracked(editTarget)?.id;
    if (!id || untracked(saving) || !untracked(editValid)) return;
    batch(() => {
      saving.set(true);
      editErr.set("");
    });
    try {
      const now = untracked(draft);
      const data = await runtimeApiFetch("/memories", {
        method: "PUT",
        body: { id, ...now, description: now.description.trim(), body: now.body.trim() },
      });
      replaceItem(data?.item);
      editTarget.set(null);
    } catch (e: any) {
      editErr.set(e?.message || t("msg_save_failed"));
    } finally {
      saving.set(false);
    }
  }

  function confirmDelete(item: Memory) {
    batch(() => {
      deleteTarget.set(item);
      deleteDialogOpen.set(true);
    });
  }

  async function deleteMemory() {
    const target = untracked(deleteTarget);
    deleteDialogOpen.set(false);
    if (!target) return;
    err.set("");
    try {
      await runtimeApiFetch(`/memories?id=${encodeURIComponent(target.id)}`, { method: "DELETE" });
      items.update((list) => list.filter((entry) => entry.id !== target.id));
    } catch (e: any) {
      err.set(e?.message || t("msg_delete_failed"));
    } finally {
      deleteTarget.set(null);
    }
  }

  function sourceLabel(item: Memory) {
    const count = Array.isArray(item.source_events) ? item.source_events.length : 0;
    return count ? countText("memories_count_source", count) : t("memories_no_source");
  }

  async function fetchJournal(params: URLSearchParams) {
    batch(() => {
      journalLoading.set(true);
      err.set("");
    });
    try {
      params.set("limit", "50");
      const data = await runtimeApiFetch(`/journal/search?${params.toString()}`);
      batch(() => {
        journalEvents.set(Array.isArray(data?.events) ? data.events : []);
        journalMore.set(Boolean(data?.has_more));
        journalSearched.set(true);
      });
    } catch (e: any) {
      err.set(e?.message || t("msg_load_failed"));
    } finally {
      journalLoading.set(false);
    }
  }

  function searchJournal() {
    sourcesOf.set(null);
    const params = new URLSearchParams();
    const text = untracked(journalQuery).trim();
    if (text) params.set("q", text);
    const since = untracked(journalSince);
    if (since) params.set("since", since);
    void fetchJournal(params);
  }

  function showSources(item: Memory) {
    const ids = Array.isArray(item.source_events) ? item.source_events : [];
    if (!ids.length) return;
    batch(() => {
      sourcesOf.set(item);
      view.set("journal");
    });
    void fetchJournal(new URLSearchParams({ ids: ids.join(",") }));
  }

  function backToMemory() {
    const item = untracked(sourcesOf);
    batch(() => {
      sourcesOf.set(null);
      view.set("memories");
      if (item) {
        subject.set(item.subject);
        expanded.set(item.id);
      }
    });
  }

  function clearSources() {
    batch(() => {
      sourcesOf.set(null);
      journalEvents.set([]);
      journalSearched.set(false);
    });
  }

  // Which memory each event led to, so the journal can point back.
  const rememberedBy = computed(() => {
    const byEvent = new Map<string, Memory>();
    for (const item of items()) {
      for (const id of item.source_events || []) if (!byEvent.has(id)) byEvent.set(id, item);
    }
    return byEvent;
  });

  function openMemory(item: Memory) {
    batch(() => {
      view.set("memories");
      sourcesOf.set(null);
      subject.set(item.subject);
      expanded.set(item.id);
    });
  }

  const days = computed(
    () =>
      journalDays(
        journalEvents().map((event) => ({
          ...event,
          clock: safeFormat({ hour: "2-digit", minute: "2-digit" }, event.time),
          audienceText: audienceLabel(event.audience || "owner"),
          audienceKind: subjectKind(event.audience || "owner"),
          chatPath:
            event.trace?.topic_id && event.trace?.runtime === "console"
              ? endpointRoutePath(endpointState.selectedRef, `/chat/${encodeURIComponent(event.trace.topic_id)}`)
              : "",
          memory: sourcesOf() ? null : rememberedBy().get(event.id) || null,
        })),
        (time: string) => safeFormat({ weekday: "short", month: "short", day: "numeric" }, time),
      ) as {
        label: string;
        events: (JournalEvent & { clock: string; audienceText: string; audienceKind: string; chatPath: string; memory: Memory | null })[];
      }[],
  );

  function clearFilters() {
    batch(() => {
      query.set("");
      subject.set("");
    });
  }

  effect(() => {
    void endpointState.selectedRef;
    untracked(() => void load());
  });
  // A link to a subject (from Contacts) picks it; dropping it shows all.
  let firstSubject = true;
  effect(() => {
    const value = subjectQuery();
    if (firstSubject) {
      firstSubject = false;
      return;
    }
    untracked(() => {
      if (value) pickSubject(value);
      else subject.set("");
    });
  });

  // The index as one flat list (dividers and rows side by side), so its rows are siblings of the
  // gliding highlight (Vue: v-sliding-selection on .memories-index-list).
  type IndexEntry = {
    key: string;
    label?: string;
    row?: { key: string; testID: string; icon: IconName; title: string; meta: string; count?: string; active: boolean; onPress: () => void };
  };
  const indexEntries = computed<IndexEntry[]>(() => {
    const out: IndexEntry[] = [];
    for (const row of indexItems()) {
      if (row.divider) out.push({ key: `divider:${row.divider}`, label: row.divider });
      out.push({
        key: row.key,
        row: {
          key: row.key,
          testID: `memories-subject:${row.key}`,
          icon: kindIcon(row.kind),
          title: row.title,
          meta: row.meta,
          count: row.count,
          active: !onJournal() && row.active,
          onPress: () => pickSubject(row.subject),
        },
      });
      if (row.kind === "all") {
        out.push({
          key: "journal",
          row: {
            key: "journal",
            testID: "memories-journal",
            icon: "PhClockCounterClockwise",
            title: t("memories_tab_journal"),
            meta: t("memories_journal_item_meta"),
            active: onJournal(),
            onPress: pickJournal,
          },
        });
      }
    }
    return out;
  });
  // Unlike Skills and Contacts, the picked subject stays marked on a phone too (Vue does the same).
  const activeIndexKey = () => {
    if (onJournal()) return "journal";
    return indexItems().find((row) => row.active)?.key ?? null;
  };
  const sliding = createSlidingSelection(activeIndexKey);

  return (
    <Page hideBar scroll={false} testID="memories-page">
      <View class="flex-1 flex-row">
        <If when={panes.shown(0, showIndexPane())}>
          <IndexColumn
            title={t("memories_title")}
            label={t("memories_index_label")}
            fill={isMobile()}
            style={panes.style(0)}
            hidden={panes.hidden(0)}
            testID="memories-index"
            top={
              <SearchField
                value={query()}
                onChange={(value) => query.set(value)}
                placeholder={t("memories_search")}
                icon={false}
                testID="memories-search"
              />
            }
          >
            <If when={!(loading() && !loaded())} else={<Blocks count={4} height={52} class={isMobile() ? "px-4" : ""} />}>
              <sliding.Highlight class="rounded-(--radius) bg-selection" />
              <Each of={indexEntries()} key={(entry) => entry.key}>
                {(entry) => (
                  <If
                    when={entry().row}
                    else={<IndexDivider label={entry().label ?? ""} class="pt-3.5" />}
                  >
                    {(row) => (
                      <IndexRow
                        testID={row().testID}
                        icon={row().icon}
                        title={row().title}
                        meta={row().meta}
                        active={row().active}
                        sliding
                        onLayout={sliding.track(row().key)}
                        onPress={() => row().onPress()}
                        trailing={row().count !== undefined ? <RowCount value={row().count!} /> : undefined}
                      />
                    )}
                  </If>
                )}
              </Each>
            </If>
          </IndexColumn>
        </If>

        <If when={panes.shown(1, showMainPane())}>
          <View
            class="flex-1"
            style={panes.style(1)}
            accessibilityElementsHidden={panes.hidden(1) || undefined}
            importantForAccessibility={panes.hidden(1) ? "no-hide-descendants" : undefined}
          >
            <If when={isMobile()}>
              <MobileBar title={heldBarTitle()} backLabel={t("memories_title")} onBack={panes.hidden(1) ? undefined : showIndexView} />
            </If>
            <EdgeScroll
              class="flex-1"
              contentClass="gap-5"
              style={
                isMobile()
                  ? { paddingLeft: gutterX(), paddingRight: gutterX(), paddingTop: 16 }
                  : // None at the left: the cards meet the index's column, whose rows then sit its
                    // 16pt gutter from them as from the sidebar on the other side.
                    { paddingRight: gutterX(), paddingTop: 18 }
              }
              testID="memories-main"
            >
              <If when={err()}>
                <InlineNotice type="error" text={err()} testID="memories-error" />
              </If>
              <If
                when={!onJournal()}
                else={
                  <View class="gap-4">
                    <View class="flex-row flex-wrap items-center gap-2.5">
                      <TextField
                        value={journalQuery()}
                        onChange={(value) => journalQuery.set(value)}
                        onSubmit={searchJournal}
                        placeholder={t("memories_journal_search")}
                        accessibilityLabel={t("memories_journal_search")}
                        leadingIcon="PhMagnifyingGlass"
                        size="sm"
                        testID="journal-search"
                        class="min-w-65 flex-[2]"
                      />
                      <SinceField value={journalSince()} onChange={(value) => journalSince.set(value)} />
                      <Button variant="outlined" size="sm" label={t("memories_journal_go")} loading={journalLoading()} onPress={searchJournal} testID="journal-go" />
                    </View>

                    <If when={sourcesOf()}>
                      {(item) => (
                        <Banner label={t("memories_sources_title")} text={t("memories_sources_for", { value: item().description })}>
                          <Button variant="outlined" size="sm" label={t("memories_back_to_memory")} onPress={backToMemory} testID="journal-back-to-memory" />
                          <Button variant="plain" size="sm" label={t("memories_show_all")} onPress={clearSources} testID="journal-show-all" />
                        </Banner>
                      )}
                    </If>

                    <If when={!journalSearched()}>
                      <Note text={t("memories_journal_meta")} class="max-w-[620px] leading-normal" />
                    </If>
                    <If when={journalSearched() && !days().length}>
                      <View class="items-center px-4 py-10">
                        <Text class="text-center text-sm leading-normal text-muted-foreground">{t("memories_journal_empty")}</Text>
                      </View>
                    </If>
                    <Each of={days()} key={(day) => day.label}>
                      {(day) => (
                        <SectionCard title={day().label} meta={countText("memories_count_event", day().events.length)}>
                          <Each of={day().events} key={(event) => String(event.seq ?? event.id)}>
                            {(event, index) => (
                              <View
                                class={`flex-row items-start gap-4 px-4 py-3 ${index() === 0 ? "" : "border-t border-line-soft"} ${sourcesOf() ? "bg-[#dc892014]" : ""}`}
                                testID={`journal-event:${event().id}`}
                              >
                                <Text class="w-[72px] pt-0.5 font-mono text-xs tabular-nums text-muted-foreground">{event().clock}</Text>
                                <If when={!isMobile()}>
                                  <JournalAudience kind={event().audienceKind} text={event().audienceText} />
                                </If>
                                <View class="flex-1 gap-1.5">
                                  <If when={isMobile()}>
                                    <JournalAudience kind={event().audienceKind} text={event().audienceText} />
                                  </If>
                                  <View selectable>
                                    <Text class="text-sm leading-[17.1px] text-foreground" style={{ numberOfLines: 4 }}>
                                      {event().text || t("memories_journal_no_text")}
                                    </Text>
                                  </View>
                                  <View class="flex-row flex-wrap items-center gap-x-4 gap-y-1">
                                    <If when={event().chatPath}>
                                      <Text
                                        role="link"
                                        class="font-mono text-[11px] text-muted-foreground hover:text-foreground"
                                        onPress={() => void navigate(event().chatPath)}
                                      >
                                        {`${event().trace?.task_id || t("memories_open_chat")} ↗`}
                                      </Text>
                                    </If>
                                    <If when={!event().chatPath && event().trace?.task_id}>
                                      <Text class="font-mono text-[11px] text-muted-foreground">{event().trace?.task_id ?? ""}</Text>
                                    </If>
                                    <If when={event().memory}>
                                      {(memory) => (
                                        <Text role="button" class="text-xs text-blue underline hover:text-ink" onPress={() => openMemory(memory())}>
                                          {t("memories_remembered_as", { value: memory().description })}
                                        </Text>
                                      )}
                                    </If>
                                  </View>
                                </View>
                              </View>
                            )}
                          </Each>
                        </SectionCard>
                      )}
                    </Each>
                    <If when={journalMore()}>
                      <Note text={t("memories_journal_more")} class="max-w-[620px] leading-normal" />
                    </If>
                  </View>
                }
              >
                <If when={!(loading() && !loaded())} else={<Blocks count={3} height={96} />}>
                  <View class="gap-0.5">
                    {/* The phone's page bar names the subject already. */}
                    <If when={!isMobile()}>
                      <View selectable>
                        <Text class="text-lg font-semibold leading-normal tracking-[-0.01em] text-foreground" role="header">
                          {subject() ? subjectTitle(subject()) : t("memories_all_subjects")}
                        </Text>
                      </View>
                    </If>
                    <Text class="max-w-[520px] text-xs leading-normal text-muted-foreground">{subjectLine(subject())}</Text>
                  </View>

                  <If when={!items().length}>
                    <View class="items-center gap-2.5 px-4 py-14" testID="memories-empty">
                      <Icon name="PhBrain" size={28} color="muted-foreground" />
                      <Text class="max-w-[360px] text-center text-sm leading-normal text-muted-foreground">{t("memories_empty")}</Text>
                    </View>
                  </If>
                  <If when={items().length > 0 && !sections().length}>
                    <View class="items-center gap-2.5 px-4 py-10">
                      <Text class="text-center text-sm leading-normal text-muted-foreground">{t("memories_no_match")}</Text>
                      <If when={filterActive()}>
                        <Button variant="outlined" size="sm" label={t("logs_clear_filters")} onPress={clearFilters} testID="memories-clear-filters" />
                      </If>
                    </View>
                  </If>

                  <Each of={sections()} key={(section) => section.key}>
                    {(section) => (
                      <SectionCard title={section().title} meta={section().meta} literal={section().literal}>
                        <Each of={section().items} key={(item) => item.id}>
                          {(item, index) => (
                            <MemoryRow
                              item={item()}
                              first={index() === 0}
                              open={expanded() === item().id}
                              busy={visibilityBusy() === item().id}
                              confirmingPublic={publicTarget() === item().id}
                              claimText={isClaim(item()) ? t("memories_says", { value: contactName(item().told_by || "") }) : ""}
                              learnedText={learnedText(item())}
                              sourceLabel={sourceLabel(item())}
                              toldByName={item().told_by ? contactName(item().told_by!) : ""}
                              onToggle={() => toggle(item())}
                              onVisibility={(value) => void setVisibility(item(), value)}
                              onCancelPublic={() => publicTarget.set("")}
                              onSources={() => showSources(item())}
                              onEdit={() => startEdit(item())}
                              onForget={() => confirmDelete(item())}
                            />
                          )}
                        </Each>
                      </SectionCard>
                    )}
                  </Each>
                </If>
              </If>
              <View style={{ height: gutterY() }} />
              <MobileBarSpacer />
            </EdgeScroll>
          </View>
        </If>
      </View>

      <Modal
        open={Boolean(editTarget())}
        onClose={closeEdit}
        title={t("memories_edit_title")}
        closeLabel={t("action_close")}
        testID="memory-edit-dialog"
        footer={
          <>
            <Button variant="outlined" label={t("action_cancel")} disabled={saving()} onPress={closeEdit} />
            <Button
              variant="primary"
              label={t("action_save")}
              loading={saving()}
              disabled={!editValid()}
              onPress={() => void saveEdit()}
              testID="memory-edit-save"
            />
          </>
        }
      >
        <If when={editTarget()}>
          {(target) => (
            <View class="gap-3 pt-2">
              <Text class="font-mono text-[11px] text-muted-foreground">{`${target().subject}/${target().name ?? ""}`}</Text>
              <View class={isMobile() ? "gap-3" : "flex-row gap-3"}>
                <EditField label={t("memories_field_type")} half>
                  <SelectField
                    items={typeOptions()}
                    value={draft().type}
                    onChange={(value) => draft.update((now) => ({ ...now, type: value }))}
                    testID="memory-edit-type"
                  />
                </EditField>
                <EditField label={t("memories_field_visibility")} half>
                  <SelectField
                    items={visibilityOptions()}
                    value={draft().visibility}
                    onChange={(value) => draft.update((now) => ({ ...now, visibility: value }))}
                    testID="memory-edit-visibility"
                  />
                </EditField>
              </View>
              <Text class="-mt-1 text-xs leading-normal text-muted-foreground">{t(`memories_visibility_hint_${draft().visibility}`)}</Text>
              <EditField label={t("memories_field_description")}>
                <TextField
                  accessibilityLabel={t("memories_field_description")}
                  value={draft().description}
                  onChange={(value) => draft.update((now) => ({ ...now, description: value }))}
                  maxLength={200}
                  disabled={saving()}
                  testID="memory-edit-description"
                />
              </EditField>
              <EditField label={t("memories_field_body")}>
                <TextField
                  accessibilityLabel={t("memories_field_body")}
                  value={draft().body}
                  onChange={(value) => draft.update((now) => ({ ...now, body: value }))}
                  multiline
                  rows={6}
                  disabled={saving()}
                  testID="memory-edit-body"
                />
              </EditField>
              <If when={editErr()}>
                <InlineNotice type="error" text={editErr()} testID="memory-edit-error" />
              </If>
            </View>
          )}
        </If>
      </Modal>
      <MessageDialog
        open={deleteDialogOpen()}
        onClose={() => deleteDialogOpen.set(false)}
        icon="PhTrash"
        tone="danger"
        title={t("memories_forget")}
        text={t("memories_delete_confirm", { value: deleteTarget()?.description || "" })}
        testID="memory-delete-dialog"
        actions={[
          { id: "cancel", label: t("action_cancel"), variant: "outlined", onPress: () => deleteDialogOpen.set(false) },
          { id: "delete", label: t("memories_forget"), variant: "danger", onPress: () => void deleteMemory() },
        ]}
      />
    </Page>
  );
}

/** A boxed section whose body is a list of rows (AppSection variant="boxed" is-list): the rows
 * carry their own inset, so the body keeps 4pt above the first and below the last. */
function SectionCard(props: { title: string; meta?: string; literal?: boolean; children?: JSX.Element }) {
  return (
    <DetailCard title={props.title} meta={props.meta} literal={props.literal === true} bodyClass="py-1">
      {props.children}
    </DetailCard>
  );
}

/** The bracketed note with its choices (.memory-confirm): the Make public confirmation, and the
 * Sources banner of the journal. An amber mark and a mono caps label in brackets. */
function Banner(props: { label: string; text: string; children?: JSX.Element }) {
  return (
    <View role="alert" class="flex-row flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-(--radius) border border-[#c9a27a8f] bg-paper-soft px-3 py-2">
      <View class="size-[7px] rounded-[1px] bg-status-pending" />
      <Text class="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-status-pending">
        <Text class="opacity-45">[</Text>
        {props.label}
        <Text class="opacity-45">]</Text>
      </Text>
      <Text class="min-w-65 flex-1 text-xs leading-normal text-foreground">{props.text}</Text>
      {props.children}
    </View>
  );
}

/** Who may hear a memory: a 7pt square mark in the visibility's tone. */
function VisibilityMark(props: { value: string; dim?: boolean }) {
  return <View class={`size-[7px] rounded-[1px] ${VISIBILITY_MARK[props.value] ?? "bg-subtle"} ${props.dim ? "opacity-45" : ""}`} />;
}

// A memory row's fills (Vue .memory-head): hover accent 4 %, an opened row and its more-area 6 %.
const MEMORY_HOVER = "hover:bg-[#426f9e0a]";

function MemoryRow(props: {
  item: Memory;
  first: boolean;
  open: boolean;
  busy: boolean;
  confirmingPublic: boolean;
  claimText: string;
  learnedText: string;
  sourceLabel: string;
  toldByName: string;
  onToggle: () => void;
  onVisibility: (value: string) => void;
  onCancelPublic: () => void;
  onSources: () => void;
  onEdit: () => void;
  onForget: () => void;
}) {
  // A narrow column puts who may hear it above the title, not beside it.
  const stacked = () => isMobile();
  return (
    <View
      class={props.first ? "" : "border-t border-line-soft"}
      testID={`memory:${props.item.id}`}
      style={{ opacity: props.busy ? 0.6 : 1, transitionProperty: "opacity", transitionDuration: motionMs(MOTION_NORMAL), transitionTimingFunction: MOTION_EASE_CSS }}
    >
      <BaseButton
        onPress={() => props.onToggle()}
        accessibilityLabel={props.item.description}
        testID={`memory-head:${props.item.id}`}
        class={`gap-x-4 gap-y-1 px-4 pb-[13px] pt-3.5 ${stacked() ? "" : "flex-row items-start"} ${props.open ? "bg-hover-soft" : MEMORY_HOVER}`}
        style={{ transitionProperty: "colors", transitionDuration: motionMs(MOTION_NORMAL), transitionTimingFunction: MOTION_EASE_CSS }}
      >
        <If when={!stacked()}>
          <View class="w-[104px] flex-row items-center gap-2 pt-0.5">
            <VisibilityMark value={props.item.visibility} />
            <Text class="text-xs leading-normal text-muted-foreground">{t(`memories_visibility_${props.item.visibility}`)}</Text>
          </View>
        </If>
        <View class={`flex-row items-start gap-4 ${stacked() ? "" : "flex-1"}`}>
          <View class="flex-1 gap-1">
            <If when={stacked()}>
              <View class="flex-row items-center gap-2">
                <VisibilityMark value={props.item.visibility} />
                <Text class="text-xs leading-normal text-muted-foreground">{t(`memories_visibility_${props.item.visibility}`)}</Text>
              </View>
            </If>
            <Text class="text-sm font-medium leading-[20.3px] text-foreground">{props.item.description}</Text>
            <Text class="text-xs leading-[21.7px] text-subtle" style={{ numberOfLines: props.open ? 0 : 1 }}>
              {props.claimText ? <Text class="font-semibold text-blue">{`${props.claimText} `}</Text> : null}
              {props.item.body}
            </Text>
            <View class="flex-row flex-wrap gap-x-3 gap-y-0.5">
              <Text class="text-xs leading-normal tabular-nums text-muted-foreground">{t(`memories_type_${props.item.type}`)}</Text>
              <Text class="text-xs leading-normal tabular-nums text-muted-foreground">{props.learnedText}</Text>
              <Text class="text-xs leading-normal tabular-nums text-muted-foreground">{formatShortTime(props.item.updated_at)}</Text>
            </View>
          </View>
          <TurnCaret open={props.open} size={16} duration={MOTION_NORMAL} class="mt-0.5" />
        </View>
      </BaseButton>

      <If when={props.open}>
        <View class={`gap-3.5 bg-hover-soft pb-4 pr-4 pt-1 ${stacked() ? "pl-4" : "pl-[136px]"}`}>
          <View class="flex-row flex-wrap items-center gap-x-3 gap-y-2">
            <Text class="text-xs font-medium text-muted-foreground">{t("memories_who_may_hear")}</Text>
            <View class="h-8 flex-row border border-line-soft bg-background p-0.5" accessibilityLabel={t("memories_field_visibility")}>
              <Each of={[...VISIBILITIES]}>
                {(value) => (
                  <BaseButton
                    onPress={() => props.onVisibility(value())}
                    selected={props.item.visibility === value()}
                    disabled={props.busy}
                    accessibilityLabel={t(`memories_visibility_${value()}`)}
                    testID={`memory-visibility:${props.item.id}:${value()}`}
                    class={`h-[26px] flex-row items-center gap-1.5 px-[11.2px] ${props.item.visibility === value() ? "bg-card" : ""}`}
                    style={{
                      boxShadow: props.item.visibility === value() ? "0 0 0 1px rgba(165, 186, 208, 0.52)" : "none",
                      transitionProperty: "colors, box-shadow",
                      transitionDuration: motionMs(MOTION_NORMAL),
                      transitionTimingFunction: MOTION_EASE_CSS,
                    }}
                  >
                    <VisibilityMark value={value()} dim={props.item.visibility !== value()} />
                    <Text class={`text-xs font-medium ${props.item.visibility === value() ? "text-foreground" : "text-muted-foreground"}`}>
                      {t(`memories_visibility_${value()}`)}
                    </Text>
                  </BaseButton>
                )}
              </Each>
            </View>
            <Text class="min-w-55 flex-1 text-xs leading-normal text-muted-foreground">{t(`memories_visibility_hint_${props.item.visibility}`)}</Text>
          </View>

          <If when={props.confirmingPublic}>
            <Banner
              label={t("memories_visibility_public")}
              text={`${t("memories_public_confirm")}${
                props.item.told_by ? ` ${t("memories_public_confirm_told", { value: props.toldByName })}` : ""
              }`}
            >
              <Button variant="outlined" size="sm" label={t("action_cancel")} onPress={() => props.onCancelPublic()} testID="memory-public-cancel" />
              <Button variant="primary" size="sm" label={t("memories_make_public")} onPress={() => props.onVisibility("public")} testID="memory-public-confirm" />
            </Banner>
          </If>

          <View class="flex-row flex-wrap items-center gap-1.5">
            <Button
              variant="outlined"
              size="sm"
              icon="PhListMagnifyingGlass"
              label={props.sourceLabel}
              disabled={!(props.item.source_events || []).length}
              onPress={() => props.onSources()}
              testID={`memory-sources:${props.item.id}`}
            />
            <Button variant="outlined" size="sm" label={t("action_edit")} onPress={() => props.onEdit()} testID={`memory-edit:${props.item.id}`} />
            <Button variant="ghost-danger" size="sm" label={t("memories_forget")} onPress={() => props.onForget()} testID={`memory-forget:${props.item.id}`} />
            <View selectable class="ml-auto">
              <Text class="font-mono text-[11px] text-muted-foreground">{`${props.item.subject}/${props.item.name ?? ""}`}</Text>
            </View>
          </View>
        </View>
      </If>
    </View>
  );
}

/** The journal's "since" date (an <input type="date"> on the Vue page): a date picker that clears. */
function SinceField(props: { value: string; onChange: (value: string) => void }) {
  return (
    <DatePicker
      value={props.value || null}
      cleanable
      accessibilityLabel={t("memories_journal_since")}
      testID="journal-since"
      onChange={({ value }) => props.onChange(typeof value === "string" ? value.slice(0, 10) : "")}
      offset={4}
      popupClass="rounded-(--radius) border border-border bg-popover p-3 shadow-md"
      popupStyle={bottomSheetStyle(12)}
      backdropClass="bg-scrim"
      headerClass="flex-row items-center justify-between pb-2"
      rowClass="flex-row justify-between"
      itemClass="h-8 min-w-8 items-center justify-center rounded-(--radius) text-sm text-foreground hover:bg-hover focus:bg-hover selected:bg-primary selected:text-primary-foreground disabled:opacity-50"
      clearButtonClass="ml-1 size-6 items-center justify-center rounded-(--radius) hover:bg-hover"
      clearButton={<Icon name="PhX" size={12} color="muted-foreground" />}
      clearButtonAccessibilityLabel={t("audit_clear_filter")}
      trigger={
        <View class="h-9.5 min-w-36 flex-row items-center gap-2 rounded-(--radius) border border-input bg-field px-2.5 hover:border-ring">
          <Icon name="PhCalendarBlank" size={14} color="muted-foreground" />
          <Text class={`text-sm tabular-nums ${props.value ? "text-foreground" : "text-placeholder"}`}>
            {props.value || t("memories_journal_since")}
          </Text>
        </View>
      }
    />
  );
}

/** Where a journal event was heard: mono 11pt with a square mark (owner blue, a contact pale blue, a group green). */
function JournalAudience(props: { kind?: string; text: string }) {
  return (
    <View class={`flex-row items-center gap-[7px] pt-[3px] ${isMobile() ? "" : "w-[150px]"}`}>
      <View class={`size-[7px] rounded-[1px] ${AUDIENCE_MARK[props.kind || "owner"] ?? "bg-blue"}`} />
      <Text class="flex-1 font-mono text-[11px] text-muted-foreground" style={{ numberOfLines: 1 }}>
        {props.text}
      </Text>
    </View>
  );
}

/** A field of the edit dialog under its label: mono 11pt caps (Vue .memory-edit-field > span). */
function EditField(props: { label: string; half?: boolean; children?: JSX.Element }) {
  return (
    <View class={`gap-1.5 ${props.half && !isMobile() ? "flex-1" : ""}`} style={{ minWidth: 0 }}>
      <Text class="font-mono text-[11px] font-medium uppercase leading-[15.4px] tracking-[0.04em] text-muted-foreground">{props.label}</Text>
      {props.children}
    </View>
  );
}
