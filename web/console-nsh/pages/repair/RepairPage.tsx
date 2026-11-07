// Troubleshooting (the Vue console's RepairView): the issues that block startup, each with only
// the actions that can resolve it: retry, replace or remove a missing secret, edit the file's
// source, or redo that part of setup. With no issue left it goes on to setup.
import { batch, effect, Scroll, signal, Text, untracked, View, windowSize } from "nsh";
import { Button, Kicker, MessageDialog, Modal, ProgressBar, TextField } from "../../components/ui";
import { ObserveSection } from "../../components/observe/parts";
import { endpointApiFetch, translate } from "../../lib/core/context.js";
import { endpointRefFromRouteParam, endpointRoutePath } from "../../lib/core/endpoint-routes.js";
import { useNotice } from "../../lib/core/notices.js";
import { fetchConsoleSetupIntegrity, invalidateConsoleSetupReadiness, setupStagePath } from "../../lib/core/setup.js";
import { currentRoute, locationOf, navigate } from "../../lib/router";
import { InlineNotice } from "../setup/InlineNotice";
import { RawTextEditorDialog } from "./RawTextEditorDialog";

const t = translate as (key: string, vars?: Record<string, unknown>) => string;

export interface IntegrityItem {
  key?: string;
  code?: string;
  name?: string;
  path?: string;
  error?: string;
  stage?: string;
  status?: string;
  field_path?: string[];
}

const ISSUE_TITLE_KEYS: Record<string, string> = {
  file_unreadable: "repair_issue_file_unreadable",
  config_empty: "repair_issue_config_empty",
  config_invalid: "repair_issue_config_invalid",
  invalid_secret_ref: "repair_issue_invalid_secret_ref",
  os_secret_not_found: "repair_issue_os_secret_not_found",
  os_secret_store_unavailable: "repair_issue_os_secret_store_unavailable",
  identity_invalid: "repair_issue_identity_invalid",
  soul_invalid: "repair_issue_soul_invalid",
};

export function issueID(item: IntegrityItem | null) {
  return [item?.key, item?.code, ...(Array.isArray(item?.field_path) ? item!.field_path! : [])]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(":");
}

export function issueTitle(item: IntegrityItem | null) {
  return t(ISSUE_TITLE_KEYS[String(item?.code || "")] || "repair_issue_unknown");
}

export function fieldLabel(item: IntegrityItem | null) {
  return Array.isArray(item?.field_path) ? item!.field_path!.join(".") : "";
}

export function hasRepairableSecretRef(item: IntegrityItem | null) {
  return item?.code === "os_secret_not_found" && fieldLabel(item) !== "";
}

export function canRetry(item: IntegrityItem | null) {
  return item?.code === "file_unreadable" || item?.code === "os_secret_store_unavailable";
}

export function canEditSource(item: IntegrityItem | null) {
  return item?.code !== "file_unreadable";
}

export function canUseSetup(item: IntegrityItem | null) {
  return ["file_unreadable", "config_empty", "config_invalid", "identity_invalid", "soul_invalid"].includes(String(item?.code || ""));
}

export function RepairPage() {
  const notice = useNotice();
  const setupEndpointRef = () => endpointRefFromRouteParam(currentRoute().params.endpoint_ref);

  const loading = signal(false);
  const saving = signal(false);
  const err = signal("");
  const items = signal<IntegrityItem[]>([]);
  const editorOpen = signal(false);
  const editorItem = signal<{ key: string; name: string; path: string } | null>(null);
  const editorValue = signal("");
  const secretValue = signal("");
  const secretSaving = signal(false);
  const replaceDialogOpen = signal(false);
  const replaceTarget = signal<IntegrityItem | null>(null);
  const removeDialogOpen = signal(false);
  const removeTarget = signal<IntegrityItem | null>(null);

  const editorTitle = () => {
    const name = String(editorItem()?.name || "").trim();
    return name ? `${t("repair_editor_title")} ${name}` : t("repair_editor_title");
  };

  async function load() {
    batch(() => {
      loading.set(true);
      err.set("");
    });
    try {
      const endpointRef = untracked(setupEndpointRef);
      const nextItems = (await fetchConsoleSetupIntegrity({ force: true, endpointRef })) as IntegrityItem[];
      items.set(nextItems);
      if (nextItems.length === 0) {
        await navigate(endpointRoutePath(endpointRef, "/setup"), { replace: true });
      }
    } catch (error) {
      err.set((error as Error)?.message || t("msg_load_failed"));
    } finally {
      loading.set(false);
    }
  }

  function openReplaceDialog(item: IntegrityItem) {
    batch(() => {
      replaceTarget.set(item);
      secretValue.set("");
      replaceDialogOpen.set(true);
    });
  }

  function closeReplaceDialog() {
    if (untracked(secretSaving)) return;
    batch(() => {
      replaceDialogOpen.set(false);
      replaceTarget.set(null);
      secretValue.set("");
    });
  }

  async function replaceSecret() {
    const target = untracked(replaceTarget);
    const fieldPath = Array.isArray(target?.field_path) ? target!.field_path! : [];
    const value = untracked(secretValue);
    if (fieldPath.length === 0 || value === "" || untracked(secretSaving)) return;
    secretSaving.set(true);
    try {
      await endpointApiFetch(untracked(setupEndpointRef), "/setup/secret", {
        method: "PUT",
        body: { field_path: fieldPath, value },
      });
      batch(() => {
        replaceDialogOpen.set(false);
        replaceTarget.set(null);
        secretValue.set("");
      });
      invalidateConsoleSetupReadiness();
      await load();
    } catch (error) {
      notice.error((error as Error)?.message || t("msg_save_failed"));
    } finally {
      secretSaving.set(false);
    }
  }

  function openRemoveDialog(item: IntegrityItem) {
    batch(() => {
      removeTarget.set(item);
      removeDialogOpen.set(true);
    });
  }

  function closeRemoveDialog() {
    batch(() => {
      removeDialogOpen.set(false);
      removeTarget.set(null);
    });
  }

  async function removeSecretReference() {
    const target = untracked(removeTarget);
    const fieldPath = Array.isArray(target?.field_path) ? target!.field_path! : [];
    if (fieldPath.length === 0) return;
    secretSaving.set(true);
    try {
      await endpointApiFetch(untracked(setupEndpointRef), "/setup/secret", {
        method: "DELETE",
        body: { field_path: fieldPath },
      });
      closeRemoveDialog();
      invalidateConsoleSetupReadiness();
      await load();
    } catch (error) {
      notice.error((error as Error)?.message || t("msg_save_failed"));
    } finally {
      secretSaving.set(false);
    }
  }

  async function openEditor(item: IntegrityItem) {
    const key = String(item?.key || "").trim();
    if (!key) return;
    batch(() => {
      loading.set(true);
      err.set("");
    });
    try {
      const payload = await endpointApiFetch(untracked(setupEndpointRef), `/setup/file?key=${encodeURIComponent(key)}`);
      batch(() => {
        editorItem.set({
          key,
          name: typeof payload?.name === "string" ? payload.name : String(item.name || ""),
          path: typeof payload?.path === "string" ? payload.path : String(item.path || ""),
        });
        editorValue.set(typeof payload?.content === "string" ? payload.content : "");
        editorOpen.set(true);
      });
    } catch (error) {
      err.set((error as Error)?.message || t("msg_load_failed"));
    } finally {
      loading.set(false);
    }
  }

  async function saveEditor() {
    const key = String(untracked(editorItem)?.key || "").trim();
    if (!key) return;
    batch(() => {
      saving.set(true);
      err.set("");
    });
    try {
      await endpointApiFetch(untracked(setupEndpointRef), `/setup/file?key=${encodeURIComponent(key)}`, {
        method: "PUT",
        body: { content: untracked(editorValue) },
      });
      invalidateConsoleSetupReadiness();
      editorOpen.set(false);
      await load();
    } catch (error) {
      notice.error((error as Error)?.message || t("msg_save_failed"));
    } finally {
      saving.set(false);
    }
  }

  function closeEditor() {
    if (untracked(saving)) return;
    editorOpen.set(false);
  }

  function goToSetup(item: IntegrityItem) {
    const endpointRef = untracked(setupEndpointRef);
    const stage = setupStagePath(item?.stage, endpointRef);
    const key = String(item?.key || "").trim();
    if (!stage || !key) return;
    void navigate(locationOf(stage, { repair: key }));
  }

  effect(() => untracked(() => void load()));

  const phone = () => windowSize().width <= 640;
  const pad = () => Math.round(Math.min(80, Math.max(24, windowSize().width * 0.06)));

  return (
    <View class="flex-1" testID="repair-page">
      {/* Vue: centred with clamp(24px, 6vw, 80px) around it; phones (<=640) from the top, 24/16. */}
      <Scroll
        class="flex-1"
        contentClass={`grow items-center ${phone() ? "" : "justify-center"}`}
        contentStyle={phone() ? { paddingTop: 24, paddingBottom: 24, paddingLeft: 16, paddingRight: 16 } : { padding: pad() }}
      >
        <View class="w-full gap-4" style={{ maxWidth: 760 }}>
          <View class="gap-2 p-2">
            <Text class="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">{t("repair_kicker")}</Text>
            <Text role="header" class="text-[32px] font-semibold leading-[34.6px] tracking-[-0.02em] text-foreground">
              {t("repair_title")}
            </Text>
            <Text class="text-base leading-[49.6px] text-muted-foreground">{t("repair_intro")}</Text>
          </View>

          <If when={loading()}>
            <ProgressBar indeterminate label={t("repair_title")} />
          </If>
          <If when={err()}>
            <InlineNotice type="error" text={err()} class="mx-2" testID="repair-error" />
          </If>

          <If when={!loading() && items().length > 0}>
            <View class="gap-3" testID="repair-list">
              <Each of={items()} key={(item) => issueID(item)}>
                {(item) => (
                  // One issue: a boxed section; the head names the problem, the resource and the field its meta.
                  <ObserveSection
                    variant="boxed"
                    title={issueTitle(item())}
                    meta={
                      <View class="flex-1 flex-row items-center">
                        <Text class="shrink text-xs text-subtle line-clamp-1">{item().name}</Text>
                        <If when={fieldLabel(item())}>
                          <View class="ml-2.5 bg-primary/9 px-1.5 py-0.75">
                            <Text class="font-mono text-xs text-primary">{fieldLabel(item())}</Text>
                          </View>
                        </If>
                      </View>
                    }
                    testID={`repair-item-${issueID(item())}`}
                  >
                    <View selectable>
                      <Text class="font-mono text-xs text-muted-foreground line-clamp-1">{item().path}</Text>
                    </View>
                    <View selectable class="border border-line-soft bg-line-soft/30 px-3 py-2.5">
                      <Text class="font-mono text-base leading-normal text-subtle">{item().error}</Text>
                    </View>
                    <View class={phone() ? "gap-2.5" : "flex-row flex-wrap justify-end gap-2.5"}>
                      <If when={canRetry(item())}>
                        <Button variant="outlined" size="sm" label={t("repair_action_retry")} onPress={() => void load()} />
                      </If>
                      <If when={hasRepairableSecretRef(item())}>
                        <Button
                          variant="primary"
                          size="sm"
                          label={t("repair_action_replace_secret")}
                          onPress={() => openReplaceDialog(item())}
                        />
                        <Button
                          variant="danger"
                          size="sm"
                          label={t("repair_action_remove_reference")}
                          onPress={() => openRemoveDialog(item())}
                        />
                      </If>
                      <If when={canEditSource(item())}>
                        <Button
                          variant="outlined"
                          size="sm"
                          label={t("repair_action_edit_source")}
                          onPress={() => void openEditor(item())}
                        />
                      </If>
                      <If when={canUseSetup(item())}>
                        <Button variant="primary" size="sm" label={t("repair_action_use_setup")} onPress={() => goToSetup(item())} />
                      </If>
                    </View>
                  </ObserveSection>
                )}
              </Each>
            </View>
          </If>

          <If when={!loading() && !err() && items().length === 0}>
            <Text class="px-2 text-xs text-muted-foreground" testID="repair-empty">
              {t("repair_empty")}
            </Text>
          </If>
        </View>
      </Scroll>

      <RawTextEditorDialog
        open={editorOpen()}
        title={editorTitle()}
        path={editorItem()?.path || ""}
        value={editorValue()}
        loading={loading()}
        saving={saving()}
        onChange={(value) => editorValue.set(value)}
        onClose={closeEditor}
        onSave={() => void saveEditor()}
      />

      <Modal
        open={replaceDialogOpen()}
        onClose={closeReplaceDialog}
        title={t("repair_action_replace_secret")}
        size="md"
        closeLabel={t("action_close")}
        testID="repair-secret-dialog"
        footer={
          <>
            <Button variant="outlined" label={t("action_cancel")} disabled={secretSaving()} onPress={closeReplaceDialog} />
            <Button
              variant="primary"
              label={t("action_save")}
              disabled={secretSaving() || secretValue() === ""}
              loading={secretSaving()}
              testID="repair-secret-save"
              onPress={() => void replaceSecret()}
            />
          </>
        }
      >
        <View class="gap-1.5">
          <Kicker>{t("repair_secret_field_label")}</Kicker>
          <Text class="font-mono text-sm text-foreground">{fieldLabel(replaceTarget())}</Text>
        </View>
        <TextField
          value={secretValue()}
          onChange={(value) => secretValue.set(value)}
          onSubmit={() => void replaceSecret()}
          masked
          placeholder={t("repair_secret_placeholder")}
          disabled={secretSaving()}
          testID="repair-secret-input"
        />
      </Modal>

      <MessageDialog
        open={removeDialogOpen()}
        onClose={closeRemoveDialog}
        icon="PhTrash"
        tone="danger"
        title={t("repair_remove_secret_title")}
        text={t("repair_remove_secret_confirm", { field: fieldLabel(removeTarget()) })}
        testID="repair-remove-dialog"
        actions={[
          { id: "cancel", label: t("action_cancel"), variant: "outlined", onPress: closeRemoveDialog },
          {
            id: "remove",
            label: t("repair_action_remove_reference"),
            variant: "danger",
            loading: secretSaving(),
            onPress: () => void removeSecretReference(),
          },
        ]}
      />
    </View>
  );
}
