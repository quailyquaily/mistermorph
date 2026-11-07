// The body of a skill_install approval card: a complete assessment first, then the skill and its
// review, then an incomplete assessment, then findings by severity with expandable evidence, then
// notes. Ported from web/console/src/components/ChatSkillInstallPreview.js; its <details> are
// folds kept by the page (rows recycle), keyed under `foldKey`.
import type { JSX } from "nsh";
import { Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Icon, type IconName } from "../ui";
import { formatBytes } from "../../lib/core/context.js";
import { openChatLink } from "./ChatMarkdown";
import { t } from "./i18n";
import type { KeyedState } from "./rowState";

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
const findingPlace = (finding: any) => (finding.line ? `${finding.file}:${finding.line}` : finding.file);

function Fold(props: { label: string; foldKey: string; folds: KeyedState<boolean>; children?: JSX.Element; summary?: JSX.Element }) {
  const open = () => props.folds.get(props.foldKey) === true;
  return (
    <View class="gap-1.5">
      <BaseButton
        onPress={() => props.folds.set(props.foldKey, !open())}
        accessibilityLabel={props.label}
        class="flex-row items-center gap-1.5 self-start rounded-(--radius) py-0.5 pr-1 hover:bg-hover"
      >
        <Icon name={open() ? "PhCaretDown" : "PhCaretRight"} size={11} color="muted-foreground" />
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
      <View class="flex-1 gap-1">{props.children}</View>
    </View>
  );
}

function ErrorLine(props: { text: string; icon?: IconName }) {
  return (
    <View role="alert" class="flex-row items-start gap-1.5">
      <Icon name={props.icon ?? "PhInfo"} size={14} color="danger" />
      <Text class="flex-1 text-xs text-danger">{props.text}</Text>
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
        <View class="flex-row flex-wrap items-center gap-1.5">
          <Icon name={severityIcon(item().severity)} size={13} color={severityColor(item().severity)} />
          <Text class="font-mono text-xs uppercase text-subtle">{severityLabel(item().severity)}</Text>
          <Text class="text-xs text-foreground">{item().title}</Text>
          <If when={item().file}>
            <Text class="font-mono text-xs text-muted-foreground">{findingPlace(item())}</Text>
          </If>
        </View>
      }
    >
      <If when={item().evidence}>
        <View selectable class="rounded-(--radius) bg-paper p-2">
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
    <View class="gap-3" testID="chat-skill-preview">
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
            <View class="flex-row flex-wrap items-center gap-1">
              <Text role="link" class="text-xs text-blue underline" onPress={() => openChatLink(p().sourceURL)}>
                {p().sourceURL}
              </Text>
              <If when={p().commit}>
                <Text class="font-mono text-xs text-muted-foreground">@{p().commit}</Text>
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
              <Text class="flex-1 text-xs text-foreground">
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
                    <View class="flex-row flex-wrap gap-1.5">
                      <Text class="font-mono text-xs text-foreground">{gap().path}</Text>
                      <Text class="text-xs text-subtle">{t(`chat_skill_audit_${gap().status}`)}</Text>
                      <If when={gap().note}>
                        <Text class="text-xs text-muted-foreground">{gap().note}</Text>
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
                <View class="flex-row flex-wrap items-center gap-1.5">
                  <Icon name="PhInfo" size={13} color="subtle" />
                  <Text class="font-mono text-xs uppercase text-subtle">{severityLabel("info")}</Text>
                  <Text class="text-xs text-foreground">{note().title}</Text>
                  <If when={note().file}>
                    <Text class="font-mono text-xs text-muted-foreground">{findingPlace(note())}</Text>
                  </If>
                  <If when={note().evidence}>
                    <Text class="text-xs text-muted-foreground">{note().evidence}</Text>
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
