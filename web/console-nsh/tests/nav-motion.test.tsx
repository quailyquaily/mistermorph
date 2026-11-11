// Which way a navigation moves (lib/navMotion.ts) and where a slide's pages start and end
// (components/motion/pageSlide.ts): pure, no app.
import { expect, test } from "nsh/test";
import { slideFrames } from "../components/motion/pageSlide";
import { classifyPageMotion, MotionHistory, navPosition, pagePresentation, reversePageMotion } from "../lib/navMotion";

const E = "/e/default";

test("pages sit in the navigation's order, deeper pages below their page", () => {
  expect(navPosition(`${E}/chat`)).toEqual({ tab: 0, depth: 0, frame: "shell" });
  expect(navPosition(`${E}/chat/topic-1`)).toEqual({ tab: 0, depth: 1, frame: "shell" });
  expect(navPosition(`${E}/chat/topic-1/context`)).toEqual({ tab: 0, depth: 2, frame: "shell" });
  expect(navPosition(`${E}/contacts`).tab).toBe(1);
  expect(navPosition(`${E}/todo`).tab).toBe(2);
  expect(navPosition(`${E}/memories`).tab).toBe(3);
  expect(navPosition(`${E}/skills/store`)).toEqual({ tab: 4, depth: 1, frame: "shell" });
  expect(navPosition(`${E}/stats`).tab).toBe(5);
  expect(navPosition(`${E}/audit`).tab).toBe(6);
  expect(navPosition(`${E}/settings/agent`)).toEqual({ tab: 7, depth: 1, frame: "shell" });
  // Logs opens from Settings → System.
  expect(navPosition(`${E}/logs`)).toEqual({ tab: 7, depth: 2, frame: "shell" });
  expect(navPosition("/login").frame).toBe("shellless");
  expect(navPosition("/overview").frame).toBe("standalone");
  expect(navPosition(`${E}/setup/llm`).frame).toBe("standalone");
  expect(navPosition(`${E}/troubleshooting`).frame).toBe("shellless");
});

test("further in is forward, out again is back, whatever opened it", () => {
  expect(classifyPageMotion(`${E}/chat/topic-1`, `${E}/chat/topic-1/context`)).toBe("forward");
  expect(classifyPageMotion(`${E}/chat/topic-1/context`, `${E}/chat/topic-1`)).toBe("back");
  expect(classifyPageMotion(`${E}/settings/system`, `${E}/logs`)).toBe("forward");
  expect(classifyPageMotion(`${E}/logs`, `${E}/settings/system`)).toBe("back");
  expect(classifyPageMotion(`${E}/skills`, `${E}/skills/store`)).toBe("forward");
  // A TODO's topic: a page further in, though another page of the navigation.
  expect(classifyPageMotion(`${E}/todo`, `${E}/chat/topic-1`)).toBe("forward");
  expect(classifyPageMotion(`${E}/chat/topic-1`, `${E}/todo`)).toBe("back");
  // Another topic, another section: the same depth of the same page.
  expect(classifyPageMotion(`${E}/chat/topic-1`, `${E}/chat/topic-2`)).toBe("none");
  expect(classifyPageMotion(`${E}/settings/agent`, `${E}/settings/tools`)).toBe("none");
});

test("the navigation's pages move in its order", () => {
  expect(classifyPageMotion(`${E}/chat`, `${E}/contacts`)).toBe("tab-forward");
  expect(classifyPageMotion(`${E}/contacts`, `${E}/chat`)).toBe("tab-back");
  expect(classifyPageMotion(`${E}/todo`, `${E}/memories`)).toBe("tab-forward");
  expect(classifyPageMotion(`${E}/settings`, `${E}/skills`)).toBe("tab-back");
  // Asked by the navigation from a page further in: still the strip's order.
  expect(classifyPageMotion(`${E}/settings/agent`, `${E}/audit`, { tab: true })).toBe("tab-back");
  expect(classifyPageMotion(`${E}/chat/topic-1`, `${E}/todo`, { tab: true })).toBe("tab-forward");
  // The same page of the navigation from a page further in: back to it.
  expect(classifyPageMotion(`${E}/settings/agent`, `${E}/settings`, { tab: true })).toBe("back");
});

test("the first page, another agent's copy and a change of frame", () => {
  expect(classifyPageMotion(null, `${E}/chat`)).toBe("none");
  expect(classifyPageMotion(`${E}/chat`, `${E}/chat`)).toBe("none");
  expect(classifyPageMotion(`${E}/chat`, "/e/other/chat")).toBe("none");
  expect(classifyPageMotion("/login", `${E}/chat`)).toBe("fade");
  expect(classifyPageMotion(`${E}/chat`, "/overview")).toBe("fade");
  // A history step whose direction is unknown, between pages of no order: back.
  expect(classifyPageMotion(`${E}/chat/topic-1`, `${E}/settings/agent`, { pop: true })).toBe("back");
  expect(classifyPageMotion(`${E}/chat/topic-1`, `${E}/settings/agent`)).toBe("forward");
});

test("history replays each step's motion: reversed going back, again going forward", () => {
  const history = new MotionHistory();
  history.replace(`${E}/todo`);
  history.push(`${E}/contacts`, "tab-back");
  history.push(`${E}/chat/topic-1`, "forward");
  expect(history.pop(`${E}/contacts`)).toBe("back");
  expect(history.pop(`${E}/todo`)).toBe("tab-forward");
  expect(history.pop(`${E}/contacts`)).toBe("tab-back");
  expect(history.pop(`${E}/chat/topic-1`)).toBe("forward");
  // A replace keeps the motion that came to the place.
  history.replace(`${E}/chat/topic-2`);
  expect(history.pop(`${E}/contacts`)).toBe("back");
  // Somewhere neither before nor after: unknown, and the history starts again there.
  expect(history.pop(`${E}/stats`)).toBe(null);
  expect(history.current()).toEqual({ location: `${E}/stats`, motion: "none" });
});

test("the phone app's history drops a place replaced by the one before", () => {
  const history = new MotionHistory(true);
  history.replace(`${E}/chat`);
  history.push(`${E}/chat/topic-1`, "forward");
  history.replace(`${E}/chat`);
  expect(history.current()).toEqual({ location: `${E}/chat`, motion: "none" });
  expect(history.pop(`${E}/todo`)).toBe(null);
});

test("each motion's presentation: slides on phones, the entrance on wide windows, nothing with reduced motion", () => {
  const phone = { stacked: true, reduced: false, topChanged: true };
  expect(pagePresentation("forward", phone)).toBe("push");
  expect(pagePresentation("back", phone)).toBe("pop");
  expect(pagePresentation("tab-forward", phone)).toBe("tab-forward");
  expect(pagePresentation("tab-back", phone)).toBe("tab-back");
  expect(pagePresentation("fade", phone)).toBe("rise");
  expect(pagePresentation("none", phone)).toBe("none");
  expect(pagePresentation("forward", { ...phone, reduced: true })).toBe("none");
  expect(pagePresentation("tab-back", { ...phone, reduced: true })).toBe("none");
  const wide = { stacked: false, reduced: false, topChanged: true };
  expect(pagePresentation("tab-forward", wide)).toBe("rise");
  expect(pagePresentation("forward", { ...wide, topChanged: false })).toBe("none");
  expect(reversePageMotion("tab-forward")).toBe("tab-back");
  expect(reversePageMotion("none")).toBe("none");
});

test("slides: further in over the page, back out over it, the navigation's pages side by side", () => {
  expect(slideFrames("push", 390)).toEqual({ incoming: [390, 0], outgoing: [0, -117], top: "incoming" });
  expect(slideFrames("pop", 390)).toEqual({ incoming: [-117, 0], outgoing: [0, 390], top: "outgoing" });
  expect(slideFrames("tab-forward", 390)).toEqual({ incoming: [390, 0], outgoing: [0, -390], top: "none" });
  expect(slideFrames("tab-back", 390)).toEqual({ incoming: [-390, 0], outgoing: [0, 390], top: "none" });
});
