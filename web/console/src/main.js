import { createApp, computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { createRouter, createWebHistory, useRoute, useRouter } from "vue-router";
import { QuailUI, applyTheme } from "quail-ui";
import "quail-ui/dist/index.css";
import "./styles.css";

const AUTH_STORAGE_KEY = "mistermorph_console_auth_v1";
const BASE_PATH = "/console";
const API_BASE = `${BASE_PATH}/api`;
const LANGUAGE_STORAGE_KEY = "quail-language";

const I18N = {
  en: {
    ttl_unknown: "unknown",
    ttl_invalid: "invalid",
    ttl_expired: "expired",
    ttl_min_left: "{m}m left",
    ttl_hour_left: "{h}h {m}m left",
    ttl_day_left: "{d}d {h}h left",

    login_required_password: "Please enter password",
    login_failed: "Login failed",
    login_button: "Login",
    login_password_placeholder: "Console password",

    dashboard_title: "Overview",
    group_basic: "Basic Status",
    group_model: "Model Config",
    group_channels: "Channels",
    group_runtime: "Runtime Metrics",
    stat_version: "Version",
    stat_started: "Started",
    stat_uptime: "Uptime",
    stat_health: "Health",
    stat_llm_provider: "LLM Provider",
    stat_llm_model: "LLM Model",
    stat_channels: "Channels",
    stat_go_version: "Go Version",
    stat_goroutines: "Goroutines",
    stat_heap_alloc: "Heap Alloc",
    stat_heap_sys: "Heap Sys",
    stat_heap_objects: "Heap Objects",
    stat_gc_cycles: "GC Cycles",

    tasks_title: "Tasks",
    status_all: "All",
    status_queued: "Queued",
    status_running: "Running",
    status_pending: "Pending",
    status_done: "Done",
    status_failed: "Failed",
    status_canceled: "Canceled",
    placeholder_status: "status",
    placeholder_limit: "limit",
    no_tasks: "No tasks",
    task_detail: "Detail",
    task_detail_title: "Task Detail",
    audit_title: "Audit",
    audit_file: "Audit File",
    audit_window_bytes: "Window Bytes",
    audit_latest: "Latest",
    audit_newer: "Newer",
    audit_older: "Older",
    audit_path: "Path",
    audit_size: "Size",
    audit_range: "Range",
    audit_empty: "No audit records in this window",
    audit_no_file: "Audit log file not found",
    audit_time: "Time",
    audit_decision: "Decision",
    audit_risk: "Risk",
    audit_action: "Action",
    audit_tool: "Tool",
    audit_run: "Run",
    audit_step: "Step",
    audit_actor: "Actor",
    audit_approval: "Approval",
    audit_reasons: "Reasons",
    audit_summary: "Summary",
    audit_raw: "Raw",
    audit_decision_allow: "Allow",
    audit_decision_redact: "Allow+Redact",
    audit_decision_require_approval: "Require Approval",
    audit_decision_deny: "Deny",
    audit_risk_low: "Low",
    audit_risk_medium: "Medium",
    audit_risk_high: "High",
    audit_risk_critical: "Critical",

    contacts_title: "Contacts",
    todo_title: "TODO",
    persona_title: "Persona",
    settings_title: "System",
    placeholder_select_file: "Select file",
    placeholder_audit_file: "Audit file",

    action_save: "Save",
    action_back: "Back",
    action_refresh: "Refresh",
    action_logout: "Logout",

    msg_load_failed: "Load failed",
    msg_read_failed: "Read failed",
    msg_save_failed: "Save failed",
    msg_save_success: "Saved",
    msg_file_missing_create: "File not found. Edit and save to create.",
    status_pass: "PASS",
    status_fail: "FAIL",

    nav_overview: "Overview",
    nav_tasks: "Tasks",
    nav_audit: "Audit",
    nav_todo: "TODO",
    nav_contacts: "Contacts",
    nav_persona: "Persona",
    nav_settings: "Settings",
    drawer_nav: "Navigation",
    topbar_ttl: "TTL {value}",
  },
  zh: {
    ttl_unknown: "未知",
    ttl_invalid: "无效",
    ttl_expired: "已过期",
    ttl_min_left: "剩余 {m} 分钟",
    ttl_hour_left: "剩余 {h} 小时 {m} 分钟",
    ttl_day_left: "剩余 {d} 天 {h} 小时",

    login_required_password: "请输入密码",
    login_failed: "登录失败",
    login_button: "登录",
    login_password_placeholder: "控制台密码",

    dashboard_title: "概览",
    group_basic: "基础状态",
    group_model: "模型配置",
    group_channels: "接入渠道",
    group_runtime: "运行时指标",
    stat_version: "版本",
    stat_started: "启动时间",
    stat_uptime: "运行时长",
    stat_health: "健康状态",
    stat_llm_provider: "LLM 提供方",
    stat_llm_model: "LLM 模型",
    stat_channels: "渠道",
    stat_go_version: "Go 版本",
    stat_goroutines: "协程数",
    stat_heap_alloc: "堆已分配",
    stat_heap_sys: "堆系统占用",
    stat_heap_objects: "堆对象数",
    stat_gc_cycles: "GC 次数",

    tasks_title: "任务",
    status_all: "全部",
    status_queued: "排队中",
    status_running: "运行中",
    status_pending: "待审批",
    status_done: "已完成",
    status_failed: "失败",
    status_canceled: "已取消",
    placeholder_status: "状态",
    placeholder_limit: "数量",
    no_tasks: "无任务",
    task_detail: "详情",
    task_detail_title: "任务详情",
    audit_title: "审计",
    audit_file: "审计文件",
    audit_window_bytes: "窗口字节",
    audit_latest: "最新",
    audit_newer: "较新",
    audit_older: "较旧",
    audit_path: "路径",
    audit_size: "大小",
    audit_range: "范围",
    audit_empty: "当前窗口内无审计记录",
    audit_no_file: "未找到审计日志文件",
    audit_time: "时间",
    audit_decision: "决策",
    audit_risk: "风险",
    audit_action: "动作",
    audit_tool: "工具",
    audit_run: "Run",
    audit_step: "步骤",
    audit_actor: "操作者",
    audit_approval: "审批",
    audit_reasons: "原因",
    audit_summary: "摘要",
    audit_raw: "原始",
    audit_decision_allow: "允许",
    audit_decision_redact: "允许并脱敏",
    audit_decision_require_approval: "需要审批",
    audit_decision_deny: "拒绝",
    audit_risk_low: "低",
    audit_risk_medium: "中",
    audit_risk_high: "高",
    audit_risk_critical: "严重",

    contacts_title: "联系人",
    todo_title: "待办",
    persona_title: "人格",
    settings_title: "系统",
    placeholder_select_file: "选择文件",
    placeholder_audit_file: "选择审计文件",

    action_save: "保存",
    action_back: "返回",
    action_refresh: "刷新",
    action_logout: "退出",

    msg_load_failed: "加载失败",
    msg_read_failed: "读取失败",
    msg_save_failed: "保存失败",
    msg_save_success: "保存成功",
    msg_file_missing_create: "文件不存在，可直接编辑后保存创建",
    status_pass: "通过",
    status_fail: "失败",

    nav_overview: "概览",
    nav_tasks: "任务",
    nav_audit: "审计",
    nav_todo: "待办",
    nav_contacts: "联系人",
    nav_persona: "人格",
    nav_settings: "配置",
    drawer_nav: "导航",
    topbar_ttl: "会话 {value}",
  },
  ja: {
    ttl_unknown: "不明",
    ttl_invalid: "無効",
    ttl_expired: "期限切れ",
    ttl_min_left: "残り {m} 分",
    ttl_hour_left: "残り {h} 時間 {m} 分",
    ttl_day_left: "残り {d} 日 {h} 時間",

    login_required_password: "パスワードを入力してください",
    login_failed: "ログインに失敗しました",
    login_button: "ログイン",
    login_password_placeholder: "コンソールパスワード",

    dashboard_title: "概要",
    group_basic: "基本状態",
    group_model: "モデル設定",
    group_channels: "接続チャネル",
    group_runtime: "ランタイム指標",
    stat_version: "バージョン",
    stat_started: "起動時刻",
    stat_uptime: "稼働時間",
    stat_health: "ヘルス",
    stat_llm_provider: "LLM プロバイダー",
    stat_llm_model: "LLM モデル",
    stat_channels: "チャネル",
    stat_go_version: "Go バージョン",
    stat_goroutines: "Goroutine 数",
    stat_heap_alloc: "ヒープ確保量",
    stat_heap_sys: "ヒープシステム量",
    stat_heap_objects: "ヒープオブジェクト数",
    stat_gc_cycles: "GC 回数",

    tasks_title: "タスク",
    status_all: "すべて",
    status_queued: "キュー中",
    status_running: "実行中",
    status_pending: "承認待ち",
    status_done: "完了",
    status_failed: "失敗",
    status_canceled: "キャンセル",
    placeholder_status: "状態",
    placeholder_limit: "件数",
    no_tasks: "タスクなし",
    task_detail: "詳細",
    task_detail_title: "タスク詳細",
    audit_title: "監査",
    audit_file: "監査ファイル",
    audit_window_bytes: "ウィンドウ bytes",
    audit_latest: "最新",
    audit_newer: "新しい側",
    audit_older: "古い側",
    audit_path: "パス",
    audit_size: "サイズ",
    audit_range: "範囲",
    audit_empty: "このウィンドウには監査記録がありません",
    audit_no_file: "監査ログファイルが見つかりません",
    audit_time: "時刻",
    audit_decision: "判定",
    audit_risk: "リスク",
    audit_action: "アクション",
    audit_tool: "ツール",
    audit_run: "Run",
    audit_step: "ステップ",
    audit_actor: "実行者",
    audit_approval: "承認",
    audit_reasons: "理由",
    audit_summary: "要約",
    audit_raw: "Raw",
    audit_decision_allow: "許可",
    audit_decision_redact: "許可+マスク",
    audit_decision_require_approval: "承認が必要",
    audit_decision_deny: "拒否",
    audit_risk_low: "低",
    audit_risk_medium: "中",
    audit_risk_high: "高",
    audit_risk_critical: "重大",

    contacts_title: "連絡先",
    todo_title: "TODO",
    persona_title: "ペルソナ",
    settings_title: "システム",
    placeholder_select_file: "ファイルを選択",
    placeholder_audit_file: "監査ファイルを選択",

    action_save: "保存",
    action_back: "戻る",
    action_refresh: "更新",
    action_logout: "ログアウト",

    msg_load_failed: "読み込みに失敗しました",
    msg_read_failed: "読み取りに失敗しました",
    msg_save_failed: "保存に失敗しました",
    msg_save_success: "保存しました",
    msg_file_missing_create: "ファイルがありません。編集して保存すると作成されます。",
    status_pass: "PASS",
    status_fail: "FAIL",

    nav_overview: "概要",
    nav_tasks: "タスク",
    nav_audit: "監査",
    nav_todo: "TODO",
    nav_contacts: "連絡先",
    nav_persona: "ペルソナ",
    nav_settings: "設定",
    drawer_nav: "ナビゲーション",
    topbar_ttl: "TTL {value}",
  },
};

const localeState = reactive({
  lang: "en",
});

function normalizeLang(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value.startsWith("zh")) {
    return "zh";
  }
  if (value.startsWith("ja")) {
    return "ja";
  }
  return "en";
}

function translate(key, vars = null) {
  const dict = I18N[localeState.lang] || I18N.en;
  let text = dict[key] || I18N.en[key] || key;
  if (!vars || typeof vars !== "object") {
    return text;
  }
  for (const [k, v] of Object.entries(vars)) {
    text = text.replaceAll(`{${k}}`, String(v));
  }
  return text;
}

function currentLocale() {
  switch (localeState.lang) {
    case "zh":
      return "zh-CN";
    case "ja":
      return "ja-JP";
    default:
      return "en-US";
  }
}

function setLanguage(lang) {
  const next = normalizeLang(lang);
  localeState.lang = next;
  localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
}

function applyLanguageChange(item) {
  if (item && typeof item === "object" && "value" in item) {
    setLanguage(item.value);
    return;
  }
  setLanguage(item);
}

function hydrateLanguage() {
  const fromStorage = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  if (fromStorage) {
    localeState.lang = normalizeLang(fromStorage);
    return;
  }
  localeState.lang = normalizeLang(navigator.language || "");
  localStorage.setItem(LANGUAGE_STORAGE_KEY, localeState.lang);
}

const TASK_STATUS_META = [
  { titleKey: "status_all", value: "" },
  { titleKey: "status_queued", value: "queued" },
  { titleKey: "status_running", value: "running" },
  { titleKey: "status_pending", value: "pending" },
  { titleKey: "status_done", value: "done" },
  { titleKey: "status_failed", value: "failed" },
  { titleKey: "status_canceled", value: "canceled" },
];

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
    cache: "no-store",
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
  return d.toLocaleString(currentLocale());
}

function formatRemainingUntil(ts) {
  if (!ts) {
    return translate("ttl_unknown");
  }
  const ms = new Date(ts).getTime() - Date.now();
  if (!Number.isFinite(ms)) {
    return translate("ttl_invalid");
  }
  if (ms <= 0) {
    return translate("ttl_expired");
  }
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 60) {
    return translate("ttl_min_left", { m: totalMinutes });
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) {
    return translate("ttl_hour_left", { h: hours, m: minutes });
  }
  const days = Math.floor(hours / 24);
  const hourPart = hours % 24;
  return translate("ttl_day_left", { d: days, h: hourPart });
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
    const t = translate;
    const lang = computed(() => localeState.lang);
    const password = ref("");
    const busy = ref(false);
    const err = ref("");

    async function submit() {
      if (!password.value.trim()) {
        err.value = t("login_required_password");
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
        err.value = e.message || t("login_failed");
      } finally {
        busy.value = false;
      }
    }

    return { t, lang, password, busy, err, submit, onLanguageChange: applyLanguageChange };
  },
  template: `
    <section class="login-box">
      <h1 class="login-title">Mistermorph Console</h1>
      <div class="login-language">
        <QLanguageSelector :lang="lang" :presist="true" @change="onLanguageChange" />
      </div>
      <div class="stack">
        <QInput
          v-model="password"
          inputType="password"
          :placeholder="t('login_password_placeholder')"
          :disabled="busy"
        />
        <QButton :loading="busy" class="primary" @click="submit">{{ t("login_button") }}</QButton>
        <QFence v-if="err" type="danger" icon="QIconCloseCircle" :text="err" />
      </div>
    </section>
  `,
};

const DashboardView = {
  setup() {
    const t = translate;
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
        err.value = e.message || t("msg_load_failed");
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
    return { t, err, loading, overview, formatTime, formatBytes };
  },
  template: `
    <section>
      <h2 class="title">{{ t("dashboard_title") }}</h2>
      <QProgress v-if="loading" :infinite="true" />
      <QFence v-if="err" type="danger" icon="QIconCloseCircle" :text="err" />
      <div class="stat-groups">
        <section class="stat-group">
          <h3 class="stat-group-title">{{ t("group_basic") }}</h3>
          <div class="stat-list">
            <div class="stat-item">
              <span class="stat-key">{{ t("stat_version") }}</span>
              <code class="stat-value">{{ overview.version }}</code>
            </div>
            <div class="stat-item">
              <span class="stat-key">{{ t("stat_started") }}</span>
              <code class="stat-value">{{ formatTime(overview.started_at) }}</code>
            </div>
            <div class="stat-item">
              <span class="stat-key">{{ t("stat_uptime") }}</span>
              <code class="stat-value">{{ overview.uptime_sec }}s</code>
            </div>
            <div class="stat-item">
              <span class="stat-key">{{ t("stat_health") }}</span>
              <code class="stat-value">{{ overview.health }}</code>
            </div>
          </div>
        </section>
        <section class="stat-group">
          <h3 class="stat-group-title">{{ t("group_model") }}</h3>
          <div class="stat-list">
            <div class="stat-item">
              <span class="stat-key">{{ t("stat_llm_provider") }}</span>
              <code class="stat-value">{{ overview.llm_provider }}</code>
            </div>
            <div class="stat-item">
              <span class="stat-key">{{ t("stat_llm_model") }}</span>
              <code class="stat-value">{{ overview.llm_model }}</code>
            </div>
          </div>
        </section>
        <section class="stat-group">
          <h3 class="stat-group-title">{{ t("group_channels") }}</h3>
          <div class="stat-list">
            <div class="stat-item">
              <span class="stat-key">{{ t("stat_channels") }}</span>
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
          <h3 class="stat-group-title">{{ t("group_runtime") }}</h3>
          <div class="stat-list">
            <div class="stat-item">
              <span class="stat-key">{{ t("stat_go_version") }}</span>
              <code class="stat-value">{{ overview.runtime_go_version }}</code>
            </div>
            <div class="stat-item">
              <span class="stat-key">{{ t("stat_goroutines") }}</span>
              <code class="stat-value">{{ overview.runtime_goroutines }}</code>
            </div>
            <div class="stat-item">
              <span class="stat-key">{{ t("stat_heap_alloc") }}</span>
              <code class="stat-value">{{ formatBytes(overview.runtime_heap_alloc_bytes) }}</code>
            </div>
            <div class="stat-item">
              <span class="stat-key">{{ t("stat_heap_sys") }}</span>
              <code class="stat-value">{{ formatBytes(overview.runtime_heap_sys_bytes) }}</code>
            </div>
            <div class="stat-item">
              <span class="stat-key">{{ t("stat_heap_objects") }}</span>
              <code class="stat-value">{{ overview.runtime_heap_objects }}</code>
            </div>
            <div class="stat-item">
              <span class="stat-key">{{ t("stat_gc_cycles") }}</span>
              <code class="stat-value">{{ overview.runtime_gc_cycles }}</code>
            </div>
          </div>
        </section>
      </div>
    </section>
  `,
};

const TasksView = {
  setup() {
    const t = translate;
    const router = useRouter();
    const taskStatusItems = computed(() =>
      TASK_STATUS_META.map((item) => ({
        title: t(item.titleKey),
        value: item.value,
      }))
    );
    const statusValue = ref(TASK_STATUS_META[0].value);
    const statusItem = computed(() => {
      return taskStatusItems.value.find((item) => item.value === statusValue.value) || taskStatusItems.value[0] || null;
    });
    const limitText = ref("20");
    const items = ref([]);
    const err = ref("");
    const loading = ref(false);

    async function load() {
      loading.value = true;
      err.value = "";
      try {
        const q = new URLSearchParams();
        const v = statusValue.value || "";
        if (v) {
          q.set("status", v);
        }
        const limit = Math.max(1, Math.min(200, parseInt(limitText.value || "20", 10) || 20));
        q.set("limit", String(limit));
        const data = await apiFetch(`/tasks?${q.toString()}`);
        items.value = Array.isArray(data.items) ? data.items : [];
      } catch (e) {
        err.value = e.message || t("msg_load_failed");
      } finally {
        loading.value = false;
      }
    }

    function onStatusChange(item) {
      if (item && typeof item === "object") {
        statusValue.value = typeof item.value === "string" ? item.value : "";
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
    return { t, taskStatusItems, statusItem, limitText, items, err, loading, load, onStatusChange, openTask, summary };
  },
  template: `
    <section>
      <h2 class="title">{{ t("tasks_title") }}</h2>
      <div class="toolbar wrap">
        <div class="tool-item">
          <QDropdownMenu
            :items="taskStatusItems"
            :initialItem="statusItem"
            :placeholder="t('placeholder_status')"
            @change="onStatusChange"
          />
        </div>
        <div class="tool-item">
          <QInput v-model="limitText" inputType="number" :placeholder="t('placeholder_limit')" />
        </div>
        <QButton class="outlined" :loading="loading" @click="load">{{ t("action_refresh") }}</QButton>
      </div>
      <QProgress v-if="loading" :infinite="true" />
      <QFence v-if="err" type="danger" icon="QIconCloseCircle" :text="err" />
      <div class="stack">
        <div v-for="item in items" :key="item.id" class="task-row">
          <code class="task-line">{{ summary(item) }}</code>
          <QButton class="plain" @click="openTask(item.id)">{{ t("task_detail") }}</QButton>
        </div>
        <p v-if="items.length === 0 && !loading" class="muted">{{ t("no_tasks") }}</p>
      </div>
    </section>
  `,
};

const TaskDetailView = {
  setup() {
    const t = translate;
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
        err.value = e.message || t("msg_load_failed");
      } finally {
        loading.value = false;
      }
    }

    function back() {
      router.push("/tasks");
    }

    onMounted(load);
    return { t, loading, err, detailJSON, load, back };
  },
  template: `
    <section>
      <h2 class="title">{{ t("task_detail_title") }}</h2>
      <div class="toolbar">
        <QButton class="outlined" @click="back">{{ t("action_back") }}</QButton>
        <QButton class="plain" :loading="loading" @click="load">{{ t("action_refresh") }}</QButton>
      </div>
      <QProgress v-if="loading" :infinite="true" />
      <QFence v-if="err" type="danger" icon="QIconCloseCircle" :text="err" />
      <QTextarea :modelValue="detailJSON" :rows="20" :disabled="true" />
    </section>
  `,
};

const AuditView = {
  setup() {
    const t = translate;
    const loading = ref(false);
    const err = ref("");
    const fileItems = ref([]);
    const selectedFile = ref("");
    const pageBytesText = ref(String(128 * 1024));
    const lines = ref([]);
    const newerStack = ref([]);
    const meta = reactive({
      path: "",
      exists: false,
      size_bytes: 0,
      before: 0,
      from: 0,
      to: 0,
      has_older: false,
    });

    const selectedFileItem = computed(() => {
      return fileItems.value.find((item) => item.value === selectedFile.value) || fileItems.value[0] || null;
    });
    const canGoNewer = computed(() => newerStack.value.length > 0);
    const auditItems = computed(() => {
      return lines.value
        .map((line, idx) => parseAuditLine(line, idx))
        .reverse();
    });

    function normalizeAuditText(value, fallback = "-") {
      if (typeof value === "string") {
        const s = value.trim();
        return s === "" ? fallback : s;
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        return String(Math.trunc(value));
      }
      return fallback;
    }

    function normalizeAuditList(value) {
      if (!Array.isArray(value)) {
        return [];
      }
      return value
        .map((it) => {
          if (typeof it === "string") {
            return it.trim();
          }
          if (it === null || it === undefined) {
            return "";
          }
          return String(it).trim();
        })
        .filter((it) => it !== "");
    }

    function humanizeAuditToken(raw) {
      const text = normalizeAuditText(raw, "");
      if (!text) {
        return "-";
      }
      return text
        .replaceAll("_", " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
    }

    function decisionBadgeType(raw) {
      switch (String(raw || "").trim().toLowerCase()) {
        case "allow":
          return "success";
        case "allow_with_redaction":
          return "warning";
        case "require_approval":
          return "warning";
        case "deny":
          return "danger";
        default:
          return "default";
      }
    }

    function riskBadgeType(raw) {
      switch (String(raw || "").trim().toLowerCase()) {
        case "low":
          return "success";
        case "medium":
          return "warning";
        case "high":
          return "danger";
        case "critical":
          return "danger";
        default:
          return "default";
      }
    }

    function decisionLabel(raw) {
      switch (String(raw || "").trim().toLowerCase()) {
        case "allow":
          return t("audit_decision_allow");
        case "allow_with_redaction":
          return t("audit_decision_redact");
        case "require_approval":
          return t("audit_decision_require_approval");
        case "deny":
          return t("audit_decision_deny");
        default:
          return humanizeAuditToken(raw);
      }
    }

    function riskLabel(raw) {
      switch (String(raw || "").trim().toLowerCase()) {
        case "low":
          return t("audit_risk_low");
        case "medium":
          return t("audit_risk_medium");
        case "high":
          return t("audit_risk_high");
        case "critical":
          return t("audit_risk_critical");
        default:
          return humanizeAuditToken(raw);
      }
    }

    function parseAuditLine(line, idx) {
      const raw = typeof line === "string" ? line : String(line ?? "");
      const parsed = safeJSON(raw, null);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
          key: `${meta.from}-${idx}-raw`,
          parsed: false,
          raw,
        };
      }

      const eventID = normalizeAuditText(parsed.event_id);
      const tsRaw = normalizeAuditText(parsed.ts);
      const stepText = normalizeAuditText(parsed.step);
      const actionTypeRaw = normalizeAuditText(parsed.action_type);
      const toolName = normalizeAuditText(parsed.tool_name);
      const runID = normalizeAuditText(parsed.run_id);
      const actor = normalizeAuditText(parsed.actor);
      const approvalStatus = normalizeAuditText(parsed.approval_status);
      const summary = normalizeAuditText(parsed.action_summary_redacted);
      const reasons = normalizeAuditList(parsed.reasons);
      const reasonsText = reasons.length > 0 ? reasons.join(" | ") : "-";
      const decisionRaw = normalizeAuditText(parsed.decision, "");
      const riskRaw = normalizeAuditText(parsed.risk_level, "");

      return {
        key: `${meta.from}-${idx}-${eventID}`,
        parsed: true,
        eventID,
        tsText: tsRaw === "-" ? "-" : formatTime(tsRaw),
        actionType: humanizeAuditToken(actionTypeRaw),
        toolName,
        runID,
        stepText,
        actor,
        approvalStatus: humanizeAuditToken(approvalStatus),
        summary,
        reasonsText,
        decisionLabel: decisionLabel(decisionRaw),
        decisionType: decisionBadgeType(decisionRaw),
        riskLabel: riskLabel(riskRaw),
        riskType: riskBadgeType(riskRaw),
      };
    }

    function windowBytes() {
      const parsed = parseInt(pageBytesText.value || "", 10);
      if (!Number.isFinite(parsed)) {
        return 128 * 1024;
      }
      return Math.max(4 * 1024, Math.min(2 * 1024 * 1024, parsed));
    }

    async function loadFiles() {
      const data = await apiFetch("/audit/files");
      const items = Array.isArray(data.items) ? data.items : [];
      fileItems.value = items
        .map((it) => {
          const name = typeof it.name === "string" ? it.name.trim() : "";
          return {
            title: `${name} (${formatBytes(it.size_bytes)})`,
            value: name,
          };
        })
        .filter((it) => it.value !== "");

      const preferred = typeof data.default_file === "string" ? data.default_file.trim() : "";
      if (fileItems.value.length === 0) {
        selectedFile.value = preferred;
        return;
      }
      if (fileItems.value.find((it) => it.value === selectedFile.value)) {
        return;
      }
      if (preferred && fileItems.value.find((it) => it.value === preferred)) {
        selectedFile.value = preferred;
        return;
      }
      selectedFile.value = fileItems.value[0].value;
    }

    async function loadChunk(before = null, resetNewer = false) {
      loading.value = true;
      err.value = "";
      try {
        const q = new URLSearchParams();
        if (selectedFile.value) {
          q.set("file", selectedFile.value);
        }
        q.set("max_bytes", String(windowBytes()));
        if (before !== null && before >= 0) {
          q.set("before", String(before));
        }
        const data = await apiFetch(`/audit/logs?${q.toString()}`);
        meta.path = data.path || "";
        meta.exists = toBool(data.exists, false);
        meta.size_bytes = toInt(data.size_bytes, 0);
        meta.before = toInt(data.before, 0);
        meta.from = toInt(data.from, 0);
        meta.to = toInt(data.to, 0);
        meta.has_older = toBool(data.has_older, false);
        lines.value = Array.isArray(data.lines) ? data.lines : [];
        if (resetNewer) {
          newerStack.value = [];
        }
      } catch (e) {
        err.value = e.message || t("msg_load_failed");
      } finally {
        loading.value = false;
      }
    }

    async function refreshLatest() {
      await loadChunk(null, true);
    }

    async function older() {
      if (loading.value || !meta.has_older) {
        return;
      }
      newerStack.value.push(meta.to);
      await loadChunk(meta.from, false);
    }

    async function newer() {
      if (loading.value || newerStack.value.length === 0) {
        return;
      }
      const before = newerStack.value.pop();
      if (!Number.isFinite(before)) {
        return;
      }
      await loadChunk(before, false);
    }

    async function onFileChange(item) {
      if (!item || typeof item !== "object" || typeof item.value !== "string") {
        return;
      }
      selectedFile.value = item.value;
      await loadChunk(null, true);
    }

    async function init() {
      try {
        await loadFiles();
      } catch (e) {
        err.value = e.message || t("msg_load_failed");
      }
      await loadChunk(null, true);
    }

    onMounted(init);
    return {
      t,
      loading,
      err,
      fileItems,
      selectedFileItem,
      pageBytesText,
      auditItems,
      meta,
      canGoNewer,
      refreshLatest,
      older,
      newer,
      onFileChange,
      formatBytes,
    };
  },
  template: `
    <section>
      <h2 class="title">{{ t("audit_title") }}</h2>
      <div class="toolbar wrap">
        <div class="tool-item">
          <QDropdownMenu
            :items="fileItems"
            :initialItem="selectedFileItem"
            :placeholder="t('placeholder_audit_file')"
            @change="onFileChange"
          />
        </div>
        <div class="tool-item">
          <QInput v-model="pageBytesText" inputType="number" :placeholder="t('audit_window_bytes')" />
        </div>
        <QButton class="outlined" :loading="loading" @click="refreshLatest">{{ t("audit_latest") }}</QButton>
        <QButton class="plain" :disabled="!canGoNewer || loading" @click="newer">{{ t("audit_newer") }}</QButton>
        <QButton class="plain" :disabled="!meta.has_older || loading" @click="older">{{ t("audit_older") }}</QButton>
      </div>
      <QProgress v-if="loading" :infinite="true" />
      <QFence v-if="err" type="danger" icon="QIconCloseCircle" :text="err" />
      <div class="audit-meta">
        <code>{{ t("audit_path") }}: {{ meta.path || "-" }}</code>
        <code>{{ t("audit_size") }}: {{ formatBytes(meta.size_bytes) }}</code>
        <code>{{ t("audit_range") }}: {{ meta.from }} - {{ meta.to }}</code>
      </div>
      <div class="audit-list">
        <div v-for="item in auditItems" :key="item.key" class="audit-row">
          <template v-if="item.parsed">
            <div class="audit-item-head">
              <code class="audit-item-id">{{ item.eventID }}</code>
              <code class="audit-item-time">{{ t("audit_time") }}: {{ item.tsText }}</code>
              <QBadge :type="item.decisionType" size="sm" variant="filled">{{ item.decisionLabel }}</QBadge>
              <QBadge :type="item.riskType" size="sm" variant="filled">{{ item.riskLabel }}</QBadge>
            </div>
            <div class="audit-item-meta">
              <code>{{ t("audit_action") }}: {{ item.actionType }}</code>
              <code>{{ t("audit_tool") }}: {{ item.toolName }}</code>
              <code>{{ t("audit_run") }}: {{ item.runID }}</code>
              <code>{{ t("audit_step") }}: {{ item.stepText }}</code>
              <code v-if="item.approvalStatus !== '-'">{{ t("audit_approval") }}: {{ item.approvalStatus }}</code>
              <code v-if="item.actor !== '-'">{{ t("audit_actor") }}: {{ item.actor }}</code>
            </div>
            <code v-if="item.summary !== '-'" class="audit-summary">{{ t("audit_summary") }}: {{ item.summary }}</code>
            <code v-if="item.reasonsText !== '-'" class="audit-summary">{{ t("audit_reasons") }}: {{ item.reasonsText }}</code>
          </template>
          <template v-else>
            <div class="audit-item-head">
              <QBadge type="default" size="sm" variant="filled">{{ t("audit_raw") }}</QBadge>
            </div>
            <code class="audit-line">{{ item.raw }}</code>
          </template>
        </div>
        <p v-if="!loading && auditItems.length === 0" class="muted">{{ meta.exists ? t("audit_empty") : t("audit_no_file") }}</p>
      </div>
    </section>
  `,
};

const ContactsFilesView = {
  setup() {
    const t = translate;
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
        err.value = e.message || t("msg_read_failed");
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
        ok.value = t("msg_save_success");
      } catch (e) {
        err.value = e.message || t("msg_save_failed");
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
    return { t, loading, saving, err, ok, fileItems, selectedFile, content, onFileChange, save };
  },
  template: `
    <section>
      <h2 class="title">{{ t("contacts_title") }}</h2>
      <div class="toolbar wrap">
        <div class="tool-item">
          <QDropdownMenu
            :items="fileItems"
            :initialItem="selectedFile"
            :placeholder="t('placeholder_select_file')"
            @change="onFileChange"
          />
        </div>
        <QButton class="primary" :loading="saving" @click="save">{{ t("action_save") }}</QButton>
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
    const t = translate;
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
          ok.value = t("msg_file_missing_create");
          return;
        }
        err.value = e.message || t("msg_read_failed");
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
        ok.value = t("msg_save_success");
      } catch (e) {
        err.value = e.message || t("msg_save_failed");
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
    return { t, loading, saving, err, ok, fileItems, selectedFile, content, onFileChange, save };
  },
  template: `
    <section>
      <h2 class="title">{{ t("todo_title") }}</h2>
      <div class="toolbar wrap">
        <div class="tool-item">
          <QDropdownMenu
            :items="fileItems"
            :initialItem="selectedFile"
            :placeholder="t('placeholder_select_file')"
            @change="onFileChange"
          />
        </div>
        <QButton class="primary" :loading="saving" @click="save">{{ t("action_save") }}</QButton>
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
    const t = translate;
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
          ok.value = t("msg_file_missing_create");
          return;
        }
        err.value = e.message || t("msg_read_failed");
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
        ok.value = t("msg_save_success");
      } catch (e) {
        err.value = e.message || t("msg_save_failed");
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
    return { t, loading, saving, err, ok, fileItems, selectedFile, content, onFileChange, save };
  },
  template: `
    <section>
      <h2 class="title">{{ t("persona_title") }}</h2>
      <div class="toolbar wrap">
        <div class="tool-item">
          <QDropdownMenu
            :items="fileItems"
            :initialItem="selectedFile"
            :placeholder="t('placeholder_select_file')"
            @change="onFileChange"
          />
        </div>
        <QButton class="primary" :loading="saving" @click="save">{{ t("action_save") }}</QButton>
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
    const t = translate;
    const router = useRouter();
    const lang = computed(() => localeState.lang);
    const loading = ref(false);
    const loggingOut = ref(false);
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
        err.value = e.message || t("msg_load_failed");
      } finally {
        loading.value = false;
      }
    }

    function checkStatus(c) {
      return c && c.ok ? t("status_pass") : t("status_fail");
    }

    function checkClass(c) {
      return c && c.ok ? "check-status check-pass" : "check-status check-fail";
    }

    async function logout() {
      loggingOut.value = true;
      try {
        await apiFetch("/auth/logout", { method: "POST" });
      } catch {
        // ignore logout failure
      } finally {
        clearAuth();
        router.replace("/login");
        loggingOut.value = false;
      }
    }

    onMounted(load);
    return {
      t,
      lang,
      loading,
      loggingOut,
      err,
      configJSON,
      checks,
      load,
      logout,
      checkStatus,
      checkClass,
      onLanguageChange: applyLanguageChange,
    };
  },
  template: `
    <section>
      <h2 class="title">{{ t("settings_title") }}</h2>
      <div class="toolbar settings-toolbar">
        <div class="settings-toolbar-left">
          <QLanguageSelector :lang="lang" :presist="true" @change="onLanguageChange" />
        </div>
        <div class="settings-toolbar-right">
          <QButton class="outlined" :loading="loading" @click="load">{{ t("action_refresh") }}</QButton>
          <QButton class="danger" :loading="loggingOut" @click="logout">{{ t("action_logout") }}</QButton>
        </div>
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
  { path: "/audit", component: AuditView },
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

const NAV_ITEMS_META = [
  { id: "/dashboard", titleKey: "nav_overview" },
  { id: "/tasks", titleKey: "nav_tasks" },
  { id: "/audit", titleKey: "nav_audit" },
  { id: "/todo-files", titleKey: "nav_todo" },
  { id: "/contacts-files", titleKey: "nav_contacts" },
  { id: "/persona-files", titleKey: "nav_persona" },
  { id: "/settings", titleKey: "nav_settings" },
];

const App = {
  setup() {
    const t = translate;
    const router = useRouter();
    const route = useRoute();
    const inLogin = computed(() => route.path === "/login");
    const navItems = computed(() =>
      NAV_ITEMS_META.map((item) => ({
        id: item.id,
        title: t(item.titleKey),
      }))
    );
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
    const sessionText = computed(() => t("topbar_ttl", { value: sessionLabel.value }));

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
      t,
      inLogin,
      navItems,
      goTo,
      isActive,
      openMobileNav,
      closeMobileNav,
      authState,
      sessionLabel,
      sessionText,
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
            <span class="session-inline">{{ sessionText }}</span>
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
          :title="t('drawer_nav')"
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

hydrateLanguage();
hydrateAuth();

const app = createApp(App);
app.use(router);
app.use(QuailUI);
applyTheme("morph", false);
app.mount("#app");
