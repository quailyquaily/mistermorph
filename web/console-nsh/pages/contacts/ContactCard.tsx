// A contact's card in the Contacts library (pages/contacts/ContactsPage.tsx), and the avatar with
// its kind badge that the card and the panel show.
//
// The card: the avatar (64pt) is its hero; the name (15pt bold), the kind as a mono readout, and
// under a hairline the channel's logo with the handle in mono. Hovered it takes the column rows'
// soft fill. The selection is the library's, as the column lists' is: one highlight that glides from
// card to card (ContactsPage.tsx), so the card draws none of its own.
//
// On a phone the library keeps at least three cards a row, so there the card is compact
// (`geometry.compact`): the same parts in the same order, smaller: a 44pt avatar, the name at 13pt,
// the kind at 9pt, the handle at 10pt, less padding, a lower card (COMPACT_CARD_HEIGHT). Each line
// stays one line cut to the card's width (the name and the handle fade out, FadeText); the whole
// card is still the button, and its accessibility label still says all of it.
//
// It moves when the library does (`motion()`), from where it was to where it is, both read from
// `places` (the page's memory of each card's index and the grid it was in, kept across the
// virtualized list's recycling and remounts):
// - "glide" (the panel opening or closing narrows or widens the grid, a filter): a card that stays
//   in its row slides along it; one that changes rows fades in where it lands, rather than cross
//   the grid; one that was not shown before (a filter let it back) grows in.
// - "cascade" (the first load): a diagonal rise from the top left, done within about 300 ms.
// - nothing (scrolling): it is where it is.
// A filter taking it out (`leaving`) shrinks and fades it out first. Reduced motion: no motion.
import { cleanup, createMotion, effect, Image, Text, untracked, View } from "nsh";
import type { ViewRef } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { ContactAvatar } from "../../components/shared/ContactAvatar";
import { Icon } from "../../components/ui";
import { ROW_TRANSITION } from "../../components/knowledge/parts";
import { createPartProbe, type PartLayoutListener } from "../../components/shared/partProbe";
import { FadeText, MOTION_EASE, MOTION_EXIT_EASE, motionMs, PIXEL_RESOLVE_MS, PixelResolve } from "../../components/motion";
import { agentLinkAvatarURL } from "../../lib/core/agent-link-avatar.js";
import { endpointState } from "../../lib/core/context.js";
import { cardHandle, channelLogo, contactAccessibilityLabel, displayName, isAgent, kindText, type Contact } from "./contact-format";

export const contactID = (item: Contact | null | undefined) => String(item?.contact_id || "").trim();

/** The library's grid: its columns, a column's width, the side padding and the gap, in points;
 *  a card's height (the grid's rows are this tall), and whether the cards are the compact ones. */
export interface LibraryGeometry {
  columns: number;
  cell: number;
  pad: number;
  gap: number;
  height: number;
  compact: boolean;
}

/** The card's height, and the compact card's (a phone's three or more a row). */
export const CARD_HEIGHT = 196;
export const COMPACT_CARD_HEIGHT = 142;

/** What differs between the card and the compact card. */
const LOOK = {
  regular: {
    avatar: 64,
    card: "px-3.5 pb-4 pt-[26px]",
    nameBox: "mt-4",
    name: "text-[15px] font-bold leading-[19.5px] tracking-[-0.01em] text-foreground",
    nameFade: 22,
    kind: "mt-[3px] max-w-full font-mono text-[10px] uppercase leading-[14px] tracking-[0.14em] text-muted-foreground",
    foot: "gap-1.5 pt-2.5",
    mark: 13,
    handle: "font-mono text-[11.5px] leading-[16px] text-muted-foreground",
    handleFade: 16,
  },
  compact: {
    avatar: 44,
    card: "px-2 pb-2.5 pt-4",
    nameBox: "mt-2.5",
    name: "text-[13px] font-bold leading-[17px] tracking-[-0.01em] text-foreground",
    nameFade: 14,
    kind: "mt-0.5 max-w-full font-mono text-[9px] uppercase leading-[12px] tracking-[0.1em] text-muted-foreground",
    foot: "gap-1 pt-[7px]",
    mark: 11,
    handle: "font-mono text-[10px] leading-[14px] text-muted-foreground",
    handleFade: 12,
  },
};

/** Where card `index` lies in `geometry`: its row and column, and its left edge. */
export function cardPlace(index: number, geometry: LibraryGeometry) {
  const columns = Math.max(1, geometry.columns);
  const column = index % columns;
  return { column, row: Math.floor(index / columns), x: geometry.pad + column * (geometry.cell + geometry.gap) };
}

export type LibraryMotion = "glide" | "cascade" | null;

/**
 * The avatar with its kind badge (a person or an agent) at its lower right: a white disc 22 % of
 * the avatar wide, 1pt past its edge, the avatar cut away round it (Vue .contacts-kind-badge).
 * `resolve`: the avatar comes into focus from coarse pixels each time it changes (PixelResolve), and
 * the badge, which stays out of the shader (its icon is a mask the shader's picture does not keep),
 * pops in once it has.
 */
export function KindAvatar(props: { item: Contact; size: number; resolve?: string }) {
  const scale = () => props.size / 64;
  const badge = () => Math.round(14 * scale());
  const centre = () => props.size - 6 * scale();
  const badgeMotion = createMotion();
  effect(() => {
    if (props.resolve === undefined) return;
    void props.resolve;
    untracked(() => {
      const ms = motionMs(220);
      if (ms <= 0) return;
      badgeMotion.opacity.set(0);
      badgeMotion.scale.set(0.4);
      void badgeMotion.play(
        { keyframes: { opacity: [{ value: 0, easing: MOTION_EASE }, 1], scale: [{ value: 0.4, easing: MOTION_EASE }, 1] } },
        { duration: ms, delay: motionMs(PIXEL_RESOLVE_MS) - 40 },
      );
    });
  });
  const avatar = () => (
    <ContactAvatar
      item={props.item}
      imageURL={agentLinkAvatarURL(props.item, endpointState.items)}
      name={displayName(props.item)}
      endpointRef={endpointState.selectedRef}
      size={props.size}
      notch={{ x: centre(), y: centre(), r: 9 * scale() }}
    />
  );
  return (
    <View class="relative" accessibilityElementsHidden style={{ width: props.size, height: props.size }}>
      <If when={props.resolve !== undefined} else={avatar()}>
        <PixelResolve watch={props.resolve} size={props.size}>
          {avatar()}
        </PixelResolve>
      </If>
      <View
        class="absolute -bottom-px -right-px items-center justify-center rounded-full bg-white"
        style={{ width: badge(), height: badge(), boxShadow: "inset 0 0 0 1px rgba(24, 24, 50, 0.09)", ...badgeMotion.style }}
      >
        <Icon
          name={isAgent(props.item) ? "PhCpu" : "PhUserCircle"}
          size={Math.round(10 * scale())}
          color={isAgent(props.item) ? "ink" : "blue"}
        />
      </View>
    </View>
  );
}

/** The channel's logo, or an icon for a channel without one (the console's terminal, a link). */
export function ChannelMark(props: { channel: unknown; size: number }) {
  const key = () => String(props.channel || "").trim().toLowerCase();
  return (
    <If
      when={channelLogo(key())}
      else={<Icon name={key() === "console" ? "PhTerminalWindow" : "PhLink"} size={props.size} color="muted-foreground" />}
    >
      {(logo) => <Image class="overflow-hidden" src={logo()} style={{ width: props.size, height: props.size }} accessibilityElementsHidden />}
    </If>
  );
}

export function ContactCard(props: {
  item: Contact;
  index: number;
  geometry: LibraryGeometry;
  /** What moves the library now (see the head of this file). */
  motion: () => LibraryMotion;
  /** The page's memory of where each card was: its index and grid. */
  places: Map<string, { index: number; geometry: LibraryGeometry }>;
  /** The library's selection is on it (for screen readers; the highlight is the library's). */
  selected: boolean;
  /** A filter is taking it out. */
  leaving: boolean;
  onPress: () => void;
  /** For tests: where the card and its parts lie on the page (`card:<id>`, `avatar:<id>`,
   *  `name:<id>`, `kind:<id>`, `foot:<id>`, `handle:<id>`). */
  onPartLayout?: PartLayoutListener;
}) {
  const motion = createMotion();
  const look = () => (props.geometry.compact ? LOOK.compact : LOOK.regular);
  // The probe (tests): each part reports its frame when it is laid out, and all of them again when
  // the card moves in the grid (a filter, a recycled cell), which changes no layout of its own.
  const parts = createPartProbe(() => props.onPartLayout);
  const nodes = new Map<string, ViewRef>();
  const report = (name: string) => parts.report(`${name}:${contactID(props.item)}`, nodes.get(name));
  const part = (name: string) => (props.onPartLayout ? { ref: (node: ViewRef) => void nodes.set(name, node), onLayout: () => report(name) } : {});
  effect(() => {
    void props.index;
    void props.item;
    if (!props.onPartLayout) return;
    const timer = setTimeout(() => nodes.forEach((_, name) => report(name)), 50);
    cleanup(() => clearTimeout(timer));
  });

  effect(() => {
    const id = contactID(props.item);
    const index = props.index;
    const geometry = props.geometry;
    untracked(() => {
      const before = props.places.get(id);
      props.places.set(id, { index, geometry });
      const kind = props.motion();
      if (!kind || motionMs(1) <= 0) return;
      const now = cardPlace(index, geometry);
      if (kind === "cascade" && !before) {
        motion.opacity.set(0);
        motion.translateY.set(8);
        void motion.play(
          { keyframes: { opacity: [{ value: 0, easing: MOTION_EASE }, 1], translateY: [{ value: 8, easing: MOTION_EASE }, 0], scale: [{ value: 0.985, easing: MOTION_EASE }, 1] } },
          { duration: 360, delay: Math.min(260, (now.column + now.row) * 34) },
        );
        return;
      }
      if (kind !== "glide") return;
      if (!before) {
        // Shown again (a filter let it back): it grows in.
        motion.opacity.set(0);
        void motion.play(
          { keyframes: { opacity: [{ value: 0, easing: MOTION_EASE }, 1], scale: [{ value: 0.94, easing: MOTION_EASE }, 1] } },
          { duration: 260, delay: 60 },
        );
        return;
      }
      if (before.index === index && before.geometry === geometry) return;
      const was = cardPlace(before.index, before.geometry);
      if (was.row !== now.row) {
        // Another row: it fades in where it lands instead of crossing the grid.
        motion.opacity.set(0);
        void motion.play(
          { keyframes: { opacity: [{ value: 0, easing: MOTION_EASE }, 1], scale: [{ value: 0.97, easing: MOTION_EASE }, 1] } },
          { duration: 240, delay: 100 },
        );
      } else if (Math.abs(was.x - now.x) > 0.5) {
        // The same row: it slides along it.
        motion.translateX.set(was.x - now.x);
        void motion.translateX.timing(0, { duration: motionMs(300), easing: MOTION_EASE });
      }
    });
  });

  // A filter taking it out: it shrinks a little and fades, before the grid closes ranks.
  effect(() => {
    if (!props.leaving) return;
    untracked(() => {
      if (motionMs(1) <= 0) return;
      void motion.play(
        { keyframes: { opacity: [{ value: 1, easing: MOTION_EXIT_EASE }, 0], scale: [{ value: 1, easing: MOTION_EXIT_EASE }, 0.94] } },
        { duration: 140 },
      );
    });
  });

  return (
    <View style={motion.style} {...part("card")}>
      <BaseButton
        testID={`contact-row:${contactID(props.item)}`}
        accessibilityLabel={contactAccessibilityLabel(props.item)}
        selected={props.selected}
        onPress={() => props.onPress()}
        class={`items-center rounded-[16px] border border-line-faint bg-card hover:bg-hover-soft ${look().card}`}
        style={{ height: props.geometry.height, ...ROW_TRANSITION }}
      >
        <View {...part("avatar")}>
          <Each of={[look().avatar]} key={(size) => size}>
            {(size) => <KindAvatar item={props.item} size={size()} />}
          </Each>
        </View>
        <View class={`max-w-full items-center ${look().nameBox}`} {...part("name")}>
          <FadeText text={displayName(props.item)} fade={look().nameFade} class={look().name} />
        </View>
        <Text class={look().kind} style={{ numberOfLines: 1 }} {...part("kind")}>
          {kindText(props.item)}
        </Text>
        <View class={`mt-auto w-full flex-row items-center justify-center border-t border-line-soft ${look().foot}`} {...part("foot")}>
          <ChannelMark channel={props.item.channel} size={look().mark} />
          <View class="shrink" style={{ minWidth: 0 }} {...part("handle")}>
            <FadeText text={cardHandle(props.item)} fade={look().handleFade} class={look().handle} />
          </View>
        </View>
      </BaseButton>
    </View>
  );
}
