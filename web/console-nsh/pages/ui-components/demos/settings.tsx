// Gallery demos: the Settings page's rows and typed fields (components/settings-page,
// components/settings/SettingFields), and its panels and dialogs that take all their data as
// props. Saving anywhere here only notes the action.
import { signal, Text, View } from "nsh";
import { ADMIN_PLATFORM_OPTIONS, HEARTBEAT_INTERVAL_OPTIONS, LOGGING_LEVEL_OPTIONS } from "../../../lib/core/config-options.js";
import { SETUP_PROVIDER_OPTIONS } from "../../../lib/core/setup-contract.js";
import { PokeDialog } from "../../../components/settings-page/PokeDialog";
import {
  BoxFold,
  DirtyDot,
  Fold,
  GroupTitle,
  PaneHead,
  PlaceholderButton,
  RestartTag,
  SettingField as PageSettingField,
  SettingRow,
  SettingsCard,
  SettingSwitch,
  SettingToggleRow,
} from "../../../components/settings-page/parts";
import { SettingsRestartBanner, SettingsSaveBar } from "../../../components/settings-page/SaveBar";
import { CodexAuthDialog, DeviceAuthDialogContent, ProAuthDialog, XAIAuthDialog } from "../../../components/settings/AuthDialogs";
import { AuthProfilesPanel } from "../../../components/settings/AuthProfilesPanel";
import { ConfigSettingsPanel } from "../../../components/settings/ConfigSettingsPanel";
import { ConsolePasswordPanel } from "../../../components/settings/ConsolePasswordPanel";
import { DialogShell, InlineNotice as DialogInlineNotice } from "../../../components/settings/DialogShell";
import { EnvManagedField } from "../../../components/settings/EnvManagedField";
import { ImageUploadField } from "../../../components/settings/ImageUploadField";
import { InferenceProviderPicker, ProviderLogo, type ProviderItem } from "../../../components/settings/InferenceProviderPicker";
import { MCPSettingsPanel, type MCPServer } from "../../../components/settings/MCPSettingsPanel";
import { ModelRoutesPanel } from "../../../components/settings/ModelRoutesPanel";
import { SettingsPane } from "../../../components/settings/PaneTarget";
import { SettingDialog } from "../../../components/settings/SettingDialog";
import {
  SettingBytes,
  SettingChoices,
  SettingDuration,
  SettingField,
  SettingFieldGrid,
  SettingLimit,
  SettingMenu,
  SettingPath,
  SettingPercent,
  SettingRows,
  SettingSelect,
} from "../../../components/settings/SettingFields";
import { SetupConnectionTestDialogContent, SetupConnectionTestDialog } from "../../../components/settings/SetupConnectionTestDialog";
import { SetupPickerDialog } from "../../../components/settings/SetupPickerDialog";
import { Badge, Button, Muted, TextField } from "../../../components/ui";
import { RawTextEditorDialog } from "../../repair/RawTextEditorDialog";
import { RuntimeFold } from "../../settings/RuntimePanel";
import { InlineNotice as SetupInlineNotice } from "../../setup/InlineNotice";
import { act, Col, type DemoMap, LONG_TEXT, LONG_WORD, Row, t, useFlag, useText, V, Wide } from "../demo";

const PROVIDERS = SETUP_PROVIDER_OPTIONS as ProviderItem[];

/** A value a field writes, read out under it. */
function Echo(props: { value: unknown }) {
  return <Text class="font-mono text-[11px] text-muted-foreground">{typeof props.value === "string" ? JSON.stringify(props.value) : JSON.stringify(props.value)}</Text>;
}

function FieldsDemo() {
  const level = signal("info");
  const interval = signal("30m");
  const duration = signal("30m");
  const zero = signal("0s");
  const bytes = signal("536870912");
  const limit = signal("0");
  const path = signal("");
  const percent = signal("0.5");
  const off = useFlag(false);
  return (
    <Col>
      <Button variant="outlined" size="xs" selected={off.on()} label={t("uig_state_disabled")} onPress={off.toggle} testID="uig-settings-disable" />
      <SettingFieldGrid>
        <SettingField label="SettingSelect" note={t("uig_fixture_hint")}>
          <SettingSelect value={level()} onChange={(v) => level.set(v)} options={LOGGING_LEVEL_OPTIONS} label="SettingSelect" disabled={off.on()} testID="uig-setting-select" />
          <Echo value={level()} />
        </SettingField>
        <SettingField label="SettingSelect · allowCustom">
          <SettingSelect value={interval()} onChange={(v) => interval.set(v)} options={HEARTBEAT_INTERVAL_OPTIONS} allowCustom label="SettingSelect custom" disabled={off.on()} />
          <Echo value={interval()} />
        </SettingField>
        <SettingField label="SettingDuration">
          <SettingDuration value={duration()} onChange={(v) => duration.set(v)} label="SettingDuration" disabled={off.on()} testID="uig-setting-duration" />
          <Echo value={duration()} />
        </SettingField>
        <SettingField label="SettingDuration · zeroLabel">
          <SettingDuration value={zero()} onChange={(v) => zero.set(v)} zeroLabel={t("uig_fixture_empty_title")} label="SettingDuration zero" disabled={off.on()} />
          <Echo value={zero()} />
        </SettingField>
        <SettingField label="SettingBytes">
          <SettingBytes value={bytes()} onChange={(v) => bytes.set(v)} label="SettingBytes" disabled={off.on()} />
          <Echo value={bytes()} />
        </SettingField>
        <SettingField label="SettingLimit" note={LONG_TEXT} noteItalic>
          <SettingLimit value={limit()} onChange={(v) => limit.set(v)} defaultLimit="200000" label="SettingLimit" disabled={off.on()} />
          <Echo value={limit()} />
        </SettingField>
        <SettingField label="SettingPath">
          <SettingPath value={path()} onChange={(v) => path.set(v)} label="SettingPath" placeholder="<state>/logs" disabled={off.on()} />
          <Echo value={path()} />
        </SettingField>
        <SettingField label="SettingPercent" labelRight={<RestartTag />}>
          <SettingPercent value={percent()} onChange={(v) => percent.set(v)} label="SettingPercent" disabled={off.on()} />
          <Echo value={percent()} />
        </SettingField>
        <SettingField label={LONG_TEXT} inactive wide>
          <TextField value="inactive · wide" readonly />
        </SettingField>
      </SettingFieldGrid>
    </Col>
  );
}

function RowsDemo() {
  const list = signal("~/.ssh\n/etc");
  const map = signal('{\n  "X-Token": "a"\n}');
  const identities = signal("tg:42");
  const patterns = signal("[]");
  const choices = signal<string[]>(["GET"]);
  return (
    <SettingFieldGrid>
      <SettingField label="SettingRows · list" wide>
        <SettingRows value={list()} onChange={(v) => list.set(v)} mode="list" addLabel={t("uig_fixture_add")} label="list" testID="uig-setting-rows" />
        <Echo value={list()} />
      </SettingField>
      <SettingField label="SettingRows · map" wide>
        <SettingRows value={map()} onChange={(v) => map.set(v)} mode="map" addLabel={t("uig_fixture_add")} label="map" />
      </SettingField>
      <SettingField label="SettingRows · identities" wide>
        <SettingRows value={identities()} onChange={(v) => identities.set(v)} mode="identities" platforms={ADMIN_PLATFORM_OPTIONS} addLabel={t("uig_fixture_add")} label="identities" />
      </SettingField>
      <SettingField label="SettingRows · patterns" wide>
        <SettingRows value={patterns()} onChange={(v) => patterns.set(v)} mode="patterns" addLabel={t("uig_fixture_add")} label="patterns" />
      </SettingField>
      <SettingField label="SettingRows · fallback" wide>
        <SettingRows value={'{"a": 1}'} mode="map" label="fallback" fallback={<Muted>{t("uig_fixture_empty_text")}</Muted>} />
      </SettingField>
      <SettingField label="SettingChoices" wide>
        <SettingChoices value={choices()} onChange={(v) => choices.set(v)} options={["GET", "POST", "PUT", "DELETE"]} disabledOptions={["DELETE"]} label="SettingChoices" testID="uig-setting-choices" />
        <Echo value={choices()} />
      </SettingField>
    </SettingFieldGrid>
  );
}

function PageRowsDemo() {
  const a = useFlag(true);
  const b = useFlag(false);
  const fold = useFlag(false);
  const box = useFlag(true);
  const runtime = useFlag(false);
  return (
    <Col>
      <V l="SettingsCard · boxed">
        <SettingsCard
          title={t("uig_fixture_title")}
          meta={t("uig_fixture_hint")}
          actions={<Button variant="plain" size="xs" label={t("action_refresh")} onPress={() => act("SettingsCard")} />}
          list
        >
          <SettingToggleRow first title={t("uig_fixture_toggle")} note={t("uig_fixture_hint")} checked={a.on()} onChange={a.set} testID="uig-setting-toggle-row" />
          <SettingToggleRow title={LONG_TEXT} note={LONG_TEXT} checked={b.on()} onChange={b.set} actions={<Button variant="plain" size="xs" label={t("uig_fixture_menu")} onPress={() => act("SettingToggleRow", "action")} />} />
          <SettingToggleRow title={t("uig_fixture_toggle")} checked disabled note={t("uig_state_disabled")} />
          <SettingRow title={t("uig_fixture_name")} note={t("uig_fixture_hint")} status={<Badge tone="ok" label={t("uig_state_on")} />}>
            <Button variant="outlined" size="xs" label={t("uig_fixture_open")} onPress={() => act("SettingRow")} />
          </SettingRow>
          <SettingRow title={LONG_TEXT} note={LONG_TEXT} inline>
            <SettingSwitch checked={a.on()} onChange={a.set} accessibilityLabel={t("uig_fixture_toggle")} />
          </SettingRow>
        </SettingsCard>
      </V>
      <V l="SettingsCard · plain · literal">
        <SettingsCard variant="plain" literal title={LONG_TEXT} metaLead={<DirtyDot label={t("uig_state_filled")} />} meta={t("uig_fixture_count_one")}>
          <PageSettingField label={t("uig_fixture_name")} note={t("uig_fixture_hint")} right={<RestartTag />}>
            <TextField value="Morph" readonly />
          </PageSettingField>
        </SettingsCard>
      </V>
      <V l="SettingsCard · headOnly">
        <SettingsCard title={t("uig_fixture_title")} headOnly actions={<PlaceholderButton label={t("uig_fixture_add")} icon="PhPlus" onPress={() => act("PlaceholderButton")} />} />
      </V>
      <V l="Fold">
        <Fold open={fold.on()} onToggle={fold.toggle} title={t("uig_fixture_title")} note={t("uig_fixture_hint")} testID="uig-fold">
          <View testID="uig-fold-body"><Muted>{LONG_TEXT}</Muted></View>
        </Fold>
      </V>
      <V l="BoxFold">
        <BoxFold open={box.on()} onToggle={box.toggle} title={LONG_TEXT}>
          <Muted>{LONG_TEXT}</Muted>
        </BoxFold>
      </V>
      <V l="RuntimeFold">
        <RuntimeFold open={runtime.on()} onToggle={runtime.toggle} title={t("uig_fixture_title")}>
          <Muted>{LONG_TEXT}</Muted>
        </RuntimeFold>
      </V>
      <V l="GroupTitle · PaneHead">
        <GroupTitle text={t("uig_fixture_title")} />
        <View class="border border-line-faint">
          <PaneHead title={t("uig_fixture_title")} meta={t("uig_fixture_hint")} actions={<Button variant="plain" size="xs" iconOnly icon="PhX" title={t("action_close")} onPress={() => act("PaneHead", "close")} />} />
        </View>
        <View class="border border-line-faint">
          <PaneHead title={LONG_TEXT} literal meta={LONG_TEXT} />
        </View>
      </V>
      <V l="PlaceholderButton" row>
        <PlaceholderButton label={t("uig_fixture_add")} icon="PhPlus" onPress={() => act("PlaceholderButton")} />
        <PlaceholderButton label={t("uig_fixture_add")} disabled />
        <PlaceholderButton label={LONG_TEXT} class="max-w-64" />
      </V>
      <V l="RestartTag · DirtyDot · SettingSwitch" row>
        <RestartTag />
        <RestartTag label={t("uig_fixture_title")} />
        <DirtyDot label={t("uig_state_filled")} />
        <SettingSwitch checked={a.on()} onChange={a.set} accessibilityLabel={t("uig_fixture_toggle")} />
        <SettingSwitch checked disabled accessibilityLabel={t("uig_fixture_toggle")} />
      </V>
    </Col>
  );
}

function SaveBarDemo() {
  // The save bar floats over the foot of the window, so it starts hidden.
  const dirty = useFlag(false);
  const saving = useFlag(false);
  const failed = useFlag(false);
  const pending = useFlag(true);
  const tasks = useFlag(false);
  return (
    <Col>
      <View class="flex-row flex-wrap gap-2">
        <Button variant="outlined" size="xs" selected={dirty.on()} label="visible" onPress={dirty.toggle} testID="uig-savebar-toggle" />
        <Button variant="outlined" size="xs" selected={saving.on()} label="saving" onPress={saving.toggle} />
        <Button variant="outlined" size="xs" selected={failed.on()} label="failed" onPress={failed.toggle} />
        <Button variant="outlined" size="xs" selected={pending.on()} label="restart pending" onPress={pending.toggle} />
        <Button variant="outlined" size="xs" selected={tasks.on()} label="tasks running" onPress={tasks.toggle} />
      </View>
      <V l="SettingsRestartBanner">
        <View class="relative min-h-16">
          <SettingsRestartBanner
            pending={pending.on()}
            busy={false}
            restarting={false}
            tasksRunning={tasks.on()}
            error={failed.on() ? t("uig_fixture_error") : ""}
            onRestart={(force) => act("SettingsRestartBanner restart", force ? "force" : "normal")}
            onCancelForce={() => tasks.set(false)}
          />
        </View>
      </V>
      <V l="SettingsSaveBar">
        <View class="relative h-28 overflow-hidden rounded-(--radius) border border-line-faint">
          <SettingsSaveBar
            visible={dirty.on()}
            items={[t("uig_fixture_name"), t("uig_fixture_address"), LONG_TEXT]}
            failed={failed.on() ? t("uig_fixture_error") : ""}
            saving={saving.on()}
            busy={saving.on()}
            onSave={() => {
              act("SettingsSaveBar", "save");
              dirty.set(false);
            }}
          />
        </View>
      </V>
    </Col>
  );
}

const CONFIG_GROUPS = [
  {
    id: "logs",
    title: "Logging",
    note: "Synthetic fields: a switch, a select, numbers and text.",
    fields: [
      { path: "logging.enabled", label: "Write logs", type: "bool" },
      { path: "logging.level", label: "Level", type: "select", options: LOGGING_LEVEL_OPTIONS, dependsOn: "logging.enabled" },
      { path: "logging.max_size", label: "Max size", type: "int", dependsOn: "logging.enabled" },
      { path: "llm.temperature", label: "Temperature", type: "float", clearable: true, placeholder: "Provider default" },
      { path: "llm.model", label: "Model", type: "string" },
      { path: "server.listen", label: "Listen", type: "string" },
      { path: "file_state_dir", label: "State directory", type: "string" },
    ],
  },
  { id: "extra", title: "Extra", fields: [{ path: "tools.timeout", label: "Tool timeout", type: "string", duration: true, editor: "duration" }] },
];
const CONFIG_VALUES = {
  "logging.enabled": true,
  "logging.level": "info",
  "logging.max_size": 10,
  "llm.temperature": 0.7,
  "llm.model": "example-large-1",
  "server.listen": "127.0.0.1:9080",
  file_state_dir: "/synthetic/state",
  "tools.timeout": "30s",
};
const CONFIG_STATES = {
  "llm.temperature": { explicit: true },
  "llm.model": { source: "environment_override", env_name: "MODEL=example-large-1" },
  "server.listen": { apply_mode: "process_restart", source: "runtime_override" },
  file_state_dir: { apply_mode: "process_restart", source: "state_folder", editable: false },
};

const MCP_SERVERS: MCPServer[] = [
  { name: "files", enable: true, type: "stdio", command: "example-mcp-files", args_text: "--root /synthetic", description: "A synthetic stdio server.", env_rows: [{ key: "MODE", value: "demo" }] },
  { name: "search-with-a-long-server-name", enable: false, on_demand: true, type: "http", url: "https://mcp.example.com/search", description: LONG_TEXT, header_rows: [{ key: "X-Demo", value: "1" }], allowed_tools_text: "search\nfetch" },
];

const PICKER_ITEMS = [
  { id: "example/large-1", title: "example/large-1", value: "example/large-1", note: "200k context", meta: "$3 / $15", verdict: "recommended" },
  { id: "example/small-2", title: "example/small-2", value: "example/small-2", note: "128k context", meta: "$0.25 / $1" },
  { id: "other/huge-with-a-very-long-identifier-2026-03-14", title: "other/huge-with-a-very-long-identifier-2026-03-14", value: "other/huge-with-a-very-long-identifier-2026-03-14", note: LONG_TEXT },
  ...Array.from({ length: 14 }, (_, i) => ({ id: `other/model-${i}`, title: `other/model-${i}`, value: `other/model-${i}` })),
];

const BENCHMARKS = [
  { id: "text_reply", ok: true, duration_ms: 420, detail: "pong" },
  { id: "json_response", ok: true, duration_ms: 615, detail: '{"ok":true}' },
  { id: "tool_calling", ok: false, duration_ms: 1300, error: "The model did not call the tool.", raw_response: '{"choices":[{"message":{"content":"I cannot call tools."}}]}' },
];

function DialogsDemo() {
  const open = signal("");
  const close = () => open.set("");
  const poke = useText("Check the build and report back.");
  const raw = useText("name: Morph\nvibe: calm\n");
  const picked = signal("example/large-1");
  const setDefault = useFlag(true);
  const button = (id: string) => <Button variant="outlined" label={id} onPress={() => open.set(id)} testID={`uig-dialog-${id.replace(/ /g, "-")}`} />;
  return (
    <Col>
      <V l="DialogShell · SettingDialog · PokeDialog · RawTextEditorDialog" row>
        {button("DialogShell")}
        {button("SettingDialog")}
        {button("PokeDialog")}
        {button("RawTextEditorDialog")}
      </V>
      <V l="SetupPickerDialog · SetupConnectionTestDialog" row>
        {button("SetupPickerDialog")}
        {button("SetupPickerDialog loading")}
        {button("SetupPickerDialog error")}
        {button("SetupConnectionTestDialog")}
        <Text class="text-xs text-muted-foreground">{t("uig_fixture_echo", { value: picked() })}</Text>
      </V>
      <V l="CodexAuthDialog · XAIAuthDialog · ProAuthDialog" row>
        {button("CodexAuthDialog")}
        {button("XAIAuthDialog")}
        {button("ProAuthDialog")}
      </V>
      <DialogShell
        open={open() === "DialogShell"}
        onClose={close}
        title={t("uig_fixture_title")}
        testID="uig-dialogshell"
        footer={<Button label={t("action_close")} onPress={close} testID="uig-dialogshell-done" />}
      >
        <View class="gap-3 p-4">
          <DialogInlineNotice type="info" text={t("uig_fixture_dialog_text")} />
          <Muted>{LONG_TEXT}</Muted>
        </View>
      </DialogShell>
      <SettingDialog
        open={open() === "SettingDialog"}
        onOpenChange={(next) => !next && close()}
        title={t("uig_fixture_title")}
        onSave={() => {
          act("SettingDialog", "save");
          close();
        }}
        testID="uig-settingdialog"
      >
        <Muted>{t("uig_fixture_dialog_text")}</Muted>
        <TextField label={t("uig_fixture_name")} value={poke.get()} onChange={poke.set} />
      </SettingDialog>
      <PokeDialog
        open={open() === "PokeDialog"}
        onClose={close}
        body={poke.get()}
        onBodyChange={poke.set}
        bodyTooLarge={poke.get().length > 120}
        disabled={false}
        error={poke.get().length > 120 ? t("uig_fixture_error") : ""}
        submitDisabled={!poke.get().trim() || poke.get().length > 120}
        submitting={false}
        onSubmit={() => {
          act("PokeDialog", "submit");
          close();
        }}
      />
      <RawTextEditorDialog
        open={open() === "RawTextEditorDialog"}
        title="identity.yaml"
        path="/synthetic/state/identity.yaml"
        value={raw.get()}
        onChange={raw.set}
        onClose={close}
        onSave={() => {
          act("RawTextEditorDialog", "save");
          close();
        }}
      />
      <SetupPickerDialog
        open={open().startsWith("SetupPickerDialog")}
        onOpenChange={(next) => !next && close()}
        title={t("uig_fixture_choice")}
        items={open() === "SetupPickerDialog" ? PICKER_ITEMS : []}
        loading={open() === "SetupPickerDialog loading"}
        error={open() === "SetupPickerDialog error" ? t("uig_fixture_error") : ""}
        showValue
        selectedValue={picked()}
        filterPlaceholder={t("uig_filter_placeholder")}
        emptyText={t("uig_fixture_empty_title")}
        groupByPrefix
        allowCustom
        onSelect={(item) => {
          picked.set(String(item.value || ""));
          act("SetupPickerDialog", item.value);
          close();
        }}
      />
      <SetupConnectionTestDialog
        open={open() === "SetupConnectionTestDialog"}
        onOpenChange={(next) => !next && close()}
        benchmarks={BENCHMARKS}
        provider="openai"
        apiBase="https://api.example.com/v1"
        model="example-large-1"
        onRetry={() => act("SetupConnectionTestDialog", "retry")}
      />
      <CodexAuthDialog
        open={open() === "CodexAuthDialog"}
        onOpenChange={(next) => !next && close()}
        status={{ logged_in: true, account_id: "acct-synthetic-42", file_mode_ok: false, file_mode_warning: "auth.json is world-readable" }}
        summary="Signed in"
        onLogout={() => act("CodexAuthDialog", "logout")}
      />
      <XAIAuthDialog
        open={open() === "XAIAuthDialog"}
        onOpenChange={(next) => !next && close()}
        status={{ logged_in: false }}
        summary=""
        loginSession="session-synthetic"
        userCode="ABCD-1234"
        loginExpiresLabel="10:00"
        setDefault={setDefault.on()}
        onSetDefaultChange={setDefault.set}
        onLogin={() => act("XAIAuthDialog", "login")}
        onLogout={() => act("XAIAuthDialog", "logout")}
      />
      <ProAuthDialog
        open={open() === "ProAuthDialog"}
        onOpenChange={(next) => !next && close()}
        error={t("uig_fixture_error")}
        status={{ logged_in: false }}
        summary=""
        onLogout={() => act("ProAuthDialog", "logout")}
      />
    </Col>
  );
}

function PaneDemo() {
  const open = useFlag(true);
  const sheet = useFlag(false);
  return (
    <Col>
      <View class="flex-row gap-2">
        <Button variant="outlined" size="xs" label={open.on() ? t("action_close") : t("uig_fixture_open")} onPress={open.toggle} />
        <Button variant="outlined" size="xs" label="sheet" onPress={() => sheet.set(true)} />
      </View>
      <View class="h-64 flex-row overflow-hidden rounded-(--radius) border border-line-faint">
        <View class="min-w-0 flex-1 p-3"><Muted>{LONG_TEXT}</Muted></View>
        <SettingsPane
          open={open.on()}
          title={t("uig_fixture_title")}
          meta={t("uig_fixture_hint")}
          closeLabel={t("action_close")}
          onClose={() => open.set(false)}
          foot={<Button label={t("action_save")} onPress={() => act("SettingsPane", "save")} />}
        >
          <View class="gap-2 p-4"><Muted>{LONG_TEXT}</Muted></View>
        </SettingsPane>
      </View>
      <SettingsPane open={sheet.on()} sheet title={LONG_TEXT} literal closeLabel={t("action_close")} onClose={() => sheet.set(false)}>
        <View class="gap-2 p-4"><Muted>{t("uig_fixture_dialog_text")}</Muted></View>
      </SettingsPane>
    </Col>
  );
}

export const SETTINGS_DEMOS: DemoMap = {
  SettingFieldGrid: { render: () => <FieldsDemo />, wide: true },
  SettingRows: { render: () => <RowsDemo />, wide: true },
  SettingMenu: {
    render: () => {
      const value = signal("b");
      const items = () => [
        { title: t("uig_fixture_option", { n: 1 }), value: "a", hint: t("uig_fixture_hint") },
        { title: t("uig_fixture_option", { n: 2 }), value: "b" },
        { title: t("uig_fixture_option", { n: 3 }), value: "c", disabled: true },
        { title: LONG_TEXT, value: "d" },
      ];
      return (
        <V s="default" row>
          <SettingMenu
            items={items()}
            selected={value()}
            label={t("uig_fixture_choice")}
            accessibilityLabel={t("uig_fixture_choice")}
            onSelect={(item) => value.set(item.value)}
            trigger={<View class="rounded-(--radius) border border-line px-3 py-2"><Text class="text-sm text-foreground">{t("uig_fixture_menu")}</Text></View>}
            testID="uig-setting-menu"
          />
          <Text class="text-xs text-muted-foreground">{t("uig_fixture_echo", { value: value() })}</Text>
        </V>
      );
    },
  },
  SettingsCard: { render: () => <PageRowsDemo />, wide: true },
  SettingsSaveBar: { render: () => <SaveBarDemo />, wide: true },
  SettingsPane: { render: () => <PaneDemo />, wide: true },
  EnvManagedField: {
    render: () => (
      <Col>
        <V s="default"><EnvManagedField name="MISTER_MORPH_LOG_LEVEL=debug" /></V>
        <V s="long"><EnvManagedField name={`MISTER_MORPH_${LONG_WORD.toUpperCase()}=value`} /></V>
        <V l="children"><EnvManagedField name="MISTER_MORPH_MODEL"><Muted>{t("uig_fixture_hint")}</Muted></EnvManagedField></V>
      </Col>
    ),
  },
  ImageUploadField: {
    render: () => (
      <Row>
        <V s="empty"><ImageUploadField crop outputSize={256} dialogTitle={t("uig_fixture_title")} onSave={() => act("ImageUploadField", "save")} onDelete={() => act("ImageUploadField", "delete")} /></V>
        <V s="busy"><ImageUploadField busy /></V>
        <V s="disabled"><ImageUploadField disabled /></V>
      </Row>
    ),
  },
  InferenceProviderPicker: {
    render: () => {
      const value = signal(PROVIDERS[0]?.value ?? "");
      return (
        <Row>
          <V s="default" class="w-72">
            <InferenceProviderPicker value={value()} items={PROVIDERS} onChange={(item) => value.set(item.value)} testID="uig-provider-picker" />
            <Text class="text-xs text-muted-foreground">{t("uig_fixture_echo", { value: value() })}</Text>
          </V>
          <V s="empty" class="w-72"><InferenceProviderPicker value="" items={PROVIDERS} placeholder={t("uig_fixture_placeholder")} onChange={(item) => value.set(item.value)} /></V>
          <V s="disabled" class="w-72"><InferenceProviderPicker value={value()} items={PROVIDERS} disabled disabledReason={t("uig_fixture_hint")} /></V>
          <V s="readonly" class="w-72"><InferenceProviderPicker value={value()} items={PROVIDERS} readOnly /></V>
        </Row>
      );
    },
  },
  ProviderLogo: {
    render: () => (
      <V s="default" row>
        <Each of={PROVIDERS.slice(0, 10)} key={(item) => item.value}>{(item) => <ProviderLogo item={item()} size={24} />}</Each>
        <ProviderLogo item={null} size={24} />
      </V>
    ),
  },
  "InlineNotice-settings-DialogShell": {
    render: () => (
      <Col>
        <Each of={["info", "success", "warning", "error"] as const} key={(type) => type}>
          {(type) => <V l={type()}><DialogInlineNotice type={type()} text={t("uig_fixture_notice", { type: type() })} /></V>}
        </Each>
        <V s="long"><DialogInlineNotice type="error" text={`${LONG_TEXT} ${LONG_WORD}`} /></V>
      </Col>
    ),
  },
  "InlineNotice-setup-InlineNotice": {
    render: () => (
      <Col>
        <Each of={["info", "success", "warning", "error"] as const} key={(type) => type}>
          {(type) => <V l={type()}><SetupInlineNotice type={type()} text={t("uig_fixture_notice", { type: type() })} /></V>}
        </Each>
      </Col>
    ),
  },
  DialogShell: { render: () => <DialogsDemo />, wide: true },
  DeviceAuthDialogContent: {
    render: () => (
      <Row>
        <V s="loading" class="w-80"><DeviceAuthDialogContent loading /></V>
        <V l="signed in" class="w-80">
          <DeviceAuthDialogContent status={{ logged_in: true, account_id: "acct-synthetic-42", user: { name: "Ada Example", email: "ada@example.com" }, subscription: "pro" }} summary="Signed in" onLogout={() => act("DeviceAuth", "logout")} onLogin={() => act("DeviceAuth", "login")} />
        </V>
        <V l="code" class="w-80">
          <DeviceAuthDialogContent status={{ logged_in: false }} loginSession="session-synthetic" userCode="ABCD-1234" loginExpiresLabel="10:00" onLogin={() => act("DeviceAuth", "login")} />
        </V>
        <V s="error" class="w-80"><DeviceAuthDialogContent status={{ logged_in: false }} error={t("uig_fixture_error")} onLogin={() => act("DeviceAuth", "login")} /></V>
      </Row>
    ),
    wide: true,
  },
  SetupConnectionTestDialogContent: {
    render: () => (
      <Row>
        <V s="default" class="min-w-72 flex-1"><SetupConnectionTestDialogContent benchmarks={BENCHMARKS} provider="openai" apiBase="https://api.example.com/v1" model="example-large-1" showIntro onRetry={() => act("ConnectionTest", "retry")} onClose={() => act("ConnectionTest", "close")} /></V>
        <V s="loading" class="min-w-72 flex-1"><SetupConnectionTestDialogContent loading provider="openai" apiBase="https://api.example.com/v1" model="example-large-1" /></V>
        <V s="error" class="min-w-72 flex-1"><SetupConnectionTestDialogContent error={`${t("uig_fixture_error")} ${LONG_WORD}`} provider="openai" model="example-large-1" onRetry={() => act("ConnectionTest", "retry")} /></V>
      </Row>
    ),
    wide: true,
  },
  ConfigSettingsPanel: {
    render: () => (
      <Col>
        <V s="default">
          <ConfigSettingsPanel groups={CONFIG_GROUPS} values={CONFIG_VALUES} fieldStates={CONFIG_STATES} inactiveGroups={{ extra: t("uig_fixture_hint") }} onSave={() => act("ConfigSettingsPanel", "save")} testID="uig-config-panel" />
        </V>
        <V s="loading"><ConfigSettingsPanel groups={[CONFIG_GROUPS[1]]} values={{}} loading /></V>
      </Col>
    ),
    wide: true,
  },
  ModelRoutesPanel: {
    render: () => (
      <Wide><View class="min-w-[620px] flex-1"><ModelRoutesPanel
        values={{ "llm.routes.main_loop": "cheap", "llm.routes.addressing": { profile: "ghost" } }}
        profiles={[{ value: "default", note: "example-large-1" }, { value: "cheap", note: "example-small-2" }, { value: "smart", note: "example-huge-3" }]}
        onSave={() => act("ModelRoutesPanel", "save")}
        onAddProfile={() => act("ModelRoutesPanel", "add profile")}
      /></View></Wide>
    ),
    wide: true,
  },
  AuthProfilesPanel: {
    render: () => (
      <Col>
        <V s="default">
          <AuthProfilesPanel
            profiles={[
              { name: "example-api", credential_kind: "bearer", credential_secret_configured: true, url_prefixes: ["https://api.example.com/"], methods: ["GET", "POST"] },
              { name: "long-profile-name-for-wrapping", credential_kind: "basic", url_prefixes: [`https://example.com/${LONG_WORD}`], methods: ["GET"] },
            ]}
            onSave={() => act("AuthProfilesPanel", "save")}
          />
        </V>
        <V s="empty"><AuthProfilesPanel profiles={[]} onSave={() => act("AuthProfilesPanel", "save")} /></V>
      </Col>
    ),
    wide: true,
  },
  MCPSettingsPanel: {
    render: () => {
      const servers = signal<MCPServer[]>(MCP_SERVERS);
      return (
        <Col>
          <V s="default">
            <MCPSettingsPanel
              servers={servers()}
              onSave={(next) => {
                servers.set(next);
                act("MCPSettingsPanel", "save");
              }}
            />
          </V>
          <V s="readonly"><MCPSettingsPanel servers={MCP_SERVERS.slice(0, 1)} readOnly readOnlyMessage={t("uig_fixture_hint")} /></V>
          <V s="empty"><MCPSettingsPanel servers={[]} onSave={() => act("MCPSettingsPanel", "save")} /></V>
        </Col>
      );
    },
    wide: true,
  },
  ConsolePasswordPanel: {
    render: () => (
      <Row>
        <V s="empty" class="min-w-72 flex-1"><ConsolePasswordPanel onSave={() => act("ConsolePasswordPanel", "save")} /></V>
        <V s="filled" l="configured" class="min-w-72 flex-1"><ConsolePasswordPanel configured onSave={() => act("ConsolePasswordPanel", "save")} /></V>
        <V s="busy" l="saving" class="min-w-72 flex-1"><ConsolePasswordPanel configured saving /></V>
      </Row>
    ),
    wide: true,
  },
};
