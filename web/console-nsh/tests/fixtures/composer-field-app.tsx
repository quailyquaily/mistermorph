// A test entry for tests/chat-composer-field.test.tsx: the composer's frame and field row as
// ChatComposer lays them out (composerFrameClass, composerRowClass, composerFieldBox,
// nextComposerRows), a 38pt add button, the field and a 38pt Send, with the field's measured text
// height fed back as the composer does, and the frames, boxes and row mode read out as text. A
// second row is read-only, as a disabled composer is.
import type { Bounds } from "nsh";
import { mount, signal, Text, token, View, windowSize } from "nsh";
import { Input } from "nsh/base";
import { COMPOSER_LINE_HEIGHT, composerFieldBox, composerFrameClass, composerRowClass } from "../../components/chat/composerField";
import { nextComposerRows, SINGLE_ROW, type ComposerRows } from "../../components/chat/composerRows";

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

function FieldRow(props: { name: string; readonly?: boolean }) {
  const value = signal("");
  const measured = signal(COMPOSER_LINE_HEIGHT);
  const rows = signal<ComposerRows>(SINGLE_ROW);
  const multi = () => rows().multi;
  const box = () => composerFieldBox(multi(), measured());
  const settle = () => {
    const next = nextComposerRows(rows(), value(), measured() <= COMPOSER_LINE_HEIGHT * 1.5);
    if (next !== rows()) rows.set(next);
    put(`${props.name}-state`, { multi: next.multi, measured: measured(), box: composerFieldBox(next.multi, measured()) });
  };
  const control = (part: string) => <View class="size-[38px] rounded-(--radius) border border-line-soft" onLayout={track(`${props.name}-${part}`)} />;
  return (
    // lib/shell's isMobile (980pt), without the app's frame and stores.
    <View class={composerFrameClass(windowSize().width <= 980)} onLayout={track(`${props.name}-shell`)}>
      <View class={composerRowClass(multi())} onLayout={track(`${props.name}-row`)}>
        <If when={!multi()}>{control("add")}</If>
        <Input
          value={value()}
          multiline
          readonly={props.readonly}
          placeholder="Ask anything"
          testID={`${props.name}-input`}
          onChange={({ value: next }) => {
            value.set(next);
            settle();
          }}
          onContentSizeChange={({ size }) => {
            measured.set(Math.ceil(size.height));
            settle();
          }}
          onLayout={track(`${props.name}-field`)}
          class={`font-mono text-sm text-foreground placeholder:text-muted-foreground ${multi() ? "w-full" : "flex-1"}`}
          style={box()}
        />
        <If when={!multi()}>{control("send")}</If>
        <If when={multi()}>
          <View class="flex-row items-center justify-between">
            {control("add")}
            {control("send")}
          </View>
        </If>
      </View>
    </View>
  );
}

// The theme's colours the frame is drawn in, for the test's contrast check.
put("tokens", Object.fromEntries(["background", "field", "line", "input", "muted-foreground"].map((name) => [name, String(token(name as "line"))])));

mount(() => (
  <View class="gap-3 bg-background p-4">
    <FieldRow name="live" />
    <FieldRow name="readonly" readonly />
    <Text>{JSON.stringify(report())}</Text>
  </View>
));
