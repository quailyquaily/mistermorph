import { createApp, computed, onMounted, reactive, ref } from "vue";
import { createRouter, createWebHistory, useRoute, useRouter } from "vue-router";
import { QuailUI } from "quail-ui";
import "./styles.css";

const AUTH_STORAGE_KEY = "mistermorph_admin_auth_v1";

function detectBasePath(pathname) {
  const clean = (pathname || "/").replace(/\/+$/, "") || "/";
  const fixed = ["/login", "/dashboard", "/tasks", "/contacts-files", "/settings"];
  for (const p of fixed) {
    if (clean.endsWith(p)) {
      const base = clean.slice(0, clean.length - p.length);
      return base || "/admin";
    }
  }
  if (clean.includes("/tasks/")) {
    return clean.slice(0, clean.indexOf("/tasks/")) || "/admin";
  }
  if (clean === "/") {
    return "/admin";
  }
  return clean;
}

const BASE_PATH = detectBasePath(window.location.pathname);
const API_BASE = `${BASE_PATH}/api`;

const authState = reactive({
  token: "",
  expiresAt: "",
  account: "admin",
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
  authState.account = "admin";
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
    authState.account = typeof parsed.account === "string" ? parsed.account : "admin";
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
        authState.account = "admin";
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
      <h1 class="login-title">MisterMorph Admin</h1>
      <p class="muted">输入管理密码登录。</p>
      <div class="stack">
        <QInput
          v-model="password"
          inputType="password"
          placeholder="Admin password"
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
    const overview = reactive({
      version: "-",
      started_at: "-",
      uptime_sec: 0,
      health: "-",
    });

    async function load() {
      loading.value = true;
      err.value = "";
      try {
        const data = await apiFetch("/dashboard/overview");
        overview.version = data.version || "-";
        overview.started_at = data.started_at || "-";
        overview.uptime_sec = data.uptime_sec || 0;
        overview.health = data.health || "-";
      } catch (e) {
        err.value = e.message || "加载失败";
      } finally {
        loading.value = false;
      }
    }

    onMounted(load);
    return { err, loading, overview, load, formatTime };
  },
  template: `
    <section>
      <h2 class="title">Dashboard</h2>
      <p class="muted">只保留当前运行态信息，不做近期任务统计。</p>
      <QProgress v-if="loading" :infinite="true" />
      <QFence v-if="err" type="danger" icon="QIconCloseCircle" :text="err" />
      <div class="fence-grid">
        <QFence icon="QIconInfoCircle" :text="'Version: ' + overview.version" />
        <QFence icon="QIconClockRewind" :text="'Started: ' + formatTime(overview.started_at)" />
        <QFence icon="QIconSpeedoMeter" :text="'Uptime: ' + overview.uptime_sec + 's'" />
        <QFence icon="QIconCheckCircle" :text="'Health: ' + overview.health" />
      </div>
      <div class="toolbar">
        <QButton class="outlined" @click="load" :loading="loading">刷新</QButton>
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
      return `${item.id} | ${source} | ${item.status} | ${item.model || "-"} | ${formatTime(item.created_at)}`;
    }

    onMounted(load);
    return { taskStatusItems, statusItem, limitText, items, err, loading, load, onStatusChange, openTask, summary };
  },
  template: `
    <section>
      <h2 class="title">当前任务</h2>
      <p class="muted">显示当前连接 daemon 的运行中任务视图（内存态）。</p>
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
        <QButton class="outlined" :loading="loading" @click="load">刷新列表</QButton>
      </div>
      <QProgress v-if="loading" :infinite="true" />
      <QFence v-if="err" type="danger" icon="QIconCloseCircle" :text="err" />
      <div class="stack">
        <div v-for="item in items" :key="item.id" class="task-row">
          <QFence icon="QIconCpuChip" :text="summary(item)" />
          <QButton class="plain" @click="openTask(item.id)">查看详情</QButton>
        </div>
        <QFence v-if="items.length === 0 && !loading" icon="QIconInbox" text="没有可显示任务" />
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
        <QButton class="outlined" @click="back">返回任务列表</QButton>
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
      <h2 class="title">联系人文件</h2>
      <p class="muted">只编辑 ACTIVE.md / INACTIVE.md 文件。</p>
      <div class="toolbar wrap">
        <div class="tool-item">
          <QDropdownMenu
            :items="fileItems"
            :initialItem="selectedFile"
            placeholder="选择文件"
            @change="onFileChange"
          />
        </div>
        <QButton class="primary" :loading="saving" @click="save">保存文件</QButton>
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

    function checkText(c) {
      return `${c.id} | ok=${c.ok ? "true" : "false"}${c.detail ? " | " + c.detail : ""}`;
    }

    onMounted(load);
    return { loading, err, configJSON, checks, load, checkText };
  },
  template: `
    <section>
      <h2 class="title">配置与诊断</h2>
      <p class="muted">只读脱敏配置 + 路径/文件/健康检查。</p>
      <div class="toolbar">
        <QButton class="outlined" :loading="loading" @click="load">刷新</QButton>
      </div>
      <QProgress v-if="loading" :infinite="true" />
      <QFence v-if="err" type="danger" icon="QIconCloseCircle" :text="err" />
      <div class="stack">
        <QFence v-for="(item, idx) in checks" :key="idx" icon="QIconInfoSquare" :text="checkText(item)" />
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
  { path: "/contacts-files", component: ContactsFilesView },
  { path: "/settings", component: SettingsView },
  { path: "/", redirect: "/dashboard" },
];

const router = createRouter({
  history: createWebHistory(BASE_PATH + "/"),
  routes,
});

const navItems = [
  { id: "/dashboard", title: "Dashboard" },
  { id: "/tasks", title: "当前任务" },
  { id: "/contacts-files", title: "联系人文件" },
  { id: "/settings", title: "配置与诊断" },
];

const App = {
  setup() {
    const router = useRouter();
    const route = useRoute();
    const inLogin = computed(() => route.path === "/login");

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
      if (route.path !== item.id) {
        router.push(item.id);
      }
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

    return { inLogin, navItems, goTo, isActive, logout, authState };
  },
  template: `
    <div>
      <section v-if="inLogin">
        <RouterView />
      </section>
      <section v-else class="app-shell">
        <header class="topbar">
          <div class="brand">
            MisterMorph Admin
            <small>Base: <code>${BASE_PATH}</code></small>
          </div>
          <div class="topbar-actions">
            <span class="muted topbar-account">account: <code>{{ authState.account }}</code></span>
            <QButton class="outlined" @click="logout">退出</QButton>
          </div>
        </header>
        <div class="workspace">
          <aside class="sidebar">
            <p class="sidebar-title">导航</p>
            <div class="sidebar-nav">
              <QButton
                v-for="item in navItems"
                :key="item.id"
                :class="isActive(item) ? 'primary' : 'plain'"
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
    authState.account = me.account || "admin";
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
app.mount("#app");
