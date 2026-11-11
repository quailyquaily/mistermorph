// Settings (the Vue console's SettingsView): a list of sections beside the section's content on wide
// windows; on phones the list, then the section with a back button. Search across settings sits
// above the list. One save bar for the whole page; leaving a section with unsaved changes asks
// first. The sections are in ./sections, the state and requests in ./store.ts.
import type { InputRef, JSX, ScrollRef } from "nsh";
import { batch, cleanup, effect, Scroll, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton, Input } from "nsh/base";
import { endpointState } from "../../lib/core/context.js";
import { endpointRoutePath } from "../../lib/core/endpoint-routes.js";
import { buildSettingsSearchIndex, searchSettings } from "../../lib/core/settings-search.js";
import { previousLocation } from "../../lib/platform";
import { currentRoute, navigate, setLeaveGuard } from "../../lib/router";
import { isMobile } from "../../lib/shell";
import { onSystemBack } from "../../lib/systemBack";
import { createPaneStack } from "../../components/motion/PaneStack";
import { BackButton, confirm, Icon, type IconName, MessageDialog, Page, PageBar, PageTitle } from "../../components/ui";
import { IndexColumn } from "../../components/knowledge/parts";
import { createScrollEdges, createSlidingSelection, SCROLLBAR } from "../../components/motion";
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
import { ShortcutsPanel } from "../../components/settings/ShortcutsPanel";
import { SettingsCreditsPanel } from "../../components/settings/SettingsCreditsPanel";
import { MobileBarSpacer } from "../../components/frame/mobileBar";

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
  shortcuts: () => <ShortcutsPanel />,
  runtime: () => <RuntimePanel />,
  credits: () => <SettingsCreditsPanel />,
};

/** A row of the section list: icon and title; the list's sliding highlight marks the selected one. */
function SectionItem(props: {
  item: { id: string; icon: IconName; title: string };
  selected: boolean;
  mobile: boolean;
  onPress: () => void;
  onLayout: (event: { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } }) => void;
}) {
  const hovered = signal(false);
  return (
    <View onLayout={props.onLayout} onMouseEnter={() => hovered.set(true)} onMouseLeave={() => hovered.set(false)}>
    <BaseButton
      onPress={() => props.onPress()}
      accessibilityLabel={props.item.title}
      selected={props.selected}
      testID={`settings-section-${props.item.id}`}
      class={`flex-row items-center gap-2.5 rounded-(--radius) border border-transparent transition-colors duration-180 ${
        props.mobile ? "min-h-11 px-3 py-2.5" : "min-h-10 py-2 pl-3.5 pr-[13px]"
      } ${
        props.selected ? "hover:bg-blue/3" : "hover:bg-hover-soft"
      }`}
    >
      <Icon
        name={props.item.icon}
        size={18}
        color={props.selected ? "blue" : hovered() ? "subtle" : "muted-foreground"}
      />
      <Text class="flex-1 text-sm leading-[18.2px] tracking-tight text-foreground line-clamp-2">{props.item.title}</Text>
    </BaseButton>
    </View>
  );
}

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
  // On phones the sections (0) and a section (1) are levels of the page that slide (PaneStack).
  const panes = createPaneStack(() => (mobile() ? (mobilePanelVisible() ? 1 : 0) : null));
  // Android's Back from a section goes to the sections, as the bar's back arrow does. A section
  // opened from the sections also goes back to their address, so the next Back leaves Settings
  // instead of only changing the address under the same screen.
  // Set while that Back replaces the address with the sections': the route effect hides the
  // section in the same change that selects the address's own (Persona), so the section going
  // out keeps what it showed (panelKey) instead of turning into Persona as it slides.
  let backToIndex = false;
  onSystemBack(mobileShowBack, async () => {
    const indexPath = endpointRoutePath(endpointState.selectedRef, "/settings");
    if (previousLocation() === indexPath) {
      // Replacing with the previous entry removes this section from mobile history. Wait for
      // the leave guard and route to finish before hiding the editor; cancellation keeps it.
      backToIndex = true;
      try {
        await navigate(indexPath, { replace: true });
      } finally {
        backToIndex = false;
      }
      if (disposed || untracked(() => currentRoute().path) !== indexPath) return;
    }
    mobilePanelVisible.set(false);
  });
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
      batch(() => {
        s.selectedSectionID.set(id);
        if (backToIndex && !section) mobilePanelVisible.set(false);
      });
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
        reveal.mark(text);
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
  // The section list (SettingsView.css `.settings-index`, common.css `.workspace-sidebar-item`):
  // 40pt rows, an 18pt icon that turns blue on the selected row, and one soft highlight that
  // glides from row to row (the Vue list's v-sliding-selection) instead of each row lighting up.
  // The selected row is marked by the highlight alone: Vue's list keeps a dot for it but hides it.
  const sectionSelected = (id: string) => !mobile() && sectionID() === id;
  const selection = createSlidingSelection(() => (mobile() ? null : sectionID()));
  const searchFocused = signal(false);
  let searchInput: InputRef | undefined;
  // The section list is an index column as Todo's, Contacts' and Skills' are: the page's title in
  // its head (there is no bar over both columns), the search under it, then the sections.
  const index = () => (
    <IndexColumn
      title={t("settings_title")}
      fill={mobile()}
      style={panes.style(0)}
      hidden={panes.hidden(0)}
      testID="settings-index"
      search={
        <View
          class={`mx-4 mt-4 h-[34px] flex-row items-center gap-2 rounded-(--radius) border bg-card px-2.5 ${
            searchFocused() ? "border-subtle" : "border-line"
          }`}
        >
          <Icon name="PhMagnifyingGlass" size={14} color="muted-foreground" />
          <Input
            ref={(node: InputRef) => {
              searchInput = node;
            }}
            value={query()}
            onChange={({ value }) => query.set(value)}
            onSubmit={() => {
              const first = untracked(results)[0];
              if (first) void goToSetting(first);
            }}
            onKeyPress={({ key }) => {
              if (key === "Escape" && untracked(query)) query.set("");
            }}
            onFocus={() => searchFocused.set(true)}
            onBlur={() => searchFocused.set(false)}
            placeholder={t("settings_search_placeholder")}
            accessibilityLabel={t("settings_search_placeholder")}
            autoCapitalize="none"
            autoCorrect={false}
            testID="settings-search"
            class="flex-1 px-0.5 text-xs text-foreground placeholder:text-placeholder"
          />
          <If when={searching()}>
            <BaseButton
              onPress={() => {
                query.set("");
                searchInput?.focus();
              }}
              accessibilityLabel={t("audit_clear_filter")}
              class="size-4 items-center justify-center rounded-(--radius) hover:bg-blue/6"
            >
              <Icon name="PhX" size={11} color="subtle" />
            </BaseButton>
          </If>
        </View>
      }
    >
      <If
        when={searching()}
        else={
          <View class="relative gap-0.5">
            <selection.Highlight class="rounded-(--radius) bg-selection" />
            <Each of={s.settingsSections()} key={(item) => item.id}>
              {(item) => <SectionItem item={item()} selected={sectionSelected(item().id)} mobile={mobile()} onLayout={selection.track(item().id)} onPress={() => void selectSection(item().id)} />}
            </Each>
          </View>
        }
      >
        <View role="listbox" accessibilityLabel={t("settings_search_placeholder")} class="gap-0.5" testID="settings-search-results">
          <If when={results().length === 0}>
            <Text class="my-1 text-xs text-muted-foreground">{t("settings_search_empty")}</Text>
          </If>
          <Each of={results()} key={(entry) => entry.id}>
            {(entry) => (
              <BaseButton
                role="option"
                selected={activeResultID() === entry().id}
                onPress={() => void goToSetting(entry())}
                accessibilityLabel={entry().title}
                class={`gap-1 rounded-(--radius) border border-transparent py-2 pl-3.5 pr-[13px] transition-colors duration-180 hover:bg-hover-soft ${
                  activeResultID() === entry().id ? "bg-selection" : ""
                }`}
              >
                <Text class="text-sm leading-[15.1px] tracking-tight text-foreground line-clamp-2">{entry().title}</Text>
                <If when={searchWhere(entry())}>
                  <Text class={`text-xs leading-[16.8px] ${activeResultID() === entry().id ? "text-subtle" : "text-muted-foreground"}`}>
                    {searchWhere(entry())}
                  </Text>
                </If>
              </BaseButton>
            )}
          </Each>
        </View>
      </If>
    </IndexColumn>
  );

  const contentKey = () =>
    `${sectionID()}${s.agentSettingsUnsupported() && ["agent", "routes", "tools", "mcp"].includes(sectionID()) ? ":unsupported" : ""}`;
  // The section pane keeps its section while it slides out (Back may select another as it goes).
  const panelKey = panes.held(1, contentKey);
  // Its bar's title, kept the same way while the section slides out.
  const heldBarTitle = panes.held(1, () => s.selectedSection()?.title || t("settings_title"));

  // The section's own scroll (`.settings-panel-scroll`). On a desktop its cards are framed as a
  // detail card beside an index is (Contacts, Skills): 8pt from the top, the right and the bottom,
  // none at the left, where they meet the section list's column, whose rows then sit its 16pt
  // gutter from them as from the sidebar. On phones, 12pt both sides under the section's bar.
  // Hidden content at an edge fades out (v-scroll-edges).
  const panelEdges = createScrollEdges();
  const content = () => (
    <Scroll
      ref={(node: ScrollRef) => {
        scrollRef = node;
      }}
      onScroll={(event) => {
        scrollOffset = event.offset.y;
        panelEdges.handlers.onScroll(event);
      }}
      onLayout={panelEdges.handlers.onLayout}
      scrollEventThrottle={panelEdges.handlers.scrollEventThrottle}
      style={panelEdges.style()}
      class="flex-1"
      contentClass="grow"
      scrollbar={SCROLLBAR}
      testID="settings-panel"
    >
      <View
        onLayout={panelEdges.onContentLayout}
        class={`grow gap-4 ${mobile() ? "px-3 pt-4" : "pl-0 pr-2 pt-2"} ${s.saveBarVisible() ? "pb-[88px]" : mobile() ? "pb-4" : "pb-2"}`}
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
        <Each of={[panelKey()]} key={(id) => id}>
          {(key) =>
            untracked(() => {
              const [id, unsupported] = key().split(":");
              if (unsupported) return <UnsupportedSection s={s} />;
              return SECTIONS[id]?.(s, pane) ?? <View />;
            })
          }
        </Each>
      </View>
      <MobileBarSpacer />
    </Scroll>
  );

  return (
    <SettingsSaveRegistryContext.Provider value={s.saveRegistry}>
      <SettingsCanBrowsePaths.Provider value={() => s.canBrowsePaths()}>
        <SecretPicker.Provider value={{ enabled: () => s.secretRevealLocal() }}>
          <RevealContext.Provider value={reveal}>
            {/* No bar over both columns: the list's column has the page's title in its head, and on
                phones the section has a bar of its own, with Back (it slides with the section). */}
            <Page hideBar scroll={false} testID="settings-page">
              <View class="flex-1">
                <View class={`flex-1 flex-row ${mobile() ? "" : "gap-1"}`}>
                  {/* The list and the section meet with no gap (the section's cards are the list's
                      right edge); the side panes keep the workbench's 4pt gap. */}
                  <View class="flex-1 flex-row">
                    <If when={panes.shown(0, showIndexPane())}>{index()}</If>
                    <If when={panes.shown(1, showPanelPane())}>
                      <View
                        class="flex-1"
                        style={panes.style(1)}
                        accessibilityElementsHidden={panes.hidden(1) || undefined}
                        importantForAccessibility={panes.hidden(1) ? "no-hide-descendants" : undefined}
                      >
                        <If when={mobile()}>
                          <PageBar
                            leading={
                              <View class="flex-1 flex-row items-center gap-2">
                                <BackButton title={t("settings_title")} onPress={() => mobilePanelVisible.set(false)} testID="settings-back" />
                                <PageTitle text={heldBarTitle()} />
                              </View>
                            }
                          />
                        </If>
                        {content()}
                      </View>
                    </If>
                  </View>
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
