// The agent's skills (web/console/src/views/SkillsView.js): an index column with search, the store
// and Add skill, and a card per skill (its name and "⋯" menu, its properties with the switch first,
// then SKILL.md). Add skill starts a chat task where the agent reviews the skill and the user
// approves the install. The store has its own page (SkillStorePage); here it only marks installed
// skills with updates. The Files row opens a read-only tree of the skill's folder; choosing a file
// shows it as plain text in place of SKILL.md until SKILL.md is chosen again.
import type { ScrollRef, ViewRef } from "nsh";
import { batch, computed, effect, keymap, Scroll, signal, Text, untracked, View, windowSize } from "nsh";
import { Button as BaseButton, Popover } from "nsh/base";
import { Button, DropdownMenu, Fab, Icon, MENU_POPUP, MENU_POPUP_STYLE, MENU_STARTING, MessageDialog, Modal, Page, TextField } from "../../components/ui";
import { createSlidingSelection, FadeText, SCROLLBAR } from "../../components/motion";
import { AppMarkdownEditor } from "../../components/shared/MarkdownEditor";
import { SkillFileTree } from "../../components/knowledge/SkillFileTree";
import { SkillDocument } from "../../components/knowledge/SkillDocument";
import {
  Blocks,
  DetailCard,
  HeadButton,
  IndexColumn,
  IndexRow,
  InlineNotice,
  LinkText,
  MobileBar,
  MonoLabel,
  MoreTrigger,
  Note,
  PropertyList,
  PropertyRow,
  PropertyText,
  ROW_TRANSITION,
  SearchField,
  SwitchOnly,
  t,
  TurnCaret,
} from "../../components/knowledge/parts";
import {
  endpointApiFetch,
  endpointState,
  formatBytes,
  runtimeApiFetchForEndpoint,
} from "../../lib/core/context.js";
import { endpointRoutePath } from "../../lib/core/endpoint-routes.js";
import {
  filterSkills,
  normalizeInstallLink,
  normalizeStoreSkill,
  skillInstallTask,
  skillSourceInfo,
  stripFrontmatter,
} from "../../lib/core/skills-install.js";
import { skillToggleSettings } from "../../lib/core/skills-load.js";
import { SKILL_DOC_PATH, skillFileURL, useSkillFilePreview } from "../../lib/core/skill-files.js";
import { openExternal } from "../../lib/platform";
import { currentRoute, locationOf, navigate } from "../../lib/router";
import { isMobile } from "../../lib/shell";
import { scrollIntoViewNearest } from "./scroll";

// Search appears once the list is long enough to need it.
const SEARCH_THRESHOLD = 8;

type SkillSource = ReturnType<typeof skillSourceInfo>;
export interface Skill {
  id: string;
  name: string;
  description: string;
  dir: string;
  loaded: boolean;
  requirements: string[];
  authProfiles: string[];
  files: { path: string; size?: number }[];
  filesCapped: boolean;
  source: SkillSource;
  modified: string[];
}
type StoreSkill = ReturnType<typeof normalizeStoreSkill>;
interface Catalog {
  enabled: boolean;
  load: string[];
  roots: string[];
  readOnly: boolean;
  readOnlyReason: string;
  revision: string;
  skills: Skill[];
}
interface Detail {
  content: string;
  truncated: boolean;
  revision: string;
}
type PreviewData = { path: string; name: string; size: number; kind: string; content: string; limit: number };
type PreviewState =
  | null
  | { status: "loading"; path: string }
  | { status: "ready"; path: string; data: PreviewData }
  | { status: "error"; path: string; error: string; message: string };

function normalizeSkill(item: any): Skill {
  return {
    id: String(item?.id || "").trim(),
    name: String(item?.name || item?.id || "").trim(),
    description: String(item?.description || "").trim(),
    dir: String(item?.dir || ""),
    loaded: item?.loaded === true,
    requirements: Array.isArray(item?.requirements) ? item.requirements : [],
    authProfiles: Array.isArray(item?.auth_profiles) ? item.auth_profiles : [],
    files: Array.isArray(item?.files) ? item.files : [],
    filesCapped: item?.files_capped === true,
    source: skillSourceInfo(item?.source),
    modified: Array.isArray(item?.modified) ? item.modified : [],
  };
}

function normalizeDetail(data: any): Detail {
  return {
    content: String(data?.content || ""),
    truncated: data?.content_truncated === true,
    revision: String(data?.revision || ""),
  };
}

// Only skills added from a link have a source worth showing.
function skillSourceText(skill: Skill | null) {
  const source = skill?.source;
  if (!source || source.kind === "local") return "";
  const where = source.repo || source.url;
  const at = source.commit ? ` @ ${source.commit.slice(0, 7)}` : "";
  const when = source.installedAt ? ` · ${source.installedAt.slice(0, 10)}` : "";
  return `${where}${at}${when}`;
}

function chatPath(endpointRef: string, topicID: string) {
  return endpointRoutePath(endpointRef, topicID ? `/chat/${encodeURIComponent(topicID)}` : "/chat");
}

const previewData = (state: PreviewState) => (state && state.status === "ready" ? state.data : null);

export function SkillsPage() {
  const loading = signal(false);
  const saving = signal(false);
  const err = signal("");
  const unsupported = signal(false);
  const catalog = signal<Catalog>({ enabled: true, load: [], roots: [], readOnly: false, readOnlyReason: "", revision: "", skills: [] });
  const detail = signal<Detail | null>(null);
  const detailLoading = signal(false);
  const filesExpanded = signal(false);
  const query = signal("");
  let listSeq = 0;
  let detailSeq = 0;

  // The file shown in place of SKILL.md ("" shows SKILL.md), read from the agent selected when it
  // was opened.
  const preview = useSkillFilePreview((id: string, path: string) => endpointApiFetch(endpointState.selectedRef, skillFileURL(id, path)));
  const viewPath = () => preview.path() as string;
  const filePreview = () => preview.state() as PreviewState;

  const removeTarget = signal<Skill | null>(null);
  const removeBusy = signal(false);
  const removeErr = signal("");
  const menuOpen = signal(false);

  const addOpen = signal(false);
  const addLink = signal("");
  const addBusy = signal(false);
  const addErr = signal("");

  // Editing replaces the whole SKILL.md, frontmatter included.
  const editing = signal(false);
  const draft = signal("");
  const editSaving = signal(false);
  const editErr = signal("");

  // The store, read in the background so skills installed from it can show updates.
  const storeSkills = signal<StoreSkill[]>([]);
  const installBusy = signal(false);
  let storeSeq = 0;

  const skills = () => catalog().skills;
  const showSearch = () => skills().length > SEARCH_THRESHOLD;
  const visibleSkills = () => (showSearch() ? (filterSkills(skills(), query()) as Skill[]) : skills());
  const selectedID = () => String(currentRoute().query.skill || "").trim();
  const selected = computed(() => {
    const id = selectedID().toLowerCase();
    return skills().find((skill) => skill.id.toLowerCase() === id) || null;
  });
  const selectedKey = computed(() => selected()?.id || "");

  // The newer store version of an installed skill, when it came from the store and has one.
  function updateFor(skill: Skill | null) {
    const id = skill?.source?.kind === "store" ? skill.source.storeID.toLowerCase() : "";
    const entry = id ? storeSkills().find((item) => item.id.toLowerCase() === id) : null;
    return entry?.updateAvailable ? entry : null;
  }
  const selectedUpdate = () => updateFor(selected());
  const locked = () => saving() || catalog().readOnly;
  const documentSource = () => stripFrontmatter(detail()?.content) as string;
  // A cut-off SKILL.md cannot be edited here: saving would drop its tail.
  const canEdit = () => Boolean(detail() && !detail()!.truncated && detail()!.revision && !locked());
  const draftChanged = () => editing() && draft() !== (detail()?.content || "");
  const skillsRoot = () => catalog().roots[0] || "~/.morph/skills";
  const addLinkValid = () => Boolean(normalizeInstallLink(addLink()));
  // Phones show the list or one skill; desktop shows both, as on TODO.
  const showIndex = () => !isMobile() || !selected();
  const showDetail = () => Boolean(selected());
  // Files fold into one line; SKILL.md is what the card is for.
  const filesSummary = () => {
    const files = selected()?.files || [];
    const bytes = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    return t(files.length === 1 ? "skills_files_summary_one" : "skills_files_summary", { count: files.length, size: formatBytes(bytes) });
  };
  const treeSelectedPath = () => viewPath() || SKILL_DOC_PATH;
  const filePreviewNote = () => {
    const state = filePreview();
    if (!state) return "";
    if (state.status === "error") {
      switch (state.error) {
        case "missing":
          return t("skills_file_missing");
        case "denied":
          return t("skills_file_denied");
        case "symlink":
          return t("skills_file_symlink");
        case "unsupported":
          return t("skills_files_unsupported");
        default:
          return state.message || t("skills_file_failed");
      }
    }
    const data = previewData(state);
    switch (data?.kind) {
      case "binary":
        return t("skills_file_binary");
      case "too_large":
        return t("skills_file_too_large", { size: formatBytes(data.size), limit: formatBytes(data.limit) });
      case "unsupported":
        return t("skills_file_unsupported");
      case "text":
        return data.content ? "" : t("skills_file_empty");
      default:
        return "";
    }
  };
  const documentSize = () => {
    const file = (selected()?.files || []).find((item) => item.path === "SKILL.md");
    return file ? formatBytes(file.size) : "";
  };
  // What the switch means for this skill: a $name reference in a task loads it either way.
  const enabledNote = () => {
    const skill = selected();
    if (!skill) return "";
    if (!catalog().enabled) return t("skills_enabled_note_all_off");
    return skill.loaded ? t("skills_enabled_note_on") : t("skills_enabled_note_off", { name: skill.name });
  };

  function setSkillQuery(id: string) {
    const route = untracked(() => currentRoute());
    void navigate(locationOf(route.path, { ...route.query, skill: id || undefined }), { replace: true });
  }
  const openSkill = (skill: Skill | null) => {
    if (skill) setSkillQuery(skill.id);
  };
  const closeSkill = () => setSkillQuery("");
  const isOn = (skill: Skill | null) => Boolean(skill?.loaded && catalog().enabled);

  async function load() {
    const seq = ++listSeq;
    const endpointRef = endpointState.selectedRef;
    loading.set(true);
    try {
      const data = await endpointApiFetch(endpointRef, "/settings/agent/skills");
      if (seq !== listSeq) return;
      batch(() => {
        unsupported.set(false);
        err.set("");
        catalog.set({
          enabled: data?.enabled !== false,
          load: Array.isArray(data?.load) ? data.load : [],
          roots: Array.isArray(data?.roots) ? data.roots : [],
          readOnly: data?.read_only === true,
          readOnlyReason: String(data?.read_only_reason || ""),
          revision: String(data?.config_revision || ""),
          skills: (Array.isArray(data?.skills) ? data.skills : []).map(normalizeSkill).filter((skill: Skill) => skill.id),
        });
      });
      const first = untracked(() => catalog().skills[0]);
      if (!untracked(isMobile) && first && !untracked(selected)) openSkill(first);
    } catch (e: any) {
      if (seq !== listSeq) return;
      if (e?.status === 404) {
        batch(() => {
          unsupported.set(true);
          catalog.update((value) => ({ ...value, skills: [] }));
        });
      } else {
        err.set(e?.message || t("msg_load_failed"));
      }
    } finally {
      if (seq === listSeq) loading.set(false);
    }
  }

  async function loadDetail(id: string) {
    const seq = ++detailSeq;
    if (!id) {
      detail.set(null);
      return;
    }
    detailLoading.set(true);
    try {
      const data = await endpointApiFetch(endpointState.selectedRef, `/settings/agent/skills/detail?id=${encodeURIComponent(id)}`);
      if (seq === detailSeq) detail.set(normalizeDetail(data));
    } catch (e: any) {
      if (seq === detailSeq) {
        batch(() => {
          detail.set(null);
          err.set(e?.message || t("msg_load_failed"));
        });
      }
    } finally {
      if (seq === detailSeq) detailLoading.set(false);
    }
  }

  // Back to SKILL.md; any preview still loading is dropped.
  const showDocument = () => preview.clear();

  // The detail pane scrolls; a file opened from the tree is brought into view.
  let detailScroll: ScrollRef | undefined;
  let docSection: ViewRef | undefined;
  let detailOffset = 0;
  let detailHeight = 0;

  function openFile(path: string) {
    const skill = untracked(selected);
    if (!skill || untracked(editing)) return;
    void preview.open(skill.id, path);
    if (untracked(viewPath)) {
      setTimeout(() => void scrollIntoViewNearest(detailScroll, docSection, detailOffset, detailHeight), 0);
    }
  }

  function startEdit() {
    if (!untracked(canEdit)) return;
    batch(() => {
      draft.set(untracked(detail)!.content);
      editErr.set("");
      editing.set(true);
    });
  }

  function cancelEdit() {
    if (!untracked(editSaving)) {
      batch(() => {
        editing.set(false);
        editErr.set("");
      });
    }
  }

  async function saveEdit() {
    const skill = untracked(selected);
    if (!skill || !untracked(editing) || untracked(editSaving)) return;
    editSaving.set(true);
    editErr.set("");
    try {
      const data = await endpointApiFetch(endpointState.selectedRef, "/settings/agent/skills/update", {
        method: "POST",
        body: { id: skill.id, content: untracked(draft), revision: untracked(detail)?.revision || "" },
      });
      batch(() => {
        detail.set(normalizeDetail(data));
        editing.set(false);
      });
      // The name, description and file size may have changed.
      await load();
    } catch (e: any) {
      editErr.set(e?.status === 404 ? t("skills_edit_unsupported") : e?.message || t("msg_save_failed"));
    } finally {
      editSaving.set(false);
    }
  }

  async function loadStore() {
    const seq = ++storeSeq;
    try {
      const data = await endpointApiFetch(endpointState.selectedRef, "/settings/agent/skills/store");
      if (seq === storeSeq) {
        const repo = String(data?.repo || "");
        storeSkills.set((Array.isArray(data?.skills) ? data.skills : []).map((item: any) => normalizeStoreSkill(item, repo)));
      }
    } catch (e: any) {
      // Without the store there are no updates to show; the store page reports why.
      console.warn("skills store:", e?.message);
      if (seq === storeSeq) storeSkills.set([]);
    }
  }

  // Switches save straight away through the agent settings update, then re-read the list so the
  // switches show the agent's own view.
  async function saveSkills(next: { enabled: boolean; load: string[] }) {
    if (untracked(locked)) return;
    saving.set(true);
    err.set("");
    try {
      await endpointApiFetch(endpointState.selectedRef, "/settings/agent", {
        method: "PUT",
        body: { config_revision: untracked(catalog).revision, skills: { enabled: next.enabled, load: next.load } },
      });
      await load();
    } catch (e: any) {
      err.set(e?.message || t("msg_save_failed"));
      await load();
    } finally {
      saving.set(false);
    }
  }

  const setEnabled = (value: boolean) => void saveSkills({ enabled: Boolean(value), load: untracked(catalog).load });
  const setLoaded = (skill: Skill, value: boolean) => {
    const now = untracked(catalog);
    void saveSkills(skillToggleSettings({ enabled: now.enabled, load: now.load }, now.skills, skill, Boolean(value)));
  };

  function askRemove(skill: Skill | null) {
    batch(() => {
      removeErr.set("");
      removeTarget.set(skill);
    });
  }
  function cancelRemove() {
    if (!untracked(removeBusy)) removeTarget.set(null);
  }
  const removeDialogText = () => {
    const skill = removeTarget();
    if (!skill) return "";
    const body = skill.source.kind === "local" ? t("skills_remove_body_local") : t("skills_remove_body");
    return removeErr() ? `${body}\n\n${removeErr()}` : body;
  };

  // Removing deletes the skill's folder on the agent; the load list drops its id.
  async function confirmRemove() {
    const skill = untracked(removeTarget);
    if (!skill || untracked(removeBusy)) return;
    removeBusy.set(true);
    removeErr.set("");
    try {
      await endpointApiFetch(endpointState.selectedRef, "/settings/agent/skills/remove", { method: "POST", body: { id: skill.id } });
      removeTarget.set(null);
      closeSkill();
      await load();
    } catch (e: any) {
      removeErr.set(e?.status === 404 ? t("skills_remove_unsupported") : e?.message || t("skills_remove_failed"));
    } finally {
      removeBusy.set(false);
    }
  }

  function openAdd() {
    batch(() => {
      addLink.set("");
      addErr.set("");
      addOpen.set(true);
    });
  }
  const closeAdd = () => {
    if (!untracked(addBusy)) addOpen.set(false);
  };

  // Adding is a task in a new topic: the agent previews the skill, explains it there, and
  // skill_install waits for the user's approval in that conversation.
  async function submitAdd() {
    if (!untracked(addLinkValid)) {
      addErr.set(t("skills_install_link_invalid"));
      return;
    }
    const task = skillInstallTask(t, { link: untracked(addLink) });
    if (!task || untracked(addBusy)) return;
    const endpointRef = endpointState.selectedRef;
    addBusy.set(true);
    addErr.set("");
    try {
      const submitted = await runtimeApiFetchForEndpoint(endpointRef, "/tasks", { method: "POST", body: { task } });
      const topicID = String(submitted?.topic_id || "").trim();
      addOpen.set(false);
      await navigate(chatPath(endpointRef, topicID));
    } catch (e: any) {
      addErr.set(e?.message || t("skills_install_failed"));
    } finally {
      addBusy.set(false);
    }
  }

  // Updating from the store is the same review in chat, replacing the installed copy.
  async function updateFromStore(entry: StoreSkill | null) {
    const task = skillInstallTask(t, { storeID: entry?.id, name: entry?.name, update: true });
    if (!task || untracked(installBusy)) return;
    const endpointRef = endpointState.selectedRef;
    installBusy.set(true);
    err.set("");
    try {
      const submitted = await runtimeApiFetchForEndpoint(endpointRef, "/tasks", { method: "POST", body: { task } });
      const topicID = String(submitted?.topic_id || "").trim();
      await navigate(chatPath(endpointRef, topicID));
    } catch (e: any) {
      err.set(e?.message || t("skills_install_failed"));
    } finally {
      installBusy.set(false);
    }
  }

  const openStore = () => void navigate(endpointRoutePath(endpointState.selectedRef, "/skills/store"));

  // Escape: menus and dialogs close themselves; the editor keeps its own Escape; on a phone an open
  // skill goes back to the list.
  keymap.bind("escape", () => {
    if (untracked(menuOpen)) {
      menuOpen.set(false);
    } else if (untracked(editing) || untracked(removeTarget) || untracked(addOpen)) {
      return;
    } else if (untracked(isMobile) && untracked(selected)) {
      closeSkill();
    }
  });

  // Another skill: files fold, SKILL.md shows, an edit is dropped, and the pane goes to its top.
  effect(() => {
    const id = selectedKey();
    untracked(() => {
      batch(() => {
        filesExpanded.set(false);
        editing.set(false);
        editErr.set("");
      });
      showDocument();
      detailScroll?.scrollTo({ y: 0, animated: false });
      void loadDetail(id);
    });
  });

  // The agent (the page is rebuilt for another one, so this is mostly the first load).
  effect(() => {
    void endpointState.selectedRef;
    untracked(() => {
      batch(() => {
        editing.set(false);
        detail.set(null);
        storeSkills.set([]);
      });
      showDocument();
      void load();
      void loadStore();
    });
  });

  const skillMenu = () => [
    {
      id: "remove",
      label: t("skills_remove"),
      disabled: catalog().readOnly || removeBusy(),
      onSelect: () => askRemove(untracked(selected)),
    },
  ];

  // The selected row's fill is one highlight that glides between rows (Vue: v-sliding-selection).
  const sliding = createSlidingSelection(() => (isMobile() ? null : selected()?.id || null));
  const NOTE_PAD = () => (isMobile() ? "px-4" : "-mt-2");
  const previewMaxHeight = () => Math.min(900, Math.max(320, windowSize().height * 0.7));

  const indexActions = (
    <>
      <HeadButton icon="PhStorefront" title={t("skills_store_browse")} disabled={unsupported()} onPress={openStore} testID="skills-store" />
      <If when={!isMobile()}>
        <HeadButton icon="PhPlus" title={t("skills_add")} disabled={unsupported()} onPress={openAdd} testID="skills-add" />
      </If>
      <Popover
        open={menuOpen()}
        onOpenChange={({ open }) => menuOpen.set(open)}
        placement="bottom"
        align="end"
        popupClass={`${MENU_POPUP} w-[280px]`}
        popupStyle={MENU_POPUP_STYLE}
        popupStartingClass={MENU_STARTING}
        popupEndingClass="opacity-0"
        trigger={
          <View
            role="button"
            accessibilityLabel={t("skills_more")}
            testID="skills-more"
            class={`size-9.5 items-center justify-center rounded-(--radius) hover:bg-hover active:bg-press ${menuOpen() ? "bg-hover" : ""}`}
            style={ROW_TRANSITION}
          >
            <Icon name="PhDotsThree" size={13} color="subtle" />
          </View>
        }
      >
        {/* One row holding the global switch, in the menu's frame: its title and note, the switch at the end. */}
        <View class="flex-row items-center justify-between gap-4 px-4 py-2">
          <View class="flex-1 gap-[3px]">
            <Text class="text-sm text-foreground">{t("skills_enabled")}</Text>
            <Text class="text-xs leading-[20.3px] text-muted-foreground">{t("skills_enabled_note")}</Text>
          </View>
          <SwitchOnly
            checked={catalog().enabled}
            disabled={locked() || unsupported()}
            label={t("skills_enabled")}
            onChange={(value) => setEnabled(value)}
            testID="skills-enabled"
          />
        </View>
      </Popover>
    </>
  );

  return (
    <Page hideBar scroll={false} testID="skills-page">
      <If when={isMobile() && showDetail()}>
        <MobileBar title={t("skills_title")} backLabel={t("action_back")} onBack={closeSkill} />
      </If>
      <View class="flex-1 flex-row">
        <If when={showIndex()}>
          <IndexColumn
            title={t("skills_title")}
            fill={isMobile()}
            actions={indexActions}
            headRight="none"
            testID="skills-index"
          >
            <If when={showSearch()}>
              <View class={`pb-2 ${isMobile() ? "px-4" : ""}`}>
                <SearchField value={query()} onChange={(value) => query.set(value)} placeholder={t("skills_search")} testID="skills-search" />
              </View>
            </If>
            <If
              when={!(loading() && !skills().length && !unsupported())}
              else={<Blocks count={3} height={52} class={isMobile() ? "px-4" : ""} />}
            >
              <If when={unsupported()}>
                <Note text={t("skills_unsupported")} class={NOTE_PAD()} />
              </If>
              <If when={!unsupported() && !skills().length}>
                <Note text={t("skills_empty_add_note", { path: skillsRoot() })} class={NOTE_PAD()} />
              </If>
              <If when={!unsupported() && skills().length > 0 && !visibleSkills().length}>
                <Note text={t("skills_no_match")} class={NOTE_PAD()} />
              </If>
              <sliding.Highlight class="rounded-(--radius) bg-selection" />
              <Each of={unsupported() ? [] : visibleSkills()} key={(skill) => skill.id}>
                {(skill) => (
                  <IndexRow
                    testID={`skill-row:${skill().id}`}
                    title={skill().name}
                    meta={skill().description}
                    metaLines={2}
                    active={!isMobile() && selected()?.id === skill().id}
                    sliding
                    onLayout={sliding.track(skill().id)}
                    onPress={() => openSkill(skill())}
                    trailing={
                      <View class="flex-row items-center gap-2.5">
                        <If when={updateFor(skill())}>
                          <Text class="text-xs text-blue">{t("skills_update_available")}</Text>
                        </If>
                        <View class="w-4 items-center" accessibilityLabel={isOn(skill()) ? t("skills_on") : t("skills_off")}>
                          <View
                            class={`size-[7px] rounded-[1px] border ${isOn(skill()) ? "border-blue bg-blue" : "border-status-off"}`}
                            style={ROW_TRANSITION}
                          />
                        </View>
                      </View>
                    }
                  />
                )}
              </Each>
            </If>
          </IndexColumn>
        </If>

        <If when={showDetail() || !isMobile()}>
          <Scroll
            ref={detailScroll}
            class="flex-1"
            scrollbar={SCROLLBAR}
            contentClass="grow"
            onScroll={(event) => {
              detailOffset = event.offset.y;
              detailHeight = event.size.height;
            }}
            onLayout={({ bounds }) => {
              detailHeight = bounds.size.height;
            }}
          >
            <If
              when={selected()}
              else={
                <If when={!isMobile() && !loading()}>
                  {/* No skill open: an Add skill tile in the middle of the column. */}
                  <View class="grow gap-3 px-4 py-6">
                    <If when={err()}>
                      <InlineNotice type="error" text={err()} testID="skills-error" />
                    </If>
                    <View class="flex-1 items-center justify-center gap-3">
                      {/* Buttons align themselves to the start; a wrapper as wide as each centres it. */}
                      <View>
                        <Button
                          variant="outlined"
                          size="md"
                          iconOnly
                          title={t("skills_add")}
                          disabled={unsupported()}
                          onPress={openAdd}
                          testID="skills-empty-add"
                        >
                          <Icon name="PhPlus" size={18} color="subtle" />
                        </Button>
                      </View>
                      <If when={!skills().length}>
                        <Note text={t("skills_empty_title")} />
                        <View>
                          <Button
                            variant="plain"
                            size="sm"
                            icon="PhStorefront"
                            label={t("skills_store_browse")}
                            disabled={unsupported()}
                            onPress={openStore}
                          />
                        </View>
                      </If>
                    </View>
                  </View>
                </If>
              }
            >
              {(skill) => (
                <DetailCard
                  testID="skill-detail"
                  title={skill().name}
                  class={isMobile() ? "mx-3 mt-2 mb-4" : "mb-2 ml-5 mr-2 mt-2"}
                  actions={<DropdownMenu items={skillMenu()} trigger={<MoreTrigger label={t("skills_more")} testID="skill-actions" />} />}
                >
                  <If when={skill().description}>
                    <View selectable>
                      <Text class="text-sm leading-[21.7px] text-subtle">{skill().description}</Text>
                    </View>
                  </If>
                  <If when={catalog().readOnly && catalog().readOnlyReason}>
                    <InlineNotice type="warning" text={catalog().readOnlyReason} />
                  </If>
                  <If when={err()}>
                    <InlineNotice type="error" text={err()} testID="skills-error" />
                  </If>
                  <If when={selectedUpdate()}>
                    {(entry) => (
                      <View class="flex-row flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-(--radius) border border-[#426f9e4d] bg-[#426f9e0f] px-2.5 py-2">
                        <Text class="text-xs text-subtle">{t("skills_update_note", { version: entry().version })}</Text>
                        <Button
                          variant="outlined"
                          size="xs"
                          label={t("skills_update_to", { version: entry().version })}
                          loading={installBusy()}
                          disabled={locked()}
                          onPress={() => void updateFromStore(entry())}
                          testID="skill-update"
                        />
                      </View>
                    )}
                  </If>
                  <If when={skill().modified.length}>
                    <View class="flex-row items-start gap-1.5">
                      <View class="pt-px">
                        <Icon name="PhWarning" size={14} color="danger" />
                      </View>
                      <Text class="flex-1 text-xs leading-[17.4px] text-danger">{t("skills_modified_since", { files: skill().modified.join(", ") })}</Text>
                    </View>
                  </If>

                  <PropertyList>
                    <PropertyRow label={t("skills_field_enabled")} center>
                      <View class="flex-row flex-wrap items-center gap-x-3 gap-y-2">
                        <SwitchOnly
                          checked={isOn(skill())}
                          disabled={locked()}
                          label={t("skills_load_toggle", { name: skill().name })}
                          onChange={(value) => setLoaded(skill(), value)}
                          testID="skill-loaded"
                        />
                        <Text class="text-xs leading-normal text-muted-foreground">{enabledNote()}</Text>
                      </View>
                    </PropertyRow>
                    <If when={skillSourceText(skill())}>
                      <PropertyRow label={t("skills_fact_source")}>
                        <If when={skill().source.url} else={<PropertyText text={skillSourceText(skill())} />}>
                          <LinkText text={skillSourceText(skill())} onPress={() => openExternal(skill().source.url)} testID="skill-source" />
                        </If>
                      </PropertyRow>
                    </If>
                    <PropertyRow label={t("skills_fact_location")}>
                      <PropertyText text={skill().dir} mono />
                    </PropertyRow>
                    <If when={skill().requirements.length}>
                      <PropertyRow label={t("skills_fact_requires")}>
                        <PropertyText text={skill().requirements.join(", ")} />
                      </PropertyRow>
                    </If>
                    <If when={skill().authProfiles.length}>
                      <PropertyRow label={t("skills_fact_auth")}>
                        <PropertyText text={skill().authProfiles.join(", ")} />
                      </PropertyRow>
                    </If>
                    <PropertyRow label={t("skills_fact_files")}>
                      <View class="gap-0">
                        <BaseButton
                          onPress={() => filesExpanded.update((open) => !open)}
                          selected={filesExpanded()}
                          accessibilityLabel={filesSummary()}
                          testID="skill-files-toggle"
                          class="group flex-row items-center gap-1.5 self-start"
                        >
                          <Text class="text-xs leading-normal text-subtle group-hover:text-foreground" style={ROW_TRANSITION}>
                            {filesSummary()}
                          </Text>
                          <TurnCaret open={filesExpanded()} />
                        </BaseButton>
                        <If when={filesExpanded()}>
                          <SkillFileTree
                            endpointRef={endpointState.selectedRef}
                            skillId={skill().id}
                            selectedPath={treeSelectedPath()}
                            disabled={editing()}
                            fallbackFiles={skill().files}
                            onSelect={(path) => openFile(path)}
                          />
                        </If>
                      </View>
                    </PropertyRow>
                  </PropertyList>

                  <View ref={docSection} class="gap-3 pt-1" testID="skill-doc">
                    <If
                      when={viewPath()}
                      else={
                        <View class="gap-3">
                          <View class="min-h-8 flex-row items-center gap-2.5">
                            <MonoLabel text="SKILL.md" />
                            <If when={documentSize()}>
                              <Text class="text-xs text-muted-foreground">{documentSize()}</Text>
                            </If>
                            <View class="flex-1" />
                            <If
                              when={editing()}
                              else={
                                <If when={detail()}>
                                  <Button
                                    variant="plain"
                                    size="xs"
                                    icon="PhPencilSimple"
                                    label={t("action_edit")}
                                    disabled={!canEdit()}
                                    title={detail()?.truncated ? t("skills_edit_truncated") : undefined}
                                    onPress={startEdit}
                                    testID="skill-edit"
                                  />
                                </If>
                              }
                            >
                              <View class="flex-row items-center gap-1.5">
                                <Button
                                  variant="plain"
                                  size="xs"
                                  label={t("action_cancel")}
                                  disabled={editSaving()}
                                  onPress={cancelEdit}
                                  testID="skill-edit-cancel"
                                />
                                <Button
                                  variant="primary"
                                  size="xs"
                                  label={t("action_save")}
                                  loading={editSaving()}
                                  disabled={!draftChanged()}
                                  onPress={() => void saveEdit()}
                                  testID="skill-edit-save"
                                />
                              </View>
                            </If>
                          </View>
                          <If when={detail()?.truncated}>
                            <InlineNotice type="warning" text={t("skills_content_truncated")} />
                          </If>
                          <If when={editErr()}>
                            <InlineNotice type="error" text={editErr()} testID="skill-edit-error" />
                          </If>
                          <If when={detailLoading() && !detail()}>
                            <Blocks count={1} height={120} />
                          </If>
                          <If when={!(detailLoading() && !detail()) && editing()}>
                            <AppMarkdownEditor
                              value={draft()}
                              onChange={(value) => draft.set(value)}
                              height="clamp(320px, 60vh, 760px)"
                              disabled={editSaving()}
                              accessibilityLabel="SKILL.md"
                              testID="skill-editor"
                            />
                          </If>
                          <If when={!(detailLoading() && !detail()) && !editing() && documentSource()}>
                            <SkillDocument source={documentSource()} onLinkPress={(url) => openExternal(url)} />
                          </If>
                        </View>
                      }
                    >
                      <View class="min-h-8 flex-row items-center gap-2.5">
                        <View class="shrink" selectable style={{ minWidth: 0 }}>
                          <FadeText text={viewPath()} fade={26} class="font-mono text-[11px] font-medium leading-[15.4px] text-muted-foreground" />
                        </View>
                        <If when={previewData(filePreview())}>
                          {(data) => <Text class="text-xs text-muted-foreground">{formatBytes(data().size)}</Text>}
                        </If>
                        <View class="flex-1" />
                        <Button
                          variant="plain"
                          size="xs"
                          icon="PhArrowLeft"
                          label="SKILL.md"
                          title={t("skills_file_back")}
                          onPress={showDocument}
                          testID="skill-file-back"
                        />
                      </View>
                      <If when={filePreview()?.status === "loading"}>
                        <Blocks count={1} height={120} label={t("skills_files_loading")} />
                      </If>
                      <If when={filePreview()?.status === "error"}>
                        <InlineNotice type="error" text={filePreviewNote()} testID="skill-file-error" />
                      </If>
                      <If when={filePreview()?.status === "ready" && filePreviewNote()}>
                        <Note text={filePreviewNote()} testID="skill-file-note" />
                      </If>
                      <If when={filePreview()?.status === "ready" && !filePreviewNote()}>
                        {/* Plain text, never HTML or rendered Markdown: 14pt mono on the paper, scrolling past 70% of the window. */}
                        <Scroll
                          scrollbar={SCROLLBAR}
                          class="grow-0 rounded-(--radius) border border-line-soft bg-background"
                          style={{ maxHeight: previewMaxHeight(), flexGrow: 0 }}
                          contentClass="px-3.5 py-3"
                        >
                          <View selectable accessibilityLabel={viewPath()} testID="skill-file-preview">
                            <Text class="font-mono text-sm leading-[21.7px] text-foreground">{previewData(filePreview())?.content ?? ""}</Text>
                          </View>
                        </Scroll>
                      </If>
                    </If>
                  </View>
                </DetailCard>
              )}
            </If>
          </Scroll>
        </If>
      </View>
      <If when={isMobile() && showIndex()}>
        <Fab icon="PhPlus" label={t("skills_add")} disabled={unsupported()} onPress={openAdd} testID="skills-fab" />
      </If>

      <MessageDialog
        open={Boolean(removeTarget())}
        onClose={cancelRemove}
        icon="PhTrash"
        tone="danger"
        title={removeTarget() ? t("skills_remove_title", { name: removeTarget()!.name }) : ""}
        text={removeDialogText()}
        testID="skills-remove-dialog"
        actions={[
          { id: "cancel", label: t("action_cancel"), variant: "outlined", disabled: removeBusy(), onPress: cancelRemove },
          { id: "remove", label: t("skills_remove"), variant: "danger", loading: removeBusy(), onPress: () => void confirmRemove() },
        ]}
      />
      <Modal
        open={addOpen()}
        onClose={closeAdd}
        title={t("skills_add_title")}
        closeLabel={t("action_close")}
        testID="skills-add-dialog"
        footer={
          <>
            <Button variant="outlined" label={t("action_cancel")} disabled={addBusy()} onPress={closeAdd} />
            <Button
              variant="primary"
              label={t("skills_add_start")}
              loading={addBusy()}
              disabled={!addLinkValid()}
              onPress={() => void submitAdd()}
              testID="skills-add-start"
            />
          </>
        }
      >
        <TextField
          value={addLink()}
          onChange={(value) => addLink.set(value)}
          onSubmit={() => void submitAdd()}
          placeholder={t("skills_install_link_placeholder")}
          accessibilityLabel={t("skills_add_title")}
          disabled={addBusy()}
          autoFocus
          keyboardType="url"
          testID="skills-add-link"
        />
        <Note text={t("skills_add_note")} />
        <If when={addErr()}>
          <InlineNotice type="error" text={addErr()} testID="skills-add-error" />
        </If>
      </Modal>
    </Page>
  );
}
