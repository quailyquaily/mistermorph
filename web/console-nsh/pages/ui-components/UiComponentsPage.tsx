// The UI component gallery (/ui-components): the console's colour scheme (every token of
// theme.json, ./colors.ts) and its reused UI components (the ones more than one area of the
// console uses; ./inventory.js says which) on one page, for looking at, pressing and reading in
// each language and in the light and the dark appearance. It is a testing page: it has a route and no
// entry in any navigation. The route is guarded as any workspace page is (a session, a finished
// setup), and nothing on the page talks to the console or an agent: the demos mount the production
// components with synthetic props and local state (./demo.tsx, ./demos), one per entry of the
// inventory, and the language control is the
// console's own (`localeState.setLanguage`, the one catalog in lib/i18n).
// Only the demos near the visible part of the page are mounted (`DemoCard`): many of them draw on
// every frame (spinners, beams, clocks), wherever on the page they are.
// docs/console/ui-components.md describes it.
import type { ScrollRef } from "nsh";
import { computed, Scroll, signal, Text, token, untracked, View, windowSize } from "nsh";
import { LANGUAGES } from "../../components/LanguageSelector";
import { createSlidingSelection } from "../../components/motion/SlidingSelection";
import { EdgeScroll } from "../../components/motion/ScrollEdges";
import { Button, EmptyState, Icon, Tabs, TextField, TipButton } from "../../components/ui";
import { CARD_CORNERS } from "../../components/corners";
import { currentRoute } from "../../lib/router";
import { localeState, themeState } from "../../lib/stores/index.js";
import { COLOR_SECTIONS, COLOR_TOKENS, type ColorSchemeName, type ColorToken } from "./colors";
import { galleryAction, galleryActionCount, t } from "./demo";
import { DEMOS } from "./demos";
import { GALLERY_ENTRIES, GALLERY_GROUPS, type GalleryEntry } from "./inventory.js";

const ALL = "all";
/** The colour scheme's section: not components, so not in the inventory. */
const COLORS = "colors";

/** A token of the colour scheme: its colour as the app draws it now, its name, and its value in the palette shown. */
function ColorSwatch(props: { color: ColorToken; scheme: ColorSchemeName }) {
  return (
    <View class="w-52 flex-row items-center gap-2.5" testID={`uig-color-${props.color.name}`}>
      {/* On the page's ground, with a hairline: a translucent or near-white token still shows its edge. */}
      <View class="size-9 rounded-(--radius-control) border border-line-soft" style={{ backgroundColor: String(token(props.color.name as Parameters<typeof token>[0])) }} />
      <View class="min-w-0 flex-1">
        <Text class="font-mono text-xs text-foreground" style={{ numberOfLines: 1 }}>{props.color.name}</Text>
        <Text class="font-mono text-[11px] text-muted-foreground" style={{ numberOfLines: 1 }}>{props.color[props.scheme].toLowerCase()}</Text>
      </View>
    </View>
  );
}

/** Whether an entry matches the filter: its name or its file. */
export function matchesFilter(entry: GalleryEntry, needle: string) {
  const want = needle.trim().toLowerCase();
  if (!want) return true;
  return [entry.name, entry.id, entry.file].some((text) => text.toLowerCase().includes(want));
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

/** The sections' sidebar's width on a wide window. */
const SIDEBAR_WIDTH = 232;

/**
 * A section's row in the sidebar, as the Settings page's index draws its sections: the title, the
 * count of its components after it; the selected one is marked by the sidebar's one highlight.
 */
function SectionRow(props: {
  id: string;
  label: string;
  count: number;
  active: boolean;
  onPress: () => void;
  onLayout: (event: { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } }) => void;
}) {
  return (
    <View onLayout={props.onLayout}>
      <TipButton
        selected={props.active}
        onPress={props.onPress}
        accessibilityLabel={props.label}
        testID={`uig-index-${props.id}`}
        class={`min-h-10 flex-row items-center gap-2.5 rounded-(--radius) border border-transparent py-2 pl-3.5 pr-[13px] transition-colors duration-180 ${
          props.active ? "hover:bg-blue/3" : "hover:bg-hover-soft"
        }`}
      >
        <Text class="flex-1 text-sm leading-[18.2px] tracking-tight text-foreground line-clamp-2">{props.label}</Text>
        <Text class="font-mono text-[11px] text-muted-foreground">{String(props.count)}</Text>
      </TipButton>
    </View>
  );
}

/** How far past the visible part of the page a demo stays mounted, in points. */
const NEAR = 600;
/** The visible part moves the demos in steps of this many points, not on every scroll event. */
const STEP = 200;
/** A demo's height before it was ever mounted. */
const UNSEEN_HEIGHT = 120;

/**
 * A component's card. Its demo is mounted only while the card is near the visible part of the
 * page (`span`, in the scroll content's coordinates; `top` is where the card's row of cards starts
 * in them): a demo that animates draws on every frame even when it is far off screen, and the page
 * has dozens of them. A demo that is not mounted keeps the height it had, so nothing moves when
 * it leaves or comes back; its local state starts over.
 */
function DemoCard(props: { entry: GalleryEntry; width: number; top: number; span: { from: number; to: number } }) {
  const demo = DEMOS[props.entry.id];
  // The card's frame in its row, and the demo's height when it was last mounted.
  const frame = signal({ y: 0, height: 0 });
  const held = signal(UNSEEN_HEIGHT);
  const near = computed(() => {
    const from = props.top + frame().y;
    return from <= props.span.to + NEAR && from + frame().height >= props.span.from - NEAR;
  });
  return (
    <View
      class={`overflow-hidden ${CARD_CORNERS} border border-line-faint bg-card`}
      style={{ width: props.width }}
      testID={`uig-demo-${props.entry.id}`}
      accessibilityLabel={props.entry.name}
      onLayout={({ bounds }) => {
        const next = { y: Math.round(bounds.origin.y), height: Math.round(bounds.size.height) };
        if (next.y !== frame().y || next.height !== frame().height) frame.set(next);
      }}
    >
      <View class="gap-0.5 border-b border-line-soft px-4 py-2.5">
        <Text class="font-mono text-sm font-medium text-foreground" role="header">{props.entry.name}</Text>
        <Text class="font-mono text-[11px] text-muted-foreground">{props.entry.file}</Text>
      </View>
      <If when={near()} else={<View style={{ height: held() }} testID={`uig-demo-away-${props.entry.id}`} />}>
        <View
          class="min-w-0 p-4"
          onLayout={({ bounds }) => {
            const height = Math.round(bounds.size.height);
            if (height > 0 && height !== held()) held.set(height);
          }}
        >
          {demo ? demo.render() : null}
        </View>
      </If>
    </View>
  );
}

export function UiComponentsPage() {
  // The address may name where to start: `/ui-components?group=chat&q=composer`. It is read once;
  // the controls below do not write it back.
  const query = untracked(() => currentRoute().query);
  const filter = signal(String(query.q ?? ""));
  const group = signal(query.group === COLORS || GALLERY_GROUPS.some((item) => item.id === query.group) ? query.group : ALL);
  // The colour scheme: a section of its own in the index, shown alone (`All` is every component),
  // its tokens by the filter.
  const scheme = (): ColorSchemeName => (themeState.scheme === "dark" ? "dark" : "light");
  const colorMatches = (color: ColorToken) => {
    const want = filter().trim().toLowerCase();
    return !want || color.name.includes(want) || color.light.toLowerCase().includes(want) || color.dark.toLowerCase().includes(want);
  };
  const shownColors = computed(() => COLOR_TOKENS.filter(colorMatches));
  const colorsVisible = () => group() === COLORS && shownColors().length > 0;
  const shown = computed(() => GALLERY_ENTRIES.filter((entry) => matchesFilter(entry, filter())));
  const inGroup = (id: string) => shown().filter((entry) => entry.group === id);
  const visibleGroups = computed(() => GALLERY_GROUPS.filter((item) => (group() === ALL || group() === item.id) && inGroup(item.id).length > 0));
  // Choosing a section shows it from its start: the page goes back to its top, wherever it was
  // (else a press on the section already on screen, or on a shorter one, shows no change).
  let scroller: ScrollRef | undefined;
  const pick = (id: string) => {
    group.set(id);
    scroller?.scrollTo({ y: 0, animated: false });
  };
  const reset = () => {
    filter.set("");
    pick(ALL);
  };
  // The visible part of the scroll content, in steps (a demo is mounted near it, `DemoCard`), and
  // where each section and its row of cards start in the content.
  const span = signal({ from: 0, to: untracked(() => windowSize().height) });
  const see = (offset: number, height: number) => {
    const from = Math.max(0, Math.floor(offset / STEP) * STEP);
    const to = Math.ceil((offset + height) / STEP) * STEP;
    if (from !== span().from || to !== span().to) span.set({ from, to });
  };
  let scrolled = 0;
  const tops = signal<Record<string, number>>({});
  const place = (key: string, y: number) => {
    const next = Math.round(y);
    if (tops()[key] !== next) tops.update((all) => ({ ...all, [key]: next }));
  };
  const cardsTop = (id: string) => (tops()[`group:${id}`] ?? 0) + (tops()[`cards:${id}`] ?? 0);
  // The sections: a sidebar beside the page on a wide window, a row of chips in the head on a
  // narrow one (a phone), where a sidebar would leave the cards no room.
  const sidebar = () => windowSize().width > 900;
  const selection = createSlidingSelection(() => (sidebar() ? group() : null));
  // The page's own gutters and columns: one column on a phone, two on a wide window, three on a
  // very wide one. A card never takes more than the page's width; what is wider scrolls inside it.
  const pad = () => (windowSize().width <= 640 ? 12 : 24);
  const gap = 16;
  const room = () => Math.max(240, windowSize().width - (sidebar() ? SIDEBAR_WIDTH : 0) - pad() * 2);
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
          {/* The console's own appearance, as the language beside it is the console's own. */}
          <View testID="uig-appearance">
            <Tabs
              narrow
              accessibilityLabel={t("settings_appearance_title")}
              items={[
                { id: "light", label: t("settings_appearance_light") },
                { id: "dark", label: t("settings_appearance_dark") },
              ]}
              value={scheme()}
              onChange={(id) => themeState.setScheme(id)}
            />
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
        <If when={!sidebar()}>
          <EdgeScroll horizontal class="-mx-1" contentClass="flex-row gap-1.5 px-1" testID="uig-index">
            <Chip id={ALL} label={t("uig_group_all")} count={shown().length} active={group() === ALL} onPress={() => pick(ALL)} />
            <Chip id={COLORS} label={t("uig_group_colors")} count={shownColors().length} active={group() === COLORS} onPress={() => pick(COLORS)} />
            <Each of={GALLERY_GROUPS} key={(item) => item.id}>
              {(item) => (
                <Chip id={item().id} label={t(item().titleKey)} count={inGroup(item().id).length} active={group() === item().id} onPress={() => pick(item().id)} />
              )}
            </Each>
          </EdgeScroll>
        </If>
      </View>
      <View class="min-h-0 flex-1 flex-row">
      <If when={sidebar()}>
        <Scroll class="border-r border-line-soft" style={{ width: SIDEBAR_WIDTH }} testID="uig-index">
          <View class="relative gap-0.5 p-3">
            <selection.Highlight class="rounded-(--radius) bg-selection" />
            <SectionRow id={ALL} label={t("uig_group_all")} count={shown().length} active={group() === ALL} onPress={() => pick(ALL)} onLayout={selection.track(ALL)} />
            <SectionRow id={COLORS} label={t("uig_group_colors")} count={shownColors().length} active={group() === COLORS} onPress={() => pick(COLORS)} onLayout={selection.track(COLORS)} />
            <Each of={GALLERY_GROUPS} key={(item) => item.id}>
              {(item) => (
                <SectionRow
                  id={item().id}
                  label={t(item().titleKey)}
                  count={inGroup(item().id).length}
                  active={group() === item().id}
                  onPress={() => pick(item().id)}
                  onLayout={selection.track(item().id)}
                />
              )}
            </Each>
          </View>
        </Scroll>
      </If>
      <Scroll
        ref={(ref: ScrollRef) => (scroller = ref)}
        class="min-w-0 flex-1"
        testID="uig-scroll"
        onLayout={({ bounds }) => see(scrolled, bounds.size.height)}
        onScroll={(event) => {
          scrolled = event.offset.y;
          see(scrolled, event.size.height);
        }}
      >
        <View class="gap-8 py-5" style={{ paddingHorizontal: pad() }}>
          <If when={colorsVisible()}>
            <View class="gap-3" testID="uig-group-colors">
              <View class="gap-0.5">
                <Text class="font-mono text-xs uppercase tracking-widest text-muted-foreground" role="header">
                  {`${t("uig_group_colors")} · ${shownColors().length}`}
                </Text>
                <Text class="text-xs leading-[18px] text-subtle">{t("uig_group_colors_note")}</Text>
              </View>
              <View class={`gap-4 ${CARD_CORNERS} border border-line-faint bg-card p-4`}>
                <Each of={COLOR_SECTIONS} key={(section) => section.id}>
                  {(section) => (
                    <If when={section().tokens.some(colorMatches)}>
                      <View class="gap-2.5" testID={`uig-colors-${section().id}`}>
                        <Text class="font-mono text-[10px] uppercase tracking-[0.6px] text-muted-foreground">{t(section().titleKey)}</Text>
                        <View class="flex-row flex-wrap gap-x-4 gap-y-3">
                          <Each of={section().tokens} key={(color) => color.name}>
                            {(color) => (
                              <If when={colorMatches(color())}>
                                <ColorSwatch color={color()} scheme={scheme()} />
                              </If>
                            )}
                          </Each>
                        </View>
                      </View>
                    </If>
                  )}
                </Each>
              </View>
            </View>
          </If>
          <If when={visibleGroups().length === 0 && !colorsVisible()}>
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
                <View class="gap-3" testID={`uig-group-${item().id}`} onLayout={({ bounds }) => place(`group:${item().id}`, bounds.origin.y)}>
                  <View class="gap-0.5">
                    <Text class="font-mono text-xs uppercase tracking-widest text-muted-foreground" role="header">
                      {`${t(item().titleKey)} · ${inGroup(item().id).length}`}
                    </Text>
                    <Text class="text-xs leading-[18px] text-subtle">{t(`${item().titleKey}_note`)}</Text>
                  </View>
                  <View class="flex-row flex-wrap items-start" style={{ gap }} onLayout={({ bounds }) => place(`cards:${item().id}`, bounds.origin.y)}>
                    <Each of={GALLERY_ENTRIES.filter((entry) => entry.group === item().id)} key={(entry) => entry.id}>
                      {(entry) => (
                        <If when={matchesFilter(entry(), filter())}>
                          <DemoCard entry={entry()} width={cardWidth(DEMOS[entry().id]?.wide === true)} top={cardsTop(item().id)} span={span()} />
                        </If>
                      )}
                    </Each>
                  </View>
                </View>
              </If>
            )}
          </Each>
        </View>
      </Scroll>
      </View>
    </View>
  );
}
