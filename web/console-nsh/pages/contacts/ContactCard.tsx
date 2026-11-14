// A contact's card in the Contacts library (pages/contacts/ContactsPage.tsx), and the avatar with
// its kind badge that the card and the panel show.
//
// The card: the avatar (64pt) is its hero; the name (15pt bold), the kind as a mono readout, and
// under a hairline the channel's logo with the handle in mono. Hovered it takes the column rows'
// soft fill. The selection is the library's, as the column lists' is: one highlight that glides from
// card to card (ContactsPage.tsx), so the card draws none of its own.
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
import { createMotion, effect, Image, Text, untracked, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { ContactAvatar } from "../../components/shared/ContactAvatar";
import { Icon } from "../../components/ui";
import { ROW_TRANSITION } from "../../components/knowledge/parts";
import { FadeText, MOTION_EASE, MOTION_EXIT_EASE, motionMs, PIXEL_RESOLVE_MS, PixelResolve } from "../../components/motion";
import { agentLinkAvatarURL } from "../../lib/core/agent-link-avatar.js";
import { endpointState } from "../../lib/core/context.js";
import { cardHandle, channelLogo, contactAccessibilityLabel, displayName, isAgent, kindText, type Contact } from "./contact-format";

export const contactID = (item: Contact | null | undefined) => String(item?.contact_id || "").trim();

/** The library's grid: its columns, a column's width, the side padding and the gap, in points. */
export interface LibraryGeometry {
  columns: number;
  cell: number;
  pad: number;
  gap: number;
}

/** The card's height; the grid's rows are this tall. */
export const CARD_HEIGHT = 196;

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
      {(logo) => <Image src={logo()} style={{ width: props.size, height: props.size }} accessibilityElementsHidden />}
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
}) {
  const motion = createMotion();

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
    <View style={motion.style}>
      <BaseButton
        testID={`contact-row:${contactID(props.item)}`}
        accessibilityLabel={contactAccessibilityLabel(props.item)}
        selected={props.selected}
        onPress={() => props.onPress()}
        class="items-center rounded-[16px] border border-line-faint bg-card px-3.5 pb-4 pt-[26px] hover:bg-hover-soft"
        style={{ height: CARD_HEIGHT, ...ROW_TRANSITION }}
      >
        <KindAvatar item={props.item} size={64} />
        <View class="mt-4 max-w-full items-center">
          <FadeText text={displayName(props.item)} fade={22} class="text-[15px] font-bold leading-[19.5px] tracking-[-0.01em] text-foreground" />
        </View>
        <Text class="mt-[3px] font-mono text-[10px] uppercase leading-[14px] tracking-[0.14em] text-muted-foreground">{kindText(props.item)}</Text>
        <View class="mt-auto w-full flex-row items-center justify-center gap-1.5 border-t border-line-soft pt-2.5">
          <ChannelMark channel={props.item.channel} size={13} />
          <View class="shrink" style={{ minWidth: 0 }}>
            <FadeText text={cardHandle(props.item)} fade={16} class="font-mono text-[11.5px] leading-[16px] text-muted-foreground" />
          </View>
        </View>
      </BaseButton>
    </View>
  );
}
