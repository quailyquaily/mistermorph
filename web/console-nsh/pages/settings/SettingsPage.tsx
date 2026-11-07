// Settings (the Vue console's SettingsView): a list of sections beside the section's content on wide
// windows; on phones the list, then the section with a back button. Search across settings sits
// above the list. One save bar for the whole page; leaving a section with unsaved changes asks
// first. The sections are in ./sections, the state and requests in ./store.ts.
import type { JSX, ScrollRef } from "nsh";
import { batch, cleanup, effect, Scroll, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { endpointState } from "../../lib/core/context.js";
import { endpointRoutePath } from "../../lib/core/endpoint-routes.js";
import { buildSettingsSearchIndex, searchSettings } from "../../lib/core/settings-search.js";
import { currentRoute, navigate, setLeaveGuard } from "../../lib/router";
import { isMobile } from "../../lib/shell";
import { Button, confirm, Icon, MessageDialog, Page, TextField } from "../../components/ui";
import { SettingsSaveRegistryContext } from "../../components/settings/ConfigSettingsPanel";
import { SettingsCanBrowsePaths } from "../../components/settings/SettingFields";
import { SecretPicker } from "../../components/settings/SecretInput";
import { createPaneTarget, PaneOutlet } from "../../components/settings/PaneTarget";
import { SettingsSaveBar, SettingsRestartBanner } from "../../components/settings-page/SaveBar";
import { createRevealRegistry, findRow, RevealContext } from "../../components/settings-page/reveal";
import { CHANNEL_ITEMS, SETTINGS_DEFAULT_SECTION_ID, SETTINGS_SECTION_IDS, TOOL_ITEMS } from "./constants";
import { t } from "./i18n";
import { createSettingsStore, type SettingsStore } from "./store";
import { SettingsDialogs } from "./SettingsDialogs";
import { PersonaSection } from "./sections/PersonaSection";
import { AgentSection, ProfilePane } from "./sections/AgentSection";
import { RoutesSection } from "./sections/RoutesSection";
import { ToolsSection } from "./sections/ToolsSection";
import { McpSection } from "./sections/McpSection";
import { ChannelPane, ChannelsSection } from "./sections/ChannelsSection";
import { SecuritySection } from "./sections/SecuritySection";
import { AutomationSection } from "./sections/AutomationSection";
import { SystemSection } from "./sections/SystemSection";
import { ConsoleSection } from "./sections/ConsoleSection";
import { UnsupportedSection } from "./sections/UnsupportedSection";
import { RuntimePanel } from "./RuntimePanel";
import { SettingsAppPanel } from "../../components/settings/SettingsAppPanel";
import { SettingsCreditsPanel } from "../../components/settings/SettingsCreditsPanel";

function routeSection() {
  const value = currentRoute()?.params?.section as unknown;
  const text = Array.isArray(value) ? value[0] : value;
  return String(text || "").trim();
}

export function normalizeSettingsSectionID(value: unknown) {
  // Running a channel inside Console moved from its own section into the channel's panel.
  const id = String(value || "").trim() === "runtimes" ? "channels" : String(value || "").trim();
  return SETTINGS_SECTION_IDS.has(id) ? id : SETTINGS_DEFAULT_SECTION_ID;
}

function settingsSectionPath(endpointRef: string, id: string) {
  const sectionID = normalizeSettingsSectionID(id);
  const pagePath = sectionID === SETTINGS_DEFAULT_SECTION_ID ? "/settings" : `/settings/${sectionID}`;
  return endpointRoutePath(endpointRef, pagePath);
}

const pathOf = (location: string) => String(location || "").split(/[?#]/)[0];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type PaneTargetValue = ReturnType<typeof createPaneTarget>;
const SECTIONS: Record<string, (s: SettingsStore, pane: PaneTargetValue) => JSX.Element> = {
  persona: (s) => <PersonaSection s={s} />,
  agent: (s) => <AgentSection s={s} />,
  routes: (s) => <RoutesSection s={s} />,
  tools: (s) => <ToolsSection s={s} />,
  mcp: (s, pane) => <McpSection s={s} pane={pane} />,
  channels: (s) => <ChannelsSection s={s} />,
  security: (s) => <SecuritySection s={s} />,
  automation: (s) => <AutomationSection s={s} />,
  system: (s) => <SystemSection s={s} />,
  console: (s, pane) => <ConsoleSection s={s} pane={pane} />,
  app: () => <SettingsAppPanel />,
  runtime: () => <RuntimePanel />,
  credits: () => <SettingsCreditsPanel />,
};

export function SettingsPage() {
  const s = createSettingsStore();
  const pane = createPaneTarget();
  const reveal = createRevealRegistry();
  let disposed = false;
  cleanup(() => {
    disposed = true;
    s.dispose();
  });

  const mobile = () => isMobile();
  const mobilePanelVisible = signal(false);
  const showIndexPane = () => !mobile() || !mobilePanelVisible();
  const showPanelPane = () => !mobile() || mobilePanelVisible();
  const mobileShowBack = () => mobile() && mobilePanelVisible();
  const barTitle = () => (mobileShowBack() ? s.selectedSection()?.title || t("settings_title") : t("settings_title"));
  const sectionID = () => s.selectedSection()?.id || "";

  /* --- the route decides the section --- */
  let previousRouteSection: string | undefined;
  effect(() => {
    const section = routeSection();
    untracked(() => {
      const id = normalizeSettingsSectionID(section);
      if (previousRouteSection !== undefined && normalizeSettingsSectionID(previousRouteSection) !== id) {
        s.discardSettingsDrafts();
      }
      previousRouteSection = section;
      s.selectedSectionID.set(id);
      s.ensureSettingsSectionData(id);
      if (section && section !== id) {
        void navigate(settingsSectionPath(endpointState.selectedRef, id), { replace: true });
      }
      if (mobile() && section) mobilePanelVisible.set(true);
    });
  });

  // A section the endpoint does not have (a remote agent has no Channels): the first one instead.
  effect(() => {
    const items = s.settingsSections();
    untracked(() => {
      if (items.some((item) => item.id === s.selectedSectionID())) return;
      const id = items[0]?.id || SETTINGS_DEFAULT_SECTION_ID;
      s.selectedSectionID.set(id);
      const nextPath = settingsSectionPath(endpointState.selectedRef, id);
      if (currentRoute().path !== nextPath) void navigate(nextPath, { replace: true });
      s.ensureSettingsSectionData(id);
    });
  });

  // A remote endpoint that turns out to be a console: load what its sections show.
  effect(() => {
    if (s.selectedEndpointIsConsole()) untracked(() => s.ensureSettingsSectionData(s.selectedSectionID()));
  });

  /* --- leaving with unsaved changes --- */
  async function guard(to: string) {
    if (disposed) return true;
    const units = untracked(s.sectionSaveUnits);
    if (units.length === 0 || untracked(s.sectionSaving) || pathOf(to) === untracked(() => currentRoute().path)) return true;
    return await confirm({
      title: t("settings_unsaved_title"),
      text: t("settings_unsaved_text", { items: units.map((unit) => unit.label).join(", ") }),
      confirmLabel: t("settings_unsaved_discard"),
      cancelLabel: t("settings_unsaved_stay"),
      danger: true,
    });
  }
  // A navigation that passes the guard removes it; put it back for the next one.
  effect(() => {
    currentRoute();
    untracked(() => setLeaveGuard(guard));
  });

  async function selectSection(id: string) {
    const sectionID = normalizeSettingsSectionID(id);
    const nextPath = settingsSectionPath(endpointState.selectedRef, sectionID);
    if (untracked(() => currentRoute().path) === nextPath) {
      batch(() => {
        s.selectedSectionID.set(sectionID);
        if (untracked(mobile)) mobilePanelVisible.set(true);
      });
      return;
    }
    // The route effect selects the section once navigation succeeds; the guard may cancel it, and
    // then the current section stays on screen.
    await navigate(nextPath);
    if (untracked(mobile) && untracked(() => currentRoute().path) === nextPath) mobilePanelVisible.set(true);
  }

  /* --- search --- */
  const query = signal("");
  const searchIndex = () =>
    (buildSettingsSearchIndex as any)(t, { sections: s.settingsSections(), channels: CHANNEL_ITEMS, tools: TOOL_ITEMS });
  const results = () => searchSettings(searchIndex(), query()) as any[];
  const searching = () => query().trim() !== "";
  const activeResultID = signal("");
  let scrollRef: ScrollRef | undefined;
  let scrollOffset = 0;
  let revealSeq = 0;

  function openSearchDialog(dialog: string) {
    if (dialog === "llm-advanced") s.openDefaultLLMAdvancedSettings();
    else if (dialog === "llm-context") s.openContextAdvancedSettings();
    else if (dialog.startsWith("tool:")) s.openToolAdvancedSettings(TOOL_ITEMS.find((item) => item.id === dialog.slice(5)));
    else if (dialog.startsWith("channel:")) s.openChannelAdvancedSettings(dialog.slice(8));
  }

  // A section's data loads after it opens, so its rows can appear a moment later.
  async function revealSetting(target: { text?: string; path?: string }) {
    const seq = ++revealSeq;
    const texts = [target.text, target.path].filter(Boolean) as string[];
    for (let attempt = 0; attempt < 40 && seq === revealSeq && !disposed; attempt += 1) {
      for (const text of texts) {
        const found = await findRow(reveal, text);
        if (!found || seq !== revealSeq) continue;
        const scroll = scrollRef ? await scrollRef.measure() : null;
        if (scrollRef && scroll) {
          const top = found.measured.pagePosition.y - scroll.pagePosition.y;
          const y = Math.max(0, scrollOffset + top - scroll.bounds.size.height / 2 + found.measured.bounds.size.height / 2);
          scrollRef.scrollTo({ y, animated: true });
        }
        reveal.marked.set(text);
        setTimeout(() => {
          if (untracked(reveal.marked) === text) reveal.marked.set("");
        }, 2000);
        return;
      }
      await sleep(50);
    }
  }

  async function goToSetting(entry: any) {
    const target = entry?.target;
    if (!target) return;
    activeResultID.set(entry.id);
    if (untracked(s.selectedSectionID) !== target.section || (untracked(mobile) && !untracked(mobilePanelVisible))) {
      await selectSection(target.section);
    }
    // The unsaved-changes guard may have kept the current section.
    if (untracked(s.selectedSectionID) !== normalizeSettingsSectionID(target.section)) return;
    if (target.channel && untracked(s.openChannel) !== target.channel) s.openChannel.set(target.channel);
    if (target.dialog) openSearchDialog(target.dialog);
    if (target.path || target.text) await revealSetting(target);
  }

  function searchWhere(entry: any) {
    const parts = [...(entry.where || [])];
    if (entry.path) parts.push(entry.path);
    return parts.join(" › ");
  }

  /* --- the frame --- */
  const sectionSelected = (id: string) => !mobile() && sectionID() === id;
  const index = () => (
    <View class={mobile() ? "flex-1" : "w-64 border-r border-line-faint"} testID="settings-index">
      <View class="px-3 pb-2 pt-3">
        <TextField
          value={query()}
          onChange={(value) => query.set(value)}
          onSubmit={() => {
            const first = untracked(results)[0];
            if (first) void goToSetting(first);
          }}
          onKeyPress={(key) => {
            if (key === "Escape" && untracked(query)) query.set("");
          }}
          leadingIcon="PhMagnifyingGlass"
          placeholder={t("settings_search_placeholder")}
          accessibilityLabel={t("settings_search_placeholder")}
          testID="settings-search"
        />
      </View>
      <Scroll class="flex-1" contentClass="gap-0.5 px-2 pb-4">
        <If
          when={searching()}
          else={
            <Each of={s.settingsSections()} key={(item) => item.id}>
              {(item) => (
                <BaseButton
                  onPress={() => void selectSection(item().id)}
                  accessibilityLabel={item().title}
                  selected={sectionSelected(item().id)}
                  testID={`settings-section-${item().id}`}
                  class={`flex-row items-center gap-2.5 rounded-(--radius) px-2.5 py-2 hover:bg-hover ${
                    sectionSelected(item().id) ? "bg-selection" : ""
                  }`}
                >
                  <Icon name={item().icon} size={16} color={sectionSelected(item().id) ? "foreground" : "muted-foreground"} />
                  <Text class={`flex-1 text-sm line-clamp-1 ${sectionSelected(item().id) ? "font-medium text-foreground" : "text-subtle"}`}>
                    {item().title}
                  </Text>
                  <If when={sectionSelected(item().id)}>
                    <View class="size-1.5 rounded-full bg-blue" />
                  </If>
                  <If when={mobile()}>
                    <Icon name="PhCaretRight" size={14} color="muted-foreground" />
                  </If>
                </BaseButton>
              )}
            </Each>
          }
        >
          <View role="listbox" accessibilityLabel={t("settings_search_placeholder")} class="gap-0.5" testID="settings-search-results">
            <If when={results().length === 0}>
              <Text class="px-2.5 py-2 text-sm text-muted-foreground">{t("settings_search_empty")}</Text>
            </If>
            <Each of={results()} key={(entry) => entry.id}>
              {(entry) => (
                <BaseButton
                  role="option"
                  selected={activeResultID() === entry().id}
                  onPress={() => void goToSetting(entry())}
                  accessibilityLabel={entry().title}
                  class={`gap-0.5 rounded-(--radius) px-2.5 py-2 hover:bg-hover ${activeResultID() === entry().id ? "bg-selection" : ""}`}
                >
                  <Text class="text-sm text-foreground line-clamp-1">{entry().title}</Text>
                  <If when={searchWhere(entry())}>
                    <Text class="text-xs text-muted-foreground line-clamp-1">{searchWhere(entry())}</Text>
                  </If>
                </BaseButton>
              )}
            </Each>
          </View>
        </If>
      </Scroll>
    </View>
  );

  const contentKey = () =>
    `${sectionID()}${s.agentSettingsUnsupported() && ["agent", "routes", "tools", "mcp"].includes(sectionID()) ? ":unsupported" : ""}`;

  const content = () => (
    <Scroll
      ref={(node: ScrollRef) => {
        scrollRef = node;
      }}
      onScroll={({ offset }) => {
        scrollOffset = offset.y;
      }}
      class="flex-1"
      contentClass="gap-5 p-5 pb-28"
      testID="settings-panel"
    >
      <SettingsRestartBanner
        pending={s.restartState.pending}
        busy={s.restartState.busy}
        restarting={s.restartState.restarting}
        tasksRunning={s.restartState.tasksRunning}
        error={s.restartState.error}
        onRestart={(force) => void s.restartProcess(force)}
        onCancelForce={() => {
          s.restartState.tasksRunning = false;
        }}
      />
      <Each of={[contentKey()]} key={(id) => id}>
        {(key) =>
          untracked(() => {
            const [id, unsupported] = key().split(":");
            if (unsupported) return <UnsupportedSection s={s} />;
            return SECTIONS[id]?.(s, pane) ?? <View />;
          })
        }
      </Each>
    </Scroll>
  );

  return (
    <SettingsSaveRegistryContext.Provider value={s.saveRegistry}>
      <SettingsCanBrowsePaths.Provider value={() => s.canBrowsePaths()}>
        <SecretPicker.Provider value={{ enabled: () => s.secretRevealLocal() }}>
          <RevealContext.Provider value={reveal}>
            <Page
              title={t("settings_title")}
              scroll={false}
              testID="settings-page"
              leading={
                <View class="flex-row items-center gap-2">
                  <If when={mobileShowBack()}>
                    <Button
                      variant="plain"
                      size="xs"
                      iconOnly
                      icon="PhArrowLeft"
                      title={t("settings_title")}
                      onPress={() => mobilePanelVisible.set(false)}
                      testID="settings-back"
                    />
                  </If>
                  <Text class="text-lg font-semibold text-foreground line-clamp-1" role="header">
                    {barTitle()}
                  </Text>
                </View>
              }
            >
              <View class="flex-1">
                <View class="flex-1 flex-row">
                  <If when={showIndexPane()}>{index()}</If>
                  <If when={showPanelPane()}>{content()}</If>
                  <If when={showPanelPane() && !mobile()}>
                    <PaneOutlet target={pane} />
                  </If>
                  <If when={showPanelPane() && sectionID() === "agent"}>
                    <ProfilePane s={s} sheet={mobile()} />
                  </If>
                  <If when={showPanelPane() && sectionID() === "channels"}>
                    <ChannelPane s={s} sheet={mobile()} />
                  </If>
                </View>
                <SettingsSaveBar
                  visible={s.saveBarVisible()}
                  items={s.sectionSaveUnits().map((unit) => unit.label)}
                  failed={s.sectionSaveFailed()}
                  saving={s.sectionSaving()}
                  busy={s.sectionSaveBusy()}
                  onSave={() => void s.saveSection()}
                  onDiscard={() => s.discardSection()}
                  overSheet={mobile() && Boolean(s.openChannel() || s.openedProfile())}
                />
              </View>
              <SettingsDialogs s={s} />
              <MessageDialog
                open={s.consoleEndpointErrorOpen()}
                onClose={() => s.consoleEndpointErrorOpen.set(false)}
                icon="PhXCircle"
                tone="danger"
                title={s.consoleEndpointErrorTitle()}
                text={s.consoleEndpointError()}
                actions={[{ id: "close", label: t("action_close"), variant: "primary", onPress: () => s.consoleEndpointErrorOpen.set(false) }]}
              />
            </Page>
          </RevealContext.Provider>
        </SecretPicker.Provider>
      </SettingsCanBrowsePaths.Provider>
    </SettingsSaveRegistryContext.Provider>
  );
}
