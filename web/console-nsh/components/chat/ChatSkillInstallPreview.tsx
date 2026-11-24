// The body of a skill_install approval card: a complete assessment first, then the skill and its
// review, then an incomplete assessment, then findings by severity with expandable evidence, then
// notes. Ported from web/console/src/components/ChatSkillInstallPreview.js; its <details> are
// folds kept by the page (rows recycle), keyed under `foldKey`.
// Rows that put texts side by side (source and commit, a finding's or note's summary, a coverage
// gap) wrap, and every text in them that can be long (a URL, a title, a path, evidence) is
// `min-w-0 shrink`: a text in a row otherwise keeps its whole width and runs past the card on a
// phone. Shrunk to the row, it wraps inside it, between characters in a long unbroken run.
import type { JSX } from "nsh";
import { Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Icon, type IconName } from "../ui";
import { formatBytes } from "../../lib/core/context.js";
import { openChatLink } from "./ChatMarkdown";
import { t } from "./i18n";
import type { KeyedState } from "./rowState";
import { createPartProbe, type PartLayoutListener } from "../shared/partProbe";

const SEVERITY_ICON: Record<string, IconName> = {
  critical: "PhWarningOctagon",
  high: "PhWarning",
  medium: "PhWarningCircle",
  low: "PhInfo",
  info: "PhInfo",
  none: "PhShieldCheck",
};
const PROMINENT = new Set(["critical", "high"]);

const severityIcon = (severity: string): IconName => SEVERITY_ICON[severity] || "PhInfo";
const severityLabel = (severity: string) => t(`chat_skill_severity_${severity}`);
const severityColor = (severity: string) =>
  severity === "critical" || severity === "high" ? "danger" : severity === "medium" ? "warn-dark" : "subtle";
// Where the card's parts lie, for tests (tests/chat-skill-preview-layout.test.tsx); nothing without a listener.
let partProbe: PartLayoutListener | undefined;
export function probeSkillInstallPreview(listener: PartLayoutListener | null) {
  partProbe = listener ?? undefined;
}
const parts = createPartProbe(() => partProbe);

const findingPlace = (finding: any) => (finding.line ? `${finding.file}:${finding.line}` : finding.file);

function Fold(props: { label: string; foldKey: string; folds: KeyedState<boolean>; children?: JSX.Element; summary?: JSX.Element }) {
  const open = () => props.folds.get(props.foldKey) === true;
  return (
    <View class="gap-1.5">
      <BaseButton
        onPress={() => props.folds.set(props.foldKey, !open())}
        accessibilityLabel={props.label}
        class="max-w-full flex-row items-start gap-1.5 self-start rounded-(--radius) py-0.5 pr-1 hover:bg-hover"
      >
        {/* As tall as one line, so the caret stays by a wrapped summary's first line. */}
        <View class="h-4 justify-center" {...parts.probe(() => `caret:${props.foldKey}`)}>
          <Icon name={open() ? "PhCaretDown" : "PhCaretRight"} size={11} color="muted-foreground" />
        </View>
        {props.summary ?? <Text class="text-xs font-medium text-subtle">{props.label}</Text>}
      </BaseButton>
      <If when={open()}>
        <View class="gap-1.5 pl-4">{props.children}</View>
      </If>
    </View>
  );
}

function Param(props: { name: string; children?: JSX.Element }) {
  return (
    <View class="flex-row gap-2">
      <Text class="w-28 font-mono text-xs text-muted-foreground">{props.name}</Text>
      <View class="min-w-0 flex-1 gap-1">{props.children}</View>
    </View>
  );
}

function ErrorLine(props: { text: string; icon?: IconName }) {
  return (
    <View role="alert" class="flex-row items-start gap-1.5">
      <Icon name={props.icon ?? "PhInfo"} size={14} color="danger" />
      <Text class="min-w-0 flex-1 text-xs text-danger" {...parts.probe(() => `error:${props.icon ?? "PhInfo"}`)}>
        {props.text}
      </Text>
    </View>
  );
}

export function ChatSkillInstallPreview(props: { preview: any; foldKey: string; folds: KeyedState<boolean> }) {
  const p = () => props.preview;
  const coverage = () => t("chat_skill_coverage", { files: p().coverage.files, reviewed: p().coverage.reviewed, inspected: p().coverage.inspected });
  const groups = () => {
    const issues: any[] = p().issues || [];
    return [
      { key: "prominent", folded: false, items: issues.filter((f) => PROMINENT.has(f.severity)) },
      { key: "folded", folded: true, items: issues.filter((f) => !PROMINENT.has(f.severity)) },
    ].filter((group) => group.items.length);
  };

  const finding = (item: () => any) => (
    <Fold
      label={item().title}
      foldKey={`${props.foldKey}:finding:${item().id}`}
      folds={props.folds}
      summary={
        <View class="min-w-0 shrink flex-row flex-wrap items-center gap-1.5" {...parts.probe(() => `finding:${item().id}`)}>
          <Icon name={severityIcon(item().severity)} size={13} color={severityColor(item().severity)} />
          <Text class="font-mono text-xs uppercase text-subtle" {...parts.probe(() => `finding-severity:${item().id}`)}>
            {severityLabel(item().severity)}
          </Text>
          <Text class="min-w-0 shrink text-xs text-foreground" {...parts.probe(() => `finding-title:${item().id}`)}>
            {item().title}
          </Text>
          <If when={item().file}>
            <Text class="min-w-0 shrink font-mono text-xs text-muted-foreground" {...parts.probe(() => `finding-place:${item().id}`)}>
              {findingPlace(item())}
            </Text>
          </If>
        </View>
      }
    >
      <If when={item().evidence}>
        <View selectable class="rounded-(--radius) bg-paper p-2" {...parts.probe(() => `finding-evidence:${item().id}`)}>
          <Text class="font-mono text-xs text-foreground">{item().evidence}</Text>
        </View>
      </If>
      <If when={item().rationale}>
        <Text class="text-xs text-subtle">{item().rationale}</Text>
      </If>
      <If when={item().evidenceVerified === false}>
        <Text class="text-xs text-muted-foreground">{t("chat_skill_evidence_unverified")}</Text>
      </If>
    </Fold>
  );

  return (
    <View class="gap-3" testID="chat-skill-preview" {...parts.probe(() => "preview")}>
      <If
        when={!p().expired}
        else={<ErrorLine text={t("chat_skill_preview_expired")} />}
      >
        <If when={p().mismatch}>
          <ErrorLine text={t("chat_skill_preview_mismatch")} />
        </If>
        <If when={p().assessment.complete}>
          <View class="gap-1.5 rounded-(--radius) border border-line-faint bg-paper p-2.5" accessibilityLabel={t("chat_skill_assessment")}>
            <View class="flex-row items-center gap-2">
              <Icon name={severityIcon(p().assessment.level)} size={18} color={severityColor(p().assessment.level)} />
              <Text class="text-sm font-semibold text-foreground">{t(`chat_skill_level_${p().assessment.level}`)}</Text>
              <Text class="text-xs text-muted-foreground">{t("chat_skill_score", { score: p().assessment.score })}</Text>
            </View>
            <Text class="text-xs text-subtle">{coverage()}</Text>
            <If when={p().assessment.rubric}>
              <Fold label={t("chat_skill_rubric")} foldKey={`${props.foldKey}:rubric`} folds={props.folds}>
                <Text class="text-xs text-subtle">{p().assessment.rubric}</Text>
              </Fold>
            </If>
          </View>
        </If>
        <If when={p().reviewError}>
          <ErrorLine icon="PhXCircle" text={t("chat_skill_preview_review_failed", { error: p().reviewError })} />
        </If>
        <View class="gap-0.5">
          <Text class="text-sm font-semibold text-foreground">{p().name}</Text>
          <If when={p().description}>
            <Text class="text-xs text-subtle">{p().description}</Text>
          </If>
        </View>
        <View class="gap-1.5">
          <Param name={t("chat_skill_preview_source")}>
            <View class="flex-row flex-wrap items-center gap-1" {...parts.probe(() => "source-row")}>
              <Text
                role="link"
                class="min-w-0 shrink text-xs text-blue underline"
                onPress={() => openChatLink(p().sourceURL)}
                {...parts.probe(() => "source")}
              >
                {p().sourceURL}
              </Text>
              <If when={p().commit}>
                <Text class="min-w-0 shrink font-mono text-xs text-muted-foreground" {...parts.probe(() => "commit")}>
                  @{p().commit}
                </Text>
              </If>
            </View>
          </Param>
          <Param name={t("chat_skill_preview_files")}>
            <Text class="text-xs text-foreground">
              {t(p().fileCount === 1 ? "skills_files_summary_one" : "skills_files_summary", { count: p().fileCount, size: formatBytes(p().totalBytes) })}
            </Text>
          </Param>
          <If when={p().requirements.length}>
            <Param name={t("chat_skill_preview_requires")}>
              <Text class="text-xs text-foreground">{p().requirements.join(", ")}</Text>
            </Param>
          </If>
          <If when={p().authProfiles.length}>
            <Param name={t("chat_skill_preview_auth")}>
              <Text class="text-xs text-foreground">{p().authProfiles.join(", ")}</Text>
            </Param>
          </If>
          <If when={p().replaces}>
            <Param name={t("chat_skill_preview_replaces")}>
              <Text class="text-xs text-foreground">
                {p().replace ? t("chat_skill_preview_replaces_yes", { dir: p().replaces }) : t("chat_skill_preview_replaces_no", { dir: p().replaces })}
              </Text>
            </Param>
          </If>
        </View>
        <If when={p().summary || p().capabilities.length}>
          <View class="gap-1">
            <Text class="font-mono text-xs uppercase text-muted-foreground">{t("chat_skill_preview_review")}</Text>
            <If when={p().summary}>
              <Text class="text-xs text-foreground">{p().summary}</Text>
            </If>
            <Each of={p().capabilities as string[]} key={(item, index) => `cap:${index}:${item}`}>
              {(item) => <Text class="text-xs text-foreground">• {item()}</Text>}
            </Each>
          </View>
        </If>
        <If when={!p().assessment.complete}>
          <View class="gap-1.5">
            <Text class="font-mono text-xs uppercase text-muted-foreground">{t("chat_skill_assessment")}</Text>
            <View class="flex-row items-start gap-1.5">
              <Icon name="PhQuestion" size={14} color="warn-dark" />
              <Text class="min-w-0 flex-1 text-xs text-foreground">
                <Text class="font-semibold">{t("chat_skill_not_fully_assessed")}.</Text> {t("chat_skill_incomplete_note")}
              </Text>
            </View>
            <If when={p().assessment.incompleteReasons.length}>
              <Param name={t("chat_skill_incomplete_why")}>
                <Each of={p().assessment.incompleteReasons as string[]} key={(reason, index) => `why:${index}:${reason}`}>
                  {(reason) => <Text class="text-xs text-foreground">• {reason()}</Text>}
                </Each>
              </Param>
            </If>
            <Param name={t("chat_skill_incomplete_coverage")}>
              <Text class="text-xs text-foreground">{coverage()}</Text>
            </Param>
            <If when={p().coverage.gaps.length}>
              <Param name={t("chat_skill_incomplete_gaps", { count: p().coverage.gaps.length })}>
                <Each of={p().coverage.gaps as any[]} key={(gap) => gap.path}>
                  {(gap) => (
                    <View class="flex-row flex-wrap gap-1.5" {...parts.probe(() => `gap:${gap().path}`)}>
                      <Text class="min-w-0 shrink font-mono text-xs text-foreground" {...parts.probe(() => `gap-path:${gap().path}`)}>
                        {gap().path}
                      </Text>
                      <Text class="min-w-0 shrink text-xs text-subtle" {...parts.probe(() => `gap-status:${gap().path}`)}>
                        {t(`chat_skill_audit_${gap().status}`)}
                      </Text>
                      <If when={gap().note}>
                        <Text class="min-w-0 shrink text-xs text-muted-foreground" {...parts.probe(() => `gap-note:${gap().path}`)}>
                          {gap().note}
                        </Text>
                      </If>
                    </View>
                  )}
                </Each>
              </Param>
            </If>
            <Param name={t("chat_skill_incomplete_score")}>
              <Text class="text-xs text-foreground">
                {t("chat_skill_score_partial", { level: severityLabel(p().assessment.level), score: p().assessment.score })}
              </Text>
              <If when={p().assessment.rubric}>
                <Fold label={t("chat_skill_rubric")} foldKey={`${props.foldKey}:rubric`} folds={props.folds}>
                  <Text class="text-xs text-subtle">{p().assessment.rubric}</Text>
                </Fold>
              </If>
            </Param>
          </View>
        </If>
        <View class="gap-1.5">
          <Text class="font-mono text-xs uppercase text-muted-foreground">{t("chat_skill_findings", { count: p().issues.length })}</Text>
          <If when={!p().issues.length}>
            <Text class="text-xs text-subtle">{t("chat_skill_no_issues")}</Text>
          </If>
          <Each of={groups()} key={(group) => group.key}>
            {(group) => (
              <If
                when={group().folded}
                else={
                  <View class="gap-1">
                    <Each of={group().items} key={(item) => item.id}>
                      {(item) => finding(item)}
                    </Each>
                  </View>
                }
              >
                <Fold
                  label={t("chat_skill_findings_folded", { count: group().items.length })}
                  foldKey={`${props.foldKey}:folded`}
                  folds={props.folds}
                >
                  <Each of={group().items} key={(item) => item.id}>
                    {(item) => finding(item)}
                  </Each>
                </Fold>
              </If>
            )}
          </Each>
        </View>
        <If when={p().notes.length}>
          <Fold label={t("chat_skill_notes", { count: p().notes.length })} foldKey={`${props.foldKey}:notes`} folds={props.folds}>
            <Each of={p().notes as any[]} key={(note) => note.id}>
              {(note) => (
                <View class="flex-row flex-wrap items-center gap-1.5" {...parts.probe(() => `note:${note().id}`)}>
                  <Icon name="PhInfo" size={13} color="subtle" />
                  <Text class="font-mono text-xs uppercase text-subtle">{severityLabel("info")}</Text>
                  <Text class="min-w-0 shrink text-xs text-foreground" {...parts.probe(() => `note-title:${note().id}`)}>
                    {note().title}
                  </Text>
                  <If when={note().file}>
                    <Text class="min-w-0 shrink font-mono text-xs text-muted-foreground" {...parts.probe(() => `note-place:${note().id}`)}>
                      {findingPlace(note())}
                    </Text>
                  </If>
                  <If when={note().evidence}>
                    <Text class="min-w-0 shrink text-xs text-muted-foreground" {...parts.probe(() => `note-evidence:${note().id}`)}>
                      {note().evidence}
                    </Text>
                  </If>
                </View>
              )}
            </Each>
          </Fold>
        </If>
        <Text class="text-xs text-muted-foreground">{t("chat_skill_preview_note")}</Text>
      </If>
    </View>
  );
}
