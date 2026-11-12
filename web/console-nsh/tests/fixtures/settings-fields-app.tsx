// A test entry that mounts the settings components (components/settings, MarkdownEditor) on their
// own, with each value read out beside them, for tests/settings-fields*.test.tsx. The boot location
// picks the gallery: /fields, /secret, /secret-layout, /panel, /routes, /auth, /llm, /markdown,
// /dialog.
import type { JSX, ViewRef } from "nsh";
import { mount, signal, Text, View, Scroll } from "nsh";
import { configureApiBase, endpointState, localeState } from "../../lib/core/context.js";
import {
  ADMIN_PLATFORM_OPTIONS,
  HEARTBEAT_INTERVAL_OPTIONS,
  LOGGING_LEVEL_OPTIONS,
  REASONING_EFFORT_OPTIONS,
} from "../../lib/core/config-options.js";
import { SETUP_PROVIDER_OPTIONS } from "../../lib/core/setup-contract.js";
import { boot, initialLocation } from "../../lib/platform";
import { NoticeHost, TextField } from "../../components/ui";
import type { PartFrame } from "../../components/shared/partProbe";
import {
  SettingBytes,
  SettingChoices,
  SettingDuration,
  SettingLimit,
  SettingPath,
  SettingPercent,
  SettingRows,
  SettingSelect,
  SettingsCanBrowsePaths,
} from "../../components/settings/SettingFields";
import { SecretInput, SecretPicker } from "../../components/settings/SecretInput";
import { EnvManagedField } from "../../components/settings/EnvManagedField";
import { SettingDialog } from "../../components/settings/SettingDialog";
import {
  ConfigSettingsPanel,
  SettingsSaveRegistryContext,
  type SettingsSaveEntry,
} from "../../components/settings/ConfigSettingsPanel";
import { ModelRoutesPanel } from "../../components/settings/ModelRoutesPanel";
import { AuthProfilesPanel } from "../../components/settings/AuthProfilesPanel";
import { LLMConfigForm } from "../../components/settings/LLMConfigForm";
import { AppMarkdownEditor, type MarkdownEditorApi } from "../../components/shared/MarkdownEditor";

/** A value read out for the tests: `id:out-<name>` shows `<name>=<value>`. */
function Out(props: { name: string; value: unknown }) {
  return (
    <Text testID={`out-${props.name}`}>
      {props.name}={typeof props.value === "string" ? props.value : JSON.stringify(props.value)}
    </Text>
  );
}

function Fields() {
  const select = signal("");
  const custom = signal("30m");
  const duration = signal("30m");
  const durationZero = signal("0s");
  const durationRaw = signal("500ms");
  const bytes = signal("536870912");
  const limit = signal("0");
  const path = signal("");
  const percent = signal("0.5");
  const choices = signal<string[]>(["GET"]);
  const list = signal("~/.ssh\n/etc");
  const map = signal('{\n  "X-Token": "a"\n}');
  const unreadable = signal('{"a": 1}');
  const identities = signal("tg:42");
  const patterns = signal("[]");
  const disabled = signal(false);
  return (
    <SettingsCanBrowsePaths.Provider value={() => true}>
      <View class="gap-3 p-4">
        <Text onPress={() => disabled.update((on) => !on)} testID="toggle-disabled">
          disabled={String(disabled())}
        </Text>
        <SettingSelect value={select()} onChange={(v) => select.set(v)} options={LOGGING_LEVEL_OPTIONS} label="Level" disabled={disabled()} testID="select" />
        <Out name="select" value={select()} />
        <SettingSelect value={custom()} onChange={(v) => custom.set(v)} options={HEARTBEAT_INTERVAL_OPTIONS} allowCustom label="Interval" disabled={disabled()} testID="custom" />
        <Out name="custom" value={custom()} />
        <SettingDuration value={duration()} onChange={(v) => duration.set(v)} label="Timeout" disabled={disabled()} testID="duration" />
        <Out name="duration" value={duration()} />
        <SettingDuration value={durationZero()} onChange={(v) => durationZero.set(v)} zeroLabel="Same as run timeout" label="Zero" testID="duration-zero" />
        <Out name="duration-zero" value={durationZero()} />
        <SettingDuration value={durationRaw()} onChange={(v) => durationRaw.set(v)} label="Raw" testID="duration-raw" />
        <Out name="duration-raw" value={durationRaw()} />
        <SettingBytes value={bytes()} onChange={(v) => bytes.set(v)} label="Size" testID="bytes" />
        <Out name="bytes" value={bytes()} />
        <SettingLimit value={limit()} onChange={(v) => limit.set(v)} defaultLimit="200000" label="Tokens" testID="limit" />
        <Out name="limit" value={limit()} />
        <SettingPath value={path()} onChange={(v) => path.set(v)} label="Folder" placeholder="<state>/logs" testID="path" />
        <Out name="path" value={path()} />
        <SettingPercent value={percent()} onChange={(v) => percent.set(v)} label="Ratio" testID="percent" />
        <Out name="percent" value={percent()} />
        <SettingChoices value={choices()} onChange={(v) => choices.set(v)} options={["GET", "POST", "PUT"]} disabledOptions={["PUT"]} label="Methods" testID="choices" />
        <Out name="choices" value={choices()} />
        <SettingRows value={list()} onChange={(v) => list.set(v)} mode="list" addLabel="Add path" label="Paths" testID="rows-list" />
        <Out name="rows-list" value={list()} />
        <SettingRows value={map()} onChange={(v) => map.set(v)} mode="map" addLabel="Add header" label="Headers" testID="rows-map" />
        <Out name="rows-map" value={map()} />
        <SettingRows
          value={unreadable()}
          onChange={(v) => unreadable.set(v)}
          mode="map"
          label="Odd"
          fallback={<Text testID="rows-fallback">raw editor</Text>}
        />
        <SettingRows value={identities()} onChange={(v) => identities.set(v)} mode="identities" platforms={ADMIN_PLATFORM_OPTIONS} addLabel="Add admin" label="Admins" testID="rows-identities" />
        <Out name="rows-identities" value={identities()} />
        <SettingRows value={patterns()} onChange={(v) => patterns.set(v)} mode="patterns" addLabel="Add pattern" label="Patterns" testID="rows-patterns" />
        <Out name="rows-patterns" value={patterns()} />
      </View>
    </SettingsCanBrowsePaths.Provider>
  );
}

function Secrets() {
  const stored = signal("");
  const fresh = signal("");
  const env = signal("");
  const status = signal({ configured: true, source: "file", editable: true });
  return (
    <SecretPicker.Provider value={{ enabled: () => true }}>
      <View class="gap-3 p-4">
        <SecretInput value={stored()} onChange={(v) => stored.set(v)} status={status()} revealPath="llm.api_key" testID="secret-stored" />
        <Out name="secret-stored" value={stored()} />
        <SecretInput value={fresh()} onChange={(v) => fresh.set(v)} placeholder="sk-..." revealPath="llm.profiles.ears.api_key" testID="secret-fresh" />
        <Out name="secret-fresh" value={fresh()} />
        <SecretInput value={env()} onChange={(v) => env.set(v)} envName="OPENAI_API_KEY" status={{ configured: true, source: "environment_override" }} revealPath="llm.profiles.x.api_key" testID="secret-env" />
        <EnvManagedField name="MISTER_MORPH_LOG_LEVEL=debug" testID="env-field" />
      </View>
    </SecretPicker.Provider>
  );
}

/**
 * The secret fields at their widest: under a regular field (the height they match), each reports
 * its parts' frames (SecretInput's `onPartLayout`), read out as JSON in `id:out-frames`.
 */
function SecretLayout() {
  const frames = signal<Record<string, PartFrame>>({});
  const report = (field: string) => (name: string, frame: PartFrame) =>
    frames.update((all) => ({ ...all, [`${field}.${name}`]: frame }));
  const stored = signal("");
  const os = signal("");
  const fresh = signal("");
  const env = signal("");
  /** A view that reports its own frame on the page as `name`. */
  const Probe = (props: { name: string; children?: JSX.Element }) => {
    let node: ViewRef | undefined;
    return (
      <View
        ref={(value: ViewRef) => {
          node = value;
        }}
        onLayout={() => {
          node
            ?.measure()
            .then((m) => m && report("page")(props.name, { x: m.pagePosition.x, y: m.pagePosition.y, w: m.bounds.size.width, h: m.bounds.size.height }))
            .catch(() => undefined);
        }}
      >
        {props.children}
      </View>
    );
  };
  return (
    <SecretPicker.Provider value={{ enabled: () => true }}>
      <View class="gap-3 p-4">
        <Probe name="column">
          <View class="gap-3">
            <Probe name="baseline">
              <TextField value="gpt-5" onChange={() => undefined} placeholder="Model" accessibilityLabel="Model" testID="layout-baseline" />
            </Probe>
            <SecretInput
              value={stored()}
              onChange={(v) => stored.set(v)}
              status={{ configured: true, source: "file", editable: true }}
              revealPath="llm.api_key"
              placeholder="Paste the new API key from your provider's dashboard"
              testID="layout-stored"
              onPartLayout={report("stored")}
            />
            <SecretInput
              value={os()}
              onChange={(v) => os.set(v)}
              status={{ configured: true, source: "os", editable: true }}
              revealPath="llm.profiles.ops.api_key"
              testID="layout-os"
              onPartLayout={report("os")}
            />
            <SecretInput
              value={fresh()}
              onChange={(v) => fresh.set(v)}
              placeholder="Paste the bot token BotFather gave you when you made the bot"
              revealPath="telegram.bot_token"
              testID="layout-fresh"
              onPartLayout={report("fresh")}
            />
            <SecretInput
              value={env()}
              onChange={(v) => env.set(v)}
              envName="MISTER_MORPH_LLM_PROFILES_OPERATIONS_FALLBACK_API_KEY"
              status={{ configured: true, source: "environment_override" }}
              revealPath="llm.profiles.ops.fallback_api_key"
              testID="layout-env"
              onPartLayout={report("env")}
            />
            <Probe name="env-field">
              <EnvManagedField name="MISTER_MORPH_LLM_PROFILES_OPERATIONS_FALLBACK_MODEL=gpt-5-mini" />
            </Probe>
          </View>
        </Probe>
        <Text class="text-[6px]" testID="out-frames">{`frames=${JSON.stringify(frames())}`}</Text>
        <Out name="layout-stored" value={stored()} />
        <Out name="layout-fresh" value={fresh()} />
      </View>
    </SecretPicker.Provider>
  );
}

const PANEL_GROUPS = [
  {
    id: "logs",
    title: "Logging",
    note: "Where logs go.",
    fields: [
      { path: "logging.enabled", label: "Write logs", type: "bool" },
      { path: "logging.level", label: "Level", type: "select", options: LOGGING_LEVEL_OPTIONS, dependsOn: "logging.enabled" },
      { path: "logging.max_size", label: "Max size", type: "int", dependsOn: "logging.enabled" },
      { path: "llm.temperature", label: "Temperature", type: "float", clearable: true, placeholder: "Provider default" },
      { path: "llm.api_key", label: "API key", type: "string", secret: true },
      { path: "llm.model", label: "Model", type: "string" },
      { path: "server.listen", label: "Listen", type: "string" },
      { path: "file_state_dir", label: "State directory", type: "string" },
    ],
  },
  {
    id: "extra",
    title: "Extra",
    fields: [{ path: "tools.timeout", label: "Tool timeout", type: "string", duration: true, editor: "duration" }],
  },
];

function Panel() {
  const values = signal<Record<string, unknown>>({
    "logging.enabled": false,
    "logging.level": "",
    "logging.max_size": 10,
    "llm.temperature": 0.7,
    "llm.model": "gpt-5",
    "server.listen": "127.0.0.1:9080",
    "file_state_dir": "/home/me/.morph",
    "tools.timeout": "30s",
  });
  const states = {
    "llm.temperature": { explicit: true },
    "llm.model": { source: "environment_override", env_name: "MODEL=gpt-5" },
    "server.listen": { apply_mode: "process_restart", source: "runtime_override" },
    "file_state_dir": { apply_mode: "process_restart", source: "state_folder", editable: false },
    "llm.api_key": { configured: true, explicit: true, source: "file" },
  };
  const saved = signal<unknown>(null);
  const dirty = signal(false);
  const registered = signal<string[]>([]);
  let entry: SettingsSaveEntry | null = null;
  const collected = signal("");
  const registry = {
    register(item: SettingsSaveEntry) {
      entry = item;
      registered.update((list) => [...list, item.key]);
    },
    unregister(key: string) {
      registered.update((list) => list.filter((item) => item !== key));
    },
  };
  return (
    <View class="gap-3 p-4">
      <ConfigSettingsPanel
        groups={PANEL_GROUPS}
        values={values()}
        fieldStates={states}
        inactiveGroups={{ extra: "Turned off by the desktop app." }}
        onSave={(update) => saved.set(update)}
        onDirtyChange={(value) => dirty.set(value)}
        testID="panel"
      />
      <Out name="saved" value={saved()} />
      <Out name="dirty" value={dirty()} />
      <Text testID="reload" onPress={() => values.set({ ...values(), "llm.model": "gpt-6" })}>
        reload
      </Text>
      <SettingsSaveRegistryContext.Provider value={registry}>
        <ConfigSettingsPanel groups={[PANEL_GROUPS[1]]} values={values()} saveScope="system" testID="registered" />
      </SettingsSaveRegistryContext.Provider>
      <Out name="registered" value={registered()} />
      <Text
        testID="collect"
        onPress={() => {
          try {
            collected.set(JSON.stringify(entry?.collectUpdate() ?? null));
          } catch (error: any) {
            collected.set(`error: ${error?.message}`);
          }
        }}
      >
        collect
      </Text>
      <Out name="collected" value={collected()} />
    </View>
  );
}

function Routes() {
  const saved = signal<unknown>(null);
  const added = signal(0);
  const dirty = signal(false);
  return (
    <View class="gap-3 p-4">
      <ModelRoutesPanel
        values={{ "llm.routes.main_loop": "cheap", "llm.routes.addressing": { profile: "ghost" } }}
        profiles={[
          { value: "default", note: "gpt-5" },
          { value: "cheap", note: "gpt-5-mini" },
          { value: "smart", note: "o5" },
        ]}
        onSave={(update) => saved.set(update)}
        onDirtyChange={(value) => dirty.set(value)}
        onAddProfile={() => added.update((n) => n + 1)}
        testID="routes"
      />
      <Out name="saved" value={saved()} />
      <Out name="added" value={added()} />
      <Out name="dirty" value={dirty()} />
    </View>
  );
}

function Auth() {
  const saved = signal<unknown>(null);
  return (
    <View class="gap-3 p-4">
      <AuthProfilesPanel
        profiles={[
          {
            name: "github",
            credential_kind: "bearer",
            credential_secret_configured: true,
            url_prefixes: ["https://api.github.com/"],
            methods: ["GET"],
          },
        ]}
        onSave={(profiles) => saved.set(profiles)}
        testID="auth"
      />
      <Out name="saved" value={saved()} />
    </View>
  );
}

function LLM() {
  const config = signal<Record<string, any>>({ inference_provider: "openai", model: "gpt-5", api_key: "" });
  const events = signal<string[]>([]);
  const log = (name: string) => events.update((list) => [...list, name]);
  return (
    <SecretPicker.Provider value={{ enabled: () => false }}>
      <View class="gap-3 p-4">
        <LLMConfigForm
          config={config()}
          providerItems={SETUP_PROVIDER_OPTIONS}
          reasoningEffortItems={REASONING_EFFORT_OPTIONS}
          toolsEmulationItems={[
            { title: "Off", value: "off" },
            { title: "Fallback", value: "fallback" },
          ]}
          envManaged={{ context_window_tokens: { env_name: "CTX", value: "200000" } }}
          revealPrefix="llm"
          secretFields={{ api_key: { configured: false } }}
          showAdvanced
          showAbilities
          enableModelPicker
          showXAIAuthAction
          xaiAuthState="signed-out"
          xaiAuthTitle="Sign in to xAI"
          onUpdateField={({ field, value }) => {
            config.update((current) => ({ ...current, [field]: value }));
            log(`${field}=${value}`);
          }}
          onOpenModelPicker={() => log("model-picker")}
          onOpenXaiAuth={() => log("xai-auth")}
        />
        <Out name="events" value={events()} />
      </View>
    </SecretPicker.Provider>
  );
}

function MarkdownGallery() {
  const doc = signal("# Title\n\nHello");
  let api: MarkdownEditorApi | undefined;
  const readOnly = signal(false);
  return (
    <View class="gap-3 p-4">
      <AppMarkdownEditor
        value={doc()}
        onChange={(value) => doc.set(value)}
        placeholder="Write here"
        hint="Markdown is supported."
        height="320px"
        readOnly={readOnly()}
        accessibilityLabel="Notes"
        editorRef={(ref) => {
          api = ref;
        }}
        testID="md"
      />
      <Out name="doc" value={doc()} />
      <Text testID="insert" onPress={() => void api?.insertAtCursor("[Bob](tg:7)", { spacing: true })}>
        insert
      </Text>
      <Text testID="readonly" onPress={() => readOnly.update((on) => !on)}>
        readonly
      </Text>
    </View>
  );
}

function Dialog() {
  const open = signal(false);
  const saving = signal(false);
  const events = signal<string[]>([]);
  return (
    <View class="gap-3 p-4">
      <Text testID="open-dialog" onPress={() => open.set(true)}>
        open
      </Text>
      <SettingDialog
        open={open()}
        title="Edit thing"
        saving={saving()}
        onOpenChange={(value) => open.set(value)}
        onCancel={() => events.update((list) => [...list, "cancel"])}
        onSave={() => {
          events.update((list) => [...list, "save"]);
          saving.set(true);
        }}
        testID="setting-dialog"
      >
        <Text>Dialog body</Text>
      </SettingDialog>
      <Out name="open" value={open()} />
      <Out name="events" value={events()} />
    </View>
  );
}

const PANELS: Record<string, () => JSX.Element> = {
  "/fields": Fields,
  "/secret": Secrets,
  "/secret-layout": SecretLayout,
  "/panel": Panel,
  "/routes": Routes,
  "/auth": Auth,
  "/llm": LLM,
  "/markdown": MarkdownGallery,
  "/dialog": Dialog,
};

/** Every gallery, one after another ("/", or a run without a host). */
function All() {
  return (
    <View>
      {Object.values(PANELS).map((Gallery) => (
        <Gallery />
      ))}
    </View>
  );
}

function FixtureApp() {
  const location = initialLocation().split("?")[0];
  const Panel = PANELS[location] || All;
  return (
    <View class="flex-1 bg-background">
      <Scroll class="flex-1">
        <Panel />
      </Scroll>
      <NoticeHost />
    </View>
  );
}

async function start() {
  await boot();
  configureApiBase();
  localeState.hydrateLanguage();
  endpointState.setSelectedEndpointRef("ep_console_local");
  mount(FixtureApp);
}

void start();
