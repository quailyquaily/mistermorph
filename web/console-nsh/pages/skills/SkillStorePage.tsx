// The Morph Skill Store, under the Skills entry (web/console/src/views/SkillStoreView.js): a grid
// of the store's skills with search and tag filters. A card opens a side panel with the skill's
// details and SKILL.md (read from GitHub at the commit the store pins), and Install or Update, which
// start the same review in chat as Add skill. On a phone the panel slides in over the grid.
import { batch, computed, effect, keymap, LayoutAnimation, reduceMotion, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton, Sheet } from "nsh/base";
import { Blocks, gutterX, gutterY, Note, ROW_TRANSITION, SearchField, t, WorkspaceTitle } from "../../components/knowledge/parts";
import { EdgeScroll, MOTION_SLOW } from "../../components/motion";
import { Button, Icon, Page } from "../../components/ui";
import { endpointApiFetch, endpointState, formatBytes, runtimeApiFetchForEndpoint } from "../../lib/core/context.js";
import { endpointRoutePath } from "../../lib/core/endpoint-routes.js";
import {
  filterSkills,
  normalizeStoreSkill,
  skillInstallTask,
  storeSkillLinks,
  storeTags,
  stripFrontmatter,
} from "../../lib/core/skills-install.js";
import { currentRoute, locationOf, navigate } from "../../lib/router";
import { isMobile } from "../../lib/shell";
import { StoreSkillDetail, type StoreDoc, type StoreSkill } from "./StoreSkillDetail";

// How many tags a card shows; the panel shows them all.
const CARD_TAGS = 3;

function filesSummary(skill: StoreSkill) {
  return t(skill.fileCount === 1 ? "skills_files_summary_one" : "skills_files_summary", {
    count: skill.fileCount,
    size: formatBytes(skill.totalBytes),
  });
}

export function SkillStorePage() {
  const loading = signal(false);
  const error = signal("");
  const unsupported = signal(false);
  const loaded = signal(false);
  const skills = signal<StoreSkill[]>([]);
  const query = signal("");
  const tag = signal("");
  const doc = signal<StoreDoc>({ id: "", content: "", loading: false, failed: false });
  const installBusy = signal(false);
  const installErr = signal("");
  let seq = 0;
  let docSeq = 0;

  const tags = computed(() => storeTags(skills()) as string[]);
  const visible = () => {
    const byTag = tag() ? skills().filter((skill) => skill.tags.some((item) => item.toLowerCase() === tag())) : skills();
    return filterSkills(byTag, query()) as StoreSkill[];
  };
  const selectedID = () => String(currentRoute().query.skill || "").trim().toLowerCase();
  const selected = computed(() => skills().find((skill) => skill.id.toLowerCase() === selectedID()) || null);
  const selectedKey = computed(() => selected()?.id || "");
  const links = () => storeSkillLinks(selected()) as { folder: string; document: string };
  const documentSource = () => (doc().id === selected()?.id ? (stripFrontmatter(doc().content) as string) : "");

  // Opening or closing the panel narrows or widens the grid's column over 260 ms (Vue: the
  // grid-template-columns transition of .store-shell); switching skills changes nothing in size.
  function glidePanel(opening: boolean) {
    if (untracked(isMobile) || reduceMotion() || opening === Boolean(untracked(selected))) return;
    LayoutAnimation.configureNext({
      duration: MOTION_SLOW,
      create: { type: "easeOut", property: "opacity" },
      update: { type: "easeInEaseOut" },
      delete: { type: "easeOut", property: "opacity" },
    });
  }

  function open(skill: StoreSkill) {
    glidePanel(true);
    const route = untracked(() => currentRoute());
    void navigate(locationOf(route.path, { ...route.query, skill: skill.id }), { replace: true });
  }
  function close() {
    glidePanel(false);
    const route = untracked(() => currentRoute());
    void navigate(locationOf(route.path, { ...route.query, skill: undefined }), { replace: true });
  }
  const backToSkills = () => void navigate(endpointRoutePath(endpointState.selectedRef, "/skills"));
  const toggleTag = (value: string) => tag.update((current) => (current === value ? "" : value));

  async function load() {
    const current = ++seq;
    batch(() => {
      loading.set(true);
      error.set("");
    });
    try {
      const data = await endpointApiFetch(endpointState.selectedRef, "/settings/agent/skills/store");
      if (current !== seq) return;
      const repo = String(data?.repo || "");
      batch(() => {
        skills.set(
          (Array.isArray(data?.skills) ? data.skills : []).map((item: any) => normalizeStoreSkill(item, repo)).filter((skill: StoreSkill) => skill.id),
        );
        unsupported.set(false);
      });
    } catch (e: any) {
      if (current !== seq) return;
      console.warn("skill store:", e?.message);
      batch(() => {
        skills.set([]);
        unsupported.set(e?.status === 404);
        error.set(e?.status === 404 ? "" : t("skills_store_unavailable"));
      });
    } finally {
      if (current === seq) {
        batch(() => {
          loading.set(false);
          loaded.set(true);
        });
      }
    }
  }

  async function loadDoc(skill: StoreSkill | null) {
    const current = ++docSeq;
    const url = (storeSkillLinks(skill) as { document: string }).document;
    if (!skill || !url) {
      doc.set({ id: skill?.id || "", content: "", loading: false, failed: Boolean(skill) });
      return;
    }
    doc.set({ id: skill.id, content: "", loading: true, failed: false });
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(String(response.status));
      const content = await response.text();
      if (current === docSeq) doc.set({ id: skill.id, content, loading: false, failed: false });
    } catch (e: any) {
      console.warn("store SKILL.md:", url, e?.message);
      if (current === docSeq) doc.set({ id: skill.id, content: "", loading: false, failed: true });
    }
  }

  // Install and Update are a task in a new topic: the agent previews the store's pinned copy and
  // skill_install waits for the user's approval there.
  async function install(skill: StoreSkill | null, update = false) {
    const task = skillInstallTask(t, { storeID: skill?.id, name: skill?.name, update });
    if (!task || untracked(installBusy)) return;
    const endpointRef = endpointState.selectedRef;
    batch(() => {
      installBusy.set(true);
      installErr.set("");
    });
    try {
      const submitted = await runtimeApiFetchForEndpoint(endpointRef, "/tasks", { method: "POST", body: { task } });
      const topicID = String(submitted?.topic_id || "").trim();
      await navigate(endpointRoutePath(endpointRef, topicID ? `/chat/${encodeURIComponent(topicID)}` : "/chat"));
    } catch (e: any) {
      installErr.set(e?.message || t("skills_install_failed"));
    } finally {
      installBusy.set(false);
    }
  }

  // Installed skills open on the Skills page; a store install keeps the store id as its name.
  const openInstalled = (skill: StoreSkill) =>
    void navigate(locationOf(endpointRoutePath(endpointState.selectedRef, "/skills"), { skill: skill.id }));

  // Escape closes the panel: the page binds it beside the grid, and the sheet on a phone.

  effect(() => {
    void selectedKey();
    untracked(() => {
      installErr.set("");
      void loadDoc(selected());
    });
  });
  effect(() => {
    void endpointState.selectedRef;
    untracked(() => void load());
  });

  const detail = () => (
    <If when={selected()}>
      {(skill) => (
        <StoreSkillDetail
          skill={skill()}
          links={links()}
          doc={doc()}
          documentSource={documentSource()}
          filesSummary={filesSummary(skill())}
          installBusy={installBusy()}
          installErr={installErr()}
          onInstall={(update) => void install(skill(), update)}
          onOpenInstalled={() => openInstalled(skill())}
          onClose={close}
        />
      )}
    </If>
  );

  // The grid: as many 260pt columns as fit, 12pt apart, sharing the width (Vue: repeat(auto-fill,
  // minmax(260px, 1fr))); a flex wrap would stretch a lone last card across the row.
  const gridWidth = signal(0);
  const columns = () => Math.max(1, Math.floor((gridWidth() + 12) / (260 + 12)));
  // Floored to a whole point: a share that rounds up by a hair wraps the last card of a row.
  const cardWidth = () => (gridWidth() > 0 ? Math.floor((gridWidth() - 12 * (columns() - 1)) / columns()) : undefined);

  keymap.bind("escape", () => {
    if (!untracked(isMobile) && untracked(selected)) close();
  });

  return (
    <Page
      scroll={false}
      testID="store-page"
      leading={
        <View class="flex-row items-center gap-2">
          <BaseButton
            onPress={backToSkills}
            accessibilityLabel={t("skills_title")}
            testID="store-back"
            class="size-8 items-center justify-center rounded-(--radius) hover:bg-hover active:bg-press"
            style={ROW_TRANSITION}
          >
            <Icon name="PhArrowLeft" size={13} color="subtle" />
          </BaseButton>
          <WorkspaceTitle text={t("skills_store_title")} />
        </View>
      }
    >
      <View class="flex-1 flex-row" style={{ paddingLeft: gutterX(), paddingTop: gutterY(), paddingRight: isMobile() ? gutterX() : selected() ? 0 : gutterX() }}>
        <EdgeScroll class="flex-1" contentClass="gap-4" style={{ maxWidth: 1120 }}>
          <If when={skills().length}>
            <View class="gap-2.5">
              <SearchField
                value={query()}
                onChange={(value) => query.set(value)}
                placeholder={t("skills_store_search")}
                large
                testID="store-search"
                class="max-w-[420px]"
              />
              <If when={tags().length}>
                <View class="flex-row flex-wrap gap-1.5" accessibilityLabel={t("skills_fact_tags")}>
                  <TagChip label={t("skills_store_all")} active={!tag()} onPress={() => tag.set("")} />
                  <Each of={tags()}>{(item) => <TagChip label={item()} active={tag() === item()} onPress={() => toggleTag(item())} />}</Each>
                </View>
              </If>
            </View>
          </If>

          <If when={loading() && !skills().length}>
            <Blocks count={6} height={148} />
          </If>
          <If when={!(loading() && !skills().length)}>
            <If when={unsupported()}>
              <Note text={t("skills_store_unsupported")} />
            </If>
            <If when={!unsupported() && error()}>
              <View class="flex-row items-center gap-2" testID="store-error">
                <Text class="text-xs text-danger">{error()}</Text>
                <Button variant="plain" size="xs" label={t("skills_store_retry")} onPress={() => void load()} testID="store-retry" />
              </View>
            </If>
            <If when={!unsupported() && !error() && loaded() && !skills().length}>
              <Note text={t("skills_store_empty")} />
            </If>
            <If when={!unsupported() && !error() && loaded() && skills().length > 0 && !visible().length}>
              <Note text={t("skills_no_match")} />
            </If>
            <View testID="store-grid" class="flex-row flex-wrap gap-3 pb-6" onLayout={({ bounds }) => gridWidth.set(bounds.size.width)}>
              <Each of={unsupported() || error() ? [] : visible()} key={(skill) => skill.id}>
                {(skill) => (
                  <BaseButton
                    testID={`store-card:${skill().id}`}
                    accessibilityLabel={skill().name}
                    selected={selected()?.id === skill().id}
                    onPress={() => open(skill())}
                    class={`min-h-[148px] gap-2 rounded-(--radius) border bg-card px-4 py-3.5 hover:border-[#7092b5d8] ${
                      selected()?.id === skill().id ? "border-[#7092b5d8]" : "border-line"
                    }`}
                    style={{ width: cardWidth(), transitionProperty: "colors", transitionDuration: 120, transitionTimingFunction: "ease" }}
                  >
                    <View class="flex-row items-baseline justify-between gap-2">
                      <Text class="shrink text-base font-semibold text-foreground" style={{ numberOfLines: 1 }}>
                        {skill().name}
                      </Text>
                      <If when={skill().updateAvailable}>
                        <Text class="text-xs text-blue">{t("skills_update_available")}</Text>
                      </If>
                      <If when={!skill().updateAvailable && skill().installed}>
                        <Text class="text-xs text-muted-foreground">{t("skills_store_installed")}</Text>
                      </If>
                    </View>
                    <Text class="flex-1 text-xs leading-[23.2px] text-subtle" style={{ numberOfLines: 3 }}>
                      {skill().description}
                    </Text>
                    <View class="flex-row items-center justify-between gap-2">
                      <View class="flex-1 flex-row gap-1 overflow-hidden">
                        <Each of={skill().tags.slice(0, CARD_TAGS)}>
                          {(item) => (
                            <View class="rounded-(--radius) bg-light-2 px-1.5 py-px">
                              <Text class="text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>
                                {item()}
                              </Text>
                            </View>
                          )}
                        </Each>
                      </View>
                      <Text class="text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>
                        {`${skill().version ? `v${skill().version}` : ""}${skill().author ? ` · ${skill().author}` : ""}`}
                      </Text>
                    </View>
                  </BaseButton>
                )}
              </Each>
            </View>
          </If>
        </EdgeScroll>

        {/* The panel: a white sheet 440pt wide beside the grid, 4pt off it, fading in as the grid narrows. */}
        <If when={!isMobile() && selected()}>
          <View class="ml-1 w-[440px] pb-2 pl-2" accessibilityLabel={selected()?.name}>
            <View class="flex-1 overflow-hidden rounded-lg bg-card" style={{ boxShadow: "0 1px 4px rgba(24, 24, 50, 0.07)" }}>
              {detail()}
            </View>
          </View>
        </If>
      </View>

      {/* Phones: the panel slides in from the right over a mask (Vue: .store-panel-mobile). */}
      <Sheet
        open={isMobile() && Boolean(selected())}
        side="right"
        onOpenChange={({ open: next }) => {
          if (!next) close();
        }}
        backdropClass="bg-black/24"
        popupClass="h-full w-[92%] max-w-[440px] pb-1 pr-1 pt-1.5"
      >
        <View class="flex-1 overflow-hidden rounded-lg bg-card" style={{ boxShadow: "0 1px 4px rgba(24, 24, 50, 0.07)" }}>
          {detail()}
        </View>
      </Sheet>
    </Page>
  );
}

/** A tag filter: 26pt, a hairline that darkens on hover; the active one blue on a blue tint. */
function TagChip(props: { label: string; active: boolean; onPress: () => void }) {
  return (
    <BaseButton
      onPress={() => props.onPress()}
      selected={props.active}
      accessibilityLabel={props.label}
      testID={`store-tag:${props.label}`}
      class={`h-[26px] justify-center rounded-(--radius) border px-2.5 ${
        props.active ? "border-blue bg-blue/8" : "border-line hover:border-muted-foreground"
      }`}
      style={{ transitionProperty: "colors", transitionDuration: 120, transitionTimingFunction: "ease" }}
    >
      <Text class={`text-xs ${props.active ? "text-blue" : "text-subtle"}`} style={{ transitionProperty: "colors", transitionDuration: 120 }}>
        {props.label}
      </Text>
    </BaseButton>
  );
}
