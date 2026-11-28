// Gallery demos: the Settings page's rows and typed fields (components/settings-page,
// components/settings/SettingFields), and its panels and dialogs that take all their data as
// props. Saving anywhere here only notes the action.
import { signal, Text, View } from "nsh";
import { LOGGING_LEVEL_OPTIONS } from "../../../lib/core/config-options.js";
import { SETUP_PROVIDER_OPTIONS } from "../../../lib/core/setup-contract.js";
import { PokeDialog } from "../../../components/settings-page/PokeDialog";
import { CodexAuthDialog, XAIAuthDialog } from "../../../components/settings/AuthDialogs";
import { ConfigSettingsPanel } from "../../../components/settings/ConfigSettingsPanel";
import { DialogShell, InlineNotice as DialogInlineNotice } from "../../../components/settings/DialogShell";
import { EnvManagedField } from "../../../components/settings/EnvManagedField";
import { ImageUploadField } from "../../../components/settings/ImageUploadField";
import { InferenceProviderPicker, type ProviderItem } from "../../../components/settings/InferenceProviderPicker";
import { SettingDialog } from "../../../components/settings/SettingDialog";
import { SetupConnectionTestDialog } from "../../../components/settings/SetupConnectionTestDialog";
import { SetupPickerDialog } from "../../../components/settings/SetupPickerDialog";
import { Button, Muted, TextField } from "../../../components/ui";
import { RawTextEditorDialog } from "../../repair/RawTextEditorDialog";
import { InlineNotice as SetupInlineNotice } from "../../setup/InlineNotice";
import { act, Col, type DemoMap, LONG_TEXT, LONG_WORD, Row, t, useFlag, useText, V } from "../demo";

const PROVIDERS = SETUP_PROVIDER_OPTIONS as ProviderItem[];

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
      <V l="CodexAuthDialog · XAIAuthDialog" row>
        {button("CodexAuthDialog")}
        {button("XAIAuthDialog")}
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
    </Col>
  );
}

export const SETTINGS_DEMOS: DemoMap = {
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
};
