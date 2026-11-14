// The Usage page's Coding agents button and dialog: the subscription quota of each local coding
// CLI the coder tool runs (Codex, Claude Code). Opening the dialog reads every installed coder's
// quota at once (Codex's app server, Claude Code's /usage: no quota used); meanwhile it shows the
// last saved ones, each bar a scanning line. A coder run saves its coder's quota too.
//
// Each coder is a section: its name, plan and a limit badge, and when it reported; under it a row
// per window (5 hours, 7 days, a model's own week): its name and the share used, large, over a
// bar that turns amber and red near the limit, and when it starts again. The button is in the
// page's bar only for the coders installed where the agent runs or that reported a quota, and not
// for an agent built before the quota routes (they answer 404).
import { batch, effect, signal, Text, untracked, View } from "nsh";
import { endpointState, formatShortTime, runtimeApiFetch } from "../../lib/core/context.js";
import { Badge, Button, Divider, Modal, ProgressBar } from "../ui";
import { InlineNotice } from "../settings/DialogShell";
import {
  normalizeCoderQuota,
  shownCoders,
  untilText,
  windowExpired,
  windowLabel,
  windowTone,
  type CoderQuotaPayload,
  type QuotaWindow,
} from "./coder-quota";
import { AuditBadge, t } from "./parts";

const EMPTY: CoderQuotaPayload = { quotas: [], available: {}, errors: {} };

/** The Usage page's mono label style: a window's name. */
const LABEL = "font-mono text-xs font-medium uppercase leading-normal tracking-[0.12em] text-subtle";

export function CoderQuotaButton() {
  const payload = signal<CoderQuotaPayload>(EMPTY);
  const open = signal(false);
  const reading = signal(false);
  const err = signal("");

  /** The saved quotas (GET), or each installed coder's read now (POST …/refresh). */
  async function load(read: boolean) {
    batch(() => {
      if (read) reading.set(true);
      err.set("");
    });
    try {
      const data = read ? await runtimeApiFetch("/stats/coder/quota/refresh", { method: "POST" }) : await runtimeApiFetch("/stats/coder/quota");
      payload.set(normalizeCoderQuota(data));
    } catch (e: any) {
      // Agents built before the quota routes answer 404: no button, no error.
      if (e?.status === 404 && !read) payload.set(EMPTY);
      else err.set(e?.message || t("msg_load_failed"));
    } finally {
      if (read) reading.set(false);
    }
  }

  effect(() => {
    const ref = String(endpointState.selectedRef || "").trim();
    untracked(() => {
      if (ref) {
        payload.set(EMPTY);
        void load(false);
      }
    });
  });

  const coders = () => shownCoders(payload());
  const installed = () => payload().available.codex === true || payload().available.claude === true;

  const show = () => {
    open.set(true);
    // The saved quotas show at once; the installed coders' are read now.
    void load(untracked(installed));
  };

  return (
    <If when={coders().length > 0 || err()}>
      <Button variant="outlined" size="sm" icon="PhTerminalWindow" label={t("stats_coders_title")} onPress={show} testID="stats-coders-open" />
      <Modal open={open()} onClose={() => open.set(false)} title={t("stats_coders_title")} closeLabel={t("action_close")} size="md" testID="stats-coders">
        <View class="gap-5">
          <If when={err()}>
            <InlineNotice type="error" text={err()} testID="stats-coders-error" />
          </If>
          <Each of={coders()} key={(coder) => coder.backend}>
            {(coder, index) => (
              <View class="gap-4" testID={`stats-coder-${coder().backend}`}>
                <If when={index() > 0}>
                  <Divider />
                </If>
                <View class="flex-row flex-wrap items-center gap-x-2 gap-y-1">
                  <Text class="text-base font-semibold text-foreground">{coder().title}</Text>
                  <If when={coder().quota?.plan}>
                    <Badge label={String(coder().quota?.plan ?? "").toUpperCase()} />
                  </If>
                  <If when={coder().quota?.status === "rejected" || coder().quota?.status === "allowed_warning"}>
                    <AuditBadge
                      badge={{ type: coder().quota?.status === "rejected" ? "danger" : "warning", variant: "outlined" }}
                      label={coder().quota?.status === "rejected" ? t("stats_coders_limit_reached") : t("stats_coders_near_limit")}
                      testID={`stats-coder-${coder().backend}-status`}
                    />
                  </If>
                  <View class="flex-1" />
                  <If when={reading() && coder().available} else={
                    <If when={coder().quota?.observed_at}>
                      <Text class="font-mono text-xs text-subtle tabular-nums" testID={`stats-coder-${coder().backend}-observed`}>
                        {t("stats_coders_observed", { time: formatShortTime(coder().quota?.observed_at ?? "") })}
                      </Text>
                    </If>
                  }>
                    <Text class="font-mono text-xs text-subtle" testID={`stats-coder-${coder().backend}-reading`}>
                      {t("stats_coders_reading")}
                    </Text>
                  </If>
                </View>
                <If
                  when={(coder().quota?.windows.length ?? 0) > 0}
                  else={
                    // Nothing saved yet: while it is read, two windows' places scan; after, why not.
                    <If
                      when={reading() && coder().available}
                      else={
                        <Text class="text-sm text-subtle" testID={`stats-coder-${coder().backend}-empty`}>
                          {t("stats_coders_empty")}
                        </Text>
                      }
                    >
                      <View class="gap-4" testID={`stats-coder-${coder().backend}-loading`}>
                        <PendingWindow />
                        <PendingWindow />
                      </View>
                    </If>
                  }
                >
                  <View class="gap-4">
                    <Each of={coder().quota?.windows ?? []} key={(w) => w.kind}>
                      {(w) => <WindowRow window={w()} reading={reading() && coder().available} testID={`stats-coder-${coder().backend}-${w().kind}`} />}
                    </Each>
                  </View>
                </If>
                <If when={coder().error}>
                  <InlineNotice type="error" text={coder().error} testID={`stats-coder-${coder().backend}-error`} />
                </If>
              </View>
            )}
          </Each>
        </View>
      </Modal>
    </If>
  );
}

/**
 * One window: its name and the share used over its bar, and when it starts again. While its
 * coder's quota is read, the bar is a scanning line and the share is the last one, faint.
 */
function WindowRow(props: { window: QuotaWindow; reading: boolean; testID: string }) {
  const used = () => props.window.used_percent;
  // A window whose reset has passed started again: what it said is no longer what is used.
  const expired = () => windowExpired(props.window);
  const tone = () => (expired() ? undefined : windowTone(props.window));
  const share = () => (expired() || used() === undefined ? "—" : `${Math.round(used()!)}%`);
  const caption = () => {
    if (expired()) return t("stats_coders_reset_passed");
    const until = untilText(props.window.resets_at);
    if (!until) return "";
    return `${t("stats_coders_resets_in", { time: until })} · ${formatShortTime(props.window.resets_at ?? "")}`;
  };
  const shareClass = () =>
    props.reading ? "text-subtle" : tone() === "danger" ? "text-danger" : tone() === "warn" ? "text-warn-dark" : "text-foreground";
  return (
    <View class="gap-1.5" testID={props.testID}>
      <View class="flex-row items-end justify-between gap-3">
        <Text class={LABEL}>{windowLabel(props.window)}</Text>
        <Text class={`text-lg font-semibold leading-none tabular-nums ${shareClass()}`} testID={`${props.testID}-used`}>
          {share()}
        </Text>
      </View>
      {/* An indeterminate bar is its own kind of bar: each look is built for itself. */}
      <If
        when={props.reading}
        else={
          <ProgressBar
            value={expired() ? 0 : (used() ?? 0)}
            tone={tone()}
            label={`${windowLabel(props.window)}: ${share()}${caption() ? `, ${caption()}` : ""}`}
          />
        }
      >
        <ProgressBar indeterminate label={t("stats_coders_reading")} />
      </If>
      <Text class="font-mono text-xs text-subtle tabular-nums" testID={`${props.testID}-detail`}>
        {caption() || " "}
      </Text>
    </View>
  );
}

/** A window's place while a coder with nothing saved is read: a short label, a scanning bar. */
function PendingWindow() {
  return (
    <View class="gap-1.5">
      <View class="h-3 w-10 rounded-(--radius) bg-muted" />
      <ProgressBar indeterminate label={t("stats_coders_reading")} />
      <View class="h-3 w-32 rounded-(--radius) bg-muted" />
    </View>
  );
}
