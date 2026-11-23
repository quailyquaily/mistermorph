// A test entry for tests/button-outlined-danger.test.tsx: every Button variant in every size, as a
// text and an icon button, idle, disabled, loading and selected; every CircleButton variant, idle,
// small and disabled. Each button's frame, the looks the variants are drawn with and the colours
// of the theme shown are read out as JSON text, last. `set-dark` / `set-light` switch the
// appearance as the console's Settings does (`setColorScheme`; the console never follows the system's).
import { colorScheme, mount, setColorScheme, signal, Text, token, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import {
  BUTTON_VARIANT_NAMES,
  Button,
  buttonVariantLook,
  CIRCLE_BUTTON_VARIANT_NAMES,
  CircleButton,
  circleButtonClass,
  type ButtonSize,
} from "../../components/ui";

const SIZES: ButtonSize[] = ["md", "sm", "xs", "xxs"];

type Frame = { w: number; h: number };

const COLOURS = [
  "background",
  "card",
  "foreground",
  "danger",
  "danger-disabled-text",
  "danger-disabled-line",
  "close",
  "close-hover",
  "outline-bg",
  "outline-bg-hover",
  "outline-disabled-bg",
  "outline-line",
  "outline-disabled-text",
  "ink",
  "destructive",
  "destructive-foreground",
];

const frames = signal<Record<string, Frame>>({});
const presses = signal<Record<string, number>>({});
const press = (id: string) => presses.update((all) => ({ ...all, [id]: (all[id] ?? 0) + 1 }));
const layout = (id: string) => (event: { bounds: { size: { width: number; height: number } } }) =>
  frames.update((all) => ({ ...all, [id]: { w: Math.round(event.bounds.size.width * 10) / 10, h: Math.round(event.bounds.size.height * 10) / 10 } }));

function report() {
  return JSON.stringify({
    frames: frames(),
    presses: presses(),
    looks: Object.fromEntries(BUTTON_VARIANT_NAMES.map((variant) => [variant, buttonVariantLook(variant)])),
    circles: Object.fromEntries(CIRCLE_BUTTON_VARIANT_NAMES.map((variant) => [variant, circleButtonClass({ variant })])),
    scheme: colorScheme(),
    colours: Object.fromEntries(COLOURS.map((name) => [name, String(token(name as "card")).toLowerCase()])),
  });
}

mount(() => (
  <View class="flex-1 gap-2 bg-background p-2">
    <View class="flex-row gap-2">
      <BaseButton testID="set-dark" onPress={() => setColorScheme("dark")}>
        <Text>dark</Text>
      </BaseButton>
      <BaseButton testID="set-light" onPress={() => setColorScheme("light")}>
        <Text>light</Text>
      </BaseButton>
    </View>
    {BUTTON_VARIANT_NAMES.map((variant) =>
      SIZES.map((size) => {
        const id = `${variant}-${size}`;
        return (
          <View class="flex-row flex-wrap items-center gap-1">
            <Button testID={`text-${id}`} variant={variant} size={size} label="Delete" onPress={() => press(`text-${id}`)} onLayout={layout(`text-${id}`)} />
            <Button testID={`icon-${id}`} variant={variant} size={size} icon="PhTrash" label="Delete" onPress={() => press(`icon-${id}`)} onLayout={layout(`icon-${id}`)} />
            <Button testID={`off-${id}`} variant={variant} size={size} label="Delete" disabled onPress={() => press(`off-${id}`)} />
            <Button testID={`off-icon-${id}`} variant={variant} size={size} icon="PhTrash" label="Delete" disabled />
            <Button testID={`busy-${id}`} variant={variant} size={size} label="Delete" loading onPress={() => press(`busy-${id}`)} onLayout={layout(`busy-${id}`)} />
            <Button testID={`busy-icon-${id}`} variant={variant} size={size} icon="PhTrash" label="Delete" loading />
            <Button testID={`on-${id}`} variant={variant} size={size} label="Delete" selected onPress={() => press(`on-${id}`)} />
            <Button testID={`on-icon-${id}`} variant={variant} size={size} icon="PhTrash" label="Delete" selected />
          </View>
        );
      }),
    )}
    <View class="flex-row flex-wrap items-center gap-1">
      {CIRCLE_BUTTON_VARIANT_NAMES.map((variant) => (
        <View class="flex-row items-start gap-1">
          <View onLayout={layout(`circle-${variant}`)}>
            <CircleButton testID={`circle-${variant}`} title={`Circle ${variant}`} icon="PhTrash" variant={variant} onPress={() => press(`circle-${variant}`)} />
          </View>
          <View onLayout={layout(`circle-${variant}-sm`)}>
            <CircleButton testID={`circle-${variant}-sm`} title={`Circle ${variant} sm`} icon="PhTrash" variant={variant} size="sm" />
          </View>
          <CircleButton testID={`circle-${variant}-off`} title={`Circle ${variant} off`} icon="PhTrash" variant={variant} disabled onPress={() => press(`circle-${variant}-off`)} />
          <CircleButton testID={`circle-${variant}-on`} title={`Circle ${variant} on`} icon="PhTrash" variant={variant} selected />
        </View>
      ))}
    </View>
    <Text testID="report">{report()}</Text>
  </View>
));
