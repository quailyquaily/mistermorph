// A test entry (tests/harness.ts `openConsole({ barRooms: true })`): the console, telling the test
// where the content of each scroller under a bar starts on the page (components/frame/glassBar.tsx
// `watchBarRooms`), as `morph.fixture.room` posts ({ x, y, w, h, room }). This window draws no
// glass: the content starts at its bar's foot, with no room.
import { host } from "nsh";
import { watchBarRooms } from "../components/frame/glassBar";

// Before the app: App.tsx starts as it loads, but its start awaits the host's boot data first.
watchBarRooms((frame) => host.post("morph.fixture.room", JSON.parse(JSON.stringify(frame))));

import "../App";
