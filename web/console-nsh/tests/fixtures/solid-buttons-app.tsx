// A test entry for tests/solid-buttons.test.tsx: the solid controls (Button primary, danger and
// highlight; CircleButton primary and danger; the capsule toolbar's primary and its pale danger
// stop) at rest, disabled, loading and selected, and a switch to the dark palette (the Console
// sets its own scheme: `setColorScheme`, as themeStore does). `out-scheme` reads a token back, so
// a test knows which palette is shown before it trusts a colour; `out-shadows` says whether this
// platform draws the solid shadows (not on Android).
import { mount, setColorScheme, signal, Text, token, View } from "nsh";
import { Button, CircleButton, type ButtonVariant } from "../../components/ui";
import { CapsuleButton, capsuleButtonLook } from "../../components/shared/CapsuleBar";
import { SOLID_SHADOWS } from "../../components/solidLook";

const SOLID: ButtonVariant[] = ["primary", "danger", "highlight"];

function Gallery() {
  const presses = signal(0);
  const press = () => presses.update((n) => n + 1);
  return (
    <View class="gap-3 bg-paper p-4">
      <View class="flex-row gap-2">
        <Button testID="set-dark" variant="outlined" size="xs" label="Dark" onPress={() => setColorScheme("dark")} />
        <Button testID="set-light" variant="outlined" size="xs" label="Light" onPress={() => setColorScheme("light")} />
        <Text testID="out-scheme">scheme={String(token("background"))}</Text>
        <Text testID="out-presses">presses={presses()}</Text>
        <Text testID="out-shadows">shadows={String(SOLID_SHADOWS)}</Text>
      </View>
      {SOLID.map((variant) => (
        <View class="flex-row gap-2">
          <Button testID={`rest-${variant}`} variant={variant} label="Save" onPress={press} />
          <Button testID={`icon-${variant}`} variant={variant} icon="PhCheck" title="Save" onPress={press} />
          <Button testID={`disabled-${variant}`} variant={variant} label="Save" disabled onPress={press} />
          <Button testID={`loading-${variant}`} variant={variant} label="Save" loading onPress={press} />
          <Button testID={`selected-${variant}`} variant={variant} label="Save" selected onPress={press} />
        </View>
      ))}
      <View class="flex-row gap-2">
        <CircleButton testID="circle-primary" variant="primary" icon="PhPlus" title="Add" onPress={press} />
        <CircleButton testID="circle-primary-disabled" variant="primary" icon="PhPlus" title="Add" disabled onPress={press} />
        <CircleButton testID="circle-danger" variant="danger" icon="PhPlus" title="Add" onPress={press} />
        <CircleButton testID="circle-danger-disabled" variant="danger" icon="PhPlus" title="Add" disabled onPress={press} />
      </View>
      <View class="flex-row gap-2">
        <CapsuleButton testID="capsule-primary" look={capsuleButtonLook("primary", "PhPlay")} label="Start" onPress={press} />
        <CapsuleButton testID="capsule-primary-disabled" look={capsuleButtonLook("primary", "PhPlay", { disabled: true })} label="Start" disabled />
        <CapsuleButton testID="capsule-danger" look={capsuleButtonLook("danger", "PhStop")} label="Stop" onPress={press} />
      </View>
    </View>
  );
}

mount(() => <Gallery />);
