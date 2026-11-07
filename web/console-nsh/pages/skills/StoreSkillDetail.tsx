// A store skill's details (SkillStoreView.js's StoreSkillDetail): its name and close in a fixed
// header, then Install, its properties and SKILL.md in a body that scrolls. Shown in the side panel
// (desktop) and the slide-in panel (phones).
import { Scroll, Text, View } from "nsh";
import { Blocks, InlineNotice, LinkText, PropertyRow, PropertyText, t } from "../../components/knowledge/parts";
import { Button, Markdown } from "../../components/ui";
import type { normalizeStoreSkill } from "../../lib/core/skills-install.js";
import { openExternal } from "../../lib/platform";

export type StoreSkill = ReturnType<typeof normalizeStoreSkill>;
export interface StoreDoc {
  id: string;
  content: string;
  loading: boolean;
  failed: boolean;
}

export function StoreSkillDetail(props: {
  skill: StoreSkill;
  links: { folder: string; document: string };
  doc: StoreDoc;
  documentSource: string;
  filesSummary: string;
  installBusy: boolean;
  installErr: string;
  onInstall: (update: boolean) => void;
  onOpenInstalled: () => void;
  onClose: () => void;
}) {
  return (
    <View class="flex-1" testID="store-detail" accessibilityLabel={props.skill.name}>
      <View class="flex-row items-start gap-3 border-b border-line-faint px-5 py-4">
        <View class="flex-1 gap-1">
          <Text class="text-lg font-semibold text-foreground" role="header">
            {props.skill.name}
          </Text>
          <If when={props.skill.description}>
            <Text class="text-sm text-subtle">{props.skill.description}</Text>
          </If>
        </View>
        <Button variant="plain" size="sm" iconOnly icon="PhX" title={t("action_close")} onPress={() => props.onClose()} testID="store-detail-close" />
      </View>
      <Scroll class="flex-1" contentClass="gap-4 p-5">
        <View class="gap-2">
          <If
            when={props.skill.updateAvailable}
            else={
              <If
                when={props.skill.installed}
                else={
                  <Button
                    variant="primary"
                    label={t("skills_store_install")}
                    loading={props.installBusy}
                    onPress={() => props.onInstall(false)}
                    testID="store-install"
                  />
                }
              >
                <Button variant="outlined" label={t("skills_store_open")} onPress={() => props.onOpenInstalled()} testID="store-open-installed" />
              </If>
            }
          >
            <Button
              variant="primary"
              label={t("skills_update_to", { version: props.skill.version })}
              loading={props.installBusy}
              onPress={() => props.onInstall(true)}
              testID="store-update"
            />
          </If>
          <If when={!props.skill.installed || props.skill.updateAvailable}>
            <Text class="text-xs text-muted-foreground">{t("skills_store_install_note")}</Text>
          </If>
        </View>
        <If when={props.installErr}>
          <InlineNotice type="error" text={props.installErr} testID="store-install-error" />
        </If>

        <View>
          <If when={props.skill.version}>
            <PropertyRow label={t("skills_fact_version")}>
              <PropertyText
                text={`${props.skill.version}${
                  props.skill.installedVersion && props.skill.installedVersion !== props.skill.version
                    ? ` · ${t("skills_store_installed_version", { version: props.skill.installedVersion })}`
                    : ""
                }`}
              />
            </PropertyRow>
          </If>
          <If when={props.skill.author}>
            <PropertyRow label={t("skills_fact_author")}>
              <PropertyText text={props.skill.author} />
            </PropertyRow>
          </If>
          <If when={props.skill.license}>
            <PropertyRow label={t("skills_fact_license")}>
              <PropertyText text={props.skill.license} />
            </PropertyRow>
          </If>
          <If when={props.skill.homepage}>
            <PropertyRow label={t("skills_fact_homepage")}>
              <LinkText text={props.skill.homepage} onPress={() => openExternal(props.skill.homepage)} testID="store-homepage" />
            </PropertyRow>
          </If>
          <If when={props.skill.tags.length}>
            <PropertyRow label={t("skills_fact_tags")}>
              <PropertyText text={props.skill.tags.join(", ")} />
            </PropertyRow>
          </If>
          <If when={props.skill.requirements.length}>
            <PropertyRow label={t("skills_fact_requires")}>
              <PropertyText text={props.skill.requirements.join(", ")} />
            </PropertyRow>
          </If>
          <If when={props.skill.authProfiles.length}>
            <PropertyRow label={t("skills_fact_auth")}>
              <PropertyText text={props.skill.authProfiles.join(", ")} />
            </PropertyRow>
          </If>
          <PropertyRow label={t("skills_fact_files")}>
            <PropertyText text={props.filesSummary} />
          </PropertyRow>
          <If when={props.links.folder}>
            <PropertyRow label={t("skills_fact_source")}>
              <LinkText
                text={`${props.skill.repo} @ ${props.skill.commit.slice(0, 7)}`}
                onPress={() => openExternal(props.links.folder)}
                testID="store-source"
              />
            </PropertyRow>
          </If>
        </View>

        <View class="gap-3 border-t border-line-faint pt-4" accessibilityLabel="SKILL.md">
          <Text class="font-mono text-xs uppercase tracking-wide text-muted-foreground">SKILL.md</Text>
          <If when={props.doc.loading}>
            <Blocks count={1} height={120} />
          </If>
          <If when={!props.doc.loading && props.doc.failed}>
            <Text class="text-sm text-muted-foreground" testID="store-doc-failed">
              {t("skills_store_doc_failed")}{" "}
              {props.links.folder ? (
                <Text role="link" class="text-blue underline" onPress={() => openExternal(props.links.folder)}>
                  GitHub
                </Text>
              ) : null}
            </Text>
          </If>
          <If when={!props.doc.loading && !props.doc.failed && props.documentSource}>
            <Markdown source={props.documentSource} onLinkPress={(url) => openExternal(url)} />
          </If>
        </View>
      </Scroll>
    </View>
  );
}
