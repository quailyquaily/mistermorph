// The Settings page's one save bar (the Vue page's `.settings-save-bar`): what has unsaved changes,
// or what a save could not save, with Discard and Save. A section and its side pane both save here.
import { Text, View } from "nsh";
import { Button } from "../ui";
import { t } from "../../pages/settings/i18n";

export function SettingsSaveBar(props: {
  visible: boolean;
  /** The labels of what is unsaved. */
  items: string[];
  /** What a save could not save ("" when the last save went through). */
  failed: string;
  saving: boolean;
  busy: boolean;
  onSave: () => void;
  onDiscard: () => void;
  /** Phones: the bar sits over a side sheet. */
  overSheet?: boolean;
}) {
  return (
    <If when={props.visible}>
      <View
        role="region"
        accessibilityLabel={t("settings_save_bar_label")}
        testID="settings-save-bar"
        class="absolute bottom-4 left-4 right-4 flex-row items-center gap-3 self-center rounded-(--radius) border border-line bg-popover px-4 py-2.5 shadow-lg"
        style={{ zIndex: props.overSheet ? 60 : 20, maxWidth: 760 }}
      >
        <View class={`size-2 rounded-full ${props.failed ? "bg-danger" : "bg-warn"}`} accessibilityElementsHidden />
        <View class="flex-1 gap-0.5">
          <If
            when={props.failed}
            else={
              <>
                <Text class="text-sm font-semibold text-foreground" testID="settings-save-bar-count">
                  {t("settings_save_bar_count", { count: props.items.length })}
                </Text>
                <Text class="text-xs text-muted-foreground line-clamp-1" testID="settings-save-bar-items">
                  {props.items.join(" · ")}
                </Text>
              </>
            }
          >
            <Text class="text-sm text-danger" testID="settings-save-bar-failed">
              {t("settings_save_bar_failed", { items: props.failed })}
            </Text>
          </If>
        </View>
        <Button
          variant="plain"
          label={t("settings_unsaved_discard")}
          disabled={props.busy || props.items.length === 0}
          onPress={props.onDiscard}
          testID="settings-save-bar-discard"
        />
        <Button
          variant="primary"
          label={t("action_save")}
          loading={props.saving}
          disabled={props.busy || props.items.length === 0}
          onPress={props.onSave}
          testID="settings-save-bar-save"
        />
      </View>
    </If>
  );
}

/** The banner of a saved change that needs a restart (`.settings-restart-banner`). */
export function SettingsRestartBanner(props: {
  pending: boolean;
  busy: boolean;
  restarting: boolean;
  tasksRunning: boolean;
  error: string;
  onRestart: (force: boolean) => void;
  onCancelForce: () => void;
}) {
  return (
    <If when={props.pending}>
      <View testID="settings-restart-banner" class="flex-row flex-wrap items-center gap-3 rounded-(--radius) border border-warn bg-card px-4 py-3">
        <View class="min-w-60 flex-1 gap-0.5">
          <Text class="text-sm text-foreground">
            {props.restarting
              ? t("settings_restart_restarting")
              : props.tasksRunning
                ? t("settings_restart_tasks_running")
                : t("settings_restart_pending")}
          </Text>
          <If when={props.error}>
            <Text class="text-xs text-danger">{props.error}</Text>
          </If>
        </View>
        <If when={!props.restarting}>
          <View class="flex-row items-center gap-2">
            <If
              when={props.tasksRunning}
              else={
                <Button
                  variant="primary"
                  size="xs"
                  label={t("settings_restart_now")}
                  loading={props.busy}
                  onPress={() => props.onRestart(false)}
                  testID="settings-restart-now"
                />
              }
            >
              <Button variant="plain" size="xs" label={t("action_cancel")} disabled={props.busy} onPress={props.onCancelForce} />
              <Button
                variant="primary"
                size="xs"
                label={t("settings_restart_anyway")}
                loading={props.busy}
                onPress={() => props.onRestart(true)}
                testID="settings-restart-anyway"
              />
            </If>
          </View>
        </If>
      </View>
    </If>
  );
}
