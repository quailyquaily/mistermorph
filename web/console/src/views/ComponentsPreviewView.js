import { computed, provide, reactive, ref } from "vue";

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
import {
  ADMIN_PLATFORM_OPTIONS,
  AWS_REGION_OPTIONS,
  CACHE_TTL_OPTIONS,
  HEARTBEAT_INTERVAL_OPTIONS,
  LOGGING_LEVEL_OPTIONS,
  TASK_TARGET_OPTIONS,
} from "../core/config-options";
import "./SettingsView.css";
import "./ComponentsPreviewView.css";

// /__components: every custom settings control on one page, in its typical states, with the value
// each one would save. For reviewing and designing the controls without opening real settings.

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
    });

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

    const sections = computed(() => [
      { id: "select", title: "SettingSelect" },
      { id: "duration", title: "SettingDuration" },
      { id: "bytes", title: "SettingBytes" },
      { id: "percent", title: "SettingPercent" },
      { id: "limit", title: "SettingLimit" },
      { id: "path", title: "SettingPath" },
      { id: "choices", title: "SettingChoices" },
      { id: "rows", title: "SettingRows" },
      { id: "secret", title: "SecretInput & EnvManagedField" },
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
      disabled,
      showBrowse,
      v,
      show,
      jumpTo,
      sections,
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
          <h1 class="components-preview-title">Settings components</h1>
          <p class="components-preview-meta">Every custom settings control, in its usual states. Each demo shows the value it would save.</p>
        </div>
        <div class="components-preview-toggles">
          <label class="components-preview-toggle"><QSwitch v-model="disabled" /> Disabled</label>
          <label class="components-preview-toggle"><QSwitch v-model="showBrowse" /> Browse button</label>
        </div>
      </header>

      <nav class="components-preview-nav" aria-label="Components">
        <a v-for="section in sections" :key="section.id" :href="'#' + section.id" @click.prevent="jumpTo(section.id)">{{ section.title }}</a>
      </nav>

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
