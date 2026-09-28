import { computed, getCurrentInstance, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import {
  ROUTE_MODE_SPLIT,
  ROUTE_PURPOSES,
  addToSplit,
  percentWeights,
  removeFromSplit,
  routeFromValue,
  routeIsUnset,
  routeProblems,
  routeSingleProfile,
  routeToValue,
  setShare,
  toggleFallback,
  useProfile,
} from "../core/model-routes";
import { layoutRouteLines } from "../core/route-lines";
import "./ModelRoutesPanel.css";

const SHARE_STEP = 5;

// Model routes (llm.routes.*) as a map: the kinds of work on the left, model profiles on the right,
// and lines showing where each one's requests go. Line weight is the share; dashed, numbered lines
// are fallbacks in order. Select a route to change it from the profiles: Use, Split, or Fallback.
export default {
  name: "ModelRoutesPanel",
  props: {
    values: { type: Object, default: () => ({}) },
    fieldStates: { type: Object, default: () => ({}) },
    // [{ title, value, note }], "default" first.
    profiles: { type: Array, default: () => [] },
    loading: { type: Boolean, default: false },
    saving: { type: Boolean, default: false },
    saveScope: { type: String, default: "" },
  },
  // add-profile: open the Models page with a new profile started; profiles are made there.
  emits: ["save", "update:dirty", "add-profile"],
  setup(props, { emit }) {
    const saveRegistry = inject("settingsSaveRegistry", null);
    const registered = computed(() => Boolean(saveRegistry && props.saveScope));
    const draft = reactive({});
    const original = ref({});
    const selected = ref("");
    const validationError = ref("");

    function replaceDraft() {
      for (const key of Object.keys(draft)) {
        delete draft[key];
      }
      const saved = {};
      for (const purpose of ROUTE_PURPOSES) {
        const route = routeFromValue(props.values?.[purpose.path]);
        draft[purpose.key] = route;
        saved[purpose.key] = JSON.stringify(routeToValue(route));
      }
      original.value = saved;
      validationError.value = "";
    }

    watch(() => props.values, replaceDraft, { deep: true, immediate: true });

    const knownProfiles = computed(() => props.profiles.map((item) => item.value).filter(Boolean));

    function changed(purpose) {
      return JSON.stringify(routeToValue(draft[purpose.key])) !== original.value[purpose.key];
    }

    const dirty = computed(() => ROUTE_PURPOSES.some(changed));
    watch(dirty, (value) => emit("update:dirty", value));

    // Legacy routes are shown only while set, so an old config stays visible and editable.
    const purposes = computed(() =>
      ROUTE_PURPOSES.filter((purpose) => !purpose.legacy || !routeIsUnset(routeFromValue(props.values?.[purpose.path])))
    );
    const selectedPurpose = computed(() => purposes.value.find((purpose) => purpose.key === selected.value) || null);

    function problems(purpose) {
      return routeProblems(draft[purpose.key], knownProfiles.value.length ? knownProfiles.value : null);
    }

    function locked(purpose) {
      return props.loading || props.saving || props.fieldStates?.[purpose.path]?.editable === false;
    }

    // Every line on the map.
    const edges = computed(() => {
      const out = [];
      for (const purpose of purposes.value) {
        const route = draft[purpose.key];
        if (route.mode === ROUTE_MODE_SPLIT) {
          const shares = percentWeights(route.candidates);
          route.candidates.forEach((item, index) => {
            out.push({ id: `${purpose.key}:s:${index}`, purpose: purpose.key, profile: item.profile || "?", share: shares[index], index, kind: "split" });
          });
        } else {
          out.push({ id: `${purpose.key}:r`, purpose: purpose.key, profile: routeSingleProfile(route) || "default", share: 100, kind: "route", implicit: routeIsUnset(route) || route.mode !== "profile" });
        }
        route.fallbacks.forEach((name, index) => {
          out.push({ id: `${purpose.key}:f:${index}`, purpose: purpose.key, profile: name, order: index + 1, kind: "fallback" });
        });
      }
      return out;
    });

    // Profiles in use, plus every profile while a route is selected. A profile a route names but
    // the config does not have is shown as missing.
    const profileNodes = computed(() => {
      const used = new Set(edges.value.map((edge) => edge.profile));
      const listed = props.profiles.map((item) => ({ name: item.value, note: item.note || "", missing: false }));
      const names = new Set(listed.map((item) => item.name));
      const nodes = listed.filter((item) => selected.value || used.has(item.name) || item.name === "default");
      for (const name of used) {
        if (!names.has(name)) {
          nodes.push({ name, note: "", missing: true });
        }
      }
      return nodes;
    });
    const hiddenProfiles = computed(() => props.profiles.length - profileNodes.value.filter((node) => !node.missing).length);

    // Where the selected route sends a profile's requests: "use", "split", "fallback" (with order), or "".
    function roleOf(name) {
      const purpose = selectedPurpose.value;
      if (!purpose) {
        return { role: "" };
      }
      const route = draft[purpose.key];
      const fallback = route.fallbacks.indexOf(name);
      if (route.mode === ROUTE_MODE_SPLIT) {
        const index = route.candidates.findIndex((item) => item.profile === name);
        if (index >= 0) {
          return { role: "split", share: percentWeights(route.candidates)[index] };
        }
      } else if (routeSingleProfile(route) === name) {
        return { role: "use", implicit: route.mode !== "profile" };
      }
      return fallback >= 0 ? { role: "fallback", order: fallback + 1 } : { role: "" };
    }

    function edit(change) {
      const purpose = selectedPurpose.value;
      if (!purpose || locked(purpose)) {
        return;
      }
      draft[purpose.key] = change(draft[purpose.key]);
      validationError.value = "";
    }

    const actions = {
      use: (name) => edit((route) => useProfile(route, name)),
      split: (name) => edit((route) => addToSplit(route, name)),
      unsplit: (name) => edit((route) => removeFromSplit(route, name)),
      fallback: (name) => edit((route) => toggleFallback(route, name)),
      reset: () => edit(() => routeFromValue(null)),
      step: (index, delta) =>
        edit((route) => setShare(route, index, percentWeights(route.candidates)[index] + delta)),
    };

    function splitIndex(name) {
      const purpose = selectedPurpose.value;
      return purpose ? draft[purpose.key].candidates.findIndex((item) => item.profile === name) : -1;
    }

    function select(purpose) {
      selected.value = selected.value === purpose.key ? "" : purpose.key;
    }

    // Line geometry, measured from the nodes.
    const canvas = ref(null);
    const geometry = reactive({ width: 0, height: 0, from: {}, to: {} });
    let observer = null;

    function measure() {
      const root = canvas.value;
      if (!root) {
        return;
      }
      const box = root.getBoundingClientRect();
      geometry.width = box.width;
      geometry.height = box.height;
      const from = {};
      const to = {};
      for (const el of root.querySelectorAll("[data-route]")) {
        const r = el.getBoundingClientRect();
        from[el.dataset.route] = { x: r.right - box.left, y: r.top - box.top + r.height / 2 };
      }
      for (const el of root.querySelectorAll("[data-profile]")) {
        const r = el.getBoundingClientRect();
        to[el.dataset.profile] = { x: r.left - box.left, y: r.top - box.top + r.height / 2, top: r.top - box.top, bottom: r.bottom - box.top };
      }
      geometry.from = from;
      geometry.to = to;
    }

    watch([edges, profileNodes, selected], () => void nextTick(measure), { deep: true });
    onMounted(() => {
      void nextTick(measure);
      if (typeof ResizeObserver !== "undefined" && canvas.value) {
        observer = new ResizeObserver(measure);
        observer.observe(canvas.value);
      }
    });
    onBeforeUnmount(() => observer?.disconnect());

    // Orthogonal lines with rounded corners; see core/route-lines.js.
    const measurePath = typeof document !== "undefined" ? document.createElementNS("http://www.w3.org/2000/svg", "path") : null;

    const lines = computed(() => {
      const layout = layoutRouteLines(edges.value, geometry.from, geometry.to);
      return edges.value
        .map((edge) => {
          const placed = layout[edge.id];
          if (!placed) {
            return null;
          }
          const { path, entry, label } = placed;
          let length = 0;
          for (let i = 1; i < placed.points.length; i++) {
            length += Math.abs(placed.points[i][0] - placed.points[i - 1][0]) + Math.abs(placed.points[i][1] - placed.points[i - 1][1]);
          }
          if (measurePath) {
            measurePath.setAttribute("d", path);
            length = measurePath.getTotalLength();
          }
          return {
            ...edge,
            path,
            length,
            width: edge.kind === "fallback" ? 1 : 1.5,
            // Bigger shares carry traffic more often.
            period: edge.kind === "fallback" ? 0 : Math.min(7, 3 * Math.sqrt(100 / Math.max(1, edge.share))),
            // Shares and steppers sit on the line's longest horizontal run.
            mid: label,
            end: { x: entry.x - 12, y: entry.y },
            arrive: entry,
            active: selected.value === edge.purpose,
            dim: Boolean(selected.value) && selected.value !== edge.purpose,
          };
        })
        .filter(Boolean);
    });

    // Lines draw in one after another on first show; lines added later draw in at once.
    const drawn = ref(false);
    const uid = `mr${getCurrentInstance()?.uid ?? Math.floor(Math.random() * 1e6)}`;
    onMounted(() => {
      window.setTimeout(() => {
        drawn.value = true;
      }, 1800);
    });

    function buildUpdate() {
      const changes = {};
      const errors = [];
      for (const purpose of ROUTE_PURPOSES) {
        if (!changed(purpose)) {
          continue;
        }
        const found = problems(purpose);
        if (found.length) {
          errors.push(`${purpose.label}: ${found.join(" ")}`);
          continue;
        }
        changes[purpose.path] = routeToValue(draft[purpose.key]);
      }
      if (errors.length) {
        throw new Error(errors.join(" "));
      }
      return { config_changes: changes, reset: [] };
    }

    function collectUpdate() {
      if (!dirty.value) {
        return null;
      }
      try {
        const update = buildUpdate();
        validationError.value = "";
        return update;
      } catch (error) {
        validationError.value = error?.message || "Invalid route";
        throw error;
      }
    }

    function save() {
      try {
        emit("save", buildUpdate());
        validationError.value = "";
      } catch (error) {
        validationError.value = error?.message || "Invalid route";
      }
    }

    const registryKey = `model-routes-${getCurrentInstance()?.uid ?? Math.random()}`;
    onMounted(() => {
      if (registered.value) {
        saveRegistry.register({ key: registryKey, scope: props.saveScope, label: () => "Model Routes", dirty: () => dirty.value, collectUpdate });
      }
    });
    onBeforeUnmount(() => {
      if (registered.value) {
        saveRegistry.unregister(registryKey);
      }
    });

    return {
      SHARE_STEP,
      draft,
      selected,
      selectedPurpose,
      validationError,
      dirty,
      registered,
      purposes,
      profileNodes,
      hiddenProfiles,
      lines,
      drawn,
      uid,
      geometry,
      canvas,
      problems,
      locked,
      changed,
      roleOf,
      splitIndex,
      actions,
      select,
      save,
    };
  },
  template: `
    <QCard variant="default" class="config-settings-group model-routes-panel">
      <div class="settings-panel-shell">
        <header class="settings-panel-head">
          <div class="settings-panel-copy">
            <h3 class="settings-panel-title workspace-document-title">Model Routes</h3>
            <p class="settings-panel-meta">Where each kind of work sends its requests. Pulses show traffic, more often for bigger shares; dashed lines are fallbacks, in order. Select a route to change it.</p>
          </div>
          <QButton v-if="!registered" class="primary" :loading="saving" :disabled="loading || saving || !dirty" @click="save">Save</QButton>
        </header>
        <div v-if="validationError" class="config-settings-error" role="alert">{{ validationError }}</div>

        <div v-if="selectedPurpose" class="model-routes-inspector">
          <span class="model-routes-inspector-title">{{ selectedPurpose.label }}</span>
          <span v-if="problems(selectedPurpose).length" class="model-route-problems" role="alert">{{ problems(selectedPurpose).join(' ') }}</span>
          <span v-else-if="locked(selectedPurpose)" class="model-routes-node-note">This route is managed outside the settings file.</span>
          <span v-else class="model-routes-node-note">Use sends everything to one profile; Split shares requests; Fallback is tried, in order, when a request fails.</span>
          <QButton class="plain xs" :disabled="locked(selectedPurpose)" @click="actions.reset()">Reset to default</QButton>
          <QButton class="plain xs" @click="selected = ''">Done</QButton>
        </div>

        <div ref="canvas" class="model-routes-map" :class="{ 'has-selection': selected, 'is-drawn': drawn }">
          <svg class="model-routes-lines" :viewBox="'0 0 ' + geometry.width + ' ' + geometry.height" aria-hidden="true" focusable="false">
            <defs>
              <!-- Each line draws in like a pen plotter; a mask keeps dashed lines' own pattern. -->
              <mask
                v-for="(line, index) in lines"
                :id="uid + '-plot-' + line.id"
                :key="'mask:' + line.id"
                maskUnits="userSpaceOnUse"
                x="-2000" y="-2000" width="6000" height="6000"
              >
                <path class="model-routes-plot" :d="line.path" :style="{ '--line-length': line.length + 'px', '--plot-index': index }" />
              </mask>
            </defs>
            <path
              v-for="line in lines"
              :key="line.id"
              :d="line.path"
              :mask="'url(#' + uid + '-plot-' + line.id + ')'"
              :class="['model-routes-line', 'is-' + line.kind, { 'is-active': line.active, 'is-dim': line.dim, 'is-implicit': line.implicit }]"
              :stroke-width="line.width"
            />
            <!-- Traffic: a tapered pulse along each live line, and a ring where it arrives. -->
            <template v-for="(line, index) in lines" :key="'traffic:' + line.id">
              <g
                v-if="line.period && !line.dim"
                :class="['model-routes-traffic', { 'is-implicit': line.implicit }]"
                :style="{ '--line-length': line.length + 'px', '--line-period': line.period + 's', '--line-delay': (-index * 0.45) + 's' }"
              >
                <g class="model-routes-pulse">
                  <path
                    v-for="part in 6"
                    :key="part"
                    class="model-routes-glow"
                    :d="line.path"
                    :style="{ '--pulse-length': (19 - part * 3) + 'px', strokeWidth: 0.4 + part * 0.6, strokeOpacity: part / 6 }"
                  />
                </g>
                <circle class="model-routes-arrival" :cx="line.arrive.x" :cy="line.arrive.y" r="5" />
              </g>
            </template>
          </svg>

          <!-- Shares and fallback order sit on the lines; the selected split gets steppers. -->
          <template v-for="line in lines" :key="'label:' + line.id">
            <span
              v-if="line.kind === 'fallback'"
              class="model-routes-order"
              :class="{ 'is-active': line.active, 'is-dim': line.dim }"
              :style="{ left: line.end.x + 'px', top: line.end.y + 'px' }"
              :title="'Fallback ' + line.order"
            >{{ line.order }}</span>
            <span
              v-else-if="line.kind === 'split' && !line.active"
              class="model-routes-share"
              :class="{ 'is-dim': line.dim }"
              :style="{ left: line.mid.x + 'px', top: line.mid.y + 'px' }"
            >{{ line.share }}%</span>
            <span
              v-else-if="line.kind === 'split'"
              class="model-routes-stepper is-on-line"
              :style="{ left: line.mid.x + 'px', top: line.mid.y + 'px' }"
            >
              <button type="button" :aria-label="'Less to ' + line.profile" :disabled="line.share <= 1" @click="actions.step(line.index, -SHARE_STEP)">−</button>
              <span>{{ line.share }}%</span>
              <button type="button" :aria-label="'More to ' + line.profile" :disabled="line.share >= 99" @click="actions.step(line.index, SHARE_STEP)">+</button>
            </span>
          </template>

          <ol class="model-routes-column is-routes" aria-label="Kinds of work">
            <li v-for="(purpose, index) in purposes" :key="purpose.key" :style="{ '--node-index': index }">
              <button
                type="button"
                :data-route="purpose.key"
                :class="['model-routes-node', 'is-route', { 'is-selected': selected === purpose.key, 'has-problem': problems(purpose).length }]"
                :aria-pressed="selected === purpose.key ? 'true' : 'false'"
                @click="select(purpose)"
              >
                <span class="model-routes-node-title">
                  {{ purpose.label }}
                  <span v-if="purpose.legacy" class="model-route-tag">Legacy</span>
                  <span v-if="changed(purpose)" class="model-routes-dot" title="Unsaved"></span>
                </span>
                <span class="model-routes-node-note">{{ purpose.note }}</span>
              </button>
            </li>
          </ol>

          <ol class="model-routes-column is-profiles" aria-label="Profiles">
            <li v-for="(node, index) in profileNodes" :key="node.name" :style="{ '--node-index': index + 1 }">
              <div
                :data-profile="node.name"
                :class="['model-routes-node', 'is-profile', 'is-' + (roleOf(node.name).role || 'idle'), { 'is-missing': node.missing }]"
              >
                <span class="model-routes-node-copy">
                <span class="model-routes-node-title">
                  <code>{{ node.name }}</code>
                  <span v-if="roleOf(node.name).role === 'use'" class="model-routes-role">{{ roleOf(node.name).implicit ? 'default' : 'all' }}</span>
                  <span v-else-if="roleOf(node.name).role === 'split'" class="model-routes-role is-share">{{ roleOf(node.name).share }}%</span>
                  <span v-if="roleOf(node.name).role === 'split' && !locked(selectedPurpose)" class="model-routes-stepper is-in-node">
                    <button type="button" :aria-label="'Less to ' + node.name" :disabled="roleOf(node.name).share <= 1" @click="actions.step(splitIndex(node.name), -SHARE_STEP)">−</button>
                    <span>{{ roleOf(node.name).share }}%</span>
                    <button type="button" :aria-label="'More to ' + node.name" :disabled="roleOf(node.name).share >= 99" @click="actions.step(splitIndex(node.name), SHARE_STEP)">+</button>
                  </span>
                  <span v-else-if="roleOf(node.name).role === 'fallback'" class="model-routes-role">fallback {{ roleOf(node.name).order }}</span>
                </span>
                <span v-if="node.missing" class="model-routes-node-note is-problem">No profile has this name.</span>
                <span v-else-if="node.note" class="model-routes-node-note">{{ node.note }}</span>
                </span>

                <div v-if="selectedPurpose && !locked(selectedPurpose)" class="model-routes-actions">
                  <button
                    v-if="roleOf(node.name).role !== 'use' || roleOf(node.name).implicit"
                    type="button"
                    @click="actions.use(node.name)"
                  >Use</button>
                  <button v-if="roleOf(node.name).role === 'split'" type="button" @click="actions.unsplit(node.name)">Remove</button>
                  <button v-else-if="roleOf(node.name).role !== 'use' || roleOf(node.name).implicit" type="button" @click="actions.split(node.name)">Split</button>
                  <button
                    v-if="roleOf(node.name).role === '' || roleOf(node.name).role === 'fallback'"
                    type="button"
                    :aria-pressed="roleOf(node.name).role === 'fallback' ? 'true' : 'false'"
                    @click="actions.fallback(node.name)"
                  >{{ roleOf(node.name).role === 'fallback' ? 'No fallback' : 'Fallback' }}</button>
                </div>
              </div>
            </li>
            <li v-if="!selected && hiddenProfiles > 0" class="model-routes-more">+{{ hiddenProfiles }} more profiles; select a route to use them</li>
            <li class="model-routes-add">
              <button type="button" class="model-routes-add-button" :disabled="loading || saving" @click="$emit('add-profile')">
                <PhPlus class="icon" aria-hidden="true" />
                <span>Add profile</span>
              </button>
            </li>
          </ol>
        </div>

      </div>
    </QCard>
  `,
};
