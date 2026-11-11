// The page host: one layer per page instance, and the motion between two of them when a
// navigation commits (lib/router.ts decides which way, lib/navMotion.ts how it is drawn).
//
// On phones a page further in slides in from the right, going back slides it out to the right
// over the page it reveals, and the navigation's pages move side by side as tiles in its order
// (components/motion/pageSlide.ts). Wide windows keep the console's entrance: a new top-level
// page rises into place, the old one goes at once. The first page, the same page with other data
// and reduced motion switch at once.
//
// The outgoing page stays mounted through its exit, inert: no presses (pointerEvents), hidden
// from assistive tech, its text field blurred, and following its own last route
// (PageRouteContext), never the next page's. A new navigation during a slide ends it where it
// should end (the obsolete outgoing page goes at once) and starts its own; a resize, a rotation
// or a change of the reduced-motion setting ends it too. Only committed navigations move pages:
// a navigation whose guard is still running or that was cancelled changes nothing here.
//
// The frame around (sidebar, bottom navigation, banners) is outside this host and never moves.
import type { JSX, Motion, Signal } from "nsh";
import { computed, createMotion, effect, Keyboard, reduceMotion, signal, untracked, View, windowSize } from "nsh";
import { navigation, PageRouteContext, route, type Route } from "../../lib/router";
import { pagePresentation, topPageOf, type PagePresentation } from "../../lib/navMotion";
import { playRise } from "../motion/Entrance";
import { currentX, FILL, isSlide, nativeSlide, OUTGOING_A11Y, pageSlideMs, slideFrames, type SlideDriver } from "../motion/pageSlide";

interface Layer {
  id: number;
  key: string;
  /** How it came in: the testID says it (`page-layer.in.push`). */
  presentation: PagePresentation;
  /** translateX it mounts at (the start of its slide). */
  startX: number;
  out: Signal<boolean>;
  z: Signal<number>;
  /** The route it shows: its own last one (see PageRouteContext). */
  path: string;
  motion: Promise<Motion>;
  setMotion: (motion: Motion) => void;
}

let nextLayerID = 1;

export interface PageStackProps {
  /** A page instance's identity: a new key is a new page (and a transition). */
  keyOf: (route: Route) => string;
  /** The page for a route, rendered once per layer (it follows its own route after that). */
  render: (route: Route) => JSX.Element;
  /** Whether pages stack (phones): slides; else the wide window's entrance. */
  stacked: () => boolean;
  /** Plays a slide's parts (tests hold them part-way). */
  driver?: SlideDriver;
  /** The route followed (the router's by default; fixtures pass their own). */
  route?: () => Route | null;
  /** How the route was reached (the router's last navigation by default). */
  motionOf?: (to: Route) => import("../../lib/navMotion").PageMotion;
}

export function PageStack(props: PageStackProps) {
  const followed = () => (props.route ? props.route() : route());
  const motionOf = (to: Route) => {
    if (props.motionOf) return props.motionOf(to);
    const nav = navigation();
    return nav && nav.to === to ? nav.motion : "none";
  };
  const layers = signal<Layer[]>([]);
  let width = 0;
  let generation = 0;
  let running: { gen: number; incoming: Layer; outgoing: Layer } | null = null;

  function makeLayer(key: string, presentation: PagePresentation, startX: number, z: number, path: string): Layer {
    let setMotion: (motion: Motion) => void = () => {};
    const motion = new Promise<Motion>((resolve) => {
      setMotion = resolve;
    });
    return { id: nextLayerID++, key, presentation, startX, out: signal(false), z: signal(z), path, motion, setMotion };
  }

  /** Ends a running slide where it ends: the outgoing page goes, the incoming one is in place. */
  function settle() {
    generation += 1;
    const slide = running;
    running = null;
    if (slide) {
      void slide.incoming.motion.then((motion) => {
        motion.stop();
        motion.reset();
      });
      slide.incoming.z.set(0);
    }
    if (untracked(layers).some((layer) => untracked(layer.out))) {
      layers.set(untracked(layers).filter((layer) => !untracked(layer.out)));
    }
  }

  function show(now: Route) {
    const key = props.keyOf(now);
    const list = untracked(layers);
    const active = [...list].reverse().find((layer) => !untracked(layer.out)) || null;
    if (active && active.key === key) {
      active.path = now.path;
      return;
    }
    const presentation: PagePresentation = active
      ? pagePresentation(motionOf(now), {
          stacked: props.stacked(),
          reduced: reduceMotion() || pageSlideMs() <= 0,
          topChanged: topPageOf(active.path) !== topPageOf(now.path),
        })
      : "none";
    if (!active || !isSlide(presentation)) {
      settle();
      layers.set([makeLayer(key, presentation, 0, 0, now.path)]);
      return;
    }
    // A slide still running ends here: its outgoing page goes at once; its incoming page (the one
    // leaving now) goes on from where it is, so nothing jumps.
    const interrupted = running && running.incoming === active;
    generation += 1;
    running = null;
    // A text field of the leaving page keeps neither the focus nor the keyboard.
    Keyboard.dismiss();
    const frames = slideFrames(presentation, width || windowSize().width);
    const incoming = makeLayer(key, presentation, frames.incoming[0], frames.top === "incoming" ? 2 : 1, now.path);
    active.z.set(frames.top === "outgoing" ? 2 : 1);
    active.out.set(true);
    layers.set([active, incoming]);
    const gen = generation;
    running = { gen, incoming, outgoing: active };
    const driver = props.driver ?? nativeSlide;
    const duration = pageSlideMs();
    const outFrom = interrupted ? active.motion.then((motion) => currentX(motion)) : Promise.resolve(frames.outgoing[0]);
    // Both parts start together, once the incoming page is mounted. Tiles stay side by side.
    void Promise.all([incoming.motion, active.motion, outFrom])
      .then(([inMotion, outMotion, from]) => {
        if (gen !== generation) return null;
        const inFrom = presentation === "tab-forward" || presentation === "tab-back" ? from + frames.incoming[0] - frames.outgoing[0] : frames.incoming[0];
        return Promise.all([
          driver.play(inMotion, inFrom, frames.incoming[1], duration),
          driver.play(outMotion, from, frames.outgoing[1], duration),
        ]);
      })
      .then(() => {
        if (gen !== generation) return;
        running = null;
        incoming.z.set(0);
        layers.set(untracked(layers).filter((layer) => layer !== active));
      });
  }

  effect(() => {
    const now = followed();
    if (!now) return;
    untracked(() => show(now));
  });

  // A resize or rotation (the widths the slide was planned for), a switch of layout, or reduced
  // motion turned on: the running slide ends at once.
  effect(() => {
    void windowSize().width;
    void windowSize().height;
    void props.stacked();
    void reduceMotion();
    untracked(() => {
      if (running) settle();
    });
  });

  return (
    <View
      class="relative flex-1 overflow-hidden"
      onLayout={({ bounds }) => {
        width = bounds.size.width;
      }}
      testID="page-stack"
    >
      <Each of={layers()} key={(layer) => layer.id}>
        {(layer) => <PageLayer layer={layer()} keyOf={props.keyOf} render={props.render} followed={followed} />}
      </Each>
    </View>
  );
}

function PageLayer(props: { layer: Layer; keyOf: (route: Route) => string; render: (route: Route) => JSX.Element; followed: () => Route | null }) {
  const layer = props.layer;
  const rise = layer.presentation === "rise";
  const motion = createMotion(
    rise ? { initial: { opacity: 0, translateY: 6 } } : layer.startX ? { initial: { translateX: layer.startX } } : undefined,
  );
  layer.setMotion(motion);
  // The page's own route: the current one while it is shown and the page's; its last one after.
  let last = untracked(props.followed) as Route;
  const own = computed(() => {
    const now = props.followed();
    if (now && !layer.out() && props.keyOf(now) === layer.key) last = now;
    return last;
  });
  // The wide window's entrance plays once the page is mounted.
  if (rise) effect(() => untracked(() => playRise(motion)));
  const out = () => layer.out();
  return (
    <View
      style={{ ...motion.style, ...(out() ? FILL : { flex: 1 }), zIndex: layer.z(), pointerEvents: out() ? "none" : "auto" }}
      accessibilityElementsHidden={out() ? OUTGOING_A11Y.accessibilityElementsHidden : undefined}
      importantForAccessibility={out() ? OUTGOING_A11Y.importantForAccessibility : undefined}
      testID={out() ? "page-layer-out" : `page-layer.in.${layer.presentation}`}
    >
      {withPageRoute(own, () => props.render(untracked(own)))}
    </View>
  );
}

/** Renders `render()` with `own` as the route its pages read (`currentRoute()`). */
function withPageRoute(own: () => Route, render: () => JSX.Element) {
  // The children are a getter, read inside the provider (a function child would be rendered
  // later, outside the provided value, on the web).
  return PageRouteContext.Provider({
    value: own,
    get children() {
      return render();
    },
  });
}
