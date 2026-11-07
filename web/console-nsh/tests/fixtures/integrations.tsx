// The test entry of tests/settings-integrations*.test.tsx: mounts one of the settings integration
// components (host.params.view) with the console's API helpers, and reports each callback the
// component makes as a `morph.fixture.event` post ({ name, data }) the test reads.
import type { JSX } from "nsh";
import { effect, host, mount, signal, Text, untracked, View } from "nsh";
import { authState, configureApiBase, endpointApiFetch, endpointState } from "../../lib/core/context.js";
import { boot } from "../../lib/platform";
import { Button, NoticeHost } from "../../components/ui";
import {
  CodexAuthDialog,
  ProAuthDialog,
  useProAuthFlow,
  useXAIAuthFlow,
  XAIAuthDialog,
} from "../../components/settings/AuthDialogs";
import { WeChatLoginPanel, XLoginPanel } from "../../components/settings/ChannelLoginPanels";
import { MCPSettingsPanel, type MCPServer } from "../../components/settings/MCPSettingsPanel";
import { ConsoleEndpointsPanel, type ConsoleEndpointConfig } from "../../components/settings/ConsoleEndpointsPanel";
import { ConsolePasswordPanel } from "../../components/settings/ConsolePasswordPanel";
import { SettingsAppPanel, SettingsUpdatePanel } from "../../components/settings/SettingsAppPanel";
import { SettingsCreditsPanel } from "../../components/settings/SettingsCreditsPanel";
import { TopicNotificationSetting } from "../../components/settings/TopicNotificationSetting";
import { ImageUploadField } from "../../components/settings/ImageUploadField";
import { SetupConnectionTestDialog, type ConnectionBenchmark } from "../../components/settings/SetupConnectionTestDialog";
import { SetupPickerDialog, type SetupPickerItem } from "../../components/settings/SetupPickerDialog";
import { createPaneTarget, PaneOutlet } from "../../components/settings/PaneTarget";

const LOCAL = "ep_console_local";
const params = (host.params || {}) as Record<string, any>;

function report(name: string, data: unknown = null) {
  host.post("morph.fixture.event", { name, data: data === undefined ? null : JSON.parse(JSON.stringify(data)) });
}

/** The scenario's parameters, for the parts a test sets up front. */
const option = <T,>(name: string, fallback: T): T => (params[name] === undefined ? fallback : (params[name] as T));

function AuthScenario() {
  // The page's endpoint; a test switches it with `app.host.send("morph.fixture.endpoint", ref)`.
  const endpointRef = signal(LOCAL);
  host.on("morph.fixture.endpoint", (ref: unknown) => endpointRef.set(String(ref || "")));
  const pro = useProAuthFlow({
    request: endpointApiFetch,
    getEndpointRef: () => endpointRef(),
    onSettingsUpdated: (payload) => report("pro.settingsUpdated", payload),
  });
  const xai = useXAIAuthFlow({
    request: endpointApiFetch,
    getEndpointRef: () => endpointRef(),
    onSettingsUpdated: (payload) => report("xai.settingsUpdated", payload),
  });
  const codexOpen = signal(false);
  return (
    <View class="gap-2 p-4">
      <Button label="Open Pro" onPress={() => void pro.openProAuthDialog()} />
      <Button label="Open xAI" onPress={() => void xai.openXAIAuthDialog()} />
      <Button label="Load xAI" onPress={() => void xai.loadXAIAuthStatus()} />
      <Button label="Open Codex" onPress={() => codexOpen.set(true)} />
      <Text testID="pro-state">{`pro:${pro.proAuthButtonState()}`}</Text>
      <Text testID="xai-state">{`xai:${xai.xaiAuthButtonState()}`}</Text>
      <Text testID="xai-default">{`default:${xai.xaiSetDefault()}`}</Text>
      <ProAuthDialog
        open={pro.proAuthDialogOpen()}
        onOpenChange={(open) => pro.proAuthDialogOpen.set(open)}
        loading={pro.proAuthLoading()}
        busy={pro.proAuthBusy()}
        error={pro.proAuthError()}
        status={pro.proAuthStatus()}
        summary={pro.proAuthSummary()}
        loginSession={pro.proLoginSession()}
        verificationURL={pro.proLoginVerificationURL()}
        userCode={pro.proLoginUserCode()}
        loginExpiresLabel={pro.proLoginExpiresLabel()}
        onLogout={() => void pro.logoutProAuth()}
      />
      <XAIAuthDialog
        open={xai.xaiAuthDialogOpen()}
        onOpenChange={(open) => xai.xaiAuthDialogOpen.set(open)}
        setDefault={xai.xaiSetDefault()}
        onSetDefaultChange={(value) => xai.xaiSetDefault.set(value)}
        loading={xai.xaiAuthLoading()}
        busy={xai.xaiAuthBusy()}
        error={xai.xaiAuthError()}
        status={xai.xaiAuthStatus()}
        summary={xai.xaiAuthSummary()}
        loginSession={xai.xaiLoginSession()}
        verificationURL={xai.xaiLoginVerificationURL()}
        userCode={xai.xaiLoginUserCode()}
        loginExpiresLabel={xai.xaiLoginExpiresLabel()}
        onLogin={() => xai.reloginXAIAuth()}
        onLogout={() => void xai.logoutXAIAuth()}
      />
      <CodexAuthDialog
        open={codexOpen()}
        onOpenChange={(open) => codexOpen.set(open)}
        status={{ logged_in: true, account_id: "acct-42", file_mode_ok: false, file_mode_warning: "auth.json is world-readable" }}
        summary="Signed in"
        onLogout={() => report("codex.logout")}
      />
    </View>
  );
}

function ChannelsScenario() {
  const configured = signal(option("configured", false));
  const loggedIn = signal(option("loggedIn", false));
  return (
    <View class="gap-6 p-4">
      <WeChatLoginPanel
        request={endpointApiFetch}
        endpointRef={LOCAL}
        configured={configured()}
        botId={configured() ? "bot-7" : ""}
        onChanged={() => {
          report("wechat.changed");
          configured.set(!untracked(configured));
        }}
      />
      <XLoginPanel
        request={endpointApiFetch}
        endpointRef={LOCAL}
        loggedIn={loggedIn()}
        username={loggedIn() ? "morph" : ""}
        ready={option("ready", true)}
        onChanged={() => {
          report("x.changed");
          loggedIn.set(!untracked(loggedIn));
        }}
      />
    </View>
  );
}

function MCPScenario() {
  const servers = signal<MCPServer[]>(option("servers", []));
  const saving = signal(false);
  const pane = createPaneTarget();
  return (
    <View class="flex-1 flex-row">
      <View class="flex-1 p-4">
        <MCPSettingsPanel
          servers={servers()}
          saving={saving()}
          loading={option("loading", false)}
          readOnly={option("readOnly", false)}
          readOnlyMessage="Settings are read-only."
          validationError={option("validationError", "")}
          paneTarget={option("outlet", false) ? pane : undefined}
          onSave={(next) => {
            report("mcp.save", next);
            servers.set(next);
          }}
          onPaneChange={(open) => report("mcp.pane", open)}
        />
      </View>
      <PaneOutlet target={pane} />
    </View>
  );
}

function EndpointsScenario() {
  const endpoints = signal<ConsoleEndpointConfig[]>(option("endpoints", []));
  const saving = signal(false);
  const addRequested = signal(option("addRequested", false));
  const failSave = option("failSave", "");
  return (
    <View class="flex-1 p-4">
      <ConsoleEndpointsPanel
        endpoints={endpoints()}
        runtimeEndpoints={option("runtimeEndpoints", [])}
        saving={saving()}
        addRequested={addRequested()}
        onAddOpened={() => {
          report("endpoints.addOpened");
          addRequested.set(false);
        }}
        onPaneChange={(open) => report("endpoints.pane", open)}
        onSave={(values, done) => {
          report("endpoints.save", values);
          saving.set(true);
          setTimeout(() => {
            saving.set(false);
            if (failSave) {
              done(failSave);
              return;
            }
            endpoints.set(
              values.map((value) => ({ name: value.name, url: value.url, auth_token_configured: true })),
            );
            done();
          }, 10);
        }}
      />
    </View>
  );
}

function PasswordScenario() {
  return (
    <View class="p-4">
      <ConsolePasswordPanel configured={option("configured", false)} onSave={(values) => report("password.save", values)} />
    </View>
  );
}

function AppScenario() {
  const endpoints = option<any[]>("endpoints", []);
  if (endpoints.length) {
    endpointState.items = endpoints;
    endpointState.selectedRef = endpoints[0].endpoint_ref;
  }
  return (
    <View class="gap-4 p-4">
      <SettingsAppPanel />
      <SettingsUpdatePanel endpointRef={LOCAL} configRevision="rev-1" onConfigRevision={(revision) => report("update.revision", revision)} />
    </View>
  );
}

function ImageScenario() {
  const preview = signal(option("previewUrl", ""));
  return (
    <View class="p-4">
      <ImageUploadField
        previewUrl={preview()}
        crop
        outputSize={512}
        dialogTitle="Avatar"
        maxBytes={option("maxBytes", 10 * 1024 * 1024)}
        onSave={(image) => report("image.save", image)}
        onDelete={() => {
          report("image.delete");
          preview.set("");
        }}
      />
    </View>
  );
}

function ConnectionScenario() {
  const open = signal(false);
  const loading = signal(false);
  const error = signal("");
  const benchmarks = signal<ConnectionBenchmark[]>([]);
  const run = () => {
    loading.set(true);
    error.set("");
    benchmarks.set([]);
    report("connection.retry");
  };
  // The test ends the run (`app.host.send("morph.fixture.finish")`), so it can look at it running.
  host.on("morph.fixture.finish", () => {
    loading.set(false);
    const result = option<ConnectionBenchmark[] | null>("benchmarks", null);
    if (result) benchmarks.set(result);
    else error.set("connection refused");
  });
  return (
    <View class="p-4">
      <Button
        label="Test connection"
        onPress={() => {
          open.set(true);
          run();
        }}
      />
      <SetupConnectionTestDialog
        open={open()}
        onOpenChange={(value) => open.set(value)}
        loading={loading()}
        error={error()}
        benchmarks={benchmarks()}
        provider={option("provider", "openai")}
        apiBase="https://api.openai.com/v1"
        model="gpt-5.2"
        onRetry={run}
      />
    </View>
  );
}

function PickerScenario() {
  const open = signal(false);
  const items = option<SetupPickerItem[]>("items", []);
  const selected = signal(option("selectedValue", ""));
  return (
    <View class="p-4">
      <Button label="Pick model" onPress={() => open.set(true)} />
      <Text testID="picked">{selected()}</Text>
      <SetupPickerDialog
        open={open()}
        onOpenChange={(value) => open.set(value)}
        title="Choose a model"
        items={items}
        error={option("error", "")}
        filterPlaceholder="Filter models"
        emptyText="No models"
        selectedValue={selected()}
        groupByPrefix={option("groupByPrefix", false)}
        allowCustom
        customLabel="Use {value}"
        onSelect={(item) => {
          report("picker.select", item);
          selected.set(String(item.value || ""));
        }}
      />
    </View>
  );
}

const SCENARIOS: Record<string, () => JSX.Element> = {
  auth: AuthScenario,
  channels: ChannelsScenario,
  mcp: MCPScenario,
  endpoints: EndpointsScenario,
  password: PasswordScenario,
  app: AppScenario,
  credits: () => (
    <View class="p-4">
      <SettingsCreditsPanel />
    </View>
  ),
  notifications: () => (
    <View class="p-4">
      <TopicNotificationSetting />
    </View>
  ),
  image: ImageScenario,
  connection: ConnectionScenario,
  picker: PickerScenario,
};

function Fixture() {
  const Scenario = SCENARIOS[String(params.view || "")] ?? (() => <Text>unknown view</Text>);
  effect(() => untracked(() => report("ready")));
  return (
    <View class="flex-1 bg-background">
      <Scenario />
      <NoticeHost />
    </View>
  );
}

async function start() {
  await boot();
  configureApiBase();
  authState.token = "token-1";
  mount(Fixture);
}

void start();
