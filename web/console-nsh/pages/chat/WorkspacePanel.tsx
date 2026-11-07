// The panel beside the conversation (a sheet on phones): the open topic (its title, regenerate and
// delete, pin, tags, context window meter, dates) and its workspace (the attached directory, its
// files as a tree, and what to do with the selected one).
import { Image, List, Scroll, Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Button, Icon, Kicker, Tabs, Toggle } from "../../components/ui";
import { TopicTagsEditor } from "../../components/chat/TopicTagsEditor";
import { t } from "../../components/chat/i18n";
import { formatBytes } from "../../lib/core/context.js";
import { workspaceTreeIcon } from "../../lib/core/workspace-icons.js";
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
              <View selectable tooltip={<Text class="text-xs">{c.workspaceDir()}</Text>}>
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
                <BaseButton
                  selected={String(row().entry?.path || "") === String(selected()?.path || "")}
                  onPress={() => void c.selectWorkspaceTreeNode(row())}
                  accessibilityLabel={row().entry?.name}
                  tooltip={<Text class="text-xs">{row().entry?.path}</Text>}
                  class="mx-2 flex-row items-center gap-1.5 rounded-(--radius) py-1 pr-2 hover:bg-hover selected:bg-selection"
                  style={{ paddingLeft: 8 + row().depth * 14 }}
                >
                  <Image src={workspaceTreeIcon(row().entry, row().expanded)} accessibilityElementsHidden style={{ width: 15, height: 15 }} />
                  <Text class="flex-1 text-sm text-foreground line-clamp-1">{row().entry?.name}</Text>
                </BaseButton>
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

/** The panel's body: its tabs, then the topic or the workspace. `trailing` sits in the tab row. */
export function WorkspacePanel(props: { c: ChatController; trailing?: any; class?: string }) {
  const c = props.c;
  return (
    <View class={`bg-card ${props.class ?? ""}`} accessibilityLabel={t("chat_workspace_label")} testID="chat-workspace-panel">
      <View class="flex-row items-end gap-2 px-3 pt-2">
        <Tabs
          class="flex-1"
          items={c.workspacePanelTabs().map((tab) => ({ id: tab.id, label: tab.label }))}
          value={c.workspaceSidebarTabID()}
          onChange={(id) => c.onWorkspaceTabChange(id)}
        />
        {props.trailing}
      </View>
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
