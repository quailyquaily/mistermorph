// The details of a chip under a Solo reply (FT188): the workspace, the memory or the journal the
// reply's run used, and what its successful tool calls did there, each kind of use with how many
// calls made it. It says only what the runtime recorded (result.solo_sources[].uses: an action's
// name and a count, never a call's arguments, output, commands, paths or search words); a reply
// from before uses were kept says that its details were not recorded, and still names the source.
// It opens over the conversation and closes back to it: nothing navigates.
import { Text, View } from "nsh";
import { Button, Icon, Modal, type IconName } from "../ui";
import { soloSourceText, type SoloSource, type SoloSourceUse } from "./ChatSoloSources";
import { t } from "./i18n";

type DetailKind = "workspace" | "memory" | "journal";

const ICON: Record<DetailKind, IconName> = { workspace: "PhFolder", memory: "PhBrain", journal: "PhFileText" };

// The uses each kind of source can have (internal/daemonruntime/solo.go), each with its words.
const ACTIONS: Record<DetailKind, string[]> = {
  workspace: ["select", "read_file", "write_file", "shell", "coder"],
  memory: ["search", "save", "forget"],
  journal: ["search", "read"],
};

function detailKind(source: SoloSource | null): DetailKind {
  return source?.kind === "memory" || source?.kind === "journal" ? source.kind : "workspace";
}

/** The dialog's title: what kind of source it is. */
export function soloSourceDetailTitle(source: SoloSource | null) {
  return t(`chat_solo_source_details_title_${detailKind(source)}`);
}

/** What one use says: what was done; a use this Console has no words for (a newer runtime's) says so. */
export function soloSourceUseText(source: SoloSource, use: SoloSourceUse) {
  const kind = detailKind(source);
  return ACTIONS[kind].includes(use.action) ? t(`chat_solo_source_use_${kind}_${use.action}`) : t("chat_solo_source_use_other");
}

export function ChatSoloSourceDialog(props: { open: boolean; source: SoloSource | null; onClose: () => void }) {
  const source = () => props.source;
  const uses = (): SoloSourceUse[] => source()?.uses ?? [];
  const isWorkspace = () => source()?.kind === "workspace";
  // The workspace's folder in full, when the chip shows a shorter form of it (~/proj).
  const fullPath = () => {
    const now = source();
    return now && isWorkspace() && now.id && now.id !== soloSourceText(now) ? now.id : "";
  };
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={soloSourceDetailTitle(source())}
      closeLabel={t("action_close")}
      size="sm"
      testID="chat-solo-source-dialog"
      footer={<Button variant="outlined" label={t("action_close")} onPress={props.onClose} testID="chat-solo-source-dialog-done" />}
    >
      <If when={source()}>
        {(now) => (
          <View class="gap-4">
            <View class="flex-row items-start gap-2" testID="chat-solo-source-dialog-identity">
              <View class="pt-0.5">
                <Icon name={ICON[detailKind(now())]} size={16} color="muted-foreground" />
              </View>
              <View class="min-w-0 shrink gap-0.5">
                <Text class={`text-sm font-medium text-foreground ${isWorkspace() ? "font-mono" : ""}`} testID="chat-solo-source-dialog-name">
                  {soloSourceText(now())}
                </Text>
                <If when={fullPath()}>
                  <Text class="font-mono text-xs text-subtle" accessibilityLabel={t("chat_solo_source_details_path", { path: fullPath() })} testID="chat-solo-source-dialog-path">
                    {fullPath()}
                  </Text>
                </If>
              </View>
            </View>
            <If
              when={uses().length > 0}
              else={
                <Text class="text-sm text-subtle" testID="chat-solo-source-dialog-empty">
                  {t("chat_solo_source_details_none")}
                </Text>
              }
            >
              <View class="gap-2" testID="chat-solo-source-dialog-uses">
                <View class="flex-row items-center gap-3">
                  <Text class="min-w-0 flex-1 text-xs text-muted-foreground" role="header">
                    {t("chat_solo_source_details_uses")}
                  </Text>
                  <Text class="text-xs text-muted-foreground">{t("chat_solo_source_details_calls")}</Text>
                </View>
                <Each of={uses()} key={(use) => use.action}>
                  {(use) => (
                    <View
                      class="flex-row items-start gap-3"
                      accessibilityLabel={t("chat_solo_source_details_use_label", { use: soloSourceUseText(now(), use()), count: String(use().count) })}
                      testID={`chat-solo-source-use.${use().action}`}
                    >
                      <Text class="min-w-0 flex-1 text-sm text-foreground">{soloSourceUseText(now(), use())}</Text>
                      <Text class="text-sm tabular-nums text-subtle" testID={`chat-solo-source-use-count.${use().action}`}>
                        {String(use().count)}
                      </Text>
                    </View>
                  )}
                </Each>
                <Text class="text-xs text-muted-foreground">{t("chat_solo_source_details_note")}</Text>
              </View>
            </If>
          </View>
        )}
      </If>
    </Modal>
  );
}
