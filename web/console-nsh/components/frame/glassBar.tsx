// A bar over a scrolling area, as glass (lib/glass.ts): the list runs on under the bar, blurred
// behind it, instead of stopping at the bar's foot.
//
// The bar stays where it was in its column, and takes the glass fill and a place above its
// siblings (`glassBarClass`, `glassBarStyle`). The scroller that follows it is pulled up under it by
// the bar's height (`underBar`), and its content starts with that much room (`BarRoom`), so at the
// top of the list everything lies where it did and nothing is hidden; scrolled, the rows pass
// behind the bar:
//
//   <View class={`h-[57px] … ${glassBarClass()}`} style={glassBarStyle()}>…</View>
//   <Scroll class="flex-1" style={underBar()}>
//     <BarRoom />
//     …
//   </Scroll>
//
// Only a scroller directly under its bar takes this: a bar over a toolbar or a framed card (Logs,
// the audit's ledger) has nothing to show behind it and stays as it was. A position in the list
// counted from the scroller's top (a `scrollTo` to a heading) lies `barRoom()` further down.
//
// Where the window draws no glass, all of these are nothing: no room, no pull, no fill, and the
// column is laid out exactly as before.
import { View } from "nsh";
import { glassClass, glassEnabled, glassStyle } from "../../lib/glass";
import { CHROME_BAR_HEIGHT } from "./metrics";

/** The room a glass bar takes over the scroller under it (0 where no glass is drawn). `height`: a bar that is not the page bar's 57pt. */
export function barRoom(height: number = CHROME_BAR_HEIGHT): number {
  return glassEnabled() ? height : 0;
}

/** The classes of a bar over a scroller: the glass fill, above the scroller pulled under it. */
export function glassBarClass(): string {
  return glassEnabled() ? `relative z-10 ${glassClass("bar")}` : "";
}

/** The style of a bar over a scroller (the blur of what scrolls behind it); spread it into the bar's own. */
export const glassBarStyle = glassStyle;

/** The style of the scroller under a glass bar: pulled up behind it. Spread it into the scroller's own. */
export function underBar(height: number = CHROME_BAR_HEIGHT): { marginTop?: number } {
  const room = barRoom(height);
  return room > 0 ? { marginTop: -room } : {};
}

/**
 * The start of the content of a scroller under a glass bar: as tall as the bar, so the first row
 * starts at the bar's foot. Nothing where no glass is drawn. Its test id tells the room
 * (`bar-room-57`). `gap`: the gap the content puts after it (a `gap-*` column), which is part of
 * the room.
 */
export function BarRoom(props: { height?: number; gap?: number } = {}) {
  const room = () => barRoom(props?.height ?? CHROME_BAR_HEIGHT);
  return (
    <If when={room() > 0}>
      <View accessibilityElementsHidden testID={`bar-room-${Math.round(room())}`} style={{ height: Math.max(0, room() - (props?.gap ?? 0)) }} />
    </If>
  );
}
