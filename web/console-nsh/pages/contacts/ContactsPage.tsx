// The agent's contacts (web/console/src/views/ContactsView.js): an index of contacts with a filter,
// and the picked contact's card: avatar, the owner switch, its connections (copyable handles), the
// agent's memories about it, its activity, and its YAML for editing. On a phone the index and the
// card take turns, with a back button.
import { batch, computed, effect, Image, List, Scroll, signal, Text, untracked, View } from "nsh";
import {
  Blocks,
  DetailCard,
  IndexColumn,
  InlineNotice,
  MobileBar,
  Note,
  SearchField,
  SubHeading,
  SwitchOnly,
  t,
} from "../../components/knowledge/parts";
import { ContactAvatar } from "../../components/shared/ContactAvatar";
import { Button, DropdownMenu, Icon, MessageDialog, Page, TextField } from "../../components/ui";
import { agentLinkAvatarURL } from "../../lib/core/agent-link-avatar.js";
import { endpointState, formatShortTime, runtimeApiFetch } from "../../lib/core/context.js";
import { endpointRoutePath } from "../../lib/core/endpoint-routes.js";
import { useNotice } from "../../lib/core/notices.js";
import { copyText } from "../../lib/platform";
import { locationOf, navigate } from "../../lib/router";
import { isMobile } from "../../lib/shell";
import { useContactsStore } from "../../lib/stores/contactsStore.js";
import { Button as BaseButton } from "nsh/base";
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

type Memory = { id: string; description?: string; body?: string };

const contactID = (item: Contact | null | undefined) => String(item?.contact_id || "").trim();

/** The avatar with its kind badge (a person or an agent) at its corner. */
function KindAvatar(props: { item: Contact; size?: "list" | "detail" }) {
  return (
    <View class="relative" accessibilityElementsHidden>
      <ContactAvatar
        item={props.item}
        imageURL={agentLinkAvatarURL(props.item, endpointState.items)}
        name={displayName(props.item)}
        endpointRef={endpointState.selectedRef}
        size={props.size ?? "list"}
      />
      <View
        class={`absolute -bottom-0.5 -right-0.5 items-center justify-center rounded-full border border-card ${
          isAgent(props.item) ? "bg-blue" : "bg-paper"
        }`}
        style={{ width: props.size === "detail" ? 22 : 16, height: props.size === "detail" ? 22 : 16 }}
      >
        <Icon
          name={isAgent(props.item) ? "PhCpu" : "PhUserCircle"}
          size={props.size === "detail" ? 14 : 11}
          color={isAgent(props.item) ? "primary-foreground" : "blue"}
        />
      </View>
    </View>
  );
}

export function ContactsPage() {
  const notice = useNotice();
  const store = useContactsStore();

  const err = signal("");
  const filterText = signal("");
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
    { id: "delete", label: t("action_delete"), icon: "PhTrash" as const, danger: true, disabled: deleting(), onSelect: confirmDelete },
  ];

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
            top={
              <SearchField
                value={filterText()}
                onChange={(value) => filterText.set(value)}
                placeholder={t("contacts_filter_placeholder")}
                testID="contacts-filter"
              />
            }
          >
            <If when={store.loading}>
              <Blocks count={4} height={62} class="px-2" />
            </If>
            <If when={!store.loading && err()}>
              <InlineNotice type="error" text={err()} class="mx-2" testID="contacts-error" />
            </If>
            <If
              when={!store.loading && filteredItems().length > 0}
              else={
                <If when={!store.loading}>
                  <Note
                    text={items().length === 0 ? t("contacts_empty") : t("contacts_empty_filtered")}
                    class="px-4"
                    testID="contacts-empty"
                  />
                </If>
              }
            >
              <List
                each={filteredItems()}
                keyExtractor={(item) => contactID(item)}
                estimatedItemSize={58}
                class="flex-1"
                contentClass="gap-0.5 px-2 pb-4"
                testID="contacts-list"
              >
                {(item) => (
                  <BaseButton
                    testID={`contact-row:${contactID(item())}`}
                    accessibilityLabel={contactAccessibilityLabel(item())}
                    selected={!isMobile() && contactID(item()) === selectedContactID()}
                    onPress={() => selectContact(item())}
                    class={`flex-row items-center gap-3 rounded-(--radius) px-2.5 py-2 hover:bg-hover active:bg-selection ${
                      !isMobile() && contactID(item()) === selectedContactID() ? "bg-selection" : ""
                    }`}
                  >
                    <KindAvatar item={item()} />
                    <View class="flex-1 gap-0.5">
                      <Text class="text-sm text-foreground line-clamp-1">{displayName(item())}</Text>
                      <Text class="text-xs text-muted-foreground line-clamp-1">{primaryContactMeta(item())}</Text>
                    </View>
                  </BaseButton>
                )}
              </List>
            </If>
          </IndexColumn>
        </If>

        <If when={showEditorPane()}>
          <Scroll class="flex-1" contentClass="gap-4 p-5">
            <If
              when={selectedContact()}
              else={
                <View class="items-center gap-2 py-16" testID="contacts-placeholder">
                  <Text class="text-lg font-semibold text-foreground">{t("contacts_detail_empty_title")}</Text>
                  <Note text={t("contacts_detail_empty_hint")} />
                </View>
              }
            >
              {(contact) => (
                <DetailCard
                  testID="contact-detail"
                  title={displayName(contact())}
                  meta={
                    <Text class="text-xs text-muted-foreground">
                      {`${kindText(contact())} · ${channelLabel(contact().channel)}`}
                    </Text>
                  }
                  actions={
                    <If when={!editing()}>
                      <View class="flex-row items-center gap-1">
                        <Button
                          variant="plain"
                          size="xs"
                          iconOnly
                          icon="PhPencilSimple"
                          title={t("contacts_action_edit_yaml")}
                          onPress={() => void startEdit()}
                          testID="contact-edit"
                        />
                        <DropdownMenu
                          items={contactMenu()}
                          trigger={
                            <View
                              role="button"
                              accessibilityLabel={t("todo_action_more")}
                              testID="contact-actions"
                              class="size-7 items-center justify-center rounded-(--radius) hover:bg-hover active:bg-selection"
                            >
                              <Icon name="PhDotsThree" size={16} color="subtle" />
                            </View>
                          }
                        />
                      </View>
                    </If>
                  }
                >
                  <View class="flex-row" accessibilityLabel={kindText(contact())}>
                    <KindAvatar item={contact()} size="detail" />
                  </View>

                  <If when={!editing() && !isAgent(contact())}>
                    <View class="flex-row items-center gap-3">
                      <Each of={[ownerSwitchKey()]}>
                        {() => (
                          <SwitchOnly
                            checked={Boolean(contact().owner)}
                            disabled={ownerSaving()}
                            label={t("contacts_owner_label")}
                            onChange={(value) => void setOwner(value)}
                            testID="contact-owner"
                          />
                        )}
                      </Each>
                      <View class="flex-1 gap-0.5">
                        <Text class="text-sm text-foreground">{t("contacts_owner_label")}</Text>
                        <Text class="text-xs text-muted-foreground">{t("contacts_owner_hint")}</Text>
                      </View>
                    </View>
                  </If>

                  <If
                    when={editing()}
                    else={
                      <View class={isMobile() ? "gap-5" : "flex-row items-start gap-6"}>
                        <View class="flex-1 gap-5">
                          <View class="gap-2">
                            <SubHeading text={t("contacts_section_connections")} />
                            <Each of={selectedConnections()} key={(connection) => connection.key}>
                              {(connection) => (
                                <View class="flex-row items-center gap-3 rounded-(--radius) border border-line-faint px-3 py-2">
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
                                  <View class="flex-1 gap-0.5">
                                    <Text class="text-sm font-medium text-foreground">{connection().channel}</Text>
                                    <View selectable>
                                      <Text class="font-mono text-xs text-subtle line-clamp-1">{connection().full}</Text>
                                    </View>
                                  </View>
                                  <If when={connection().copyable}>
                                    <Button
                                      variant="plain"
                                      size="xs"
                                      iconOnly
                                      icon="PhCopy"
                                      title={t("action_copy")}
                                      onPress={() => void copyContactValue(connection().full)}
                                      testID={`contact-copy:${connection().key}`}
                                    />
                                  </If>
                                </View>
                              )}
                            </Each>
                            <View class="flex-row items-center gap-3 px-3 py-2">
                              <Icon name="PhFingerprint" size={20} color="muted-foreground" />
                              <View class="flex-1 gap-0.5">
                                <Text class="text-xs text-muted-foreground">{t("contacts_field_contact_id")}</Text>
                                <View selectable>
                                  <Text class="font-mono text-xs text-foreground">{contactID(contact())}</Text>
                                </View>
                              </View>
                              <Button
                                variant="plain"
                                size="xs"
                                iconOnly
                                icon="PhCopy"
                                title={t("action_copy")}
                                onPress={() => void copyContactValue(contactID(contact()))}
                                testID="contact-copy-id"
                              />
                            </View>
                          </View>

                          <View class="gap-2">
                            <SubHeading text={t("contacts_section_memories")} />
                            <If when={memoriesLoading()}>
                              <Blocks count={1} height={48} />
                            </If>
                            <If when={!memoriesLoading() && !selectedMemories().length}>
                              <Note text={t("contacts_memories_empty")} />
                            </If>
                            <If when={!memoriesLoading() && selectedMemories().length > 0}>
                              <View class="gap-2" testID="contact-memories">
                                <Each of={selectedMemories()} key={(memory) => memory.id}>
                                  {(memory) => (
                                    <View class="gap-0.5 border-l-2 border-line pl-3">
                                      <Text class="text-sm font-medium text-foreground">{memory().description ?? ""}</Text>
                                      <Text class="text-xs text-subtle">{memory().body ?? ""}</Text>
                                    </View>
                                  )}
                                </Each>
                              </View>
                            </If>
                            <Button variant="plain" size="sm" label={t("contacts_memories_open")} onPress={openMemories} testID="contact-open-memories" />
                          </View>
                        </View>

                        <View class={`gap-3 ${isMobile() ? "" : "w-56"}`}>
                          <SubHeading text={t("contacts_section_activity")} />
                          <View class="flex-row items-start gap-3">
                            <Icon name="PhClockCounterClockwise" size={18} color="muted-foreground" />
                            <View class="flex-1 gap-0.5">
                              <Text class="text-xs text-muted-foreground">{t("contacts_field_last_interaction")}</Text>
                              <Text class="text-sm font-medium text-foreground">
                                {contact().last_interaction_at ? relativeTime(contact().last_interaction_at) : t("contacts_activity_none")}
                              </Text>
                              <If when={contact().last_interaction_at}>
                                <Text class="font-mono text-xs text-muted-foreground">{formatShortTime(contact().last_interaction_at)}</Text>
                              </If>
                            </View>
                          </View>
                          <If when={contact().cooldown_until}>
                            <View class="flex-row items-start gap-3">
                              <Icon name="PhTimer" size={18} color="muted-foreground" />
                              <View class="flex-1 gap-0.5">
                                <Text class="text-xs text-muted-foreground">{t("contacts_field_cooldown")}</Text>
                                <Text class="text-sm font-medium text-foreground">{relativeTime(contact().cooldown_until)}</Text>
                                <Text class="font-mono text-xs text-muted-foreground">{formatShortTime(contact().cooldown_until)}</Text>
                              </View>
                            </View>
                          </If>
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
                          <Note text={t("contacts_editor_hint")} />
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
