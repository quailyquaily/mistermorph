// The Settings page's one save bar (the Vue page's `.settings-save-bar`): what has unsaved changes,
// or what a save could not save, with Discard and Save. A section and its side pane both save here.
import { createMotion, effect, signal, Text, untracked, View } from "nsh";
import { Button, Icon } from "../ui";
import { MOTION_EASE, MOTION_NORMAL, motionMs } from "../motion";
import { t } from "../../pages/settings/i18n";

/**
 * The bar floats at the bottom of the window (`position: fixed`), centred, over the section and
 * its side pane alike: a 7pt waiting mark, "Unsaved changes (n)" with what is unsaved in mono
 * after it, and Save. It slides up 12pt and fades in when there is something to save, and back
 * down when there is not (`.settings-save-bar-enter/leave`, 180ms); it stays mounted until the
 * exit has played.
 */
export function SettingsSaveBar(props: {
  visible: boolean;
  /** The labels of what is unsaved. */
  items: string[];
  /** What a save could not save ("" when the last save went through). */
  failed: string;
  saving: boolean;
  busy: boolean;
  onSave: () => void;
  /** Phones: the bar sits over a side sheet. */
  overSheet?: boolean;
}) {
  const motion = createMotion({ initial: { opacity: 0, translateY: 12 } });
  const mounted = signal(false);
  let seq = 0;
  effect(() => {
    const visible = props.visible;
    untracked(() => {
      const run = ++seq;
      const duration = motionMs(MOTION_NORMAL);
      const timing = { duration, easing: MOTION_EASE };
      // Each channel turns from where it is, so a bar that comes back mid-exit does not jump.
      if (visible) {
        mounted.set(true);
        void motion.opacity.timing(1, timing);
        void motion.translateY.timing(0, timing);
        return;
      }
      if (!mounted()) return;
      void motion.translateY.timing(12, timing);
      void motion.opacity.timing(0, timing).then(() => {
        if (run === seq) mounted.set(false);
      });
    });
  });
  return (
    <If when={mounted()}>
      <View
        class="fixed bottom-4 left-0 right-0 items-center px-4"
        style={{ zIndex: props.overSheet ? 1001 : 90, pointerEvents: "box-none" }}
      >
        <View
          role="region"
          accessibilityLabel={t("settings_save_bar_label")}
          testID="settings-save-bar"
          class="w-full max-w-160 flex-row items-center gap-3 rounded-(--radius) border border-line bg-card px-3.5 py-2.5 shadow-[0_6px_24px_rgba(0,0,0,0.1)]"
          style={motion.style}
        >
          <View class={`size-[7px] rounded-[1px] ${props.failed ? "bg-status-error" : "bg-status-pending"}`} accessibilityElementsHidden />
          <View class="min-w-0 flex-1 flex-row flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <If
              when={props.failed}
              else={
                <>
                  <Text class="text-sm font-semibold text-subtle" testID="settings-save-bar-count">
                    {t("settings_save_bar_count", { count: props.items.length })}
                  </Text>
                  <Text class="min-w-0 shrink font-mono text-xs text-muted-foreground" style={{ numberOfLines: 1 }} testID="settings-save-bar-items">
                    {props.items.join(" · ")}
                  </Text>
                </>
              }
            >
              <Text class="text-sm text-subtle" testID="settings-save-bar-failed">
                {t("settings_save_bar_failed", { items: props.failed })}
              </Text>
            </If>
          </View>
          <Button
            variant="primary"
            label={t("action_save")}
            loading={props.saving}
            disabled={props.busy || props.items.length === 0}
            onPress={props.onSave}
            testID="settings-save-bar-save"
          />
        </View>
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
      {/* Vue's .settings-restart-banner: sticky 8pt below the top of the panel's scroll, so a save
          made further down still shows it; an opaque tint (orange-light 10% into the paper) since
          the content scrolls under it. */}
      <View
        testID="settings-restart-banner"
        class="flex-row flex-wrap items-center gap-3 border border-warn/45 px-3.5 py-2.5 shadow-[0_2px_8px_rgba(24,24,50,0.08)]"
        style={{ position: "sticky", top: 8, zIndex: 5, backgroundColor: "color-mix(in srgb, #eea03e 10%, #f6faff)" }}
      >
        <View class={props.restarting ? "animate-spin" : ""} style={{ animationDuration: 800 }}>
          <Icon name="PhArrowClockwise" size={18} color="warn" />
        </View>
        <View class="min-w-60 flex-1 gap-0.5">
          <Text class="text-xs leading-[17.4px] text-foreground">
            {props.restarting
              ? t("settings_restart_restarting")
              : props.tasksRunning
                ? t("settings_restart_tasks_running")
                : t("settings_restart_pending")}
          </Text>
          <If when={props.error}>
            <Text class="text-xs leading-[17.4px] text-danger">{props.error}</Text>
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
