import { createApp, computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { createRouter, createWebHistory, useRoute, useRouter } from "vue-router";
import { QuailUI, applyTheme } from "quail-ui";
import "quail-ui/dist/index.css";
import "./styles.css";

const AUTH_STORAGE_KEY = "mistermorph_console_auth_v1";
const BASE_PATH = "/console";
const API_BASE = `${BASE_PATH}/api`;

const authState = reactive({
  token: "",
  expiresAt: "",
  account: "console",
});

const authValid = computed(() => {
  if (!authState.token || !authState.expiresAt) {
    return false;
  }
  const ts = new Date(authState.expiresAt).getTime();
  if (!Number.isFinite(ts)) {
    return false;
  }
  return ts > Date.now();
});

function saveAuth() {
  localStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({
      token: authState.token,
      expiresAt: authState.expiresAt,
      account: authState.account,
    })
  );
}

function clearAuth() {
  authState.token = "";
  authState.expiresAt = "";
  authState.account = "console";
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

function hydrateAuth() {
  const raw = localStorage.getItem(AUTH_STORAGE_KEY);
  if (!raw) {
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    authState.token = typeof parsed.token === "string" ? parsed.token : "";
    authState.expiresAt = typeof parsed.expiresAt === "string" ? parsed.expiresAt : "";
    authState.account = typeof parsed.account === "string" ? parsed.account : "console";
  } catch {
    clearAuth();
  }
}

async function apiFetch(pathname, options = {}) {
  const method = options.method || "GET";
  const headers = { ...(options.headers || {}) };
  if (!options.noAuth && authState.token) {
    headers.Authorization = `Bearer ${authState.token}`;
  }
  let body = options.body;
  if (body !== undefined && body !== null && typeof body !== "string") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }

  const resp = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers,
    body,
  });
  const raw = await resp.text();
  const parsed = raw ? safeJSON(raw, { error: raw }) : {};
  if (!resp.ok) {
    if (resp.status === 401 && !options.noAuth) {
      clearAuth();
    }
    const err = new Error(parsed.error || `HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return parsed;
}

function safeJSON(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function formatTime(ts) {
  if (!ts) {
    return "-";
  }
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) {
    return ts;
  }
  return d.toLocaleString();
}

function formatRemainingUntil(ts) {
  if (!ts) {
    return "unknown";
  }
  const ms = new Date(ts).getTime() - Date.now();
  if (!Number.isFinite(ms)) {
    return "invalid";
  }
  if (ms <= 0) {
    return "expired";
  }
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 60) {
    return `${totalMinutes}m left`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) {
    return `${hours}h ${minutes}m left`;
  }
  const days = Math.floor(hours / 24);
  const hourPart = hours % 24;
  return `${days}d ${hourPart}h left`;
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.trunc(n);
}

function toBool(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes" || v === "on") {
      return true;
    }
    if (v === "false" || v === "0" || v === "no" || v === "off") {
      return false;
    }
  }
  return fallback;
}

function formatBytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return "-";
  }
  if (n < 1024) {
    return `${Math.trunc(n)} B`;
  }
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let idx = -1;
  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024;
    idx += 1;
  }
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[idx]}`;
}

const LoginView = {
  setup() {
    const router = useRouter();
    const route = useRoute();
    const password = ref("");
    const busy = ref(false);
    const err = ref("");

    async function submit() {
      if (!password.value.trim()) {
        err.value = "请输入密码";
        return;
      }
      busy.value = true;
      err.value = "";
      try {
        const body = await apiFetch("/auth/login", {
          method: "POST",
          body: { password: password.value },
          noAuth: true,
        });
        authState.token = body.access_token || "";
        authState.expiresAt = body.expires_at || "";
        authState.account = "console";
        saveAuth();
        const redirect = typeof route.query.redirect === "string" ? route.query.redirect : "/dashboard";
        router.replace(redirect);
      } catch (e) {
        err.value = e.message || "登录失败";
      } finally {
        busy.value = false;
      }
    }

    return { password, busy, err, submit };
  },
  template: `
    <section class="login-box">
      <h1 class="login-title">Mistermorph Console</h1>
      <div class="stack">
        <QInput
          v-model="password"
          inputType="password"
          placeholder="Console password"
          :disabled="busy"
        />
        <QButton :loading="busy" class="primary" @click="submit">登录</QButton>
        <QFence v-if="err" type="danger" icon="QIconCloseCircle" :text="err" />
      </div>
    </section>
  `,
};

const DashboardView = {
  setup() {
    const err = ref("");
    const loading = ref(false);
    let refreshTimer = null;
    const overview = reactive({
      version: "-",
      started_at: "-",
      uptime_sec: 0,
      health: "-",
      llm_provider: "-",
      llm_model: "-",
      channel_telegram_configured: false,
      channel_slack_configured: false,
      channel_running_telegram: false,
      channel_running_slack: false,
      runtime_go_version: "-",
      runtime_goroutines: 0,
      runtime_heap_alloc_bytes: 0,
      runtime_heap_sys_bytes: 0,
      runtime_heap_objects: 0,
      runtime_gc_cycles: 0,
    });

    async function load() {
      loading.value = true;
      err.value = "";
      try {
        const data = await apiFetch("/dashboard/overview");
        overview.version = data.version || "-";
        overview.started_at = data.started_at || "-";
        overview.uptime_sec = toInt(data.uptime_sec, 0);
        overview.health = data.health || "-";
        const llm = data && typeof data.llm === "object" ? data.llm : {};
        overview.llm_provider = llm.provider || "-";
        overview.llm_model = llm.model || "-";
        const channel = data && typeof data.channel === "object" ? data.channel : {};
        overview.channel_telegram_configured = toBool(channel.telegram_configured, false);
        overview.channel_slack_configured = toBool(channel.slack_configured, false);
        overview.channel_running_telegram = toBool(channel.telegram_running, false);
        overview.channel_running_slack = toBool(channel.slack_running, false);
        const rt = data && typeof data.runtime === "object" ? data.runtime : {};
        overview.runtime_go_version = rt.go_version || "-";
        overview.runtime_goroutines = toInt(rt.goroutines, 0);
        overview.runtime_heap_alloc_bytes = toInt(rt.heap_alloc_bytes, 0);
        overview.runtime_heap_sys_bytes = toInt(rt.heap_sys_bytes, 0);
        overview.runtime_heap_objects = toInt(rt.heap_objects, 0);
        overview.runtime_gc_cycles = toInt(rt.gc_cycles, 0);
      } catch (e) {
        err.value = e.message || "加载失败";
      } finally {
        loading.value = false;
      }
    }

    onMounted(() => {
      void load();
      refreshTimer = window.setInterval(() => {
        void load();
      }, 60000);
    });
    onUnmounted(() => {
      if (refreshTimer !== null) {
        window.clearInterval(refreshTimer);
        refreshTimer = null;
      }
    });
    return { err, loading, overview, formatTime, formatBytes };
  },
  template: `
    <section>
      <h2 class="title">概览</h2>
      <QProgress v-if="loading" :infinite="true" />
      <QFence v-if="err" type="danger" icon="QIconCloseCircle" :text="err" />
      <div class="stat-groups">
        <section class="stat-group">
          <h3 class="stat-group-title">基础状态</h3>
          <div class="stat-list">
            <div class="stat-item">
              <span class="stat-key">Version</span>
              <code class="stat-value">{{ overview.version }}</code>
            </div>
            <div class="stat-item">
              <span class="stat-key">Started</span>
              <code class="stat-value">{{ formatTime(overview.started_at) }}</code>
            </div>
            <div class="stat-item">
              <span class="stat-key">Uptime</span>
              <code class="stat-value">{{ overview.uptime_sec }}s</code>
            </div>
            <div class="stat-item">
              <span class="stat-key">Health</span>
              <code class="stat-value">{{ overview.health }}</code>
            </div>
          </div>
        </section>
        <section class="stat-group">
          <h3 class="stat-group-title">模型配置</h3>
          <div class="stat-list">
            <div class="stat-item">
              <span class="stat-key">LLM Provider</span>
              <code class="stat-value">{{ overview.llm_provider }}</code>
            </div>
            <div class="stat-item">
              <span class="stat-key">LLM Model</span>
              <code class="stat-value">{{ overview.llm_model }}</code>
            </div>
          </div>
        </section>
        <section class="stat-group">
          <h3 class="stat-group-title">接入渠道</h3>
          <div class="stat-list">
            <div class="stat-item">
              <span class="stat-key">Channels</span>
              <div class="channel-runtime-list">
                <div :class="overview.channel_telegram_configured ? 'channel-runtime-item' : 'channel-runtime-item is-disabled'">
                  <span class="channel-runtime-dot">
                    <QBadge
                      :type="overview.channel_running_telegram ? 'success' : 'default'"
                      size="md"
                      variant="filled"
                      :dot="true"
                    />
                  </span>
                  <span class="channel-runtime-label">Telegram</span>
                </div>
                <div :class="overview.channel_slack_configured ? 'channel-runtime-item' : 'channel-runtime-item is-disabled'">
                  <span class="channel-runtime-dot">
                    <QBadge
                      :type="overview.channel_running_slack ? 'success' : 'default'"
                      size="md"
                      variant="filled"
                      :dot="true"
                    />
                  </span>
                  <span class="channel-runtime-label">Slack</span>
                </div>
              </div>
            </div>
          </div>
        </section>
        <section class="stat-group">
          <h3 class="stat-group-title">运行时指标</h3>
          <div class="stat-list">
            <div class="stat-item">
              <span class="stat-key">Go Version</span>
              <code class="stat-value">{{ overview.runtime_go_version }}</code>
            </div>
            <div class="stat-item">
              <span class="stat-key">Goroutines</span>
              <code class="stat-value">{{ overview.runtime_goroutines }}</code>
            </div>
            <div class="stat-item">
              <span class="stat-key">Heap Alloc</span>
              <code class="stat-value">{{ formatBytes(overview.runtime_heap_alloc_bytes) }}</code>
            </div>
            <div class="stat-item">
              <span class="stat-key">Heap Sys</span>
              <code class="stat-value">{{ formatBytes(overview.runtime_heap_sys_bytes) }}</code>
            </div>
            <div class="stat-item">
              <span class="stat-key">Heap Objects</span>
              <code class="stat-value">{{ overview.runtime_heap_objects }}</code>
            </div>
            <div class="stat-item">
              <span class="stat-key">GC Cycles</span>
              <code class="stat-value">{{ overview.runtime_gc_cycles }}</code>
            </div>
          </div>
        </section>
      </div>
    </section>
  `,
};

const taskStatusItems = [
  { title: "All", value: "" },
  { title: "queued", value: "queued" },
  { title: "running", value: "running" },
  { title: "pending", value: "pending" },
  { title: "done", value: "done" },
  { title: "failed", value: "failed" },
  { title: "canceled", value: "canceled" },
];

const TasksView = {
  setup() {
    const router = useRouter();
    const statusItem = ref(taskStatusItems[0]);
    const limitText = ref("20");
    const items = ref([]);
    const err = ref("");
    const loading = ref(false);

    async function load() {
      loading.value = true;
      err.value = "";
      try {
        const q = new URLSearchParams();
        const v = statusItem.value?.value || "";
        if (v) {
          q.set("status", v);
        }
        const limit = Math.max(1, Math.min(200, parseInt(limitText.value || "20", 10) || 20));
        q.set("limit", String(limit));
        const data = await apiFetch(`/tasks?${q.toString()}`);
        items.value = Array.isArray(data.items) ? data.items : [];
      } catch (e) {
        err.value = e.message || "加载失败";
      } finally {
        loading.value = false;
      }
    }

    function onStatusChange(item) {
      if (item && typeof item === "object") {
        statusItem.value = item;
      }
    }

    function openTask(id) {
      router.push(`/tasks/${id}`);
    }

    function summary(item) {
      const source = item.source || "daemon";
      const status = (item.status || "unknown").toUpperCase();
      return `[${status}] ${item.id} | ${source} | ${item.model || "-"} | ${formatTime(item.created_at)}`;
    }

    onMounted(load);
    return { taskStatusItems, statusItem, limitText, items, err, loading, load, onStatusChange, openTask, summary };
  },
  template: `
    <section>
      <h2 class="title">当前任务</h2>
      <div class="toolbar wrap">
        <div class="tool-item">
          <QDropdownMenu
            :items="taskStatusItems"
            :initialItem="statusItem"
            placeholder="status"
            @change="onStatusChange"
          />
        </div>
        <div class="tool-item">
          <QInput v-model="limitText" inputType="number" placeholder="limit" />
        </div>
        <QButton class="outlined" :loading="loading" @click="load">刷新</QButton>
      </div>
      <QProgress v-if="loading" :infinite="true" />
      <QFence v-if="err" type="danger" icon="QIconCloseCircle" :text="err" />
      <div class="stack">
        <div v-for="item in items" :key="item.id" class="task-row">
          <code class="task-line">{{ summary(item) }}</code>
          <QButton class="plain" @click="openTask(item.id)">详情</QButton>
        </div>
        <p v-if="items.length === 0 && !loading" class="muted">无任务</p>
      </div>
    </section>
  `,
};

const TaskDetailView = {
  setup() {
    const router = useRouter();
    const route = useRoute();
    const loading = ref(false);
    const err = ref("");
    const detailJSON = ref("");

    async function load() {
      loading.value = true;
      err.value = "";
      try {
        const id = route.params.id || "";
        const data = await apiFetch(`/tasks/${encodeURIComponent(id)}`);
        detailJSON.value = JSON.stringify(data, null, 2);
      } catch (e) {
        detailJSON.value = "";
        err.value = e.message || "加载失败";
      } finally {
        loading.value = false;
      }
    }

    function back() {
      router.push("/tasks");
    }

    onMounted(load);
    return { loading, err, detailJSON, load, back };
  },
  template: `
    <section>
      <h2 class="title">任务详情</h2>
      <div class="toolbar">
        <QButton class="outlined" @click="back">返回</QButton>
        <QButton class="plain" :loading="loading" @click="load">刷新</QButton>
      </div>
      <QProgress v-if="loading" :infinite="true" />
      <QFence v-if="err" type="danger" icon="QIconCloseCircle" :text="err" />
      <QTextarea :modelValue="detailJSON" :rows="20" :disabled="true" />
    </section>
  `,
};

const ContactsFilesView = {
  setup() {
    const loading = ref(false);
    const saving = ref(false);
    const err = ref("");
    const ok = ref("");
    const fileItems = ref([
      { title: "ACTIVE.md", name: "ACTIVE.md" },
      { title: "INACTIVE.md", name: "INACTIVE.md" },
    ]);
    const selectedFile = ref(fileItems.value[0]);
    const content = ref("");

    async function loadFiles() {
      const data = await apiFetch("/contacts/files");
      const items = Array.isArray(data.items) ? data.items : [];
      if (items.length === 0) {
        return;
      }
      fileItems.value = items.map((it) => ({
        title: it.name || "",
        name: it.name || "",
      }));
      if (!fileItems.value.find((x) => x.name === selectedFile.value?.name)) {
        selectedFile.value = fileItems.value[0];
      }
    }

    async function loadContent(name) {
      loading.value = true;
      err.value = "";
      ok.value = "";
      try {
        const data = await apiFetch(`/contacts/files/${encodeURIComponent(name)}`);
        content.value = data.content || "";
      } catch (e) {
        err.value = e.message || "读取失败";
      } finally {
        loading.value = false;
      }
    }

    async function save() {
      saving.value = true;
      err.value = "";
      ok.value = "";
      try {
        await apiFetch(`/contacts/files/${encodeURIComponent(selectedFile.value.name)}`, {
          method: "PUT",
          body: { content: content.value },
        });
        ok.value = "保存成功";
      } catch (e) {
        err.value = e.message || "保存失败";
      } finally {
        saving.value = false;
      }
    }

    async function onFileChange(item) {
      if (!item || typeof item !== "object" || !item.name) {
        return;
      }
      selectedFile.value = item;
      await loadContent(item.name);
    }

    async function init() {
      await loadFiles();
      await loadContent(selectedFile.value.name);
    }

    onMounted(init);
    return { loading, saving, err, ok, fileItems, selectedFile, content, onFileChange, save };
  },
  template: `
    <section>
      <h2 class="title">联系人</h2>
      <div class="toolbar wrap">
        <div class="tool-item">
          <QDropdownMenu
            :items="fileItems"
            :initialItem="selectedFile"
            placeholder="选择文件"
            @change="onFileChange"
          />
        </div>
        <QButton class="primary" :loading="saving" @click="save">保存</QButton>
      </div>
      <QProgress v-if="loading" :infinite="true" />
      <QFence v-if="err" type="danger" icon="QIconCloseCircle" :text="err" />
      <QFence v-if="ok" type="success" icon="QIconCheckCircle" :text="ok" />
      <QTextarea v-model="content" :rows="22" />
    </section>
  `,
};

const TODOFilesView = {
  setup() {
    const loading = ref(false);
    const saving = ref(false);
    const err = ref("");
    const ok = ref("");
    const fileItems = ref([
      { title: "TODO.md", name: "TODO.md" },
      { title: "TODO.DONE.md", name: "TODO.DONE.md" },
    ]);
    const selectedFile = ref(fileItems.value[0]);
    const content = ref("");

    async function loadFiles() {
      const data = await apiFetch("/todo/files");
      const items = Array.isArray(data.items) ? data.items : [];
      if (items.length === 0) {
        return;
      }
      fileItems.value = items.map((it) => ({
        title: it.name || "",
        name: it.name || "",
      }));
      if (!fileItems.value.find((x) => x.name === selectedFile.value?.name)) {
        selectedFile.value = fileItems.value[0];
      }
    }

    async function loadContent(name) {
      loading.value = true;
      err.value = "";
      ok.value = "";
      try {
        const data = await apiFetch(`/todo/files/${encodeURIComponent(name)}`);
        content.value = data.content || "";
      } catch (e) {
        if (e && e.status === 404) {
          content.value = "";
          ok.value = "文件不存在，可直接编辑后保存创建";
          return;
        }
        err.value = e.message || "读取失败";
      } finally {
        loading.value = false;
      }
    }

    async function save() {
      saving.value = true;
      err.value = "";
      ok.value = "";
      try {
        await apiFetch(`/todo/files/${encodeURIComponent(selectedFile.value.name)}`, {
          method: "PUT",
          body: { content: content.value },
        });
        ok.value = "保存成功";
      } catch (e) {
        err.value = e.message || "保存失败";
      } finally {
        saving.value = false;
      }
    }

    async function onFileChange(item) {
      if (!item || typeof item !== "object" || !item.name) {
        return;
      }
      selectedFile.value = item;
      await loadContent(item.name);
    }

    async function init() {
      await loadFiles();
      await loadContent(selectedFile.value.name);
    }

    onMounted(init);
    return { loading, saving, err, ok, fileItems, selectedFile, content, onFileChange, save };
  },
  template: `
    <section>
      <h2 class="title">待办</h2>
      <div class="toolbar wrap">
        <div class="tool-item">
          <QDropdownMenu
            :items="fileItems"
            :initialItem="selectedFile"
            placeholder="选择文件"
            @change="onFileChange"
          />
        </div>
        <QButton class="primary" :loading="saving" @click="save">保存</QButton>
      </div>
      <QProgress v-if="loading" :infinite="true" />
      <QFence v-if="err" type="danger" icon="QIconCloseCircle" :text="err" />
      <QFence v-if="ok" type="success" icon="QIconCheckCircle" :text="ok" />
      <QTextarea v-model="content" :rows="22" />
    </section>
  `,
};

const PersonaFilesView = {
  setup() {
    const loading = ref(false);
    const saving = ref(false);
    const err = ref("");
    const ok = ref("");
    const fileItems = ref([
      { title: "IDENTITY.md", name: "IDENTITY.md" },
      { title: "SOUL.md", name: "SOUL.md" },
    ]);
    const selectedFile = ref(fileItems.value[0]);
    const content = ref("");

    async function loadFiles() {
      const data = await apiFetch("/persona/files");
      const items = Array.isArray(data.items) ? data.items : [];
      if (items.length === 0) {
        return;
      }
      fileItems.value = items.map((it) => ({
        title: it.name || "",
        name: it.name || "",
      }));
      if (!fileItems.value.find((x) => x.name === selectedFile.value?.name)) {
        selectedFile.value = fileItems.value[0];
      }
    }

    async function loadContent(name) {
      loading.value = true;
      err.value = "";
      ok.value = "";
      try {
        const data = await apiFetch(`/persona/files/${encodeURIComponent(name)}`);
        content.value = data.content || "";
      } catch (e) {
        if (e && e.status === 404) {
          content.value = "";
          ok.value = "文件不存在，可直接编辑后保存创建";
          return;
        }
        err.value = e.message || "读取失败";
      } finally {
        loading.value = false;
      }
    }

    async function save() {
      saving.value = true;
      err.value = "";
      ok.value = "";
      try {
        await apiFetch(`/persona/files/${encodeURIComponent(selectedFile.value.name)}`, {
          method: "PUT",
          body: { content: content.value },
        });
        ok.value = "保存成功";
      } catch (e) {
        err.value = e.message || "保存失败";
      } finally {
        saving.value = false;
      }
    }

    async function onFileChange(item) {
      if (!item || typeof item !== "object" || !item.name) {
        return;
      }
      selectedFile.value = item;
      await loadContent(item.name);
    }

    async function init() {
      await loadFiles();
      await loadContent(selectedFile.value.name);
    }

    onMounted(init);
    return { loading, saving, err, ok, fileItems, selectedFile, content, onFileChange, save };
  },
  template: `
    <section>
      <h2 class="title">人格</h2>
      <div class="toolbar wrap">
        <div class="tool-item">
          <QDropdownMenu
            :items="fileItems"
            :initialItem="selectedFile"
            placeholder="选择文件"
            @change="onFileChange"
          />
        </div>
        <QButton class="primary" :loading="saving" @click="save">保存</QButton>
      </div>
      <QProgress v-if="loading" :infinite="true" />
      <QFence v-if="err" type="danger" icon="QIconCloseCircle" :text="err" />
      <QFence v-if="ok" type="success" icon="QIconCheckCircle" :text="ok" />
      <QTextarea v-model="content" :rows="22" />
    </section>
  `,
};

const SettingsView = {
  setup() {
    const loading = ref(false);
    const err = ref("");
    const configJSON = ref("");
    const checks = ref([]);

    async function load() {
      loading.value = true;
      err.value = "";
      try {
        const [cfg, diag] = await Promise.all([apiFetch("/system/config"), apiFetch("/system/diagnostics")]);
        configJSON.value = JSON.stringify(cfg, null, 2);
        checks.value = Array.isArray(diag.checks) ? diag.checks : [];
      } catch (e) {
        err.value = e.message || "加载失败";
      } finally {
        loading.value = false;
      }
    }

    function checkStatus(c) {
      return c && c.ok ? "PASS" : "FAIL";
    }

    function checkClass(c) {
      return c && c.ok ? "check-status check-pass" : "check-status check-fail";
    }

    onMounted(load);
    return { loading, err, configJSON, checks, load, checkStatus, checkClass };
  },
  template: `
    <section>
      <h2 class="title">系统</h2>
      <div class="toolbar">
        <QButton class="outlined" :loading="loading" @click="load">刷新</QButton>
      </div>
      <QProgress v-if="loading" :infinite="true" />
      <QFence v-if="err" type="danger" icon="QIconCloseCircle" :text="err" />
      <div class="check-list">
        <div v-for="(item, idx) in checks" :key="idx" class="check-item">
          <code :class="checkClass(item)">{{ checkStatus(item) }}</code>
          <code class="check-id">{{ item.id }}</code>
          <span v-if="item.detail" class="muted check-detail">{{ item.detail }}</span>
        </div>
      </div>
      <QTextarea :modelValue="configJSON" :rows="18" :disabled="true" />
    </section>
  `,
};

const routes = [
  { path: "/login", component: LoginView },
  { path: "/dashboard", component: DashboardView },
  { path: "/tasks", component: TasksView },
  { path: "/tasks/:id", component: TaskDetailView },
  { path: "/todo-files", component: TODOFilesView },
  { path: "/contacts-files", component: ContactsFilesView },
  { path: "/persona-files", component: PersonaFilesView },
  { path: "/settings", component: SettingsView },
  { path: "/", redirect: "/dashboard" },
];

const router = createRouter({
  history: createWebHistory(BASE_PATH + "/"),
  routes,
});

const navItems = [
  { id: "/dashboard", title: "概览" },
  { id: "/tasks", title: "任务" },
  { id: "/todo-files", title: "待办" },
  { id: "/contacts-files", title: "联系人" },
  { id: "/persona-files", title: "人格" },
  { id: "/settings", title: "配置" },
];

const App = {
  setup() {
    const router = useRouter();
    const route = useRoute();
    const inLogin = computed(() => route.path === "/login");
    const mobileNavOpen = ref(false);
    const mobileMode = ref(window.innerWidth <= 980);
    const nowTick = ref(Date.now());

    function syncViewport() {
      mobileMode.value = window.innerWidth <= 980;
      if (!mobileMode.value) {
        mobileNavOpen.value = false;
      }
    }

    const tickTimer = setInterval(() => {
      nowTick.value = Date.now();
    }, 30000);
    onMounted(() => {
      syncViewport();
      window.addEventListener("resize", syncViewport);
    });
    onUnmounted(() => {
      clearInterval(tickTimer);
      window.removeEventListener("resize", syncViewport);
    });

    watch(
      () => route.fullPath,
      () => {
        mobileNavOpen.value = false;
      }
    );

    const sessionLabel = computed(() => {
      void nowTick.value;
      return formatRemainingUntil(authState.expiresAt);
    });

    async function logout() {
      try {
        await apiFetch("/auth/logout", { method: "POST" });
      } catch {
        // ignore logout failure
      }
      clearAuth();
      router.replace("/login");
    }

    function goTo(item) {
      if (!item || typeof item.id !== "string" || !item.id) {
        return;
      }
      mobileNavOpen.value = false;
      if (route.path !== item.id) {
        router.push(item.id);
      }
    }

    function openMobileNav() {
      mobileNavOpen.value = true;
    }

    function closeMobileNav() {
      mobileNavOpen.value = false;
    }

    function isActive(item) {
      if (!item || typeof item.id !== "string") {
        return false;
      }
      if (item.id === "/tasks") {
        return route.path === "/tasks" || route.path.startsWith("/tasks/");
      }
      return route.path === item.id;
    }

    return {
      inLogin,
      navItems,
      goTo,
      isActive,
      openMobileNav,
      closeMobileNav,
      logout,
      authState,
      sessionLabel,
      mobileMode,
      mobileNavOpen,
    };
  },
  template: `
    <div>
      <section v-if="inLogin">
        <RouterView />
      </section>
      <section v-else class="app-shell">
        <header class="topbar">
          <div class="topbar-brand">
            <QButton v-if="mobileMode" class="plain mobile-nav-trigger" @click="openMobileNav">
              <QIconMenu />
            </QButton>
            <div class="brand">
              <h1 class="brand-title">Mistermorph Console</h1>
            </div>
          </div>
          <div class="topbar-actions">
            <span class="session-inline">TTL {{ sessionLabel }}</span>
            <QButton class="outlined" @click="logout">退出</QButton>
          </div>
        </header>
        <div :class="mobileMode ? 'workspace is-mobile' : 'workspace'">
          <aside v-if="!mobileMode" class="sidebar">
            <div class="sidebar-nav">
              <QButton
                v-for="item in navItems"
                :key="item.id"
                :class="isActive(item) ? 'plain nav-btn nav-btn-active' : 'plain nav-btn'"
                @click="goTo(item)"
              >
                {{ item.title }}
              </QButton>
            </div>
          </aside>
          <main class="content">
            <RouterView />
          </main>
        </div>
        <QDrawer
          v-if="mobileMode"
          v-model="mobileNavOpen"
          title="导航"
          placement="left"
          size="272px"
          :showMask="true"
          :maskClosable="true"
          :lockScroll="true"
          @close="closeMobileNav"
        >
          <div class="sidebar-nav mobile-drawer-nav">
            <QButton
              v-for="item in navItems"
              :key="'drawer-' + item.id"
              :class="isActive(item) ? 'plain nav-btn nav-btn-active' : 'plain nav-btn'"
              @click="goTo(item)"
            >
              {{ item.title }}
            </QButton>
          </div>
        </QDrawer>
      </section>
    </div>
  `,
};

router.beforeEach(async (to) => {
  if (to.path === "/login") {
    return true;
  }
  if (!authValid.value) {
    return { path: "/login", query: { redirect: to.fullPath } };
  }
  try {
    const me = await apiFetch("/auth/me");
    authState.account = me.account || "console";
    authState.expiresAt = me.expires_at || authState.expiresAt;
    saveAuth();
  } catch {
    clearAuth();
    return { path: "/login", query: { redirect: to.fullPath } };
  }
  return true;
});

hydrateAuth();

const app = createApp(App);
app.use(router);
app.use(QuailUI);
applyTheme("morph", false);
app.mount("#app");
