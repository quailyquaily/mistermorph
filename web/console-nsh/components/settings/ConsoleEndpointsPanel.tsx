// The remote agents this console connects to (the Vue console's ConsoleEndpointsPanel): the list
// with each agent's status, a side pane to add or edit one, and the remove confirmation.
//
// Vue to nsh: `save` is `onSave(values, onComplete)`, `add-opened` is `onAddOpened()`,
// `pane-change` is `onPaneChange(open)`; `paneTarget` is a PaneTarget (see PaneTarget.tsx).
import { batch, cleanup, computed, effect, signal, Text, untracked, View } from "nsh";
import { Button, ProgressBar, StatusMark, TextField } from "../ui";
import { SettingsCard } from "../settings-page/parts";
import { DialogShell, t } from "./DialogShell";
import { type PaneTarget, SettingsPane, usePaneTarget } from "./PaneTarget";
import { SecretInput } from "./SecretInput";

/** A saved endpoint (`/settings/console` endpoints). */
export interface ConsoleEndpointConfig {
  name: string;
  url: string;
  auth_token_configured?: boolean;
  [key: string]: unknown;
}

/** What the panel saves: every endpoint, the edited one with its new values. */
export interface ConsoleEndpointSaveValue {
  original_name: string;
  name: string;
  url: string;
  auth_token: string;
}

export interface ConsoleEndpointsPanelProps {
  endpoints: ConsoleEndpointConfig[];
  /** The live endpoints (`endpointState.items`), for each one's status. */
  runtimeEndpoints?: any[];
  loading?: boolean;
  saving?: boolean;
  /** Opens the add pane as soon as the panel is ready (then `onAddOpened`). */
  addRequested?: boolean;
  mobile?: boolean;
  paneTarget?: PaneTarget;
  /** Saves the list; call `onComplete(error)` when done, with the error text on failure. */
  onSave?: (values: ConsoleEndpointSaveValue[], onComplete: (error?: string) => void) => void;
  onAddOpened?: () => void;
  onPaneChange?: (open: boolean) => void;
}

type Status = "online" | "offline" | "checking" | "unknown";

export function ConsoleEndpointsPanel(props: ConsoleEndpointsPanelProps) {
  const editorOpen = signal(false);
  const editorError = signal("");
  const editingName = signal<string | null>(null);
  const draft = signal({ name: "", url: "", auth_token: "", configured: false });
  const original = signal({ name: "", url: "" });
  // Set when an agent opens, so saving a new agent (which gives it a name) keeps its pane.
  const paneKey = signal("");
  let paneSeed = 0;
  const removeTarget = signal<ConsoleEndpointConfig | null>(null);
  const removeError = signal("");

  const busy = () => !!props.loading || !!props.saving;
  const dirty = () =>
    editorOpen() && (draft().name !== original().name || draft().url !== original().url || draft().auth_token.trim() !== "");
  const valid = () => Boolean(draft().name.trim() && draft().url.trim() && (draft().configured || draft().auth_token.trim()));
  const rows = computed(() =>
    (props.endpoints || []).map((endpoint) => {
      const live = (props.runtimeEndpoints || []).find((item) => item?.name === endpoint.name && item?.url === endpoint.url);
      const status: Status = live?.health_pending
        ? "checking"
        : live?.connected === true
          ? "online"
          : live?.connected === false
            ? "offline"
            : "unknown";
      return { ...endpoint, status };
    }),
  );

  function edit(endpoint: ConsoleEndpointConfig | null = null) {
    if (untracked(busy)) return;
    if (endpoint && untracked(editorOpen) && untracked(editingName) === endpoint.name) {
      editorOpen.set(false);
      return;
    }
    batch(() => {
      editingName.set(endpoint?.name ?? null);
      paneSeed += 1;
      paneKey.set(`agent-${paneSeed}`);
      original.set({ name: endpoint?.name || "", url: endpoint?.url || "" });
      draft.set({ name: endpoint?.name || "", url: endpoint?.url || "", auth_token: "", configured: endpoint?.auth_token_configured === true });
      editorError.set("");
      editorOpen.set(true);
    });
  }

  const updateDraft = (field: "name" | "url" | "auth_token", value: string) => draft.update((d) => ({ ...d, [field]: value }));

  function save() {
    if (untracked(busy) || !untracked(valid)) return;
    editorError.set("");
    const current = untracked(draft);
    const editing = untracked(editingName);
    const item = { original_name: editing || "", name: current.name.trim(), url: current.url.trim(), auth_token: current.auth_token.trim() };
    const values = (props.endpoints || []).map((endpoint) => ({
      original_name: endpoint.name,
      name: endpoint.name,
      url: endpoint.url,
      auth_token: "",
    }));
    if (editing === null) values.push(item);
    else {
      const index = values.findIndex((endpoint) => endpoint.name === editing);
      if (index < 0) {
        editorError.set(t("remote_agent_missing"));
        return;
      }
      values.splice(index, 1, item);
    }
    props.onSave?.(values, (error) => {
      if (error) {
        editorError.set(error);
        return;
      }
      // Saved: the pane stays on the agent, now as it is stored.
      batch(() => {
        editingName.set(item.name);
        original.set({ name: item.name, url: item.url });
        draft.update((d) => ({ name: item.name, url: item.url, auth_token: "", configured: d.configured || item.auth_token !== "" }));
      });
    });
  }

  function confirmRemove(endpoint: ConsoleEndpointConfig | undefined) {
    removeError.set("");
    removeTarget.set(endpoint ?? null);
  }

  function remove() {
    const target = untracked(removeTarget);
    if (untracked(busy) || !target) return;
    removeError.set("");
    const values = (props.endpoints || [])
      .filter((item) => item.name !== target.name)
      .map((item) => ({ original_name: item.name, name: item.name, url: item.url, auth_token: "" }));
    props.onSave?.(values, (error) => {
      if (error) {
        removeError.set(error);
        return;
      }
      if (untracked(editingName) === target.name) editorOpen.set(false);
      removeTarget.set(null);
    });
  }

  // The pane's open state goes to the page; closing drops the typed token and the error.
  let wasOpen = false;
  effect(() => {
    const open = editorOpen();
    if (open === wasOpen) return;
    wasOpen = open;
    untracked(() => {
      props.onPaneChange?.(open);
      if (!open) {
        draft.update((d) => ({ ...d, auth_token: "" }));
        editorError.set("");
      }
    });
  });
  // The page's Add button asks for the add pane; it opens once the list is ready.
  effect(() => {
    const requested = props.addRequested;
    const ready = !props.loading && !props.saving;
    if (!requested || !ready) return;
    untracked(() => {
      edit();
      props.onAddOpened?.();
    });
  });
  cleanup(() => {
    if (untracked(editorOpen)) props.onPaneChange?.(false);
  });

  const paneTitle = () => (editingName() === null ? t("overview_add_console") : editingName() || "");
  const closePane = () => editorOpen.set(false);
  const inTarget = () => !!props.paneTarget && !props.mobile;

  const pane = () => (
    <SettingsPane
      literal
      open={editorOpen()}
      sheet={props.mobile}
      title={paneTitle()}
      label={t(editingName() === null ? "overview_add_console" : "remote_edit_agent")}
      closeLabel={t("settings_channel_close")}
      onClose={closePane}
      testID="console-endpoint-pane"
      foot={
        dirty() || editingName() === null || editorError() ? (
          <>
            <Text class={`flex-1 text-xs ${editorError() ? "text-danger" : "text-muted-foreground"}`} testID="console-endpoint-foot">
              {editorError() || (dirty() ? t("settings_channel_unsaved_note") : "")}
            </Text>
            <Button
              variant="primary"
              label={t("action_save")}
              loading={props.saving}
              disabled={busy() || !valid() || (!dirty() && editingName() !== null)}
              onPress={save}
              testID="console-endpoint-save"
            />
          </>
        ) : undefined
      }
    >
      <TextField
        label={t("remote_agent_name")}
        value={draft().name}
        disabled={props.saving}
        onChange={(value) => updateDraft("name", value)}
        onSubmit={save}
        testID="console-endpoint-name"
      />
      <TextField
        label="Runtime API URL"
        value={draft().url}
        placeholder="https://agent.example.com/runtime"
        disabled={props.saving}
        mono
        onChange={(value) => updateDraft("url", value)}
        onSubmit={save}
        testID="console-endpoint-url"
      />
      <View class="gap-1">
        <Text class="text-xs font-medium text-subtle">{t("remote_access_token")}</Text>
        <SecretInput
          value={draft().auth_token}
          status={{ configured: draft().configured }}
          placeholder={t("remote_token_required")}
          disabled={props.saving}
          onChange={(value) => updateDraft("auth_token", value)}
          testID="console-endpoint-token"
        />
        <Text class="text-xs text-muted-foreground">{t("remote_token_note")}</Text>
      </View>
      <If when={editingName() !== null}>
        <Button
          variant="danger"
          icon="PhTrash"
          label={t("remote_remove_agent")}
          disabled={busy()}
          onPress={() => confirmRemove((props.endpoints || []).find((item) => item.name === untracked(editingName)))}
          testID="console-endpoint-remove"
        />
      </If>
    </SettingsPane>
  );

  usePaneTarget(() => (inTarget() ? props.paneTarget : undefined), editorOpen, paneKey, pane);

  return (
    <View class="flex-row" testID="console-endpoints">
      <View class="flex-1">
        <SettingsCard
          title={t("remote_agents_title")}
          list
          metaLead={<Text class="font-mono text-xs font-semibold text-foreground">{String((props.endpoints || []).length)}</Text>}
          meta={t("remote_agents_note")}
          actions={
            <Button
              variant="plain"
              size="xs"
              icon="PhPlus"
              label={t("overview_add_console")}
              disabled={busy()}
              onPress={() => edit()}
              testID="console-endpoint-add"
            />
          }
        >
          <If when={props.loading}>
            <ProgressBar indeterminate />
          </If>
          <If when={!props.loading && !rows().length}>
            <Text class="py-5 text-base text-muted-foreground" testID="console-endpoints-empty">
              {t("remote_agents_empty")}
            </Text>
          </If>
          <View>
            <Each of={rows()} key={(endpoint) => endpoint.name}>
              {(endpoint, index) => (
                <View
                  role="button"
                  accessibilityLabel={t("remote_edit_named", { name: endpoint().name })}
                  accessibilityState={{ selected: editorOpen() && editingName() === endpoint().name, disabled: busy() }}
                  disabled={busy()}
                  onPress={() => edit(endpoint())}
                  class={`gap-1 px-2 py-2.5 hover:bg-hover ${index() > 0 ? "border-t border-line-soft" : ""} ${
                    editorOpen() && editingName() === endpoint().name ? "bg-blue/9" : ""
                  }`}
                >
                  <View class="flex-row items-center justify-between gap-3">
                    <Text class="flex-1 text-sm font-semibold text-foreground line-clamp-1">{endpoint().name}</Text>
                    <View class="flex-row items-center gap-1.5">
                      <StatusMark
                        state={endpoint().status === "online" ? "on" : endpoint().status === "offline" ? "error" : endpoint().status === "checking" ? "pending" : "off"}
                      />
                      <Text class="text-xs text-muted-foreground">{t(`remote_status_${endpoint().status}`)}</Text>
                    </View>
                  </View>
                  <Text class="font-mono text-xs text-subtle line-clamp-1">{endpoint().url}</Text>
                </View>
              )}
            </Each>
          </View>
        </SettingsCard>
      </View>

      <If when={!inTarget()}>{pane()}</If>

      <DialogShell
        open={!!removeTarget()}
        title={t("remote_remove_agent")}
        size="sm"
        closeDisabled={props.saving}
        onClose={() => removeTarget.set(null)}
        testID="console-endpoint-remove-dialog"
        footer={
          <>
            <Button variant="outlined" label={t("action_cancel")} disabled={props.saving} onPress={() => removeTarget.set(null)} />
            <Button
              variant="danger"
              label={t("remote_remove_agent")}
              loading={props.saving}
              disabled={props.saving}
              onPress={remove}
              testID="console-endpoint-remove-confirm"
            />
          </>
        }
      >
        <Text class="text-sm text-foreground">{t("remote_remove_confirm", { name: removeTarget()?.name || "" })}</Text>
        <If when={removeError()}>
          <Text class="text-sm text-danger" role="alert" testID="console-endpoint-remove-error">
            {removeError()}
          </Text>
        </If>
      </DialogShell>
    </View>
  );
}
