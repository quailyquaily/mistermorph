// A test entry (tests/harness.ts `openConsole({ glass: true, barRooms: true })`): as
// tests/barRoomConsole.tsx, in a window that draws glass (tests/glassConsole.tsx): each scroller is
// pulled up under its bar and its content starts with the bar's room.
import { host } from "nsh";
import { watchBarRooms } from "../components/frame/glassBar";
import { forceGlass } from "../lib/glass";

watchBarRooms((frame) => host.post("morph.fixture.room", JSON.parse(JSON.stringify(frame))));
forceGlass(true);

import "../App";
