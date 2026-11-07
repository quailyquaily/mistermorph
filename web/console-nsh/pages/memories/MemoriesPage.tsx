// What the agent remembers (web/console/src/views/MemoriesView.js). Laid out as Contacts and TODO
// are: the subjects in an index column, and what is picked beside them. A subject shows its rules and
// facts, with who may hear each one up front; Journal, after All memories, is the raw record,
// searched, or the events a memory came from. On a phone the index and the picked view take turns,
// with a back button.
import { batch, computed, effect, Scroll, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton, DatePicker } from "nsh/base";
import {
  Blocks,
  IndexColumn,
  IndexDivider,
  IndexRow,
  InlineNotice,
  MobileBar,
  Note,
  SearchField,
  t,
} from "../../components/knowledge/parts";
import { Button, Icon, MessageDialog, Modal, Page, SelectField, TextField, type IconName } from "../../components/ui";
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
import { isMobile } from "../../lib/shell";
import { useContactsStore } from "../../lib/stores/contactsStore.js";

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
const VISIBILITY_TEXT: Record<string, string> = { private: "text-subtle", conversation: "text-ok", public: "text-warn-dark" };
const VISIBILITY_MARK: Record<string, string> = { private: "bg-subtle", conversation: "bg-ok", public: "bg-warn-dark" };
const AUDIENCE_MARK: Record<string, string> = { owner: "bg-subtle", contact: "bg-blue-lighter", conversation: "bg-ok", general: "bg-subtle" };

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
  const mobileBarTitle = () => {
    if (!mobileShowBack()) return t("memories_title");
    if (onJournal()) return t("memories_tab_journal");
    return subject() ? subjectTitle(subject()) : t("memories_all_subjects");
  };

  effect(() => {
    if (!isMobile()) untracked(() => mobileDetailVisible.set(false));
  });

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
        return { ...section, title: subjectTitle(section.subject), meta: `${subjectMeta(section.subject)} · ${count}` };
      }
      return { ...section, title: t(`memories_section_${section.key}`), meta: t(`memories_section_${section.key}_meta`) };
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

  return (
    <Page hideBar scroll={false} testID="memories-page">
      <If when={mobileShowBack()}>
        <MobileBar title={mobileBarTitle()} backLabel={t("memories_title")} onBack={showIndexView} />
      </If>
      <View class="flex-1 flex-row">
        <If when={showIndexPane()}>
          <IndexColumn
            title={t("memories_title")}
            label={t("memories_index_label")}
            fill={isMobile()}
            testID="memories-index"
            top={<SearchField value={query()} onChange={(value) => query.set(value)} placeholder={t("memories_search")} testID="memories-search" />}
          >
            <If
              when={!(loading() && !loaded())}
              else={<Blocks count={4} height={52} />}
            >
              <Each of={indexItems()} key={(row) => row.key}>
                {(row) => (
                  <View class="gap-0.5">
                    <If when={row().divider}>
                      <IndexDivider label={row().divider} />
                    </If>
                    <IndexRow
                      testID={`memories-subject:${row().key}`}
                      icon={kindIcon(row().kind)}
                      title={row().title}
                      meta={row().meta}
                      active={!onJournal() && row().active}
                      onPress={() => pickSubject(row().subject)}
                      trailing={<Text class="font-mono text-xs text-muted-foreground">{row().count}</Text>}
                    />
                    <If when={row().kind === "all"}>
                      <IndexRow
                        testID="memories-journal"
                        icon="PhClockCounterClockwise"
                        title={t("memories_tab_journal")}
                        meta={t("memories_journal_item_meta")}
                        active={onJournal()}
                        onPress={pickJournal}
                      />
                    </If>
                  </View>
                )}
              </Each>
            </If>
          </IndexColumn>
        </If>

        <If when={showMainPane()}>
          <Scroll class="flex-1" contentClass="gap-4 p-5" testID="memories-main">
            <If when={err()}>
              <InlineNotice type="error" text={err()} testID="memories-error" />
            </If>
            <If
              when={!onJournal()}
              else={
                <View class="gap-4">
                  <View class="flex-row flex-wrap items-center gap-2">
                    <SearchField
                      value={journalQuery()}
                      onChange={(value) => journalQuery.set(value)}
                      onSubmit={searchJournal}
                      placeholder={t("memories_journal_search")}
                      testID="journal-search"
                      class="min-w-48 flex-1"
                    />
                    <SinceField value={journalSince()} onChange={(value) => journalSince.set(value)} />
                    <Button variant="outlined" size="sm" label={t("memories_journal_go")} loading={journalLoading()} onPress={searchJournal} testID="journal-go" />
                  </View>

                  <If when={sourcesOf()}>
                    {(item) => (
                      <Banner label={t("memories_sources_title")} text={t("memories_sources_for", { value: item().description })} tone="blue">
                        <Button variant="outlined" size="sm" label={t("memories_back_to_memory")} onPress={backToMemory} testID="journal-back-to-memory" />
                        <Button variant="plain" size="sm" label={t("memories_show_all")} onPress={clearSources} testID="journal-show-all" />
                      </Banner>
                    )}
                  </If>

                  <If when={!journalSearched()}>
                    <Note text={t("memories_journal_meta")} />
                  </If>
                  <If when={journalSearched() && !days().length}>
                    <Note text={t("memories_journal_empty")} />
                  </If>
                  <Each of={days()} key={(day) => day.label}>
                    {(day) => (
                      <SectionCard title={day().label} meta={countText("memories_count_event", day().events.length)}>
                        <Each of={day().events} key={(event) => String(event.seq ?? event.id)}>
                          {(event) => (
                            <View class="flex-row items-start gap-3 border-t border-line-faint py-2.5" testID={`journal-event:${event().id}`}>
                              <Text class="w-12 pt-0.5 font-mono text-xs text-muted-foreground">{event().clock}</Text>
                              <View class="w-32 flex-row items-center gap-1.5 pt-0.5">
                                <View class={`size-1.5 rounded-full ${AUDIENCE_MARK[event().audienceKind || "owner"] ?? "bg-subtle"}`} />
                                <Text class="flex-1 text-xs text-subtle line-clamp-1">{event().audienceText}</Text>
                              </View>
                              <View class="flex-1 gap-1">
                                <View selectable>
                                  <Text class="text-sm text-foreground">{event().text || t("memories_journal_no_text")}</Text>
                                </View>
                                <View class="flex-row flex-wrap items-center gap-3">
                                  <If when={event().chatPath}>
                                    <Text role="link" class="font-mono text-xs text-blue underline" onPress={() => void navigate(event().chatPath)}>
                                      {`${event().trace?.task_id || t("memories_open_chat")} ↗`}
                                    </Text>
                                  </If>
                                  <If when={!event().chatPath && event().trace?.task_id}>
                                    <Text class="font-mono text-xs text-muted-foreground">{event().trace?.task_id ?? ""}</Text>
                                  </If>
                                  <If when={event().memory}>
                                    {(memory) => (
                                      <Text role="button" class="text-xs text-blue underline" onPress={() => openMemory(memory())}>
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
                    <Note text={t("memories_journal_more")} />
                  </If>
                </View>
              }
            >
              <If when={!(loading() && !loaded())} else={<Blocks count={3} height={96} />}>
                <View class="gap-1">
                  <Text class="text-xl font-semibold text-foreground" role="header">
                    {subject() ? subjectTitle(subject()) : t("memories_all_subjects")}
                  </Text>
                  <Text class="text-sm text-subtle">{subjectLine(subject())}</Text>
                </View>

                <If when={!items().length}>
                  <View class="items-center gap-2 py-12" testID="memories-empty">
                    <Icon name="PhBrain" size={28} color="muted-foreground" />
                    <Note text={t("memories_empty")} />
                  </View>
                </If>
                <If when={items().length > 0 && !sections().length}>
                  <View class="items-center gap-2 py-8">
                    <Note text={t("memories_no_match")} />
                    <If when={filterActive()}>
                      <Button variant="outlined" size="sm" label={t("logs_clear_filters")} onPress={clearFilters} testID="memories-clear-filters" />
                    </If>
                  </View>
                </If>

                <Each of={sections()} key={(section) => section.key}>
                  {(section) => (
                    <SectionCard title={section().title} meta={section().meta}>
                      <Each of={section().items} key={(item) => item.id}>
                        {(item) => (
                          <MemoryRow
                            item={item()}
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
          </Scroll>
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
            <View class="gap-3">
              <Text class="font-mono text-xs text-muted-foreground">{`${target().subject}/${target().name ?? ""}`}</Text>
              <View class="flex-row gap-3">
                <SelectField
                  class="flex-1"
                  label={t("memories_field_type")}
                  items={typeOptions()}
                  value={draft().type}
                  onChange={(value) => draft.update((now) => ({ ...now, type: value }))}
                  testID="memory-edit-type"
                />
                <SelectField
                  class="flex-1"
                  label={t("memories_field_visibility")}
                  items={visibilityOptions()}
                  value={draft().visibility}
                  onChange={(value) => draft.update((now) => ({ ...now, visibility: value }))}
                  testID="memory-edit-visibility"
                />
              </View>
              <Text class="text-xs text-muted-foreground">{t(`memories_visibility_hint_${draft().visibility}`)}</Text>
              <TextField
                label={t("memories_field_description")}
                value={draft().description}
                onChange={(value) => draft.update((now) => ({ ...now, description: value }))}
                maxLength={200}
                disabled={saving()}
                testID="memory-edit-description"
              />
              <TextField
                label={t("memories_field_body")}
                value={draft().body}
                onChange={(value) => draft.update((now) => ({ ...now, body: value }))}
                multiline
                rows={6}
                disabled={saving()}
                testID="memory-edit-body"
              />
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

/** A boxed section with its title and meta (AppSection variant="boxed" is-list). */
function SectionCard(props: { title: string; meta?: string; children?: import("nsh").JSX.Element }) {
  return (
    <View class="rounded-(--radius) border border-line-faint bg-card px-4 pt-3 pb-1">
      <View class="flex-row items-baseline justify-between gap-3 pb-2">
        <Text class="text-base font-semibold text-foreground" role="header">
          {props.title}
        </Text>
        <If when={props.meta}>
          <Text class="text-xs text-muted-foreground">{props.meta}</Text>
        </If>
      </View>
      {props.children}
    </View>
  );
}

/** A bracketed note with its choices: the Make public confirmation, the Sources banner. */
function Banner(props: { label: string; text: string; tone: "warn" | "blue"; children?: import("nsh").JSX.Element }) {
  return (
    <View
      role="alert"
      class={`flex-row flex-wrap items-center gap-2 rounded-(--radius) border-l-2 bg-paper px-3 py-2 ${
        props.tone === "warn" ? "border-warn" : "border-blue"
      }`}
    >
      <Text class={`font-mono text-xs uppercase ${props.tone === "warn" ? "text-warn-dark" : "text-blue"}`}>{`[${props.label}]`}</Text>
      <Text class="min-w-40 flex-1 text-sm text-foreground">{props.text}</Text>
      {props.children}
    </View>
  );
}

function MemoryRow(props: {
  item: Memory;
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
  return (
    <View class="border-t border-line-faint" testID={`memory:${props.item.id}`}>
      <BaseButton
        onPress={() => props.onToggle()}
        accessibilityLabel={props.item.description}
        testID={`memory-head:${props.item.id}`}
        class="flex-row items-start gap-3 py-2.5 hover:bg-hover"
      >
        <View class="w-24 flex-row items-center gap-1.5 pt-0.5">
          <View class={`size-1.5 rounded-full ${VISIBILITY_MARK[props.item.visibility] ?? "bg-subtle"}`} />
          <Text class={`text-xs ${VISIBILITY_TEXT[props.item.visibility] ?? "text-subtle"}`}>{t(`memories_visibility_${props.item.visibility}`)}</Text>
        </View>
        <View class="flex-1 gap-1">
          <Text class="text-sm font-medium text-foreground">{props.item.description}</Text>
          <Text class={`text-sm text-subtle ${props.open ? "" : "line-clamp-2"}`}>
            {props.claimText ? <Text class="font-medium text-warn-dark">{`${props.claimText} `}</Text> : null}
            {props.item.body}
          </Text>
          <View class="flex-row flex-wrap gap-x-3 gap-y-0.5">
            <Text class="text-xs text-muted-foreground">{t(`memories_type_${props.item.type}`)}</Text>
            <Text class="text-xs text-muted-foreground">{props.learnedText}</Text>
            <Text class="text-xs text-muted-foreground">{formatShortTime(props.item.updated_at)}</Text>
          </View>
        </View>
        <Icon name={props.open ? "PhCaretUp" : "PhCaretDown"} size={14} color="muted-foreground" />
      </BaseButton>

      <If when={props.open}>
        <View class="gap-3 pb-3 pl-27">
          <View class="flex-row flex-wrap items-center gap-2">
            <Text class="text-xs text-subtle">{t("memories_who_may_hear")}</Text>
            <View class="flex-row rounded-(--radius) border border-line-faint" accessibilityLabel={t("memories_field_visibility")}>
              <Each of={[...VISIBILITIES]}>
                {(value) => (
                  <BaseButton
                    onPress={() => props.onVisibility(value())}
                    selected={props.item.visibility === value()}
                    disabled={props.busy}
                    accessibilityLabel={t(`memories_visibility_${value()}`)}
                    testID={`memory-visibility:${props.item.id}:${value()}`}
                    class={`flex-row items-center gap-1.5 px-2.5 py-1 hover:bg-hover disabled:opacity-45 ${
                      props.item.visibility === value() ? "bg-selection" : ""
                    }`}
                  >
                    <View class={`size-1.5 rounded-full ${VISIBILITY_MARK[value()]}`} />
                    <Text class={`text-xs ${props.item.visibility === value() ? "font-medium text-foreground" : "text-subtle"}`}>
                      {t(`memories_visibility_${value()}`)}
                    </Text>
                  </BaseButton>
                )}
              </Each>
            </View>
            <Text class="text-xs text-muted-foreground">{t(`memories_visibility_hint_${props.item.visibility}`)}</Text>
          </View>

          <If when={props.confirmingPublic}>
            <Banner
              label={t("memories_visibility_public")}
              text={`${t("memories_public_confirm")}${
                props.item.told_by ? ` ${t("memories_public_confirm_told", { value: props.toldByName })}` : ""
              }`}
              tone="warn"
            >
              <Button variant="outlined" size="sm" label={t("action_cancel")} onPress={() => props.onCancelPublic()} testID="memory-public-cancel" />
              <Button variant="primary" size="sm" label={t("memories_make_public")} onPress={() => props.onVisibility("public")} testID="memory-public-confirm" />
            </Banner>
          </If>

          <View class="flex-row flex-wrap items-center gap-2">
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
            <View selectable class="flex-1">
              <Text class="font-mono text-xs text-muted-foreground line-clamp-1">{`${props.item.subject}/${props.item.name ?? ""}`}</Text>
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
      backdropClass="bg-scrim"
      headerClass="flex-row items-center justify-between pb-2"
      rowClass="flex-row justify-between"
      itemClass="h-8 min-w-8 items-center justify-center rounded-(--radius) text-sm text-foreground hover:bg-hover focus:bg-hover selected:bg-primary selected:text-primary-foreground disabled:opacity-50"
      clearButtonClass="ml-1 size-6 items-center justify-center rounded-(--radius) hover:bg-hover"
      clearButton={<Icon name="PhX" size={12} color="muted-foreground" />}
      clearButtonAccessibilityLabel={t("audit_clear_filter")}
      trigger={
        <View class="h-8 min-w-36 flex-row items-center gap-2 rounded-(--radius) border border-input bg-field px-2.5 hover:border-ring">
          <Icon name="PhCalendarBlank" size={14} color="muted-foreground" />
          <Text class={`font-mono text-sm ${props.value ? "text-foreground" : "text-placeholder"}`}>
            {props.value || t("memories_journal_since")}
          </Text>
        </View>
      }
    />
  );
}
