// A test entry (tests/harness.ts `openConsole({ slowSlides: true })`): the console with every page
// and pane slide stretched to a minute, so a test acts while a page or a pane is still going out
// (Android's Back during a slide). Headless steps never wait for a slide, so it stays part-way
// until a navigation ends it.
import { nativeSlide } from "../components/motion/pageSlide";
// App.tsx starts the app as it loads, but its start awaits the host's boot data first: the driver
// below is changed before any page mounts.
import "../App";

export const SLOW_SLIDE_MS = 60_000;

const play = nativeSlide.play.bind(nativeSlide);
nativeSlide.play = (motion, from, to) => play(motion, from, to, SLOW_SLIDE_MS);
