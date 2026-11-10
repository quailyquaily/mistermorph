// The agent's contacts (web/console/src/views/ContactsView.js): an index of contacts with a filter,
// and the picked contact's card: avatar, the owner switch, its connections (copyable handles), the
// agent's memories about it, its activity, and its YAML for editing. On a phone the index and the
// card take turns, with a back button.
import { batch, computed, effect, Image, List, Scroll, signal, Text, untracked, View, windowSize } from "nsh";
import {
  Blocks,
  DetailCard,
  gutterX,
  IndexColumn,
  IndexRow,
  IndexSearch,
  InlineNotice,
  MobileBar,
  MoreTrigger,
  Note,
  SubHeading,
  SwitchOnly,
  t,
} from "../../components/knowledge/parts";
import { ContactAvatar } from "../../components/shared/ContactAvatar";
import { Button, DropdownMenu, Icon, MessageDialog, Page, TextField, type IconName } from "../../components/ui";
import { FadeText, SCROLLBAR } from "../../components/motion";
import { agentLinkAvatarURL } from "../../lib/core/agent-link-avatar.js";
import { endpointState, formatShortTime, runtimeApiFetch } from "../../lib/core/context.js";
import { endpointRoutePath } from "../../lib/core/endpoint-routes.js";
import { useNotice } from "../../lib/core/notices.js";
import { copyText } from "../../lib/platform";
import { locationOf, navigate } from "../../lib/router";
import { isMobile } from "../../lib/shell";
import { useContactsStore } from "../../lib/stores/contactsStore.js";
import {
  channelHandles,
  channelLabel,
  channelLogo,
  contactAccessibilityLabel,
  displayName,
  isAgent,
  kindText,
  matchesFilter,
  primaryContactMeta,
  relativeTime,
  type Contact,
} from "./contact-format";
import { MobileBarSpacer } from "../../components/frame/mobileBar";
import { createPullSearch } from "../../components/shared/pullSearch";

type Memory = { id: string; description?: string; body?: string };

const contactID = (item: Contact | null | undefined) => String(item?.contact_id || "").trim();

/** The avatar with its kind badge (a person or an agent) at its corner. */
function KindAvatar(props: { item: Contact; size?: "list" | "detail" }) {
  // The badge: a 14pt white disc with a 10pt glyph at the avatar's lower right (1pt past its
  // edge); the avatar is cut away 2pt clear of it (Vue .contacts-kind-badge and its mask).
  const box = () => (props.size === "detail" ? 64 : 40);
  const centre = () => box() - 6;
  return (
    <View class="relative" accessibilityElementsHidden style={{ width: box(), height: box() }}>
      <ContactAvatar
        item={props.item}
        imageURL={agentLinkAvatarURL(props.item, endpointState.items)}
        name={displayName(props.item)}
        endpointRef={endpointState.selectedRef}
        size={props.size ?? "list"}
        notch={{ x: centre(), y: centre(), r: 9 }}
      />
      <View
        class="absolute -bottom-px -right-px size-3.5 items-center justify-center rounded-full bg-white"
        style={{ boxShadow: "inset 0 0 0 1px rgba(24, 24, 50, 0.09)" }}
      >
        <Icon name={isAgent(props.item) ? "PhCpu" : "PhUserCircle"} size={10} color={isAgent(props.item) ? "ink" : "blue"} />
      </View>
    </View>
  );
}

// A connection row: a 28pt icon column (24 on phones), the name and handle, a 36pt copy button.
const CONNECTION_GAP = () => (windowSize().width <= 620 ? "gap-[9px]" : "gap-[11px]");
const CONNECTION_ICON = () => (windowSize().width <= 620 ? "w-6" : "w-7");

/** A 36pt plain copy button with a 14pt icon (.contacts-copy-action). */
function CopyButton(props: { onPress: () => void; testID?: string }) {
  return (
    <Button variant="plain" size="sm" iconOnly title={t("action_copy")} onPress={() => props.onPress()} testID={props.testID} class="size-9">
      <Icon name="PhCopy" size={14} color="muted-foreground" />
    </Button>
  );
}

/** One line of the activity panel: its icon, a 12pt label, the 16pt value, the time under it. */
function ActivityItem(props: { icon: IconName; label: string; value: string; time: string; divided?: boolean }) {
  return (
    <View class={`flex-row items-start gap-2.5 pb-4 ${props.divided ? "border-t border-line-soft pt-4" : "pt-0.5"}`}>
      <View class="w-5 pt-px">
        <Icon name={props.icon} size={18} color="muted-foreground" />
      </View>
      <View class="flex-1 gap-[3px]">
        <Text class="text-xs leading-[22.4px] text-muted-foreground">{props.label}</Text>
        <Text class="text-base font-semibold leading-[23.2px] text-foreground">{props.value}</Text>
        <If when={props.time}>
          <Text class="text-xs leading-[23.2px] text-muted-foreground">{props.time}</Text>
        </If>
      </View>
    </View>
  );
}

export function ContactsPage() {
  const notice = useNotice();
  const store = useContactsStore();

  const err = signal("");
  const filterText = signal("");
  // On a touch phone the filter hides until the index is pulled down from its top
  // (components/shared/pullSearch.ts), then heads the list; once shown it stays while the page
  // lives, the index being rebuilt each time the phone comes back from a contact.
  const filterRevealed = signal(false);
  const selectedContactID = signal("");
  const mobileEditorVisible = signal(false);

  const editingContactID = signal("");
  const editorYAML = signal("");
  const loadedEditorYAML = signal("");
  const editorLoading = signal(false);
  const editorSaving = signal(false);
  const ownerSaving = signal(false);
  // Rebuilds the switch after a failed save, so it shows the stored value again.
  const ownerSwitchKey = signal(0);
  const editorErr = signal("");

  const deleteDialogOpen = signal(false);
  const deleteTarget = signal<Contact | null>(null);
  const deleting = signal(false);

  const items = () => (store.items || []) as Contact[];
  const filteredItems = () => items().filter((item) => matchesFilter(item, filterText()));
  const selectedContact = computed(() => {
    const id = selectedContactID().trim();
    return id ? items().find((item) => contactID(item) === id) || null : null;
  });
  const selectedConnections = () => {
    const contact = selectedContact();
    const handles = channelHandles(contact);
    if (handles.length > 0) return handles.map((handle) => ({ ...handle, logo: channelLogo(handle.channelKey), copyable: true }));
    const channelKey = String(contact?.channel || "").trim().toLowerCase();
    return [
      {
        key: `primary:${channelKey}`,
        channelKey,
        channel: channelLabel(channelKey),
        full: t("contacts_connection_primary"),
        short: "",
        logo: channelLogo(channelKey),
        copyable: false,
      },
    ];
  };

  // The agent's memories about the selected contact.
  const selectedMemories = signal<Memory[]>([]);
  const memoriesLoading = signal(false);
  async function loadSelectedMemories(id: string) {
    selectedMemories.set([]);
    if (!id || !endpointState.selectedRef) return;
    memoriesLoading.set(true);
    try {
      const data = await runtimeApiFetch(`/memories?subject=${encodeURIComponent(`contact:${id}`)}`);
      if (untracked(selectedContactID).trim() === id) selectedMemories.set(Array.isArray(data?.items) ? data.items : []);
    } catch (e: any) {
      // A runtime without memories has none to show.
      console.warn("contact memories:", e?.message);
    } finally {
      memoriesLoading.set(false);
    }
  }
  effect(() => {
    const id = selectedContactID().trim();
    untracked(() => void loadSelectedMemories(id));
  });
  function openMemories() {
    const id = untracked(selectedContactID).trim();
    void navigate(locationOf(endpointRoutePath(endpointState.selectedRef, "/memories"), { subject: `contact:${id}` }));
  }

  const editing = () => Boolean(selectedContact()) && editingContactID() === selectedContactID();
  const saveDisabled = () =>
    editorLoading() || editorSaving() || !editing() || !String(editorYAML() || "").trim() || editorYAML() === loadedEditorYAML();

  const showIndexPane = () => !isMobile() || !mobileEditorVisible();
  const showEditorPane = () => !isMobile() || mobileEditorVisible();
  const mobileShowBack = () => isMobile() && mobileEditorVisible();
  const mobileBarTitle = () => (mobileShowBack() && selectedContact() ? displayName(selectedContact()) : t("contacts_title"));
  const deleteDialogText = () => t("contacts_delete_confirm", { name: displayName(deleteTarget() || selectedContact()) });

  // Leaving the phone layout shows both panes again.
  effect(() => {
    if (!isMobile()) untracked(() => mobileEditorVisible.set(false));
  });

  function stopEdit() {
    batch(() => {
      editingContactID.set("");
      editorYAML.set("");
      loadedEditorYAML.set("");
      editorLoading.set(false);
      editorSaving.set(false);
      editorErr.set("");
    });
  }

  function showIndexView() {
    stopEdit();
    mobileEditorVisible.set(false);
  }

  function clearSelection() {
    stopEdit();
    batch(() => {
      selectedContactID.set("");
      mobileEditorVisible.set(false);
    });
  }

  function selectContact(item: Contact) {
    const id = contactID(item);
    if (!id) return;
    if (id !== untracked(selectedContactID)) {
      stopEdit();
      selectedContactID.set(id);
    }
    if (untracked(isMobile)) mobileEditorVisible.set(true);
  }

  async function load() {
    err.set("");
    try {
      await store.load({ force: true });
      if (untracked(selectedContactID) && !untracked(selectedContact)) clearSelection();
    } catch (e: any) {
      err.set(e?.message || t("msg_load_failed"));
    }
  }

  async function startEdit() {
    const id = contactID(untracked(selectedContact));
    if (!id || untracked(editorLoading)) return;
    batch(() => {
      editingContactID.set(id);
      editorLoading.set(true);
      editorErr.set("");
      editorYAML.set("");
      loadedEditorYAML.set("");
    });
    try {
      const data = await runtimeApiFetch(`/contacts/item?contact_id=${encodeURIComponent(id)}`);
      if (untracked(editingContactID) !== id) return;
      const yaml = String(data?.yaml || "").trim();
      batch(() => {
        editorYAML.set(yaml);
        loadedEditorYAML.set(yaml);
      });
    } catch (e: any) {
      if (untracked(editingContactID) === id) editorErr.set(e?.message || t("msg_load_failed"));
    } finally {
      if (untracked(editingContactID) === id) editorLoading.set(false);
    }
  }

  async function saveEdit() {
    const id = untracked(editingContactID).trim();
    if (!id || untracked(saveDisabled)) return;
    batch(() => {
      editorSaving.set(true);
      editorErr.set("");
    });
    try {
      await runtimeApiFetch("/contacts/item", { method: "PUT", body: { contact_id: id, yaml: untracked(editorYAML) } });
      await load();
      if (untracked(selectedContactID) === id) stopEdit();
      notice.success(t("msg_save_success"));
    } catch (e: any) {
      notice.error(e?.message || t("msg_save_failed"));
    } finally {
      editorSaving.set(false);
    }
  }

  // setOwner marks the contact as one of the owner's own accounts, or unmarks it.
  async function setOwner(owner: boolean) {
    const id = contactID(untracked(selectedContact));
    if (!id || untracked(ownerSaving)) return;
    ownerSaving.set(true);
    try {
      await runtimeApiFetch("/contacts/item", { method: "PATCH", body: { contact_id: id, owner: Boolean(owner) } });
      await load();
      notice.success(t("msg_save_success"));
    } catch (e: any) {
      ownerSwitchKey.update((key) => key + 1);
      notice.error(e?.message || t("msg_save_failed"));
    } finally {
      ownerSaving.set(false);
    }
  }

  async function copyContactValue(raw: unknown) {
    const value = String(raw || "").trim();
    if (!value) return;
    try {
      await copyText(value);
      notice.success(t("contacts_copy_success"));
    } catch (e: any) {
      console.warn("copy:", e?.message);
      notice.error(t("contacts_copy_failed"));
    }
  }

  function confirmDelete() {
    const contact = untracked(selectedContact);
    if (!contact) return;
    batch(() => {
      deleteTarget.set(contact);
      deleteDialogOpen.set(true);
    });
  }

  function closeDeleteDialog() {
    batch(() => {
      deleteDialogOpen.set(false);
      deleteTarget.set(null);
    });
  }

  async function deleteContact() {
    if (untracked(deleting)) return;
    const id = contactID(untracked(deleteTarget));
    if (!id) {
      closeDeleteDialog();
      return;
    }
    batch(() => {
      deleting.set(true);
      deleteDialogOpen.set(false);
    });
    try {
      await runtimeApiFetch(`/contacts/item?contact_id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (untracked(selectedContactID) === id) clearSelection();
      await load();
      notice.success(t("msg_delete_success"));
    } catch (e: any) {
      notice.error(e?.message || t("msg_delete_failed"));
    } finally {
      batch(() => {
        deleting.set(false);
        deleteTarget.set(null);
      });
    }
  }

  // The agent: the page is rebuilt for another one, so this is the first load.
  effect(() => {
    void endpointState.selectedRef;
    untracked(() => {
      clearSelection();
      closeDeleteDialog();
      void load();
    });
  });

  const contactMenu = () => [
    { id: "delete", label: t("action_delete"), disabled: deleting(), onSelect: confirmDelete },
  ];

  const pull = createPullSearch({
    query: () => filterText(),
    revealed: filterRevealed,
    label: t("contacts_filter_placeholder"),
  });
  const filterField = () => (
    <IndexSearch
      value={filterText()}
      onChange={(value) => filterText.set(value)}
      placeholder={t("contacts_filter_placeholder")}
      mobile={isMobile()}
      testID="contacts-filter"
    />
  );
  const contactRow = (item: () => Contact) => (
    <IndexRow
      testID={`contact-row:${contactID(item())}`}
      accessibilityLabel={contactAccessibilityLabel(item())}
      active={!isMobile() && contactID(item()) === selectedContactID()}
      onPress={() => selectContact(item())}
      leading={<KindAvatar item={item()} />}
      title={displayName(item())}
      meta={primaryContactMeta(item())}
      metaFade
    />
  );
  return (
    <Page hideBar scroll={false} testID="contacts-page">
      <If when={mobileShowBack()}>
        <MobileBar title={mobileBarTitle()} backLabel={t("contacts_title")} onBack={showIndexView} />
      </If>
      <View class="flex-1 flex-row">
        <If when={showIndexPane()}>
          <IndexColumn
            title={t("contacts_title")}
            fill={isMobile()}
            scroll={false}
            testID="contacts-index"
          >
            {/* One list on a phone and a desktop, always there, so the filter (a pull reaches it on a
                touch phone) can be used while it loads, fails or is empty too; the filter and an
                error head it and scroll with it (not the head's: the head keeps the title alone),
                and stay the same views (a focused field keeps its focus) as matches come and go and
                the window crosses the mobile breakpoint. On a desktop the rows keep the list's 16pt
                gutter; the filter has its own, so it is not doubled. A virtualized List: its rows
                are recycled cells, so the selected fill is each row's own and fades in and out
                (180 ms) rather than gliding as one highlight. */}
            <List
              footer={MobileBarSpacer}
              header={() => (
                <View>
                  <If when={pull.shown()}>{filterField()}</If>
                  <If when={!store.loading && err()}>
                    <InlineNotice type="error" text={err()} class="mx-4 mt-2" testID="contacts-error" />
                  </If>
                  {/* With the list's 2pt gap, the 8pt the list keeps before its first row (as the
                      list's top padding did under the filter). */}
                  <View class="h-1.5" />
                </View>
              )}
              empty={() => (
                <If
                  when={store.loading}
                  else={
                    <Note
                      text={items().length === 0 ? t("contacts_empty") : t("contacts_empty_filtered")}
                      class="mx-4 mt-1 leading-normal"
                      testID="contacts-empty"
                    />
                  }
                >
                  <Blocks count={4} height={65} class={isMobile() ? undefined : "px-4"} />
                </If>
              )}
              each={store.loading ? [] : filteredItems()}
              keyExtractor={(item) => contactID(item)}
              estimatedItemSize={67}
              class="flex-1"
              scrollbar={SCROLLBAR}
              contentClass="gap-0.5 pb-4"
              refreshIndicator={pull.indicator}
              refreshing={pull.refreshing()}
              onRefresh={pull.onRefresh}
              onScrollDragStart={pull.onDragStart}
              accessibilityActions={pull.actions()}
              onAccessibilityAction={pull.onAction}
              testID="contacts-list"
            >
              {(item) => <View class={isMobile() ? "" : "px-4"}>{contactRow(item)}</View>}
            </List>
          </IndexColumn>
        </If>

        <If when={showEditorPane()}>
          <Scroll class="flex-1" scrollbar={SCROLLBAR} contentClass="grow">
            <If
              when={selectedContact()}
              else={
                <View class="grow items-center justify-center px-6 py-[72px]" testID="contacts-placeholder" style={{ marginRight: gutterX() }}>
                  <View class="max-w-[576px] items-center gap-2">
                    <Text role="header" class="text-center text-xl leading-[24.0px] tracking-[-0.03em] text-foreground">
                      {t("contacts_detail_empty_title")}
                    </Text>
                    <Text class="max-w-[544px] text-center text-base leading-[32.4px] text-subtle">{t("contacts_detail_empty_hint")}</Text>
                  </View>
                </View>
              }
            >
              {(contact) => (
                <DetailCard
                  testID="contact-detail"
                  title={displayName(contact())}
                  class={isMobile() ? (windowSize().width <= 620 ? "m-3" : "m-4") : "mb-2 ml-5 mr-2 mt-2"}
                  meta={`${kindText(contact())} · ${channelLabel(contact().channel)}`}
                  actions={
                    <If when={!editing()}>
                      <View class="flex-row items-center gap-1">
                        <Button
                          variant="plain"
                          size="xs"
                          iconOnly
                          title={t("contacts_action_edit_yaml")}
                          onPress={() => void startEdit()}
                          testID="contact-edit"
                        >
                          <Icon name="PhPencilSimple" size={14} color="subtle" />
                        </Button>
                        <DropdownMenu
                          items={contactMenu()}
                          disabled={deleting()}
                          trigger={<MoreTrigger label={t("todo_action_more")} testID="contact-actions" />}
                        />
                      </View>
                    </If>
                  }
                >
                  <View class="flex-row items-center gap-3.5" accessibilityLabel={kindText(contact())}>
                    <KindAvatar item={contact()} size={isMobile() ? "list" : "detail"} />
                  </View>

                  <If when={!editing() && !isAgent(contact())}>
                    {/* One of the owner's own accounts: the switch, then what it means, between hairlines. */}
                    <View class="flex-row items-start gap-3 border-y border-line-soft py-3">
                      <Each of={[ownerSwitchKey()]}>
                        {() => (
                          <View class="pt-0.5">
                            <SwitchOnly
                              checked={Boolean(contact().owner)}
                              disabled={ownerSaving()}
                              label={t("contacts_owner_label")}
                              onChange={(value) => void setOwner(value)}
                              testID="contact-owner"
                            />
                          </View>
                        )}
                      </Each>
                      <View class="flex-1 gap-0.5">
                        <Text class="text-sm font-medium leading-normal text-foreground">{t("contacts_owner_label")}</Text>
                        <Text class="max-w-[620px] text-xs leading-normal text-muted-foreground">{t("contacts_owner_hint")}</Text>
                      </View>
                    </View>
                  </If>

                  <If
                    when={editing()}
                    else={
                      <View class={isMobile() ? "gap-[22px]" : "flex-row items-start"} style={isMobile() ? undefined : { gap: Math.min(44, Math.max(24, windowSize().width * 0.03)) }}>
                        <View class={isMobile() ? "" : "flex-[2]"} style={{ minWidth: 0 }}>
                          <View class="gap-2.5">
                            <SubHeading text={t("contacts_section_connections")} />
                            <View class="border-t border-line-soft">
                              <Each of={selectedConnections()} key={(connection) => connection.key}>
                                {(connection) => (
                                  <View class={`min-h-[62px] flex-row items-center border-b border-line-soft py-2.5 ${CONNECTION_GAP()}`}>
                                    <View class={CONNECTION_ICON()}>
                                      <If
                                        when={connection().logo}
                                        else={
                                          <Icon
                                            name={connection().channelKey === "console" ? "PhTerminalWindow" : "PhLink"}
                                            size={20}
                                            color="subtle"
                                          />
                                        }
                                      >
                                        {(logo) => <Image src={logo()} style={{ width: 20, height: 20 }} accessibilityElementsHidden />}
                                      </If>
                                    </View>
                                    <View class="flex-1 gap-[3px]" style={{ minWidth: 0 }}>
                                      <Text class="text-sm font-semibold leading-[19.6px] text-foreground">{connection().channel}</Text>
                                      <View selectable>
                                        <FadeText text={connection().full} fade={29} class="font-mono text-xs leading-[20.3px] text-muted-foreground" />
                                      </View>
                                    </View>
                                    <View class="w-9 items-center">
                                      <If when={connection().copyable}>
                                        <CopyButton onPress={() => void copyContactValue(connection().full)} testID={`contact-copy:${connection().key}`} />
                                      </If>
                                    </View>
                                  </View>
                                )}
                              </Each>
                            </View>
                            <View class={`mt-2 flex-row items-center pt-2.5 ${CONNECTION_GAP()}`}>
                              <View class={CONNECTION_ICON()}>
                                <Icon name="PhFingerprint" size={18} color="muted-foreground" />
                              </View>
                              <View class="flex-1 gap-[3px]" style={{ minWidth: 0 }}>
                                <Text class="text-xs leading-[16.8px] text-muted-foreground">{t("contacts_field_contact_id")}</Text>
                                <View selectable>
                                  <FadeText text={contactID(contact())} fade={29} class="font-mono text-xs leading-[17.4px] text-muted-foreground" />
                                </View>
                              </View>
                              <View class="w-9 items-center">
                                <CopyButton onPress={() => void copyContactValue(contactID(contact()))} testID="contact-copy-id" />
                              </View>
                            </View>
                          </View>

                          <View class="mt-[22px] gap-2.5 border-t border-line-soft pt-[18px]">
                            <SubHeading text={t("contacts_section_memories")} />
                            <If when={memoriesLoading()}>
                              <Blocks count={1} height={48} />
                            </If>
                            <If when={!memoriesLoading() && !selectedMemories().length}>
                              <Note text={t("contacts_memories_empty")} />
                            </If>
                            <If when={!memoriesLoading() && selectedMemories().length > 0}>
                              <View testID="contact-memories">
                                <Each of={selectedMemories()} key={(memory) => memory.id}>
                                  {(memory, index) => (
                                    <View selectable class={`gap-0.5 ${index() === 0 ? "pb-[9px]" : "border-t border-line-soft py-[9px]"}`}>
                                      <Text class="text-xs font-semibold leading-[17.4px] text-foreground">{memory().description ?? ""}</Text>
                                      <Text class="text-xs leading-[17.4px] text-subtle">{memory().body ?? ""}</Text>
                                    </View>
                                  )}
                                </Each>
                              </View>
                            </If>
                            <View class="-ml-3 self-start">
                              <Button variant="plain" size="sm" label={t("contacts_memories_open")} onPress={openMemories} testID="contact-open-memories" />
                            </View>
                          </View>
                        </View>

                        <View
                          class={isMobile() ? "gap-3.5 border-t border-line-soft pt-[18px]" : "min-w-55 flex-[0.85] gap-3.5 border-l border-line-soft"}
                          style={isMobile() ? undefined : { paddingLeft: Math.min(32, Math.max(20, windowSize().width * 0.024)) }}
                        >
                          <SubHeading text={t("contacts_section_activity")} />
                          <View>
                            <ActivityItem
                              icon="PhClockCounterClockwise"
                              label={t("contacts_field_last_interaction")}
                              value={contact().last_interaction_at ? relativeTime(contact().last_interaction_at) : t("contacts_activity_none")}
                              time={contact().last_interaction_at ? formatShortTime(contact().last_interaction_at) : ""}
                            />
                            <If when={contact().cooldown_until}>
                              <ActivityItem
                                icon="PhTimer"
                                label={t("contacts_field_cooldown")}
                                value={relativeTime(contact().cooldown_until)}
                                time={formatShortTime(contact().cooldown_until)}
                                divided
                              />
                            </If>
                          </View>
                        </View>
                      </View>
                    }
                  >
                    <View class="gap-3" testID="contact-editor">
                      <If when={editorLoading()} else={
                        <View class="gap-3">
                          <If when={editorErr()}>
                            <InlineNotice type="error" text={editorErr()} testID="contact-editor-error" />
                          </If>
                          <TextField
                            value={editorYAML()}
                            onChange={(value) => editorYAML.set(value)}
                            multiline
                            rows={26}
                            mono
                            disabled={editorSaving()}
                            accessibilityLabel={t("contacts_editor_hint")}
                            testID="contact-yaml"
                          />
                          <Note text={t("contacts_editor_hint")} class="leading-normal" />
                          <View class="flex-row justify-end gap-2">
                            <Button variant="outlined" size="sm" label={t("action_cancel")} disabled={editorSaving()} onPress={stopEdit} testID="contact-edit-cancel" />
                            <Button
                              variant="primary"
                              size="sm"
                              label={t("action_save")}
                              loading={editorSaving()}
                              disabled={saveDisabled()}
                              onPress={() => void saveEdit()}
                              testID="contact-edit-save"
                            />
                          </View>
                        </View>
                      }>
                        <Blocks count={1} height={360} />
                      </If>
                    </View>
                  </If>
                </DetailCard>
              )}
            </If>
            <MobileBarSpacer />
          </Scroll>
        </If>
      </View>

      <MessageDialog
        open={deleteDialogOpen()}
        onClose={closeDeleteDialog}
        icon="PhTrash"
        tone="danger"
        title={t("action_delete")}
        text={deleteDialogText()}
        testID="contacts-delete-dialog"
        actions={[
          { id: "cancel", label: t("action_cancel"), variant: "outlined", onPress: closeDeleteDialog },
          { id: "delete", label: t("action_delete"), variant: "danger", onPress: () => void deleteContact() },
        ]}
      />
    </Page>
  );
}
