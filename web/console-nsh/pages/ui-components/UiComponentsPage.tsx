// The UI component gallery (/ui-components): every component of the console on one page, for
// looking at, pressing and reading in each language. It is a testing page: it has a route and no
// entry in any navigation. The route is guarded as any workspace page is (a session, a finished
// setup), and nothing on the page talks to the console or an agent: the demos mount the production
// components with synthetic props and local state (./demo.tsx, ./demos), the inventory
// (./inventory.js) says what each component is shown as, and the language control is the
// console's own (`localeState.setLanguage`, the one catalog in lib/i18n).
// docs/console/ui-components.md describes it.
import { computed, Scroll, signal, Text, untracked, View, windowSize } from "nsh";
import { LANGUAGES } from "../../components/LanguageSelector";
import { EdgeScroll } from "../../components/motion/ScrollEdges";
import { Button, EmptyState, Icon, Tabs, TextField } from "../../components/ui";
import { currentRoute } from "../../lib/router";
import { localeState } from "../../lib/stores/index.js";
import { galleryAction, galleryActionCount, t } from "./demo";
import { DEMOS } from "./demos";
import { GALLERY_ENTRIES, GALLERY_GROUPS, type GalleryEntry } from "./inventory.js";

const ALL = "all";

/** Whether an entry matches the filter: its name, its file, or what it is shown inside. */
export function matchesFilter(entry: GalleryEntry, needle: string) {
  const want = needle.trim().toLowerCase();
  if (!want) return true;
  return [entry.name, entry.id, entry.file, entry.via ?? ""].some((text) => text.toLowerCase().includes(want));
}

/** Why an entry has no demo of its own, in the page's language. */
function noteOf(entry: GalleryEntry) {
  if (entry.mode === "composed") return t("uig_note_composed", { via: entry.via ?? "" });
  const reason = t(`uig_reason_${entry.reason ?? "live"}`, { via: entry.via ?? "" });
  // A private part's reason names what it is part of already.
  const shown = entry.reason !== "part" && GALLERY_ENTRIES.some((other) => other.name === entry.via && other.mode === "demo");
  return shown ? `${reason} ${t("uig_note_see", { via: entry.via })}` : reason;
}

function Chip(props: { id: string; label: string; count: number; active: boolean; onPress: () => void }) {
  return (
    <Button
      variant="outlined"
      size="xs"
      selected={props.active}
      label={`${props.label} · ${props.count}`}
      accessibilityLabel={props.label}
      onPress={props.onPress}
      testID={`uig-index-${props.id}`}
    />
  );
}

function DemoCard(props: { entry: GalleryEntry; width: number }) {
  const demo = DEMOS[props.entry.id];
  return (
    <View
      class="overflow-hidden rounded-(--radius) border border-line-faint bg-card"
      style={{ width: props.width }}
      testID={`uig-demo-${props.entry.id}`}
      accessibilityLabel={props.entry.name}
    >
      <View class="gap-0.5 border-b border-line-soft px-4 py-2.5">
        <Text class="font-mono text-sm font-medium text-foreground" role="header">{props.entry.name}</Text>
        <Text class="font-mono text-[11px] text-muted-foreground">{props.entry.file}</Text>
      </View>
      <View class="min-w-0 p-4">{demo ? demo.render() : null}</View>
    </View>
  );
}

function NoteRow(props: { entry: GalleryEntry }) {
  return (
    <View class="gap-0.5 border-t border-line-soft px-4 py-2" testID={`uig-note-${props.entry.id}`}>
      <View class="flex-row flex-wrap items-baseline gap-x-2">
        <Text class="font-mono text-sm text-foreground">{props.entry.name}</Text>
        <Text class="font-mono text-[11px] text-muted-foreground">{props.entry.file}</Text>
      </View>
      <Text class="text-xs leading-[18px] text-subtle">{noteOf(props.entry)}</Text>
    </View>
  );
}

export function UiComponentsPage() {
  // The address may name where to start: `/ui-components?group=chat&q=composer`. It is read once;
  // the controls below do not write it back.
  const query = untracked(() => currentRoute().query);
  const filter = signal(String(query.q ?? ""));
  const group = signal(GALLERY_GROUPS.some((item) => item.id === query.group) ? query.group : ALL);
  const shown = computed(() => GALLERY_ENTRIES.filter((entry) => matchesFilter(entry, filter())));
  const inGroup = (id: string) => shown().filter((entry) => entry.group === id);
  const visibleGroups = computed(() => GALLERY_GROUPS.filter((item) => (group() === ALL || group() === item.id) && inGroup(item.id).length > 0));
  const reset = () => {
    filter.set("");
    group.set(ALL);
  };
  // The page's own gutters and columns: one column on a phone, two on a wide window, three on a
  // very wide one. A card never takes more than the page's width; what is wider scrolls inside it.
  const pad = () => (windowSize().width <= 640 ? 12 : 24);
  const gap = 16;
  const room = () => Math.max(240, windowSize().width - pad() * 2);
  const columns = () => (room() >= 1560 ? 3 : room() >= 900 ? 2 : 1);
  const cardWidth = (wide: boolean) => (wide ? room() : Math.floor((room() - gap * (columns() - 1)) / columns()));
  const countLabel = () => {
    const count = shown().length;
    const total = GALLERY_ENTRIES.length;
    if (count === total) return t(count === 1 ? "uig_count_one" : "uig_count_many", { count });
    return t("uig_count_filtered", { count, total });
  };
  return (
    <View class="flex-1 bg-background" testID="ui-components-page">
      <View class="gap-2.5 border-b border-line-soft bg-background py-3" style={{ paddingHorizontal: pad() }}>
        <View class="flex-row flex-wrap items-center gap-x-4 gap-y-2">
          <View class="min-w-0 shrink grow gap-0.5">
            <Text class="text-xl leading-[24px] tracking-[-0.4px] text-foreground" role="header" testID="uig-title">{t("uig_title")}</Text>
            <Text class="text-xs leading-[17px] text-muted-foreground">{t("uig_subtitle")}</Text>
          </View>
          <View class="flex-row items-center gap-2" testID="uig-language">
            <Icon name="PhGlobe" size={16} color="muted-foreground" />
            <Tabs
              narrow
              accessibilityLabel={t("uig_language")}
              items={LANGUAGES.map((item) => ({ id: item.value, label: item.label }))}
              value={localeState.lang}
              onChange={(id) => localeState.setLanguage(id)}
            />
          </View>
        </View>
        <View class="flex-row flex-wrap items-center gap-x-3 gap-y-2">
          <TextField
            class="min-w-48 max-w-96 flex-1"
            size="sm"
            value={filter()}
            onChange={(value) => filter.set(value)}
            leadingIcon="PhMagnifyingGlass"
            placeholder={t("uig_filter_placeholder")}
            accessibilityLabel={t("uig_filter_placeholder")}
            clearable
            clearLabel={t("uig_filter_clear")}
            testID="uig-filter"
          />
          <Text class="text-xs text-muted-foreground" testID="uig-count">{countLabel()}</Text>
          <Text class="min-w-0 shrink text-xs text-muted-foreground" testID="uig-last-action" style={{ numberOfLines: 1 }}>
            {galleryActionCount() > 0 ? t("uig_last_action", { action: galleryAction(), count: galleryActionCount() }) : t("uig_no_action")}
          </Text>
        </View>
        <EdgeScroll horizontal class="-mx-1" contentClass="flex-row gap-1.5 px-1" testID="uig-index">
          <Chip id={ALL} label={t("uig_group_all")} count={shown().length} active={group() === ALL} onPress={() => group.set(ALL)} />
          <Each of={GALLERY_GROUPS} key={(item) => item.id}>
            {(item) => (
              <Chip id={item().id} label={t(item().titleKey)} count={inGroup(item().id).length} active={group() === item().id} onPress={() => group.set(item().id)} />
            )}
          </Each>
        </EdgeScroll>
      </View>
      <Scroll class="flex-1" testID="uig-scroll">
        <View class="gap-8 py-5" style={{ paddingHorizontal: pad() }}>
          <If when={visibleGroups().length === 0}>
            <View testID="uig-empty">
              <EmptyState
                icon="PhMagnifyingGlass"
                title={t("uig_empty_title")}
                text={t("uig_empty_text", { query: filter() })}
                action={<Button variant="outlined" size="sm" label={t("uig_empty_reset")} onPress={reset} testID="uig-empty-reset" />}
              />
            </View>
          </If>
          <Each of={GALLERY_GROUPS} key={(item) => item.id}>
            {(item) => (
              <If when={visibleGroups().some((visible) => visible.id === item().id)}>
                <View class="gap-3" testID={`uig-group-${item().id}`}>
                  <View class="gap-0.5">
                    <Text class="font-mono text-xs uppercase tracking-widest text-muted-foreground" role="header">
                      {`${t(item().titleKey)} · ${inGroup(item().id).length}`}
                    </Text>
                    <Text class="text-xs leading-[18px] text-subtle">{t(`${item().titleKey}_note`)}</Text>
                  </View>
                  <View class="flex-row flex-wrap items-start" style={{ gap }}>
                    <Each of={GALLERY_ENTRIES.filter((entry) => entry.group === item().id && entry.mode === "demo")} key={(entry) => entry.id}>
                      {(entry) => (
                        <If when={matchesFilter(entry(), filter())}>
                          <DemoCard entry={entry()} width={cardWidth(DEMOS[entry().id]?.wide === true)} />
                        </If>
                      )}
                    </Each>
                  </View>
                  <If when={inGroup(item().id).some((entry) => entry.mode !== "demo")}>
                    <View class="rounded-(--radius) border border-line-faint bg-card" testID={`uig-notes-${item().id}`}>
                      <Text class="px-4 py-2.5 font-mono text-xs uppercase tracking-widest text-muted-foreground">{t("uig_notes_title")}</Text>
                      <Each of={GALLERY_ENTRIES.filter((entry) => entry.group === item().id && entry.mode !== "demo")} key={(entry) => entry.id}>
                        {(entry) => (
                          <If when={matchesFilter(entry(), filter())}>
                            <NoteRow entry={entry()} />
                          </If>
                        )}
                      </Each>
                    </View>
                  </If>
                </View>
              </If>
            )}
          </Each>
        </View>
      </Scroll>
    </View>
  );
}
