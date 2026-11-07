// Extension points of the frame (the Vue console's ext/slots): a build that ships extra features
// sets these to components; the open build leaves them empty, and the frame then shows nothing.
//
// - `sidebar.before_runtime`: in the sidebar's navigation, just before the Settings link (not in
//   the folded sidebar), and likewise in the phone's More menu.
// - `sidebar.bottom_left`: at the foot of the sidebar (not in the folded sidebar), and at the foot
//   of the phone's More menu.
import type { JSX } from "nsh";
import type { EndpointItem } from "../../lib/shell";

export interface SidebarSlotProps {
  selectedEndpointItem: EndpointItem | null;
  currentPath: string;
  /** In the phone's More menu. */
  mobile?: boolean;
  t: (key: string, vars?: Record<string, unknown>) => string;
}

export type SidebarSlot = (props: SidebarSlotProps) => JSX.Element;

export const uiSlots: Record<"sidebar.before_runtime" | "sidebar.bottom_left", SidebarSlot | null> = {
  "sidebar.before_runtime": null,
  "sidebar.bottom_left": null,
};
