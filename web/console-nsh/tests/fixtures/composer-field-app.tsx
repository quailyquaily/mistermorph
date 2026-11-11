// A test entry for tests/chat-composer-field.test.tsx: the composer's frame and field row as
// ChatComposer lays them out (composerFrameClass, composerRowClass, composerFieldBox, the hidden
// copies of ComposerMeasure and followComposerLayout), a 38pt add button, the field and the actions,
// with the frames, boxes, row mode and the field's own measured text height (what it shows, at the
// width it has) read out as text, and how many of its layout commits followComposerLayout eased. A
// second row is read-only, as a disabled composer is; a third has wider actions, as with the model
// picker and voice input.
import type { Bounds } from "nsh";
import { effect, LayoutAnimation, mount, signal, Text, token, untracked, View, windowSize } from "nsh";
import { Input } from "nsh/base";
import { COMPOSER_FIELD_TEXT, COMPOSER_LINE_HEIGHT, composerFieldBox, composerFrameClass, composerRowClass } from "../../components/chat/composerField";
import { ComposerMeasure, INITIAL_MEASURES } from "../../components/chat/ComposerMeasure";
import { followComposerLayout, ONE_ROW, type ComposerLayout } from "../../components/chat/composerRows";

type Frame = { x: number; y: number; w: number; h: number };

const report = signal<Record<string, unknown>>({});

function put(name: string, value: unknown) {
  report.update((all) => ({ ...all, [name]: value }));
}

function track(name: string) {
  return (event: { bounds: Bounds }) => {
    const { origin, size } = event.bounds;
    put(name, { x: origin.x, y: origin.y, w: size.width, h: size.height } satisfies Frame);
  };
}

const LONG = "A draft put in at once, long enough to wrap beside the controls and above them on any window this test opens. ";

export const PUT = {
  long: LONG.repeat(2),
  short: "hi",
  lines: "one\ntwo",
  // The long draft with as much again pasted after it: taller at both widths.
  longer: LONG.repeat(4),
};

// Every commit followComposerLayout eases, counted (only the live row is edited while it is read).
const ease = LayoutAnimation.configureNext;
(LayoutAnimation as { configureNext: unknown }).configureNext = (...args: Parameters<typeof ease>) => {
  put("eased", ((untracked(report).eased as number | undefined) ?? 0) + 1);
  return ease.apply(LayoutAnimation, args);
};

function FieldRow(props: { name: string; readonly?: boolean; tools?: boolean }) {
  const value = signal("");
  const measures = signal(INITIAL_MEASURES);
  // Measures delivered this many milliseconds late, as a platform slower to report would.
  const late = signal(0);
  const actionsWidth = signal(0);
  // What the field reports for its own text, at the width it has.
  const shown = signal(COMPOSER_LINE_HEIGHT);
  // The field's laid-out width, as drawn.
  const fieldWidth = signal(0);
  const layout = signal<ComposerLayout>(ONE_ROW);
  followComposerLayout(layout, value, measures);
  const multi = () => layout().rows === "two";
  const box = () => composerFieldBox(multi(), layout().height);
  // How many times what the user sees changed (the rows, the field's height or its laid-out width),
  // read once a display frame as it is drawn: the two hidden copies report one after the other
  // within a layout, and only the layout they leave is drawn.
  const visible = () => `${layout().rows} ${box().height.toFixed(1)} ${fieldWidth().toFixed(1)}`;
  const drawn = signal({ changes: 0, history: [] as string[], key: "" });
  let looking = false;
  effect(() => {
    visible();
    if (looking) return;
    looking = true;
    requestAnimationFrame(() => {
      looking = false;
      const key = untracked(visible);
      const last = untracked(drawn);
      if (key === last.key) return;
      drawn.set(last.key ? { changes: last.changes + 1, history: [...last.history, key].slice(-4), key } : { ...last, key });
    });
  });
  effect(() =>
    put(`${props.name}-state`, {
      value: value(),
      rows: layout().rows,
      multi: multi(),
      height: layout().height,
      measures: measures(),
      late: late(),
      shown: shown(),
      box: box(),
      changes: drawn().changes,
      history: drawn().history.join(" | "),
    }),
  );
  const control = (part: string) => <View class="size-[38px] rounded-(--radius) border border-line-soft" onLayout={track(`${props.name}-${part}`)} />;
  const actions = () => (
    <View
      class="shrink-0 flex-row items-center gap-2"
      onLayout={(event) => {
        actionsWidth.set(event.bounds.size.width);
        track(`${props.name}-actions`)(event);
      }}
    >
      <If when={props.tools}>
        <View class="h-8 w-[90px] rounded-(--radius) border border-line-soft" />
      </If>
      {control("send")}
    </View>
  );
  return (
    <View class="gap-1">
      {/* lib/shell's isMobile (980pt), without the app's frame and stores. */}
      <View class={composerFrameClass(windowSize().width <= 980)} onLayout={track(`${props.name}-shell`)}>
        <View class={composerRowClass(multi())} onLayout={track(`${props.name}-row`)}>
          <ComposerMeasure
            text={value()}
            actionsWidth={actionsWidth()}
            onMeasure={(next) => (untracked(late) ? setTimeout(() => measures.set(next), untracked(late)) : measures.set(next))}
          />
          <If when={!multi()}>{control("add")}</If>
          <Input
            value={value()}
            multiline
            readonly={props.readonly}
            placeholder="Ask anything"
            testID={`${props.name}-input`}
            onChange={({ value: next }) => value.set(next)}
            onContentSizeChange={({ size }) => shown.set(Math.ceil(size.height))}
            onLayout={(event) => {
              fieldWidth.set(event.bounds.size.width);
              track(`${props.name}-field`)(event);
            }}
            class={`${COMPOSER_FIELD_TEXT} text-foreground placeholder:text-muted-foreground ${multi() ? "w-full" : "flex-1"}`}
            style={box()}
          />
          <If when={!multi()}>{actions()}</If>
          <If when={multi()}>
            <View class="flex-row items-center justify-between" onLayout={track(`${props.name}-controls`)}>
              {control("add")}
              {actions()}
            </View>
          </If>
        </View>
      </View>
      {/* Drafts put in at once, as history, a topic switch or a restored draft does; cleared and
          retyped before the copies could measure the empty field; late measures on and off. */}
      <If when={props.name === "live"}>
        <View class="flex-row gap-2">
          {Object.entries(PUT).map(([key, text]) => (
            <View class="px-2 py-1" testID={`${props.name}-put-${key}`} onPress={() => value.set(text)}>
              <Text>{key}</Text>
            </View>
          ))}
          <View
            class="px-2 py-1"
            testID={`${props.name}-retype`}
            onPress={() => {
              value.set("");
              setTimeout(() => value.set(PUT.short), 30);
            }}
          >
            <Text>retype</Text>
          </View>
          <View class="px-2 py-1" testID={`${props.name}-late`} onPress={() => late.set(untracked(late) ? 0 : 60)}>
            <Text>late</Text>
          </View>
        </View>
      </If>
    </View>
  );
}

// The theme's colours the frame is drawn in, for the test's contrast check.
put("tokens", Object.fromEntries(["background", "field", "line", "input", "muted-foreground"].map((name) => [name, String(token(name as "line"))])));

mount(() => (
  <View class="gap-3 bg-background p-4">
    <FieldRow name="live" />
    <FieldRow name="readonly" readonly />
    <FieldRow name="tools" tools />
    <Text>{JSON.stringify(report())}</Text>
  </View>
));
