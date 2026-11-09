// The panel beside the conversation (a sheet on phones): the open topic (its title, regenerate and
// delete, pin, tags, context window meter, dates) and its workspace (the attached directory, its
// files as a tree, and what to do with the selected one).
import type { Bounds } from "nsh";
import { Image, List, Scroll, Text, View } from "nsh";
import { Sheet } from "nsh/base";
import { Button, Icon, Kicker, Tabs, Tip, TipButton, Toggle } from "../../components/ui";
import { CHROME_BAR_HEIGHT } from "../../components/frame/metrics";
import { TopicTagsEditor } from "../../components/chat/TopicTagsEditor";
import { t } from "../../components/chat/i18n";
import { formatBytes } from "../../lib/core/context.js";
import { workspaceTreeIcon } from "../../lib/core/workspace-icons.js";
import { rightSheetSystemInsets } from "../../lib/shell";
import type { ChatController } from "./chatController";
import { TOPIC_TAB_ID, WORKSPACE_TAB_ID } from "./chatController";

function ErrorNote(props: { text: string }) {
  return (
    <View role="alert" class="flex-row items-start gap-2 rounded-(--radius) border-l-2 border-danger bg-card px-3 py-2">
      <Icon name="PhWarningCircle" size={14} color="danger" />
      <Text class="flex-1 text-xs text-danger">{props.text}</Text>
    </View>
  );
}

function PropertyRow(props: { label: string; children?: any; title?: string }) {
  return (
    <View class="flex-row items-start gap-3 py-1.5" tooltip={props.title ? <Text class="text-xs">{props.title}</Text> : undefined}>
      <Text class="w-24 pt-0.5 text-xs text-muted-foreground">{props.label}</Text>
      <View class="flex-1 gap-1">{props.children}</View>
    </View>
  );
}

function ContextMeter(props: { c: ChatController }) {
  const progress = () => props.c.topicContextProgress();
  const meterTone = () => {
    const state = progress()?.meter?.state;
    return state === "over" ? "bg-danger" : state === "near" ? "bg-warn" : "bg-blue";
  };
  return (
    <If when={progress()}>
      {(p) => (
        <PropertyRow label={t("chat_topic_context_ratio_label")} title={p().title}>
          <View class="flex-row items-center gap-1.5">
            <Text class="text-sm font-semibold text-foreground" testID="chat-topic-context-ratio">
              {p().label}
            </Text>
            <Button
              variant="plain"
              size="xs"
              iconOnly
              icon="PhMagnifyingGlass"
              title={t("context_inspector_open")}
              onPress={() => props.c.openContextInspector()}
              testID="chat-topic-context-inspect"
            />
          </View>
          <If when={!p().unknownWindow}>
            <View
              role="progressbar"
              accessibilityLabel={t("chat_topic_context_ratio_label")}
              accessibilityValue={{ min: 0, max: 100, now: Math.round(p().fill * 100), text: p().label }}
              class="relative h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <If
                when={p().meter}
                else={<View class={`absolute bottom-0 left-0 top-0 ${meterTone()}`} style={{ width: `${p().fill * 100}%` }} />}
              >
                {(meter) => (
                  <>
                    <View class="absolute bottom-0 left-0 top-0 bg-blue-lighter" style={{ width: `${meter().cachedShare * 100}%` }} />
                    <View
                      class={`absolute bottom-0 top-0 ${meterTone()}`}
                      style={{ left: `${meter().cachedShare * 100}%`, width: `${meter().freshShare * 100}%` }}
                    />
                    <If when={meter().triggerShare !== null}>
                      <View class="absolute bottom-0 top-0 w-px bg-foreground" style={{ left: `${(meter().triggerShare ?? 0) * 100}%` }} />
                    </If>
                  </>
                )}
              </If>
            </View>
          </If>
        </PropertyRow>
      )}
    </If>
  );
}

function TopicTab(props: { c: ChatController }) {
  const c = props.c;
  return (
    <View class="gap-3 p-4" testID="chat-topic-panel">
      <If when={c.topicDeleteError() || c.topicRegenerateError()}>
        <ErrorNote text={c.topicDeleteError() || c.topicRegenerateError()} />
      </If>
      <View class="flex-row items-start gap-2">
        <Text class="flex-1 text-base font-semibold text-foreground" role="header" testID="chat-topic-panel-title">
          {c.deskTitle()}
        </Text>
        <If when={c.topicRegenerateAvailable()}>
          <View class="flex-row items-center gap-1">
            <Button
              variant="plain"
              size="sm"
              iconOnly
              icon="PhMagicWand"
              title={c.topicRegenerateLabel()}
              loading={c.topicRegenerating()}
              disabled={c.topicRegenerateDisabled()}
              onPress={() => void c.regenerateTopicName()}
              testID="chat-topic-regenerate"
            />
            <If when={c.topicDeleteAvailable()}>
              <Button
                variant="ghost-danger"
                size="sm"
                iconOnly
                icon="PhTrash"
                title={t("chat_topic_delete_action")}
                loading={c.topicDeleting()}
                disabled={c.topicDeleteDisabled()}
                onPress={() => c.confirmDeleteTopic()}
                testID="chat-topic-delete"
              />
            </If>
          </View>
        </If>
      </View>
      <View>
        <If when={c.topicTagsAvailable()}>
          <PropertyRow label={t("chat_topic_pin_label")}>
            <Toggle
              checked={c.selectedTopicPinned()}
              disabled={c.topicTagsSaving()}
              onChange={(pinned) => void c.setSelectedTopicPinned(pinned)}
              testID="chat-topic-pin"
            />
          </PropertyRow>
          <PropertyRow label={t("chat_topic_tags_label")}>
            <TopicTagsEditor
              tags={c.selectedTopicOrdinaryTags()}
              known={c.knownTags()}
              saving={c.topicTagsSaving()}
              disabled={c.topicTagsSaving()}
              onChange={(tags) => void c.saveSelectedTopicTags(tags)}
            />
            <If when={c.topicTagsError()}>
              <Text role="alert" class="text-xs text-danger">
                {c.topicTagsError()}
              </Text>
            </If>
          </PropertyRow>
        </If>
        <ContextMeter c={c} />
        <Each of={c.topicPropertyRows()} key={(row) => row.key}>
          {(row) => (
            <PropertyRow label={row().label} title={row().title}>
              <Text class="text-sm text-foreground">{row().value}</Text>
            </PropertyRow>
          )}
        </Each>
      </View>
    </View>
  );
}

function WorkspaceTab(props: { c: ChatController }) {
  const c = props.c;
  const selected = () => c.workspaceSelectedTreeEntry();
  return (
    <If
      when={c.workspaceReady()}
      else={
        <View class="gap-1 p-4">
          <Text class="text-sm font-medium text-foreground">{t("chat_workspace_unavailable_title")}</Text>
          <If when={c.workspaceHintText()}>
            <Text class="text-xs text-muted-foreground">{c.workspaceHintText()}</Text>
          </If>
        </View>
      }
    >
      <If
        when={c.workspaceDir()}
        else={
          <View class="gap-3 p-4">
            <If when={c.workspaceError()}>
              <ErrorNote text={c.workspaceError()} />
            </If>
            <Text class="text-sm font-medium text-foreground">{t("chat_workspace_empty_title")}</Text>
            <If when={!c.selectedTopicIsCron()}>
              <Button
                variant="primary"
                size="sm"
                label={t("chat_workspace_action_attach")}
                disabled={c.workspaceAttachDisabled()}
                onPress={() => c.openWorkspaceBrowser()}
                testID="chat-workspace-attach"
              />
            </If>
          </View>
        }
      >
        <View class="flex-1">
          <View class="flex-row items-start gap-2 p-4 pb-2">
            <View class="flex-1 gap-1">
              <Kicker>{t("chat_workspace_label")}</Kicker>
              <View selectable tooltip={<Tip text={c.workspaceDir()} />}>
                <Text class="font-mono text-xs line-clamp-2" testID="chat-workspace-path">
                  <If when={c.workspaceDirDisplay().prefix}>
                    <Text class="text-muted-foreground">{c.workspaceDirDisplay().prefix}</Text>
                  </If>
                  <Text class="text-muted-foreground">{c.workspaceDirDisplay().separator}</Text>
                  <Text class="text-foreground">{c.workspaceDirDisplay().tail}</Text>
                </Text>
              </View>
              <If when={c.workspaceHintText()}>
                <Text class="text-xs text-muted-foreground">{c.workspaceHintText()}</Text>
              </If>
            </View>
            <If when={!c.selectedTopicIsCron()}>
              <View class="flex-row items-center gap-0.5">
                <Button
                  variant="plain"
                  size="xs"
                  iconOnly
                  icon="PhPlus"
                  title={t("chat_workspace_action_attach")}
                  disabled={c.workspaceAttachDisabled()}
                  onPress={() => c.openWorkspaceBrowser()}
                />
                <If when={c.workspaceSource() === "attachment"}>
                  <Button
                    variant="plain"
                    size="xs"
                    iconOnly
                    icon="PhTrash"
                    title={t("chat_workspace_action_detach")}
                    disabled={c.workspaceDetachDisabled()}
                    loading={c.workspaceSaving()}
                    onPress={() => void c.detachWorkspace()}
                    testID="chat-workspace-detach"
                  />
                </If>
              </View>
            </If>
          </View>
          <View class="gap-2 px-4">
            <If when={c.workspaceError()}>
              <ErrorNote text={c.workspaceError()} />
            </If>
            <If when={c.workspaceTreeError()}>
              <ErrorNote text={c.workspaceTreeError()} />
            </If>
          </View>
          <If
            when={c.workspaceTreeRows().length > 0}
            else={
              <Text class="px-4 py-3 text-xs text-muted-foreground">
                {c.workspaceTreeLoading() ? t("chat_workspace_tree_loading") : t("chat_workspace_tree_empty")}
              </Text>
            }
          >
            <List each={c.workspaceTreeRows()} keyExtractor={(row: any) => `workspace:${row.key}`} estimatedItemSize={28} class="flex-1" testID="chat-workspace-tree">
              {(row) => (
                <TipButton
                  selected={String(row().entry?.path || "") === String(selected()?.path || "")}
                  onPress={() => void c.selectWorkspaceTreeNode(row())}
                  accessibilityLabel={row().entry?.name}
                  tooltip={<Tip text={row().entry?.path} />}
                  class="mx-2 flex-row items-center gap-1.5 rounded-(--radius) py-1 pr-2 hover:bg-hover selected:bg-selection"
                  style={{ paddingLeft: 8 + row().depth * 14 }}
                >
                  <Image src={workspaceTreeIcon(row().entry, row().expanded)} accessibilityElementsHidden style={{ width: 15, height: 15 }} />
                  <Text class="flex-1 text-sm text-foreground line-clamp-1">{row().entry?.name}</Text>
                </TipButton>
              )}
            </List>
          </If>
          <If when={selected()}>
            {(entry) => (
              <View class="gap-2 border-t border-line-faint p-4" testID="chat-workspace-selection">
                <View class="flex-row items-center gap-2">
                  <Text class="flex-1 text-sm font-medium text-foreground line-clamp-1">{entry().name}</Text>
                  <Kicker>{entry().is_dir ? t("chat_workspace_kind_dir") : t("chat_workspace_kind_file")}</Kicker>
                </View>
                <View class="flex-row items-center gap-3">
                  <Text class="w-16 text-xs text-muted-foreground">{t("audit_size")}</Text>
                  <Text class="text-xs text-foreground">{formatBytes(entry().size_bytes)}</Text>
                </View>
                <View class="flex-row items-center gap-3">
                  <Text class="w-16 text-xs text-muted-foreground">{t("audit_action")}</Text>
                  <View class="flex-row items-center gap-0.5">
                    <If when={!c.selectedTopicIsCron()}>
                      <Button
                        variant="plain"
                        size="xs"
                        iconOnly
                        icon="PhPlus"
                        title={t("chat_workspace_action_insert")}
                        disabled={c.composerDisabled()}
                        onPress={() => c.addWorkspaceSelectionToComposer()}
                        testID="chat-workspace-insert"
                      />
                    </If>
                    <Button
                      variant="plain"
                      size="xs"
                      iconOnly
                      icon="PhArrowSquareOut"
                      title={t("chat_workspace_action_open")}
                      loading={c.workspaceOpening()}
                      onPress={() => void c.openWorkspaceSelection()}
                    />
                    <Button
                      variant="plain"
                      size="xs"
                      iconOnly
                      icon="PhCloudArrowDown"
                      title={t("chat_workspace_action_download")}
                      disabled={entry().is_dir}
                      loading={c.workspaceDownloading()}
                      onPress={() => void c.downloadWorkspaceSelection()}
                      testID="chat-workspace-download"
                    />
                  </View>
                </View>
              </View>
            )}
          </If>
        </View>
      </If>
    </If>
  );
}

/** A tab of the panel, as `ChatController.workspacePanelTabs` lists them. */
export interface WorkspacePanelTab {
  id: string;
  label: string;
}

/**
 * The panel's tab row: the console's segmented control (`Tabs`).
 *
 * - Beside the conversation (wide windows) it sits low in its row, 12pt in, the toggle (`trailing`)
 *   at its right; its options are as wide as their labels.
 * - In the phone's sheet (`phone`) the row is as tall as a page's bar (57pt), the control in its
 *   middle, on the panel's 16pt gutter, and spans the row: its options share it equally, so all of
 *   the outlined box takes presses and the selected fill covers a whole half.
 */
export function WorkspacePanelTabs(props: {
  tabs: WorkspacePanelTab[];
  value: string;
  onChange: (id: string) => void;
  phone?: boolean;
  trailing?: any;
  /** Each option's frame, as `onLayout` reports it (tests). */
  onTabLayout?: (id: string, event: { bounds: Bounds }) => void;
}) {
  return (
    <View
      class={props.phone ? "flex-row items-center px-4" : "flex-row items-end gap-2 px-3 pt-2"}
      style={props.phone ? { height: CHROME_BAR_HEIGHT } : undefined}
      testID="chat-workspace-tabs"
    >
      <Tabs
        class="flex-1"
        equal={props.phone}
        items={props.tabs.map((tab) => ({ id: tab.id, label: tab.label }))}
        value={props.value}
        onChange={(id) => props.onChange(id)}
        onItemLayout={props.onTabLayout}
      />
      {props.trailing}
    </View>
  );
}

/**
 * The panel on phones: a sheet from the right over a scrim. Like the dialogs, it is an Overlay
 * over the whole surface, outside the app's frame, so on Android it runs under the status bar (and
 * the navigation bar) unless it keeps out from under them itself: its paper reaches the edges and
 * its padding takes the bars' insets (lib/systemInsets.ts `rightSheetInsets`), once. Elsewhere
 * there are none.
 */
export function WorkspaceSheet(props: { open: boolean; onClose: () => void; children?: any }) {
  const padding = () => {
    const insets = rightSheetSystemInsets();
    return insets ? { paddingTop: insets.top, paddingRight: insets.right, paddingBottom: insets.bottom } : undefined;
  };
  return (
    <Sheet
      open={props.open}
      side="right"
      onOpenChange={({ open }) => {
        if (!open) props.onClose();
      }}
      backdropClass="bg-scrim"
      popupClass="h-full w-[88%] max-w-md border-l border-line bg-card"
      popupStyle={padding()}
    >
      {props.children}
    </Sheet>
  );
}

/**
 * The panel's body: its tabs, then the topic or the workspace. `trailing` sits in the tab row;
 * `phone` lays the row out for the sheet (`WorkspacePanelTabs`).
 */
export function WorkspacePanel(props: { c: ChatController; trailing?: any; phone?: boolean; class?: string }) {
  const c = props.c;
  return (
    <View class={`bg-card ${props.class ?? ""}`} accessibilityLabel={t("chat_workspace_label")} testID="chat-workspace-panel">
      <WorkspacePanelTabs
        tabs={c.workspacePanelTabs()}
        value={c.workspaceSidebarTabID()}
        onChange={(id) => c.onWorkspaceTabChange(id)}
        phone={props.phone}
        trailing={props.trailing}
      />
      <If when={c.workspaceSidebarTabID() === WORKSPACE_TAB_ID} else={<If when={c.workspaceSidebarTabID() === TOPIC_TAB_ID}>
            <Scroll class="flex-1">
              <TopicTab c={c} />
            </Scroll>
          </If>}>
        <WorkspaceTab c={c} />
      </If>
    </View>
  );
}
