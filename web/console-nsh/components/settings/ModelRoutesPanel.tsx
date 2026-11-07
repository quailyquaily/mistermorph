// Model routes (llm.routes.*) as a map (the Vue console's ModelRoutesPanel): the kinds of work on
// the left, model profiles on the right, and lines showing where each one's requests go. Line weight
// is the share; dashed, numbered lines are fallbacks in order. Select a route to change it from the
// profiles: Use, Split (with steppers for the shares), or Fallback.
//
// The lines are drawn on a Canvas from the nodes' measured positions (lib/core/route-lines.js lays
// them out, as in Vue). The Vue map's draw-in and traffic pulses are not drawn.
//
// Vue to nsh: `save` is `onSave(update)`, `update:dirty` is `onDirtyChange(dirty)`, `add-profile`
// is `onAddProfile()`.
import type { ViewRef } from "nsh";
import { batch, Canvas, cleanup, computed, effect, Path2D, signal, Text, token, untracked, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import {
  addToSplit,
  percentWeights,
  removeFromSplit,
  ROUTE_MODE_SPLIT,
  ROUTE_PURPOSES,
  routeFromValue,
  routeIsUnset,
  routeProblems,
  routeSingleProfile,
  routeToValue,
  setShare,
  toggleFallback,
  useProfile,
} from "../../lib/core/model-routes.js";
import { layoutRouteLines } from "../../lib/core/route-lines.js";
import { Button, Icon, Section } from "../ui";
import { type ConfigFieldState, type ConfigUpdate, SettingsSaveRegistryContext } from "./ConfigSettingsPanel";

export interface RouteProfileItem {
  title?: string;
  value: string;
  note?: string;
}

export interface ModelRoutesPanelProps {
  values?: Record<string, unknown>;
  fieldStates?: Record<string, ConfigFieldState | undefined>;
  /** [{ title, value, note }], "default" first. */
  profiles?: RouteProfileItem[];
  loading?: boolean;
  saving?: boolean;
  saveScope?: string;
  onSave?: (update: ConfigUpdate) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Open the Models page with a new profile started. */
  onAddProfile?: () => void;
  testID?: string;
}

const SHARE_STEP = 5;

interface Purpose {
  key: string;
  path: string;
  label: string;
  note: string;
  legacy?: boolean;
  single?: boolean;
  unsetOff?: boolean;
}

interface Route {
  mode: string;
  profile: string;
  candidates: { profile: string; weight: number }[];
  fallbacks: string[];
}

interface Edge {
  id: string;
  purpose: string;
  profile: string;
  kind: "split" | "route" | "fallback";
  share?: number;
  index?: number;
  order?: number;
  implicit?: boolean;
}

interface Role {
  role: "" | "use" | "split" | "fallback";
  share?: number;
  order?: number;
  implicit?: boolean;
}

type Point = { x: number; y: number };

let panelSeq = 0;

export function ModelRoutesPanel(props: ModelRoutesPanelProps) {
  const registry = SettingsSaveRegistryContext();
  const registered = () => Boolean(registry && props.saveScope);
  const draft = signal<Record<string, Route>>({});
  const original = signal<Record<string, string>>({});
  const selected = signal("");
  const validationError = signal("");

  effect(() => {
    const values = props.values || {};
    untracked(() => {
      const next: Record<string, Route> = {};
      const saved: Record<string, string> = {};
      for (const purpose of ROUTE_PURPOSES as Purpose[]) {
        const route = routeFromValue(values[purpose.path]) as Route;
        next[purpose.key] = route;
        saved[purpose.key] = JSON.stringify(routeToValue(route));
      }
      batch(() => {
        draft.set(next);
        original.set(saved);
        validationError.set("");
      });
    });
  });

  const knownProfiles = () => (props.profiles || []).map((item) => item.value).filter(Boolean);
  const routeOf = (purpose: Purpose): Route => draft()[purpose.key] || (routeFromValue(null) as Route);
  const changed = (purpose: Purpose) => JSON.stringify(routeToValue(routeOf(purpose))) !== original()[purpose.key];
  const dirty = computed(() => (ROUTE_PURPOSES as Purpose[]).some(changed));
  let firstDirty = true;
  effect(() => {
    const value = dirty();
    if (firstDirty) {
      firstDirty = false;
      if (!value) return;
    }
    untracked(() => props.onDirtyChange?.(value));
  });

  // Legacy routes are shown only while set, so an old config stays visible and editable.
  const purposes = computed(() =>
    (ROUTE_PURPOSES as Purpose[]).filter(
      (purpose) => !purpose.legacy || !routeIsUnset(routeFromValue((props.values || {})[purpose.path])),
    ),
  );
  const selectedPurpose = () => purposes().find((purpose) => purpose.key === selected()) || null;

  const problems = (purpose: Purpose): string[] =>
    (routeProblems as (route: Route, known: string[] | null, options: { single: boolean }) => string[])(
      routeOf(purpose),
      knownProfiles().length ? knownProfiles() : null,
      { single: purpose.single === true },
    );
  const locked = (purpose: Purpose | null) =>
    Boolean(props.loading || props.saving || (purpose && props.fieldStates?.[purpose.path]?.editable === false));

  // Every line on the map.
  const edges = computed<Edge[]>(() => {
    const out: Edge[] = [];
    for (const purpose of purposes()) {
      const route = routeOf(purpose);
      if (route.mode === ROUTE_MODE_SPLIT) {
        const shares = percentWeights(route.candidates);
        route.candidates.forEach((item, index) => {
          out.push({ id: `${purpose.key}:s:${index}`, purpose: purpose.key, profile: item.profile || "?", share: shares[index], index, kind: "split" });
        });
      } else if (purpose.unsetOff && routeIsUnset(route)) {
        // An unset route that means "off" has no line to the default profile.
      } else {
        out.push({
          id: `${purpose.key}:r`,
          purpose: purpose.key,
          profile: routeSingleProfile(route) || "default",
          share: 100,
          kind: "route",
          implicit: routeIsUnset(route) || route.mode !== "profile",
        });
      }
      route.fallbacks.forEach((name, index) => {
        out.push({ id: `${purpose.key}:f:${index}`, purpose: purpose.key, profile: name, order: index + 1, kind: "fallback" });
      });
    }
    return out;
  });

  // Profiles in use, plus every profile while a route is selected. A profile a route names but the
  // config does not have is shown as missing.
  const profileNodes = computed(() => {
    const used = new Set(edges().map((edge) => edge.profile));
    const listed = (props.profiles || []).map((item) => ({ name: item.value, note: item.note || "", missing: false }));
    const names = new Set(listed.map((item) => item.name));
    const nodes = listed.filter((item) => selected() || used.has(item.name) || item.name === "default");
    for (const name of used) {
      if (!names.has(name)) nodes.push({ name, note: "", missing: true });
    }
    return nodes;
  });
  const hiddenProfiles = () => (props.profiles || []).length - profileNodes().filter((node) => !node.missing).length;

  // Where the selected route sends a profile's requests.
  const roleOf = (name: string): Role => {
    const purpose = selectedPurpose();
    if (!purpose) return { role: "" };
    const route = routeOf(purpose);
    const fallback = route.fallbacks.indexOf(name);
    if (route.mode === ROUTE_MODE_SPLIT) {
      const index = route.candidates.findIndex((item) => item.profile === name);
      if (index >= 0) return { role: "split", share: percentWeights(route.candidates)[index] };
    } else if (routeSingleProfile(route) === name && !(purpose.unsetOff && routeIsUnset(route))) {
      return { role: "use", implicit: route.mode !== "profile" };
    }
    return fallback >= 0 ? { role: "fallback", order: fallback + 1 } : { role: "" };
  };

  const edit = (change: (route: Route) => Route) => {
    const purpose = selectedPurpose();
    if (!purpose || locked(purpose)) return;
    batch(() => {
      draft.update((current) => ({ ...current, [purpose.key]: change(current[purpose.key] || (routeFromValue(null) as Route)) }));
      validationError.set("");
    });
  };
  const actions = {
    use: (name: string) => edit((route) => useProfile(route, name)),
    split: (name: string) => edit((route) => addToSplit(route, name)),
    unsplit: (name: string) => edit((route) => removeFromSplit(route, name)),
    fallback: (name: string) => edit((route) => toggleFallback(route, name)),
    reset: () => edit(() => routeFromValue(null) as Route),
    step: (index: number, delta: number) =>
      edit((route) => setShare(route, index, percentWeights(route.candidates)[index] + delta)),
  };
  const splitIndex = (name: string) => {
    const purpose = selectedPurpose();
    return purpose ? routeOf(purpose).candidates.findIndex((item) => item.profile === name) : -1;
  };
  const select = (purpose: Purpose) => selected.update((current) => (current === purpose.key ? "" : purpose.key));

  /* ---------- line geometry, measured from the nodes ---------- */

  let mapRef: ViewRef | undefined;
  const routeRefs = new Map<string, ViewRef>();
  const profileRefs = new Map<string, ViewRef>();
  const geometry = signal<{ from: Record<string, Point>; to: Record<string, Point & { top: number; bottom: number }> }>({
    from: {},
    to: {},
  });
  let measureSeq = 0;
  let scheduled = false;
  let alive = true;
  cleanup(() => {
    alive = false;
  });

  const measure = async () => {
    const seq = ++measureSeq;
    const map = await mapRef?.measure();
    if (!map || !alive || seq !== measureSeq) return;
    const origin = map.pagePosition;
    const from: Record<string, Point> = {};
    const to: Record<string, Point & { top: number; bottom: number }> = {};
    await Promise.all([
      ...[...routeRefs].map(async ([key, ref]) => {
        const box = await ref.measure();
        if (!box) return;
        const x = box.pagePosition.x - origin.x + box.bounds.size.width;
        const y = box.pagePosition.y - origin.y + box.bounds.size.height / 2;
        from[key] = { x, y };
      }),
      ...[...profileRefs].map(async ([name, ref]) => {
        const box = await ref.measure();
        if (!box) return;
        const top = box.pagePosition.y - origin.y;
        to[name] = { x: box.pagePosition.x - origin.x, y: top + box.bounds.size.height / 2, top, bottom: top + box.bounds.size.height };
      }),
    ]);
    if (!alive || seq !== measureSeq) return;
    geometry.set({ from, to });
  };
  const scheduleMeasure = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      void measure();
    });
  };
  effect(() => {
    void edges();
    void profileNodes();
    void selected();
    untracked(scheduleMeasure);
  });

  interface Line extends Edge {
    path: string;
    width: number;
    mid: Point;
    end: Point;
    active: boolean;
    dim: boolean;
  }
  const lines = computed<Line[]>(() => {
    const { from, to } = geometry();
    const layout = layoutRouteLines(edges(), from, to) as Record<string, { path: string; entry: Point; label: Point }>;
    const out: Line[] = [];
    for (const edge of edges()) {
      const placed = layout[edge.id];
      if (!placed) continue;
      out.push({
        ...edge,
        path: placed.path,
        width: edge.kind === "fallback" ? 1 : 1.5,
        // Shares and steppers sit on the line's longest horizontal run.
        mid: placed.label,
        end: { x: placed.entry.x - 12, y: placed.entry.y },
        active: selected() === edge.purpose,
        dim: Boolean(selected()) && selected() !== edge.purpose,
      });
    }
    return out;
  });

  /* ---------- saving ---------- */

  const buildUpdate = (): ConfigUpdate => {
    const changes: Record<string, unknown> = {};
    const errors: string[] = [];
    for (const purpose of ROUTE_PURPOSES as Purpose[]) {
      if (!untracked(() => changed(purpose))) continue;
      const found = untracked(() => problems(purpose));
      if (found.length) {
        errors.push(`${purpose.label}: ${found.join(" ")}`);
        continue;
      }
      changes[purpose.path] = routeToValue(untracked(() => routeOf(purpose)));
    }
    if (errors.length) throw new Error(errors.join(" "));
    return { config_changes: changes, reset: [] };
  };
  const collectUpdate = () => {
    if (!untracked(dirty)) return null;
    try {
      const update = buildUpdate();
      validationError.set("");
      return update;
    } catch (error: any) {
      validationError.set(error?.message || "Invalid route");
      throw error;
    }
  };
  const save = () => {
    try {
      props.onSave?.(buildUpdate());
      validationError.set("");
    } catch (error: any) {
      validationError.set(error?.message || "Invalid route");
    }
  };

  const registryKey = `model-routes-${++panelSeq}`;
  if (untracked(registered)) {
    registry!.register({
      key: registryKey,
      scope: untracked(() => props.saveScope || ""),
      label: () => "Model Routes",
      dirty: () => dirty(),
      collectUpdate,
    });
    cleanup(() => registry!.unregister(registryKey));
  }

  /* ---------- drawing ---------- */

  const color = (name: Parameters<typeof token>[0]) => token(name) as string;
  const draw = (cx: any) => {
    for (const line of lines()) {
      cx.save?.();
      const fallback = line.kind === "fallback";
      cx.globalAlpha = line.dim ? 0.3 : line.implicit && !line.active ? 0.55 : line.active ? 1 : 0.75;
      cx.strokeStyle = fallback ? color("warn") : line.active ? color("blue") : color("blue-lighter");
      cx.lineWidth = line.width;
      cx.lineCap = "round";
      cx.lineJoin = "round";
      cx.setLineDash(fallback ? [4, 6] : []);
      cx.stroke(new Path2D(line.path));
      cx.restore?.();
    }
  };

  const stepper = (name: string, share: number, index: number, testPrefix: string) => (
    <View class="flex-row items-center gap-1 rounded-(--radius) border border-line bg-card px-1">
      <BaseButton
        accessibilityLabel={`Less to ${name}`}
        disabled={share <= 1}
        onPress={() => actions.step(index, -SHARE_STEP)}
        testID={`${testPrefix}-less-${name}`}
        class="size-5 items-center justify-center hover:bg-hover disabled:opacity-40"
      >
        <Text class="text-sm text-foreground">−</Text>
      </BaseButton>
      <Text class="font-mono text-xs text-foreground">{share}%</Text>
      <BaseButton
        accessibilityLabel={`More to ${name}`}
        disabled={share >= 99}
        onPress={() => actions.step(index, SHARE_STEP)}
        testID={`${testPrefix}-more-${name}`}
        class="size-5 items-center justify-center hover:bg-hover disabled:opacity-40"
      >
        <Text class="text-sm text-foreground">+</Text>
      </BaseButton>
    </View>
  );

  const nodeAction = (label: string, onPress: () => void, pressed?: boolean) => (
    <BaseButton
      onPress={onPress}
      selected={pressed}
      accessibilityLabel={label}
      class="rounded-(--radius) border border-line-faint px-2 py-0.5 hover:border-ring hover:bg-hover active:bg-selection"
    >
      <Text class="text-xs text-subtle">{label}</Text>
    </BaseButton>
  );

  return (
    <Section
      variant="card"
      title="Model Routes"
      meta="Where each kind of work sends its requests. Line weight is the share; dashed lines are fallbacks, in order. Select a route to change it."
      actions={
        !registered() ? (
          <Button
            variant="plain"
            size="xs"
            label="Save"
            loading={props.saving}
            disabled={props.loading || props.saving || !dirty()}
            onPress={save}
            testID={props.testID ? `${props.testID}-save` : "model-routes-save"}
          />
        ) : undefined
      }
    >
      <View class="gap-3" testID={props.testID}>
        <If when={validationError()}>
          <View class="rounded-(--radius) border border-danger bg-card px-3 py-2" role="alert">
            <Text class="text-sm text-danger">{validationError()}</Text>
          </View>
        </If>

        <If when={selectedPurpose()}>
          {(purpose) => (
            <View class="flex-row flex-wrap items-center gap-2 rounded-(--radius) bg-selection px-3 py-2">
              <Text class="text-sm font-semibold text-foreground">{purpose().label}</Text>
              <View class="flex-1 min-w-48">
                <If
                  when={problems(purpose()).length}
                  else={
                    <Text class="text-xs text-muted-foreground">
                      {locked(purpose())
                        ? "This route is managed outside the settings file."
                        : purpose().single
                          ? "Use picks the one profile for these requests; this route has no split or fallbacks."
                          : "Use sends everything to one profile; Split shares requests; Fallback is tried, in order, when a request fails."}
                    </Text>
                  }
                >
                  <Text class="text-xs text-danger" role="alert">
                    {problems(purpose()).join(" ")}
                  </Text>
                </If>
              </View>
              <Button
                variant="plain"
                size="xs"
                label={purpose().unsetOff ? "Turn off" : "Reset to default"}
                disabled={locked(purpose())}
                onPress={actions.reset}
              />
              <Button variant="plain" size="xs" label="Done" onPress={() => selected.set("")} />
            </View>
          )}
        </If>

        <View ref={mapRef} class="relative flex-row items-center py-2" onLayout={scheduleMeasure}>
          <Canvas class="absolute inset-0" style={{ pointerEvents: "none" }} draw={draw} accessibilityElementsHidden />

          <View class="w-2/5 min-w-36 gap-2" accessibilityLabel="Kinds of work">
            <Each of={purposes()} key={(purpose) => purpose.key}>
              {(purpose) => (
                <BaseButton
                  ref={(node: ViewRef) => {
                    routeRefs.set(purpose().key, node);
                    cleanup(() => routeRefs.delete(purpose().key));
                  }}
                  selected={selected() === purpose().key}
                  onPress={() => select(purpose())}
                  onLayout={scheduleMeasure}
                  accessibilityLabel={purpose().label}
                  testID={`route-${purpose().key}`}
                  class={`gap-0.5 rounded-(--radius) border px-3 py-2 hover:border-ring ${
                    selected() === purpose().key
                      ? "border-blue bg-selection"
                      : problems(purpose()).length
                        ? "border-danger bg-card"
                        : "border-line-faint bg-card"
                  }`}
                >
                  <View class="flex-row items-center gap-1.5">
                    <Text class="text-sm font-medium text-foreground">{purpose().label}</Text>
                    <If when={purpose().legacy}>
                      <Text class="rounded-(--radius) border border-line px-1 font-mono text-xs uppercase text-muted-foreground">Legacy</Text>
                    </If>
                    <If when={changed(purpose())}>
                      <View class="size-1.5 rounded-full bg-warn" accessibilityLabel="Unsaved" />
                    </If>
                  </View>
                  <Text class="text-xs text-muted-foreground">{purpose().note}</Text>
                </BaseButton>
              )}
            </Each>
          </View>

          <View class="flex-1 min-w-14" />

          <View class="w-2/5 min-w-40 gap-2" accessibilityLabel="Profiles">
            <Each of={profileNodes()} key={(node) => node.name}>
              {(node) => (
                <View
                  ref={(ref: ViewRef) => {
                    profileRefs.set(node().name, ref);
                    cleanup(() => profileRefs.delete(node().name));
                  }}
                  onLayout={scheduleMeasure}
                  testID={`profile-${node().name}`}
                  class={`gap-1 rounded-(--radius) border px-3 py-2 ${
                    node().missing
                      ? "border-danger bg-card"
                      : roleOf(node().name).role === "use" || roleOf(node().name).role === "split"
                        ? "border-blue bg-selection"
                        : roleOf(node().name).role === "fallback"
                          ? "border-warn bg-card"
                          : "border-line-faint bg-card"
                  }`}
                >
                  <View class="flex-row flex-wrap items-center gap-1.5">
                    <Text class="font-mono text-sm text-foreground">{node().name}</Text>
                    <If when={roleOf(node().name).role === "use"}>
                      <Text class="font-mono text-xs text-blue">{roleOf(node().name).implicit ? "default" : "all"}</Text>
                    </If>
                    <If when={roleOf(node().name).role === "split"}>
                      <If
                        when={!locked(selectedPurpose())}
                        else={<Text class="font-mono text-xs text-blue">{roleOf(node().name).share}%</Text>}
                      >
                        {stepper(node().name, roleOf(node().name).share ?? 0, splitIndex(node().name), "node")}
                      </If>
                    </If>
                    <If when={roleOf(node().name).role === "fallback"}>
                      <Text class="font-mono text-xs text-warn-dark">fallback {roleOf(node().name).order}</Text>
                    </If>
                  </View>
                  <If when={node().missing}>
                    <Text class="text-xs text-danger">No profile has this name.</Text>
                  </If>
                  <If when={!node().missing && node().note}>
                    <Text class="text-xs text-muted-foreground">{node().note}</Text>
                  </If>
                  <If when={selectedPurpose() && !locked(selectedPurpose())}>
                    <View class="flex-row flex-wrap gap-1">
                      <If when={roleOf(node().name).role !== "use" || roleOf(node().name).implicit}>
                        {nodeAction("Use", () => actions.use(node().name))}
                      </If>
                      <If
                        when={roleOf(node().name).role === "split"}
                        else={
                          <If
                            when={!selectedPurpose()?.single && (roleOf(node().name).role !== "use" || roleOf(node().name).implicit)}
                          >
                            {nodeAction("Split", () => actions.split(node().name))}
                          </If>
                        }
                      >
                        {nodeAction("Remove", () => actions.unsplit(node().name))}
                      </If>
                      <If
                        when={
                          !selectedPurpose()?.single && (roleOf(node().name).role === "" || roleOf(node().name).role === "fallback")
                        }
                      >
                        {nodeAction(
                          roleOf(node().name).role === "fallback" ? "No fallback" : "Fallback",
                          () => actions.fallback(node().name),
                          roleOf(node().name).role === "fallback",
                        )}
                      </If>
                    </View>
                  </If>
                </View>
              )}
            </Each>
            <If when={!selected() && hiddenProfiles() > 0}>
              <Text class="text-xs text-muted-foreground">+{hiddenProfiles()} more profiles; select a route to use them</Text>
            </If>
            <BaseButton
              disabled={props.loading || props.saving}
              onPress={() => props.onAddProfile?.()}
              accessibilityLabel="Add profile"
              class="flex-row items-center gap-1.5 self-start rounded-(--radius) border border-dashed border-line px-3 py-1.5 hover:bg-hover disabled:opacity-50"
            >
              <Icon name="PhPlus" size={14} color="blue" />
              <Text class="text-sm text-blue">Add profile</Text>
            </BaseButton>
          </View>

          {/* Shares and fallback order sit on the lines. */}
          <Each of={lines()} key={(line) => line.id}>
            {(line) => (
              <>
                <If when={line().kind === "fallback"}>
                  <View
                    class="absolute size-4 items-center justify-center rounded-full border border-warn bg-card"
                    style={{ left: line().end.x - 8, top: line().end.y - 8, opacity: line().dim ? 0.4 : 1 }}
                    accessibilityLabel={`Fallback ${line().order}`}
                  >
                    <Text class="font-mono text-xs text-warn-dark">{line().order}</Text>
                  </View>
                </If>
                <If when={line().kind === "split" && !line().active}>
                  <View
                    class="absolute rounded-(--radius) bg-card px-1"
                    style={{ left: line().mid.x - 16, top: line().mid.y - 9, opacity: line().dim ? 0.4 : 1 }}
                  >
                    <Text class="font-mono text-xs text-subtle">{line().share}%</Text>
                  </View>
                </If>
                <If when={line().kind === "split" && line().active && !locked(selectedPurpose())}>
                  <View class="absolute" style={{ left: line().mid.x - 36, top: line().mid.y - 11 }}>
                    {stepper(line().profile, line().share ?? 0, line().index ?? 0, "line")}
                  </View>
                </If>
              </>
            )}
          </Each>
        </View>
      </View>
    </Section>
  );
}
