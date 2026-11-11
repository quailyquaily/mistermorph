// A test entry for tests/page-stack.test.tsx: the console's page host (components/frame/PageStack.tsx)
// over a route of its own, with a slide driver that holds every slide part-way until "finish" is
// pressed, so the test sees both pages during a slide. Each page shows the route it reads
// (`currentRoute()`, its own while it goes out) and how many routes it has seen.
import { mount, signal, Text, View } from "nsh";
import { PageStack } from "../../components/frame/PageStack";
import type { SlideDriver } from "../../components/motion/pageSlide";
import type { PageMotion } from "../../lib/navMotion";
import type { PageKey, Route } from "../../lib/router";
import { currentRoute } from "../../lib/router";
import { effect, untracked } from "nsh";

function routeOf(path: string): Route {
  const page = (path.split("/")[1] || "root") as PageKey;
  return { path, fullPath: path, query: {}, hash: "", params: {}, meta: {}, page };
}

const route = signal<Route>(routeOf("/a"));
const stacked = signal(true);
let nextMotion: PageMotion = "none";
const plays = signal<string[]>([]);
let waiting: (() => void)[] = [];

const driver: SlideDriver = {
  play(_motion, from, to) {
    plays.update((list) => [...list, `${from}>${to}`]);
    return new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  },
};

function go(path: string, motion: PageMotion) {
  nextMotion = motion;
  route.set(routeOf(path));
}

function finish() {
  const list = waiting;
  waiting = [];
  for (const resolve of list) resolve();
}

function FixturePage() {
  const name = untracked(() => currentRoute().page);
  let seen = 0;
  const count = signal(0);
  effect(() => {
    void currentRoute().path;
    untracked(() => count.set(++seen));
  });
  return (
    <View class="flex-1 p-2" testID={`fixture-page.${name}`}>
      <Text testID={`fixture-route.${name}`}>{`${name}:${currentRoute().path}:${count()}`}</Text>
    </View>
  );
}

const button = (id: string, onPress: () => void) => (
  <Text testID={id} class="p-1" onPress={onPress}>
    {id}
  </Text>
);

function Fixture() {
  return (
    <View class="flex-1">
      <View class="flex-row flex-wrap">
        {button("go-b-forward", () => go("/b", "forward"))}
        {button("go-c-forward", () => go("/c", "forward"))}
        {button("go-a-back", () => go("/a", "back"))}
        {button("go-c-tab", () => go("/c", "tab-forward"))}
        {button("go-a-tab", () => go("/a", "tab-back"))}
        {button("go-b2-none", () => go("/b/2", "none"))}
        {button("go-b3-forward", () => go("/b/3", "forward"))}
        {button("wide", () => stacked.set(false))}
        {button("finish", finish)}
      </View>
      <Text testID="plays">{plays().join(" ")}</Text>
      <PageStack
        keyOf={(r) => r.page}
        render={() => <FixturePage />}
        stacked={() => stacked()}
        driver={driver}
        route={() => route()}
        motionOf={() => nextMotion}
      />
    </View>
  );
}

mount(() => <Fixture />);
