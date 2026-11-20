// A test entry (tests/harness.ts `openConsole({ loginProbe: true })`): the console, telling the test
// where the login card's parts are (`morph.fixture.login`: { part, x, y, w, h }, each in its
// parent; pages/login/LoginPage.tsx) and standing in for the QR scanner's page, which a headless
// web view does not run (lib/qrScannerPage.js; its own test is lib/qrScannerPage.test.mjs).
// `app.host.send("morph.fixture.scan.say", { message })` speaks as the newest scan's page would
// (`scan`: an earlier one, from 0), and `app.host.send("morph.fixture.scans")` is answered with a
// `morph.fixture.scans` post: every scan so far, its state and what its page was told.
// `app.host.send("morph.fixture.navigate", { to })` leaves for another page, as a link would.
import { host } from "nsh";
import { type Scan, watchScans } from "../lib/qrScan";
import { watchLoginLayout } from "../pages/login/LoginPage";
import { navigate } from "../lib/router";
import "../App";

const scans: { scan: Scan; told: string[]; attached: boolean }[] = [];

watchLoginLayout((part, frame) =>
  host.post("morph.fixture.login", { part, x: frame.origin.x, y: frame.origin.y, w: frame.size.width, h: frame.size.height }),
);
watchScans((scan) => {
  const entry = { scan, told: [] as string[], attached: false };
  scans.push(entry);
  // What the web view's page is told goes through here on its way to the web view.
  const attach = scan.attach;
  scan.attach = (post) => {
    entry.attached = true;
    attach((message) => {
      entry.told.push(message);
      post(message);
    });
  };
});
host.on("morph.fixture.scan.say", (data) => {
  const { message, scan } = (data || {}) as { message?: unknown; scan?: number };
  const entry = scans[scan ?? scans.length - 1];
  entry?.scan.receive(typeof message === "string" ? message : JSON.stringify(message));
});
host.on("morph.fixture.scans", () =>
  host.post(
    "morph.fixture.scans",
    scans.map((entry) => ({ state: entry.scan.state(), told: [...entry.told], attached: entry.attached })),
  ),
);
host.on("morph.fixture.navigate", (data) => void navigate(String((data as { to?: unknown })?.to || "/")));
