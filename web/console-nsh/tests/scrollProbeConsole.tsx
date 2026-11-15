// A test entry (tests/harness.ts `openConsole({ scrollProbe: true })`): the console, telling the
// test where its pages' remembered scrollers are (lib/scrollMemory.ts). Each area's offset goes to
// the host as it scrolls (`morph.fixture.scroll`: { key, y }), and what is remembered now when the
// test asks (`app.host.send("morph.fixture.saved")` answers with a `morph.fixture.saved` post).
import { host } from "nsh";
import { savedScrollAreas, watchScrollAreas } from "../lib/scrollMemory";
import "../App";

watchScrollAreas((key, y) => host.post("morph.fixture.scroll", { key, y: Math.round(y) }));
host.on("morph.fixture.saved", () => host.post("morph.fixture.saved", JSON.parse(JSON.stringify(savedScrollAreas()))));
