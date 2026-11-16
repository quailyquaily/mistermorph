// The gallery's demos by inventory id (../inventory.js): one per component shown as `demo`.
import type { DemoMap } from "../demo";
import { CHAT_DEMOS } from "./chat";
import { CONTROL_DEMOS } from "./controls";
import { FRAME_DEMOS } from "./frame";
import { KNOWLEDGE_DEMOS } from "./knowledge";
import { MOTION_DEMOS } from "./motion";
import { OVERLAY_DEMOS } from "./overlays";
import { SETTINGS_DEMOS } from "./settings";

export const DEMOS: DemoMap = {
  ...CONTROL_DEMOS,
  ...OVERLAY_DEMOS,
  ...MOTION_DEMOS,
  ...KNOWLEDGE_DEMOS,
  ...SETTINGS_DEMOS,
  ...CHAT_DEMOS,
  ...FRAME_DEMOS,
};
