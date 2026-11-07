// WorkspaceDirPickerDialog browses the runtime's file system for a directory, and can create one
// (web/console/src/components/WorkspaceDirPickerDialog.js). It reports `onConfirm` with the chosen
// path; the caller decides what picking it means. In the desktop app, browsing the local agent,
// the native folder picker is offered too: what it picks becomes the selection.
import { batch, computed, effect, Image, List, signal, Text, untracked, View, windowSize } from "nsh";
import type { InputRef } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { runtimeApiFetch, runtimeApiFetchForEndpoint, endpointState, translate } from "../../lib/core/context.js";
import { CONSOLE_LOCAL_ENDPOINT_REF } from "../../lib/core/endpoints.js";
import { pushNotice } from "../../lib/core/notices.js";
import { loadRecentWorkspaceDirs, rememberRecentWorkspaceDir } from "../../lib/core/recent-workspace-dirs.js";
import { workspaceTreeIcon } from "../../lib/core/workspace-icons.js";
import { buildTreeRows, hasOwnTreePath, normalizeTreeItems } from "../../lib/core/workspace-tree.js";
import { hasFeature, isDesktop, pickDirectory } from "../../lib/platform";
import { isMobile } from "../../lib/shell";
import { createSlidingSelection, FadeText, SCROLLBAR } from "../motion";
import { Button, Modal, TextField, Tip, Toggle } from "../ui";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

export interface WorkspaceDirPickerDialogProps {
  /** Whether the dialog is open (the Vue `modelValue`). */
  open: boolean;
  /** The Vue `update:modelValue`: false when the dialog asks to close. */
  onOpenChange?: (open: boolean) => void;
  /** The Vue `close`. */
  onClose?: () => void;
  /** The Vue `confirm`: the chosen directory. */
  onConfirm?: (dir: string) => void;
  /** The runtime endpoint to browse. Empty means the currently selected endpoint. */
  endpointRef?: string;
  /** The directory selected when the dialog opens. */
  initialDir?: string;
  title?: string;
  confirmLabel?: string;
  /** True while the caller is acting on a confirmed directory. */
  confirming?: boolean;
  confirmDisabled?: boolean;
}

const SOURCE_RECENT = "recent";
const SOURCE_HOME = "home";
const SOURCE_SYSTEM = "system";
const SOURCE_STATE_DIR = "state_dir";
const SOURCE_CACHE_DIR = "cache_dir";

interface TreeEntry {
  name: string;
  path: string;
  is_dir: boolean;
  has_children: boolean;
}

interface TreeRow {
  key: string;
  depth: number;
  source?: string;
  entry: TreeEntry;
  expandable: boolean;
  expanded: boolean;
}

interface BrowserSource {
  id: string;
  kind: "recent" | "system" | "place" | "home";
  path: string;
  selection: string;
}

function text(value: unknown) {
  return String(value || "").trim();
}

function browserSource(sourceID: string, stateDir = "", cacheDir = ""): BrowserSource {
  const value = text(sourceID);
  if (value === SOURCE_RECENT) {
    return { id: SOURCE_RECENT, kind: "recent", path: "", selection: "" };
  }
  if (value === SOURCE_SYSTEM) {
    return { id: SOURCE_SYSTEM, kind: "system", path: "", selection: "" };
  }
  const statePath = text(stateDir);
  if (value === SOURCE_STATE_DIR && statePath) {
    return { id: SOURCE_STATE_DIR, kind: "place", path: statePath, selection: statePath };
  }
  const cachePath = text(cacheDir);
  if (value === SOURCE_CACHE_DIR && cachePath) {
    return { id: SOURCE_CACHE_DIR, kind: "place", path: cachePath, selection: cachePath };
  }
  return { id: SOURCE_HOME, kind: "home", path: "~", selection: "" };
}

function pathLabel(path: string) {
  const value = text(path);
  if (!value) {
    return "";
  }
  const normalized = value.replace(/[\\/]+$/u, "");
  if (!normalized) {
    return value;
  }
  const parts = normalized.split(/[\\/]/u).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : value;
}

export function WorkspaceDirPickerDialog(props: WorkspaceDirPickerDialogProps) {
  const items = signal<Record<string, TreeEntry[]>>({});
  const expanded = signal<Record<string, boolean>>({ "": true });
  const loading = signal(false);
  const loadingPath = signal("");
  const error = signal("");
  const sourceID = signal(SOURCE_HOME);
  const recentDirs = signal<string[]>(loadRecentWorkspaceDirs());
  const stateDir = signal("");
  const cacheDir = signal("");
  const selection = signal("");
  const showHidden = signal(false);
  const createOpen = signal(false);
  const createName = signal("");
  const creating = signal(false);
  const picking = signal(false);
  let createField: InputRef | undefined;

  const dialogTitle = () => props.title || t("chat_workspace_dialog_title");
  const dialogConfirmLabel = () => props.confirmLabel || t("chat_workspace_action_attach");
  const placeSourceItems = computed(() =>
    [
      { id: SOURCE_STATE_DIR, title: t("chat_workspace_dialog_state_dir"), path: stateDir() },
      { id: SOURCE_CACHE_DIR, title: t("chat_workspace_dialog_cache_dir"), path: cacheDir() },
    ].filter((item) => text(item.path) !== ""),
  );
  const currentSource = computed(() => browserSource(sourceID(), stateDir(), cacheDir()));
  const rows = computed<TreeRow[]>(() => {
    if (currentSource().kind === "recent") {
      return recentDirs().map((path) => ({
        key: `recent:${path}`,
        depth: 0,
        source: "recent",
        entry: { name: pathLabel(path), path, is_dir: true, has_children: false },
        expandable: false,
        expanded: false,
      }));
    }
    return buildTreeRows(items(), expanded(), currentSource().path) as TreeRow[];
  });
  const createParent = computed(() => {
    const selectedPath = text(selection());
    if (selectedPath) {
      return selectedPath;
    }
    const source = currentSource();
    if (source.kind === "home" || source.kind === "place") {
      return text(source.path);
    }
    return "";
  });
  const createDisabled = computed(() => loading() || Boolean(props.confirming) || creating() || !createParent());
  const createSubmitDisabled = computed(() => createDisabled() || !text(createName()));
  const confirmButtonDisabled = computed(
    () => Boolean(props.confirmDisabled) || Boolean(props.confirming) || creating() || text(selection()) === "",
  );
  const emptyText = () =>
    currentSource().kind === "recent" ? t("chat_workspace_dialog_recent_empty") : t("chat_workspace_dialog_empty");
  const effectiveEndpointRef = () => text(props.endpointRef) || text(endpointState.selectedRef);
  // The native picker chooses on this machine: only the desktop app's own agent sees those paths.
  const canPickNative = () =>
    isDesktop() && hasFeature("pickDirectory") && effectiveEndpointRef() === CONSOLE_LOCAL_ENDPOINT_REF;

  function fetchRuntime(pathname: string, options: Record<string, unknown> = {}) {
    const endpointRef = text(untracked(() => props.endpointRef));
    if (endpointRef) {
      return runtimeApiFetchForEndpoint(endpointRef, pathname, options);
    }
    return runtimeApiFetch(pathname, options);
  }

  function resetState() {
    batch(() => {
      items.set({});
      expanded.set({ "": true });
      loading.set(false);
      loadingPath.set("");
      error.set("");
      selection.set("");
      createOpen.set(false);
      createName.set("");
      creating.set(false);
    });
  }

  async function load(treePath = "") {
    const path = text(treePath);
    batch(() => {
      loading.set(true);
      loadingPath.set(path);
    });
    try {
      const query = new URLSearchParams();
      if (path) {
        query.set("path", path);
      }
      if (untracked(showHidden)) {
        query.set("show_hidden", "true");
      }
      const data = await fetchRuntime(query.toString() ? `/workspace/browse?${query.toString()}` : "/workspace/browse");
      batch(() => {
        stateDir.set(text(data?.state_dir));
        cacheDir.set(text(data?.cache_dir));
        items.update((map) => ({ ...map, [path]: normalizeTreeItems(data?.items) as TreeEntry[] }));
        if (path) {
          expanded.update((map) => ({ ...map, [path]: true }));
        }
        error.set("");
      });
      return true;
    } catch (e) {
      error.set(text((e as Error)?.message) || t("msg_load_failed"));
      return false;
    } finally {
      if (untracked(loadingPath) === path) {
        batch(() => {
          loading.set(false);
          loadingPath.set("");
        });
      }
    }
  }

  async function activateSource(nextSourceID: string) {
    const source = browserSource(nextSourceID, untracked(stateDir), untracked(cacheDir));
    sourceID.set(source.id);
    resetState();
    if (source.kind === "recent") {
      error.set("");
      return true;
    }
    const ok = await load(source.path);
    if (ok) {
      selection.set(source.selection);
    }
    return ok;
  }

  async function openBrowser() {
    batch(() => {
      recentDirs.set(loadRecentWorkspaceDirs());
      showHidden.set(false);
    });
    await activateSource(SOURCE_HOME);
    const selectedDir = text(untracked(() => props.initialDir));
    if (selectedDir) {
      selection.set(selectedDir);
    }
  }

  effect(() => {
    if (props.open) {
      untracked(() => void openBrowser());
    }
  });

  function close() {
    if (untracked(creating)) {
      return;
    }
    batch(() => {
      createOpen.set(false);
      createName.set("");
      error.set("");
    });
    props.onOpenChange?.(false);
    props.onClose?.();
  }

  async function setShowHidden(value: boolean) {
    const nextValue = Boolean(value);
    if (untracked(showHidden) === nextValue) {
      return;
    }
    showHidden.set(nextValue);
    const source = untracked(currentSource);
    if (!props.open || source.kind === "recent") {
      return;
    }
    resetState();
    const ok = await load(source.path);
    if (ok) {
      selection.set(source.selection);
    }
  }

  async function toggleNode(entry: TreeEntry) {
    const path = text(entry?.path);
    if (!entry?.is_dir || !path) {
      return;
    }
    if (untracked(expanded)[path]) {
      expanded.update((map) => {
        const next = { ...map };
        delete next[path];
        return next;
      });
      return;
    }
    if (!hasOwnTreePath(untracked(items), path)) {
      const ok = await load(path);
      if (!ok) {
        return;
      }
    }
    expanded.update((map) => ({ ...map, [path]: true }));
  }

  async function selectNode(row: TreeRow) {
    const entry = row?.entry;
    if (!entry?.is_dir) {
      return;
    }
    selection.set(text(entry.path));
    if (!row?.expandable || untracked(currentSource).kind === "recent") {
      return;
    }
    await toggleNode(entry);
  }

  function openCreate() {
    if (untracked(createDisabled)) {
      return;
    }
    batch(() => {
      createOpen.set(true);
      createName.set("");
    });
    setTimeout(() => createField?.focus(), 0);
  }

  function cancelCreate() {
    if (untracked(creating)) {
      return;
    }
    batch(() => {
      createOpen.set(false);
      createName.set("");
    });
  }

  async function createDir() {
    const parentPath = text(untracked(createParent));
    const name = text(untracked(createName));
    if (!parentPath || !name || untracked(creating)) {
      return;
    }
    const sourceKind = untracked(currentSource).kind;
    batch(() => {
      creating.set(true);
      error.set("");
    });
    try {
      const data = await fetchRuntime("/workspace/directory", {
        method: "POST",
        body: { parent_path: parentPath, name },
      });
      const createdPath = text(data?.path);
      if (!createdPath) {
        throw new Error(t("msg_save_failed"));
      }
      if (sourceKind === "recent") {
        recentDirs.set(rememberRecentWorkspaceDir(createdPath));
      } else {
        const refreshed = await load(parentPath);
        if (!refreshed) {
          return;
        }
      }
      batch(() => {
        selection.set(createdPath);
        createOpen.set(false);
        createName.set("");
      });
    } catch (e) {
      pushNotice({ type: "error", text: text((e as Error)?.message) || t("msg_save_failed") });
    } finally {
      creating.set(false);
    }
  }

  async function pickNative() {
    if (untracked(picking)) {
      return;
    }
    picking.set(true);
    try {
      const picked = text(await pickDirectory({ title: untracked(dialogTitle), current: untracked(selection) }));
      if (picked) {
        selection.set(picked);
      }
    } catch (e) {
      pushNotice({ type: "error", text: text((e as Error)?.message) || t("msg_load_failed") });
    } finally {
      picking.set(false);
    }
  }

  function confirm() {
    const dir = text(untracked(selection));
    if (!dir || untracked(confirmButtonDisabled)) {
      return;
    }
    props.onConfirm?.(dir);
  }

  // The places: workspace-sidebar items without a meta line (40pt, 14pt titles), the selected
  // one on the list's gliding highlight.
  const placeSelection = createSlidingSelection(() => sourceID());
  const SourceItem = (item: { id: string; title: string; path?: string }) => (
    <BaseButton
      onPress={() => void activateSource(item.id)}
      disabled={creating()}
      selected={sourceID() === item.id}
      accessibilityLabel={item.title}
      tooltip={item.path ? <Tip text={item.path} /> : undefined}
      testID={`workspace-source-${item.id}`}
      onLayout={placeSelection.track(item.id)}
      class={`min-h-10 justify-center rounded-(--radius) border border-transparent pb-2 pl-3.5 pr-[13px] pt-2 disabled:opacity-45 ${
        sourceID() === item.id ? "hover:bg-hover-faint" : "hover:bg-hover-soft"
      } ${isMobile() ? "min-w-37 max-w-60" : ""}`}
      // The hover fill comes in after 60ms and goes at once (calm hover).
      style={{ transitionProperty: "colors", transitionDuration: 180, transitionTimingFunction: "ease" }}
      hoverStyle={{ transitionDelay: 60 }}
    >
      <Text class="text-sm leading-[18.2px] tracking-[-0.35px] text-foreground" style={{ numberOfLines: 1 }}>
        {item.title}
      </Text>
    </BaseButton>
  );

  /** A small mono caps label (`.ui-kicker`). */
  const Kicker = (kicker: { text: string }) => (
    <Text class="font-mono text-xs font-medium uppercase tracking-[1.92px] text-muted-foreground" style={{ numberOfLines: 1 }}>
      {kicker.text}
    </Text>
  );

  // The picker is min(68vh, 560) tall in Vue with 12pt above and below; the Modal's body has 16.
  const pickerHeight = () => Math.min(windowSize().height * 0.68, 560) - 8;

  return (
    <Modal
      open={props.open}
      onClose={close}
      title={dialogTitle()}
      size="lg"
      scroll={false}
      testID="workspace-dir-picker"
      closeLabel={t("action_cancel")}
    >
      <View class="gap-4" style={{ height: pickerHeight() }}>
        <If when={error()}>
          <View class="rounded-(--radius) border-l-2 border-danger bg-paper px-3 py-2" role="alert">
            <Text class="text-sm text-danger">{error()}</Text>
          </View>
        </If>
        <View class="flex-1 gap-3.5">
          <View class={`flex-1 gap-3.5 ${isMobile() ? "" : "flex-row"}`}>
            <View class={isMobile() ? "gap-3" : "w-55 gap-2"}>
              <Kicker text={t("chat_workspace_dialog_places")} />
              <View class={`relative gap-0.5 ${isMobile() ? "flex-row flex-wrap gap-2" : ""}`}>
                <placeSelection.Highlight class="rounded-(--radius) bg-selection" />
                <SourceItem id={SOURCE_RECENT} title={t("chat_workspace_dialog_recent")} />
                <SourceItem id={SOURCE_HOME} title={t("chat_workspace_dialog_home")} />
                <SourceItem id={SOURCE_SYSTEM} title={t("chat_workspace_dialog_system")} />
                <Each of={placeSourceItems()} key={(item) => item.id}>
                  {(item) => <SourceItem id={item().id} title={item().title} path={item().path} />}
                </Each>
              </View>
            </View>

            <View class="flex-1">
              <View class="mb-2 min-h-8 flex-row items-center justify-between gap-2.5">
                <View class="flex-1 flex-row items-center gap-2">
                  <Kicker text={t("chat_workspace_dialog_create_in")} />
                  <FadeText
                    text={createParent() || t("chat_workspace_dialog_selection_empty")}
                    class="flex-1 font-mono text-xs leading-[16.8px] text-subtle"
                    testID="workspace-create-parent"
                  />
                </View>
                <If when={canPickNative()}>
                  <Button
                    variant="plain"
                    size="xs"
                    iconOnly
                    icon="PhFolderOpen"
                    title={t("todo_workspace_dir_browse")}
                    loading={picking()}
                    disabled={creating() || Boolean(props.confirming)}
                    testID="workspace-native-pick"
                    onPress={() => void pickNative()}
                  />
                </If>
                <Button
                  variant="plain"
                  size="xs"
                  icon="PhPlus"
                  label={t("chat_workspace_dialog_new_directory")}
                  disabled={createDisabled() || createOpen()}
                  testID="workspace-new-directory"
                  onPress={openCreate}
                />
              </View>

              <If when={createOpen()}>
                <View class={`mb-2 gap-2 ${isMobile() ? "" : "flex-row items-center"}`}>
                  <TextField
                    class="flex-1"
                    value={createName()}
                    placeholder={t("chat_workspace_dialog_directory_name")}
                    accessibilityLabel={t("chat_workspace_dialog_directory_name")}
                    disabled={creating()}
                    testID="workspace-directory-name"
                    inputRef={(node) => {
                      createField = node;
                    }}
                    onChange={(value) => createName.set(value)}
                    onSubmit={() => void createDir()}
                  />
                  <View class="flex-row items-center justify-end gap-2">
                    <Button variant="plain" size="sm" label={t("action_cancel")} disabled={creating()} onPress={cancelCreate} />
                    <Button
                      variant="primary"
                      size="sm"
                      label={t("chat_workspace_dialog_create_directory")}
                      loading={creating()}
                      disabled={createSubmitDisabled()}
                      testID="workspace-create-directory"
                      onPress={() => void createDir()}
                    />
                  </View>
                </View>
              </If>

              {/* The browser (`.workspace-picker-browser`): a soft hairline on paper. */}
              <View class="flex-1 overflow-hidden rounded-(--radius) border border-line-soft/85 bg-paper">
                <If
                  when={!(loading() && rows().length === 0)}
                  else={<Text class="p-3.5 text-sm leading-[20.3px] text-muted-foreground">{t("chat_workspace_dialog_loading")}</Text>}
                >
                  <List
                    each={rows()}
                    keyExtractor={(row) => `browser:${row.key}`}
                    class="flex-1"
                    contentClass="gap-0.5 p-1.5"
                    scrollbar={SCROLLBAR}
                    testID="workspace-tree"
                    empty={<Text class="p-3.5 text-sm leading-[20.3px] text-muted-foreground">{emptyText()}</Text>}
                  >
                    {(row) => (
                      <View style={{ paddingLeft: row().depth * 14 }}>
                        <BaseButton
                          onPress={() => void selectNode(row())}
                          disabled={!row().entry.is_dir || creating()}
                          selected={selection() === text(row().entry.path)}
                          accessibilityLabel={row().entry.path}
                          tooltip={<Tip text={row().entry.path} />}
                          testID={`workspace-row-${row().entry.path}`}
                          // `.chat-workspace-tree-entry`: a quiet row that takes a hairline and the
                          // plain hover fill; the chosen one a firmer line on a faint ink tint.
                          class={`flex-row items-center gap-2 rounded-(--radius) border pb-[7px] pl-2 pr-2.5 pt-[7px] disabled:opacity-70 ${
                            selection() === text(row().entry.path)
                              ? "border-line bg-blue-dark/10"
                              : "border-transparent hover:border-line-soft/75 hover:bg-hover"
                          } ${row().source === "recent" ? "py-2" : ""}`}
                          style={{ transitionProperty: "colors", transitionDuration: 180 }}
                        >
                          <View class="size-[18px] items-center justify-center">
                            <Image
                              src={workspaceTreeIcon(row().entry, row().expanded)}
                              accessibilityElementsHidden
                              style={{ width: 16, height: 16 }}
                            />
                          </View>
                          <If
                            when={row().source === "recent"}
                            else={
                              <FadeText
                                text={row().entry.name}
                                noTooltip
                                class={`flex-1 text-sm leading-[20.3px] ${
                                  selection() === text(row().entry.path) ? "text-foreground" : "text-subtle"
                                }`}
                              />
                            }
                          >
                            <View class="flex-1 gap-0.5">
                              <FadeText text={row().entry.name} noTooltip class="text-sm leading-[18.2px] text-foreground" />
                              <FadeText text={row().entry.path} noTooltip class="text-xs leading-[15.6px] text-muted-foreground" />
                            </View>
                          </If>
                        </BaseButton>
                      </View>
                    )}
                  </List>
                </If>
              </View>
            </View>
          </View>

          {/* The actions sit in the picker itself, under the browser, with no rule above them. */}
          <View class="flex-row flex-wrap items-center justify-between gap-2">
            <Toggle
              checked={showHidden()}
              disabled={loading() || creating()}
              label={t("chat_workspace_dialog_show_hidden")}
              testID="workspace-show-hidden"
              onChange={(checked) => void setShowHidden(checked)}
            />
            <View class="flex-row items-center gap-2">
              <Button
                variant="plain"
                size="sm"
                label={t("action_cancel")}
                disabled={Boolean(props.confirming) || creating()}
                testID="workspace-cancel"
                onPress={close}
              />
              <Button
                variant="primary"
                size="sm"
                label={dialogConfirmLabel()}
                loading={Boolean(props.confirming)}
                disabled={confirmButtonDisabled()}
                testID="workspace-confirm"
                onPress={confirm}
              />
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}
