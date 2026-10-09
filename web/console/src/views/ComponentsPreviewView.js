import { computed, provide, reactive, ref } from "vue";

import AppTabs from "../components/AppTabs";
import ConfigSettingsPanel from "../components/ConfigSettingsPanel";
import EnvManagedField from "../components/EnvManagedField";
import SecretInput from "../components/SecretInput";
import SettingBytes from "../components/SettingBytes";
import SettingChoices from "../components/SettingChoices";
import SettingDuration from "../components/SettingDuration";
import SettingLimit from "../components/SettingLimit";
import SettingPath from "../components/SettingPath";
import SettingPercent from "../components/SettingPercent";
import SettingRows from "../components/SettingRows";
import SettingSelect from "../components/SettingSelect";
import SetupPickerDialogContent from "../components/SetupPickerDialogContent";
import {
  ADMIN_PLATFORM_OPTIONS,
  AWS_REGION_OPTIONS,
  CACHE_TTL_OPTIONS,
  HEARTBEAT_INTERVAL_OPTIONS,
  LOGGING_LEVEL_OPTIONS,
  TASK_TARGET_OPTIONS,
} from "../core/config-options";
import { dismissNotice, pushNotice, useNotice } from "../core/notices";
import "./SettingsView.css";
import "./ComponentsPreviewView.css";

// /__components: every component the console builds itself (not Quail's), on one page in its usual
// states; settings controls also show the value they would save. For reviewing and designing them
// without opening the real pages.

const PANEL_GROUPS = [
  {
    id: "preview-panel",
    title: "Settings panel",
    note: "The same fields as real settings: edit them, then Save to see the update the panel sends.",
    fields: [
      { path: "demo.enabled", label: "Feature switch", type: "bool", note: "Fields below depend on this switch." },
      { path: "demo.level", label: "Level", type: "select", options: LOGGING_LEVEL_OPTIONS },
      { path: "demo.timeout", label: "Timeout", type: "string", duration: true, editor: "duration", dependsOn: "demo.enabled" },
      { path: "demo.size", label: "Maximum size", type: "int", editor: "bytes", dependsOn: "demo.enabled" },
      { path: "demo.ratio", label: "Compact at", type: "float", editor: "percent", note: "A 0–1 ratio shown as a percentage." },
      { path: "demo.budget", label: "Token budget", type: "int", editor: "limit", defaultLimit: "200000" },
      { path: "demo.listen", label: "Listen address", type: "string", validate: "listen", placeholder: "127.0.0.1:9080" },
      { path: "demo.temperature", label: "Temperature", type: "float", clearable: true, placeholder: "Provider default" },
      { path: "demo.dir", label: "Directory", type: "string", wide: true, editor: "directory", placeholder: "~/.morph" },
      { path: "demo.paths", label: "Denied paths", type: "string_list", wide: true, editor: "rows", placeholder: "~/.ssh", addLabel: "Add path" },
      { path: "demo.headers", label: "HTTP headers", type: "json", wide: true, editor: "rows", rows: "map", addLabel: "Add header" },
    ],
  },
];

const PANEL_VALUES = {
  "demo.enabled": true,
  "demo.level": "",
  "demo.timeout": "1m30s",
  "demo.size": 33554432,
  "demo.ratio": 0.8,
  "demo.budget": 0,
  "demo.listen": "127.0.0.1:9080",
  "demo.temperature": 0,
  "demo.dir": "",
  "demo.paths": ["~/.ssh"],
  "demo.headers": { "X-Team": "core" },
};

const PANEL_STATES = {
  "demo.temperature": { explicit: false, editable: true, source: "default" },
};

const ComponentsPreviewView = {
  components: {
    AppTabs,
    ConfigSettingsPanel,
    EnvManagedField,
    SecretInput,
    SettingBytes,
    SettingChoices,
    SettingDuration,
    SettingLimit,
    SettingPath,
    SettingPercent,
    SettingRows,
    SettingSelect,
    SetupPickerDialogContent,
  },
  setup() {
    const disabled = ref(false);
    const showBrowse = ref(false);
    // SettingPath only shows Browse when settings may pick local folders (desktop app, local endpoint).
    provide("settingsCanBrowsePaths", showBrowse);

    const v = reactive({
      selectPlain: "warn",
      selectEmpty: "",
      selectCustomPreset: "30m",
      selectCustomValue: "45m",
      selectRegion: "",
      durationMinutes: "30m",
      durationMixed: "1m30s",
      durationDays: "168h",
      durationZero: "",
      durationRaw: "500ms",
      bytesMB: "536870912",
      bytesOdd: "1000",
      percent: "0.6",
      limitOff: "0",
      limitOn: "200000",
      pathEmpty: "",
      pathSet: "~/projects/morph",
      choices: ["console", "telegram"],
      rowsList: "~/.ssh\n/etc/secrets",
      rowsMap: JSON.stringify({ "X-Team": "core", Authorization: "Bearer ${TOKEN}" }, null, 2),
      rowsEnv: JSON.stringify(["OPENAI_API_BASE", { name: "MY_FIXED_TOKEN", value: "abc123" }], null, 2),
      rowsPatterns: JSON.stringify([{ name: "jwt", re: "eyJ[a-zA-Z0-9_-]+" }, { name: "broken", re: "[a-z" }], null, 2),
      rowsIdentities: "tg:@admin\nslack:T123:U234\nmixin:773e5e77-4107-45c2-b648-8fc722ed77f5",
      rowsUnreadable: "{\"not\": [\"a map of strings\"]}",
      secret: "",
      pickedModel: "gpt-5-mini",
    });

    const PICKER_MODELS = [
      { id: "gpt-5", title: "gpt-5", value: "gpt-5", meta: "400K" },
      { id: "gpt-5-mini", title: "gpt-5-mini", value: "gpt-5-mini", meta: "400K" },
      { id: "gpt-5-nano", title: "gpt-5-nano", value: "gpt-5-nano", meta: "400K" },
      { id: "gpt-4.1", title: "gpt-4.1", value: "gpt-4.1", meta: "1M" },
      { id: "o4-mini", title: "o4-mini", value: "o4-mini", meta: "200K" },
    ];

    const panelUpdate = ref(null);
    const panelValues = ref({ ...PANEL_VALUES });

    function savePanel(update) {
      panelUpdate.value = update;
    }

    // Section links scroll this page; letting the router see "#id" would navigate away.
    function jumpTo(id) {
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function show(value) {
      return JSON.stringify(value);
    }

    const notice = useNotice();
    const noticeDismissed = ref(false);
    function pinNotice() {
      pushNotice({ id: "components-preview-pinned", type: "warning", text: "A pinned notice stays until it is dismissed, like a page error.", timeout: 0 });
    }
    function clearPinnedNotice() {
      dismissNotice("components-preview-pinned");
    }
    const tabItems = [
      { id: "topic", title: "Topic", icon: "PhChats" },
      { id: "workspace", title: "Workspace", icon: "PhCube" },
      { id: "files", title: "Files", icon: "PhFolderOpen" },
    ];
    const tabText = ref(tabItems[0]);
    const tabIcon = ref(tabItems[1]);

    const sections = computed(() => [
      { id: "section", title: "AppSection" },
      { id: "notice", title: "AppNotice" },
      { id: "tabs", title: "AppTabs" },
      { id: "select", title: "SettingSelect" },
      { id: "duration", title: "SettingDuration" },
      { id: "bytes", title: "SettingBytes" },
      { id: "percent", title: "SettingPercent" },
      { id: "limit", title: "SettingLimit" },
      { id: "path", title: "SettingPath" },
      { id: "choices", title: "SettingChoices" },
      { id: "rows", title: "SettingRows" },
      { id: "secret", title: "SecretInput & EnvManagedField" },
      { id: "picker", title: "SetupPickerDialogContent" },
      { id: "panel", title: "ConfigSettingsPanel" },
    ]);

    return {
      ADMIN_PLATFORM_OPTIONS,
      AWS_REGION_OPTIONS,
      CACHE_TTL_OPTIONS,
      HEARTBEAT_INTERVAL_OPTIONS,
      LOGGING_LEVEL_OPTIONS,
      TASK_TARGET_OPTIONS,
      PANEL_GROUPS,
      PANEL_STATES,
      PICKER_MODELS,
      disabled,
      showBrowse,
      v,
      show,
      jumpTo,
      sections,
      notice,
      noticeDismissed,
      pinNotice,
      clearPinnedNotice,
      tabItems,
      tabText,
      tabIcon,
      panelValues,
      panelUpdate,
      savePanel,
    };
  },
  template: `
    <!-- The console locks page scrolling (html { overflow: hidden }), so this page scrolls itself. -->
    <div class="components-preview-scroll">
    <div class="components-preview">
      <header class="components-preview-head">
        <div>
          <h1 class="components-preview-title">Components</h1>
          <p class="components-preview-meta">Every component the console builds itself, in its usual states. Settings controls show the value they would save.</p>
        </div>
        <div class="components-preview-toggles">
          <label class="components-preview-toggle"><QSwitch v-model="disabled" /> Disabled</label>
          <label class="components-preview-toggle"><QSwitch v-model="showBrowse" /> Browse button</label>
        </div>
      </header>

      <nav class="components-preview-nav" aria-label="Components">
        <a v-for="section in sections" :key="section.id" :href="'#' + section.id" @click.prevent="jumpTo(section.id)">{{ section.title }}</a>
      </nav>

      <section id="section" class="components-preview-section">
        <h2>AppSection</h2>
        <p class="components-preview-note">A titled block of a page, in place of QCard. The head reads like an AppNotice: square mark and mono bracket label, then the meta, actions at the far end, on a hairline rule. Plain has no frame (settings groups). Boxed is a hairline frame whose top strip is the head (status, list items). Pane has a left hairline, its own scroll and a pinned head (a detail pane beside a list).</p>
        <h3 class="components-preview-subhead">Plain</h3>
        <div class="components-preview-stack">
          <AppSection title="Default model" meta="Used when a task does not name a model.">
            <template #actions><QButton class="plain xs">Test</QButton></template>
            <SettingSelect v-model="v.selectPlain" :options="LOGGING_LEVEL_OPTIONS" label="Level" :disabled="disabled" />
          </AppSection>
          <AppSection title="Logging" meta="How much the agent writes to its log.">
            <SettingSelect v-model="v.selectPlain" :options="LOGGING_LEVEL_OPTIONS" label="Level" :disabled="disabled" />
          </AppSection>
          <AppSection title="A section with only a title" />
        </div>
        <h3 class="components-preview-subhead">Boxed</h3>
        <div class="components-preview-stack">
          <AppSection variant="boxed" title="Runtime" meta="Up for 3h 12m · 2 tasks running">
            <template #actions><QButton class="plain xs">Restart</QButton></template>
            <p class="components-preview-note">Body content sits under the head.</p>
          </AppSection>
          <AppSection variant="boxed" title="A command and a menu" meta="Save beside a plain dropdown, as in a TODO's head.">
            <template #actions>
              <QButton class="plain xs">Save</QButton>
              <QDropdownMenu
                class="components-preview-menu"
                variant="plain"
                :items="[{ title: 'Duplicate', value: 'duplicate' }, { title: 'Delete', value: 'delete' }]"
                hideSelected
                hideActionLabel
              >
                <PhDotsThree class="icon" />
              </QDropdownMenu>
            </template>
            <p class="components-preview-note">The menu keeps to its trigger's width.</p>
          </AppSection>
          <AppSection variant="boxed">
            <p class="components-preview-note">A boxed section without a head.</p>
          </AppSection>
        </div>
        <h3 class="components-preview-subhead">Pane</h3>
        <div class="components-preview-pane-host">
          <div class="components-preview-pane-list">List</div>
          <AppSection variant="pane" title="Contact detail" meta="tg:@admin">
            <template #actions><QButton class="plain xs">Close</QButton></template>
            <p v-for="n in 12" :key="n" class="components-preview-note">Line {{ n }} of a long pane; the head stays put while this scrolls.</p>
          </AppSection>
        </div>
      </section>

      <section id="notice" class="components-preview-section">
        <h2>AppNotice</h2>
        <p class="components-preview-note">A status line: square mark and bracket label in the type's colour, then the message. Inline it replaces QFence; floating it is one entry of the notice stack, which replaces QToast (useNotice). An error that is a network failure gets a plain-language line, with the browser's message in the tooltip.</p>
        <div class="components-preview-stack">
          <AppNotice type="error" text="Couldn't save the profile: the endpoint returned 500." />
          <AppNotice type="warning" text="Settings are read-only: this console is managed by the desktop app." />
          <AppNotice type="info" text="Changes apply to the next task." />
          <AppNotice type="success" text="Saved." />
          <AppNotice type="error" text="Failed to fetch" />
          <AppNotice v-if="!noticeDismissed" type="info" text="A dismissible notice." dismissible @dismiss="noticeDismissed = true" />
          <div class="components-preview-narrow">
            <AppNotice type="error" text="In a narrow pane the message drops below the label and wraps, instead of squeezing beside it." />
          </div>
        </div>
        <h3 class="components-preview-subhead">Floating stack</h3>
        <div class="components-preview-actions">
          <QButton class="outlined sm" @click="notice.success('Saved.')">Success</QButton>
          <QButton class="outlined sm" @click="notice.info('Changes apply to the next task.')">Info</QButton>
          <QButton class="outlined sm" @click="notice.warning('The model list is cached; refresh to see new models.')">Warning</QButton>
          <QButton class="outlined sm" @click="notice.error('Could not delete the topic.')">Error</QButton>
          <QButton class="outlined sm" @click="notice.error('Failed to fetch')">Network error</QButton>
          <QButton class="outlined sm" @click="pinNotice">Pinned</QButton>
          <QButton class="plain sm" @click="clearPinnedNotice">Clear pinned</QButton>
        </div>
      </section>

      <section id="tabs" class="components-preview-section">
        <h2>AppTabs</h2>
        <p class="components-preview-note">A segmented control with a sliding highlight. iconOnly shows square icon segments; each tab's title becomes its tooltip and accessible name.</p>
        <div class="components-preview-grid">
          <div class="components-preview-demo">
            <span class="settings-field-label">With labels</span>
            <AppTabs :tabs="tabItems" v-model="tabText" ariaLabel="With labels" :disabled="disabled" />
            <code>{{ show(tabText.id) }}</code>
          </div>
          <div class="components-preview-demo">
            <span class="settings-field-label">iconOnly</span>
            <AppTabs :tabs="tabItems" v-model="tabIcon" iconOnly ariaLabel="Icon only" :disabled="disabled" />
            <code>{{ show(tabIcon.id) }}</code>
          </div>
        </div>
      </section>

      <section id="select" class="components-preview-section">
        <h2>SettingSelect</h2>
        <p class="components-preview-note">One box that opens a list. With allowCustom the box is also where your own value is typed: it shows the preset's name, and on focus the stored text with the presets listed below.</p>
        <div class="components-preview-grid">
          <div class="components-preview-demo">
            <span class="settings-field-label">Plain choices</span>
            <SettingSelect v-model="v.selectPlain" :options="LOGGING_LEVEL_OPTIONS" label="Plain choices" :disabled="disabled" />
            <code>{{ show(v.selectPlain) }}</code>
          </div>
          <div class="components-preview-demo">
            <span class="settings-field-label">Empty value named</span>
            <SettingSelect v-model="v.selectEmpty" :options="CACHE_TTL_OPTIONS" label="Empty value named" :disabled="disabled" />
            <code>{{ show(v.selectEmpty) }}</code>
          </div>
          <div class="components-preview-demo">
            <span class="settings-field-label">Custom allowed, preset chosen</span>
            <SettingSelect v-model="v.selectCustomPreset" :options="HEARTBEAT_INTERVAL_OPTIONS" allowCustom label="Custom allowed, preset chosen" :disabled="disabled" />
            <code>{{ show(v.selectCustomPreset) }}</code>
          </div>
          <div class="components-preview-demo">
            <span class="settings-field-label">Custom allowed, custom value</span>
            <SettingSelect v-model="v.selectCustomValue" :options="HEARTBEAT_INTERVAL_OPTIONS" allowCustom label="Custom allowed, custom value" :disabled="disabled" />
            <code>{{ show(v.selectCustomValue) }}</code>
          </div>
          <div class="components-preview-demo">
            <span class="settings-field-label">Custom allowed, not a duration</span>
            <SettingSelect v-model="v.selectRegion" :options="AWS_REGION_OPTIONS" allowCustom label="Custom allowed, not a duration" :disabled="disabled" />
            <code>{{ show(v.selectRegion) }}</code>
          </div>
        </div>
      </section>

      <section id="duration" class="components-preview-section">
        <h2>SettingDuration</h2>
        <p class="components-preview-note">A number and its unit in one box; the unit opens a short list. Arrow keys step the number. Values show in the largest whole unit.</p>
        <div class="components-preview-grid">
          <div class="components-preview-demo">
            <span class="settings-field-label">Minutes</span>
            <SettingDuration v-model="v.durationMinutes" label="Minutes" :disabled="disabled" />
            <code>{{ show(v.durationMinutes) }}</code>
          </div>
          <div class="components-preview-demo">
            <span class="settings-field-label">Not a whole minute (1m30s)</span>
            <SettingDuration v-model="v.durationMixed" label="Not a whole minute" :disabled="disabled" />
            <code>{{ show(v.durationMixed) }}</code>
          </div>
          <div class="components-preview-demo">
            <span class="settings-field-label">Days</span>
            <SettingDuration v-model="v.durationDays" label="Days" :disabled="disabled" />
            <code>{{ show(v.durationDays) }}</code>
          </div>
          <div class="components-preview-demo">
            <span class="settings-field-label">Zero has a meaning (zeroLabel)</span>
            <SettingDuration v-model="v.durationZero" zeroLabel="Same as run timeout" label="Zero has a meaning" :disabled="disabled" />
            <code>{{ show(v.durationZero) }}</code>
          </div>
          <div class="components-preview-demo">
            <span class="settings-field-label">Unsupported text (500ms)</span>
            <SettingDuration v-model="v.durationRaw" label="Unsupported text" :disabled="disabled" />
            <code>{{ show(v.durationRaw) }}</code>
          </div>
        </div>
      </section>

      <section id="bytes" class="components-preview-section">
        <h2>SettingBytes</h2>
        <p class="components-preview-note">The same box as durations, with byte units; saved as whole bytes.</p>
        <div class="components-preview-grid">
          <div class="components-preview-demo">
            <span class="settings-field-label">512 MB</span>
            <SettingBytes v-model="v.bytesMB" label="512 MB" :disabled="disabled" />
            <code>{{ show(v.bytesMB) }}</code>
          </div>
          <div class="components-preview-demo">
            <span class="settings-field-label">Not a whole KB (1000 bytes)</span>
            <SettingBytes v-model="v.bytesOdd" label="Not a whole KB" :disabled="disabled" />
            <code>{{ show(v.bytesOdd) }}</code>
          </div>
        </div>
      </section>

      <section id="percent" class="components-preview-section">
        <h2>SettingPercent</h2>
        <p class="components-preview-note">A 0–1 ratio as a position on a scale: drag, click the track, or use the arrow keys (Shift for steps of 10). The value is read out, not typed.</p>
        <div class="components-preview-grid">
          <div class="components-preview-demo">
            <span class="settings-field-label">Ratio</span>
            <SettingPercent v-model="v.percent" label="Ratio" :disabled="disabled" />
            <code>{{ show(v.percent) }}</code>
          </div>
        </div>
      </section>

      <section id="limit" class="components-preview-section">
        <h2>SettingLimit</h2>
        <p class="components-preview-note">A limit where 0 means none, in one box: a number with "No limit", or "No limit" with "Set limit".</p>
        <div class="components-preview-grid">
          <div class="components-preview-demo">
            <span class="settings-field-label">Off</span>
            <SettingLimit v-model="v.limitOff" defaultLimit="200000" label="Off" :disabled="disabled" />
            <code>{{ show(v.limitOff) }}</code>
          </div>
          <div class="components-preview-demo">
            <span class="settings-field-label">On</span>
            <SettingLimit v-model="v.limitOn" label="On" :disabled="disabled" />
            <code>{{ show(v.limitOn) }}</code>
          </div>
        </div>
      </section>

      <section id="path" class="components-preview-section">
        <h2>SettingPath</h2>
        <p class="components-preview-note">A folder path with Browse at the end of the box. Browse shows only in the desktop app for this machine's settings; turn on "Browse button" above to see it (it cannot open a picker here).</p>
        <div class="components-preview-grid">
          <div class="components-preview-demo is-wide">
            <span class="settings-field-label">Empty, placeholder explains the default</span>
            <SettingPath v-model="v.pathEmpty" label="Empty" placeholder="<state directory>/logs" :disabled="disabled" />
            <code>{{ show(v.pathEmpty) }}</code>
          </div>
          <div class="components-preview-demo is-wide">
            <span class="settings-field-label">Set</span>
            <SettingPath v-model="v.pathSet" label="Set" :disabled="disabled" />
            <code>{{ show(v.pathSet) }}</code>
          </div>
        </div>
      </section>

      <section id="choices" class="components-preview-section">
        <h2>SettingChoices</h2>
        <p class="components-preview-note">Several values from a known list, as toggles.</p>
        <div class="components-preview-demo is-wide">
          <span class="settings-field-label">Task persistence targets</span>
          <SettingChoices v-model="v.choices" :options="TASK_TARGET_OPTIONS" label="Task persistence targets" :disabled="disabled" />
          <code>{{ show(v.choices) }}</code>
        </div>
      </section>

      <section id="rows" class="components-preview-section">
        <h2>SettingRows</h2>
        <p class="components-preview-note">Lists and maps as rows. Each row is one box: its values are parts split by a hairline, and removing it is the last part. Each mode saves the same text the panel stores (one item per line, or JSON).</p>
        <div class="components-preview-grid is-wide">
          <div class="components-preview-demo is-wide">
            <span class="settings-field-label">list</span>
            <SettingRows v-model="v.rowsList" mode="list" placeholder="~/.ssh" addLabel="Add path" label="list" :disabled="disabled" />
            <code>{{ show(v.rowsList) }}</code>
          </div>
          <div class="components-preview-demo is-wide">
            <span class="settings-field-label">map</span>
            <SettingRows v-model="v.rowsMap" mode="map" addLabel="Add header" label="map" :disabled="disabled" />
            <code>{{ show(v.rowsMap) }}</code>
          </div>
          <div class="components-preview-demo is-wide">
            <span class="settings-field-label">env (empty value passes the variable through)</span>
            <SettingRows v-model="v.rowsEnv" mode="env" addLabel="Add variable" label="env" :disabled="disabled" />
            <code>{{ show(v.rowsEnv) }}</code>
          </div>
          <div class="components-preview-demo is-wide">
            <span class="settings-field-label">patterns (invalid regex flagged)</span>
            <SettingRows v-model="v.rowsPatterns" mode="patterns" addLabel="Add pattern" label="patterns" :disabled="disabled" />
            <code>{{ show(v.rowsPatterns) }}</code>
          </div>
          <div class="components-preview-demo is-wide">
            <span class="settings-field-label">identities</span>
            <SettingRows v-model="v.rowsIdentities" mode="identities" :platforms="ADMIN_PLATFORM_OPTIONS" addLabel="Add admin" label="identities" :disabled="disabled" />
            <code>{{ show(v.rowsIdentities) }}</code>
          </div>
          <div class="components-preview-demo is-wide">
            <span class="settings-field-label">JSON the rows cannot show falls back to text</span>
            <SettingRows v-model="v.rowsUnreadable" mode="map" label="unreadable" :disabled="disabled">
              <template #fallback>
                <QTextarea v-model="v.rowsUnreadable" :rows="3" class="config-settings-json" :disabled="disabled" />
              </template>
            </SettingRows>
            <code>{{ show(v.rowsUnreadable) }}</code>
          </div>
        </div>
      </section>

      <section id="secret" class="components-preview-section">
        <h2>SecretInput &amp; EnvManagedField</h2>
        <p class="components-preview-note">A stored secret is never shown; a value from an environment variable is read-only.</p>
        <div class="components-preview-grid">
          <div class="components-preview-demo">
            <span class="settings-field-label">Secret, configured</span>
            <SecretInput v-model="v.secret" :status="{ configured: true, source: 'config', editable: true }" :disabled="disabled" />
            <code>{{ show(v.secret) }}</code>
          </div>
          <div class="components-preview-demo">
            <span class="settings-field-label">From the environment</span>
            <EnvManagedField name="MISTER_MORPH_LLM_API_KEY" />
          </div>
        </div>
      </section>

      <section id="picker" class="components-preview-section">
        <h2>SetupPickerDialogContent</h2>
        <p class="components-preview-note">The list inside the model picker. The selected item is marked by weight, a tint and a check, not a lighter color.</p>
        <div class="components-preview-demo components-preview-picker">
          <SetupPickerDialogContent
            :items="PICKER_MODELS"
            :selectedValue="v.pickedModel"
            filterPlaceholder="Filter models"
            emptyText="No models"
            :showValue="false"
            @select="v.pickedModel = $event.value"
          />
          <code>{{ show(v.pickedModel) }}</code>
        </div>
      </section>

      <section id="panel" class="components-preview-section">
        <h2>ConfigSettingsPanel</h2>
        <p class="components-preview-note">The real settings panel with every editor. Dependent fields grey out with their switch; Save shows the update it would send.</p>
        <ConfigSettingsPanel
          :groups="PANEL_GROUPS"
          :values="panelValues"
          :fieldStates="PANEL_STATES"
          @save="savePanel"
        />
        <code class="components-preview-update">{{ panelUpdate ? JSON.stringify(panelUpdate, null, 2) : "Save to see the update." }}</code>
      </section>
    </div>
    </div>
  `,
};

export default ComponentsPreviewView;
