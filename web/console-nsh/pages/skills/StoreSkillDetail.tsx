// A store skill's details (SkillStoreView.js's StoreSkillDetail): its name and close in a fixed
// header, then Install, its properties and SKILL.md in a body that scrolls. Shown in the side panel
// (desktop) and the slide-in panel (phones).
import { Text, View } from "nsh";
import { Blocks, InlineNotice, LinkText, PropertyList, PropertyRow, PropertyText, t, WorkspaceTitle } from "../../components/knowledge/parts";
import { SkillDocument } from "../../components/knowledge/SkillDocument";
import { EdgeScroll } from "../../components/motion";
import { Button } from "../../components/ui";
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
      {/* The head: the name in the 20pt title face, the description under it, close at the end, on a soft hairline. */}
      <View class="flex-row items-start justify-between gap-3 pb-3 pl-[18px] pr-3.5 pt-4" style={{ boxShadow: "inset 0 -1px 0 rgba(165, 186, 208, 0.31)" }}>
        <View class="flex-1 gap-1">
          <View selectable>
            <WorkspaceTitle text={props.skill.name} />
          </View>
          <If when={props.skill.description}>
            <Text class="text-xs leading-normal text-subtle">{props.skill.description}</Text>
          </If>
        </View>
        <Button variant="plain" size="xs" iconOnly icon="PhX" title={t("action_close")} onPress={() => props.onClose()} testID="store-detail-close" />
      </View>
      <EdgeScroll class="flex-1" contentClass="gap-3.5 px-[18px] pb-6 pt-3.5">
        <View class="flex-row flex-wrap items-center gap-x-3 gap-y-2">
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
            <Text class="min-w-50 flex-1 text-xs leading-[17.4px] text-muted-foreground">{t("skills_store_install_note")}</Text>
          </If>
        </View>
        <If when={props.installErr}>
          <InlineNotice type="error" text={props.installErr} testID="store-install-error" />
        </If>

        <PropertyList>
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
        </PropertyList>

        <View class="gap-2.5" accessibilityLabel="SKILL.md">
          <Text class="font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground">SKILL.md</Text>
          <If when={props.doc.loading}>
            <Blocks count={1} height={120} />
          </If>
          <If when={!props.doc.loading && props.doc.failed}>
            <Text class="text-xs text-muted-foreground" testID="store-doc-failed">
              {t("skills_store_doc_failed")}{" "}
              {props.links.folder ? (
                <Text role="link" class="text-blue hover:underline" onPress={() => openExternal(props.links.folder)}>
                  GitHub
                </Text>
              ) : null}
            </Text>
          </If>
          <If when={!props.doc.loading && !props.doc.failed && props.documentSource}>
            <SkillDocument source={props.documentSource} onLinkPress={(url) => openExternal(url)} />
          </If>
        </View>
      </EdgeScroll>
    </View>
  );
}
