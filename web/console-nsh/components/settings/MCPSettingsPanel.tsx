// The MCP servers section of Settings (the Vue console's MCPSettingsPanel): the list with an
// on/off switch per server, and a side pane that edits one server as a draft (Save writes it into
// the list and saves the list).
//
// Vue to nsh: `modelValue` is `servers`; `save` is `onSave(servers)`, `pane-change` is
// `onPaneChange(open)`; `paneTarget` is a PaneTarget (see PaneTarget.tsx).
import { batch, cleanup, computed, effect, signal, Text, untracked, View } from "nsh";
import { Button, Icon, Skeleton, Tabs, TextField } from "../ui";
import { SettingSwitch, SettingsCard, SettingToggleRow } from "../settings-page/parts";
import { t } from "./DialogShell";
import { type PaneTarget, SettingsPane, usePaneTarget } from "./PaneTarget";

export interface MCPPair {
  _key?: string;
  key: string;
  value: string;
}

/** One server as the Settings page keeps it (the Vue `state.mcp.servers` items). */
export interface MCPServer {
  _key?: string;
  name: string;
  enable?: boolean;
  on_demand?: boolean;
  description?: string;
  type?: "stdio" | "http";
  command?: string;
  args_text?: string;
  env_rows?: MCPPair[];
  url?: string;
  header_rows?: MCPPair[];
  allowed_tools_text?: string;
}

export interface MCPSettingsPanelProps {
  /** The Vue `modelValue`. */
  servers: MCPServer[];
  loading?: boolean;
  saving?: boolean;
  readOnly?: boolean;
  readOnlyMessage?: string;
  validationError?: string;
  /** Phones: the server opens in a drawer. */
  mobile?: boolean;
  /** The page's pane column (see PaneTarget.tsx); without it the pane opens beside the list. */
  paneTarget?: PaneTarget;
  /** The whole new list, to save. */
  onSave?: (servers: MCPServer[]) => void;
  onPaneChange?: (open: boolean) => void;
}

type FullServer = Required<MCPServer> & { env_rows: Required<MCPPair>[]; header_rows: Required<MCPPair>[] };
type PairField = "env_rows" | "header_rows";
type TextFieldName = "name" | "description" | "type" | "command" | "args_text" | "url" | "allowed_tools_text";

let keySeed = 0;
function nextKey(kind: string) {
  keySeed += 1;
  return `mcp-${kind}-${keySeed}`;
}

function clonePair(row: Partial<MCPPair> | undefined): Required<MCPPair> {
  return { _key: String(row?._key || nextKey("pair")), key: String(row?.key || ""), value: String(row?.value || "") };
}

/** A full copy of a server with every field set (the Vue `cloneServer`). */
export function cloneServer(server: Partial<MCPServer> | undefined): FullServer {
  return {
    _key: String(server?._key || nextKey("server")),
    name: String(server?.name || ""),
    enable: server?.enable !== false,
    on_demand: server?.on_demand === true,
    description: String(server?.description || ""),
    type: server?.type === "http" ? "http" : "stdio",
    command: String(server?.command || ""),
    args_text: String(server?.args_text || ""),
    env_rows: Array.isArray(server?.env_rows) ? server.env_rows.map(clonePair) : [],
    url: String(server?.url || ""),
    header_rows: Array.isArray(server?.header_rows) ? server.header_rows.map(clonePair) : [],
    allowed_tools_text: String(server?.allowed_tools_text || ""),
  };
}

function emptyServer() {
  return cloneServer({ enable: true, type: "stdio" });
}

export function MCPSettingsPanel(props: MCPSettingsPanelProps) {
  const paneOpen = signal(false);
  const editingIndex = signal(-1);
  const editor = signal<FullServer>(emptyServer());
  const dialogError = signal("");
  // Set when a server opens, not from the index, so saving a new server keeps its pane.
  const paneKey = signal("");
  // The editor is a draft of one server: Save writes it into the list, closing drops it.
  const snapshot = signal("");

  const servers = () => (Array.isArray(props.servers) ? props.servers : []);
  const busy = () => !!props.loading || !!props.saving || !!props.readOnly;
  const paneTitle = () =>
    editingIndex() < 0 ? t("settings_mcp_add_server") : editor().name.trim() || servers()[editingIndex()]?.name || "MCP Server";
  const dirty = computed(() => paneOpen() && JSON.stringify(cloneServer(editor())) !== snapshot());

  function replaceEditor(server: Partial<MCPServer>) {
    const copy = cloneServer(server);
    batch(() => {
      editor.set(copy);
      snapshot.set(JSON.stringify(cloneServer(copy)));
      dialogError.set("");
    });
  }

  function openAdd() {
    batch(() => {
      editingIndex.set(-1);
      paneKey.set(nextKey("pane"));
      replaceEditor(emptyServer());
      paneOpen.set(true);
    });
  }

  function openEdit(index: number) {
    const server = untracked(servers)[index];
    if (!server) return;
    if (untracked(paneOpen) && untracked(editingIndex) === index) {
      closePane();
      return;
    }
    batch(() => {
      editingIndex.set(index);
      paneKey.set(String(server._key || nextKey("pane")));
      replaceEditor(server);
      paneOpen.set(true);
    });
  }

  function closePane() {
    batch(() => {
      paneOpen.set(false);
      dialogError.set("");
    });
  }

  let wasOpen = false;
  effect(() => {
    const open = paneOpen();
    if (open === wasOpen) return;
    wasOpen = open;
    untracked(() => props.onPaneChange?.(open));
  });
  cleanup(() => {
    if (untracked(paneOpen)) props.onPaneChange?.(false);
  });

  function setServerEnabled(index: number, enabled: boolean) {
    const next = untracked(servers).map(cloneServer);
    if (!next[index]) return;
    next[index].enable = !!enabled;
    props.onSave?.(next);
  }

  function updateEditor(field: TextFieldName, value: string) {
    batch(() => {
      editor.update((server) => ({ ...server, [field]: String(value ?? "") }));
      dialogError.set("");
    });
  }

  function updateOnDemand(value: boolean) {
    batch(() => {
      editor.update((server) => ({ ...server, on_demand: !!value }));
      dialogError.set("");
    });
  }

  function addPair(field: PairField) {
    editor.update((server) => ({ ...server, [field]: [...server[field], { _key: nextKey("pair"), key: "", value: "" }] }));
  }

  function updatePair(field: PairField, rowKey: string, part: "key" | "value", value: string) {
    batch(() => {
      editor.update((server) => ({
        ...server,
        [field]: server[field].map((row) => (row._key === rowKey ? { ...row, [part]: String(value ?? "") } : row)),
      }));
      dialogError.set("");
    });
  }

  function removePair(field: PairField, rowKey: string) {
    editor.update((server) => ({ ...server, [field]: server[field].filter((row) => row._key !== rowKey) }));
  }

  function validate(next: FullServer[]) {
    const server = untracked(editor);
    const name = server.name.trim();
    if (!name) return t("settings_mcp_error_name_required");
    const index = untracked(editingIndex);
    const duplicate = next.some((item, i) => i !== index && String(item?.name || "").trim().toLowerCase() === name.toLowerCase());
    if (duplicate) return t("settings_mcp_error_name_duplicate", { name });
    if (server.enable && server.type === "http" && !server.url.trim()) return t("settings_mcp_error_url_required", { name });
    if (server.enable && server.type !== "http" && !server.command.trim()) return t("settings_mcp_error_command_required", { name });
    for (const rows of [server.env_rows, server.header_rows]) {
      const keys = new Set<string>();
      for (const row of rows) {
        const key = row.key.trim();
        if (!key) return t("settings_mcp_error_key_required", { name });
        const normalized = key.toLowerCase();
        if (keys.has(normalized)) return t("settings_mcp_error_key_duplicate", { name, key });
        keys.add(normalized);
      }
    }
    return "";
  }

  function saveEditor() {
    const next = untracked(servers).map(cloneServer);
    const error = validate(next);
    if (error) {
      dialogError.set(error);
      return;
    }
    const server = cloneServer(untracked(editor));
    batch(() => {
      if (untracked(editingIndex) < 0) {
        next.push(server);
        editingIndex.set(next.length - 1);
      } else {
        next[untracked(editingIndex)] = server;
      }
      snapshot.set(JSON.stringify(cloneServer(untracked(editor))));
    });
    props.onSave?.(next);
  }

  function deleteEditor() {
    const index = untracked(editingIndex);
    if (index < 0) return;
    const next = untracked(servers).map(cloneServer);
    next.splice(index, 1);
    closePane();
    props.onSave?.(next);
  }

  const transportTabs = () => [
    { id: "stdio", label: t("settings_mcp_stdio"), icon: "PhTerminalWindow" as const },
    { id: "http", label: t("settings_mcp_http"), icon: "PhGlobe" as const },
  ];
  const inTarget = () => !!props.paneTarget && !props.mobile;
  const showFoot = () => dirty() || editingIndex() < 0 || !!dialogError();

  function PairRows(pairProps: { field: PairField; keyPlaceholder: string; valuePlaceholder: string }) {
    return (
      <Each of={editor()[pairProps.field]} key={(row) => row._key}>
        {(row) => (
          <View class="flex-row items-start gap-2">
            <TextField
              class="flex-1"
              value={row().key}
              placeholder={pairProps.keyPlaceholder}
              disabled={busy()}
              mono
              onChange={(value) => updatePair(pairProps.field, row()._key, "key", value)}
            />
            <TextField
              class="flex-1"
              value={row().value}
              placeholder={pairProps.valuePlaceholder}
              disabled={busy()}
              mono
              onChange={(value) => updatePair(pairProps.field, row()._key, "value", value)}
            />
            <Button
              variant="plain"
              iconOnly
              icon="PhTrash"
              title={t("action_delete")}
              disabled={busy()}
              onPress={() => removePair(pairProps.field, row()._key)}
            />
          </View>
        )}
      </Each>
    );
  }

  const pane = () => (
    <SettingsPane
      literal
      open={paneOpen()}
      sheet={props.mobile}
      title={paneTitle()}
      meta={editor().type === "http" ? t("settings_mcp_http") : t("settings_mcp_stdio")}
      closeLabel={t("settings_channel_close")}
      onClose={closePane}
      testID="mcp-pane"
      foot={
        showFoot() ? (
          <>
            <Text class={`flex-1 text-xs ${dialogError() ? "text-danger" : "text-muted-foreground"}`} testID="mcp-pane-foot">
              {dialogError() || (dirty() ? t("settings_channel_unsaved_note") : "")}
            </Text>
            <Button
              variant="primary"
              label={t("action_save")}
              loading={props.saving}
              disabled={busy() || (!dirty() && editingIndex() >= 0)}
              onPress={saveEditor}
              testID="mcp-save"
            />
          </>
        ) : undefined
      }
    >
      <Tabs
        items={transportTabs().map((tab) => ({ ...tab, disabled: busy() }))}
        value={editor().type}
        onChange={(id) => updateEditor("type", id)}
      />
      <TextField
        label={t("settings_mcp_name")}
        value={editor().name}
        placeholder={t("settings_mcp_name_placeholder")}
        disabled={busy()}
        onChange={(value) => updateEditor("name", value)}
        testID="mcp-name"
      />
      <SettingToggleRow
        first
        title={t("settings_mcp_on_demand")}
        note={t("settings_mcp_on_demand_note", { name: editor().name.trim() || "<name>" })}
        checked={editor().on_demand}
        disabled={busy()}
        onChange={updateOnDemand}
        testID="mcp-on-demand"
      />
      <TextField
        label={t("settings_mcp_description")}
        hint={t("settings_mcp_description_note")}
        value={editor().description}
        placeholder={t("settings_mcp_description_placeholder")}
        disabled={busy()}
        onChange={(value) => updateEditor("description", value)}
        testID="mcp-description"
      />
      <If
        when={editor().type === "http"}
        else={
          <>
            <TextField
              label={t("settings_mcp_command")}
              value={editor().command}
              placeholder="node"
              disabled={busy()}
              mono
              onChange={(value) => updateEditor("command", value)}
              testID="mcp-command"
            />
            <TextField
              label={t("settings_mcp_arguments")}
              hint={t("settings_mcp_arguments_note")}
              value={editor().args_text}
              placeholder={t("settings_mcp_arguments_placeholder")}
              multiline
              rows={3}
              disabled={busy()}
              mono
              onChange={(value) => updateEditor("args_text", value)}
              testID="mcp-arguments"
            />
            <View class="gap-2">
              <View class="flex-row items-center justify-between gap-2">
                <Text class="text-xs font-medium text-subtle">{t("settings_mcp_environment")}</Text>
                <Button
                  variant="plain"
                  icon="PhPlus"
                  label={t("settings_mcp_add_variable")}
                  disabled={busy()}
                  onPress={() => addPair("env_rows")}
                  testID="mcp-add-variable"
                />
              </View>
              <PairRows field="env_rows" keyPlaceholder={t("settings_mcp_variable_name")} valuePlaceholder={t("settings_mcp_variable_value")} />
            </View>
          </>
        }
      >
        <TextField
          label={t("settings_mcp_url")}
          value={editor().url}
          placeholder="https://mcp.example.com/mcp"
          disabled={busy()}
          mono
          onChange={(value) => updateEditor("url", value)}
          testID="mcp-url"
        />
        <View class="gap-2">
          <View class="flex-row items-center justify-between gap-2">
            <Text class="text-xs font-medium text-subtle">{t("settings_mcp_headers")}</Text>
            <Button
              variant="plain"
              icon="PhPlus"
              label={t("settings_mcp_add_header")}
              disabled={busy()}
              onPress={() => addPair("header_rows")}
              testID="mcp-add-header"
            />
          </View>
          <PairRows field="header_rows" keyPlaceholder={t("settings_mcp_header_name")} valuePlaceholder={t("settings_mcp_header_value")} />
        </View>
      </If>
      <TextField
        label={t("settings_mcp_allowed_tools")}
        hint={t("settings_mcp_allowed_tools_note")}
        value={editor().allowed_tools_text}
        placeholder={t("settings_mcp_allowed_tools_placeholder")}
        multiline
        rows={3}
        disabled={busy()}
        mono
        onChange={(value) => updateEditor("allowed_tools_text", value)}
        testID="mcp-allowed-tools"
      />
      <If when={editingIndex() >= 0}>
        <Button
          variant="danger"
          icon="PhTrash"
          label={t("settings_mcp_delete_server")}
          disabled={busy()}
          onPress={deleteEditor}
          testID="mcp-delete"
        />
      </If>
    </SettingsPane>
  );

  usePaneTarget(() => (inTarget() ? props.paneTarget : undefined), paneOpen, paneKey, pane);

  return (
    <View class="flex-row" testID="mcp-settings">
      <View class="flex-1">
        <SettingsCard
          title={t("settings_mcp_title")}
          meta={t("settings_section_mcp_meta")}
          actions={
            <Button
              variant="plain"
              size="xs"
              iconOnly
              icon="PhPlus"
              title={t("settings_mcp_add_server")}
              disabled={busy()}
              onPress={openAdd}
              testID="mcp-add"
            />
          }
        >
          <If when={props.readOnly}>
            <View class="rounded-(--radius) border border-warn bg-card px-3 py-2.5">
              <Text class="text-xs text-foreground">{props.readOnlyMessage ?? ""}</Text>
            </View>
          </If>
          <If when={!props.readOnly && props.validationError}>
            <View class="rounded-(--radius) border border-danger bg-card px-3 py-2.5">
              <Text class="text-xs text-danger" testID="mcp-validation-error">
                {props.validationError ?? ""}
              </Text>
            </View>
          </If>
          <If
            when={!props.loading}
            else={<Skeleton rows={4} />}
          >
            <If
              when={servers().length}
              else={
                <View class="min-h-45 items-center justify-center gap-2" testID="mcp-empty">
                  <View class="mb-1">
                    <Icon name="PhPlugsConnected" size={34} color="muted-foreground" />
                  </View>
                  <Text class="text-base font-semibold text-subtle">{t("settings_mcp_empty")}</Text>
                  <Text class="text-center text-base text-muted-foreground">{t("settings_mcp_empty_note")}</Text>
                </View>
              }
            >
              <View>
                <Each of={servers()} key={(server) => String(server._key || server.name)}>
                  {(server, index) => (
                    <View
                      class={`flex-row items-center gap-3 ${index() > 0 ? "border-t border-line-soft" : ""} ${
                        paneOpen() && editingIndex() === index() ? "bg-blue/9" : ""
                      }`}
                    >
                      <View
                        role="button"
                        accessibilityLabel={server().name}
                        accessibilityState={{ selected: paneOpen() && editingIndex() === index(), disabled: busy() }}
                        disabled={busy()}
                        onPress={() => openEdit(index())}
                        class="flex-1 gap-0.5 px-2 py-3 hover:bg-hover"
                      >
                        <Text class="text-sm font-semibold text-foreground">{server().name}</Text>
                        <Text class="font-mono text-xs text-muted-foreground line-clamp-1">
                          {server().type === "http" ? server().url ?? "" : server().command ?? ""}
                        </Text>
                        <If when={server().on_demand}>
                          <Text class="text-xs text-muted-foreground">{t("settings_mcp_on_demand_hint", { name: server().name })}</Text>
                        </If>
                      </View>
                      <View class="pr-2">
                        <SettingSwitch
                          checked={server().enable !== false}
                          disabled={busy()}
                                                    testID={`mcp-enable-${index()}`}
                          onChange={(value) => setServerEnabled(index(), value)}
                        />
                      </View>
                    </View>
                  )}
                </Each>
              </View>
            </If>
          </If>
        </SettingsCard>
      </View>
      <If when={!inTarget()}>{pane()}</If>
    </View>
  );
}
