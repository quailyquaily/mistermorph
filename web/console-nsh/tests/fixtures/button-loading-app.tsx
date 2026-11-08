// A test entry for tests/button-loading.test.tsx: Buttons whose press starts an action the test
// settles (`id:settle-ok`, `id:settle-fail`), each variant held loading, and the widths the
// buttons lay out at, read out beside them.
import { mount, signal, Text, View } from "nsh";
import { Button, type ButtonVariant } from "../../components/ui";

const VARIANTS: ButtonVariant[] = ["primary", "outlined", "plain", "danger", "highlight", "ghost-danger"];

function Out(props: { name: string; value: unknown }) {
  return (
    <Text testID={`out-${props.name}`}>
      {props.name}={String(props.value)}
    </Text>
  );
}

function Gallery() {
  const saving = signal(false);
  const runs = signal(0);
  const result = signal("none");
  const width = signal(0);
  const held = signal(true);
  let settle: ((ok: boolean) => void) | null = null;

  // As the console's pages do: loading on, the request, then loading off whichever way it ends.
  async function save() {
    runs.update((n) => n + 1);
    saving.set(true);
    try {
      const ok = await new Promise<boolean>((resolve) => (settle = resolve));
      if (!ok) throw new Error("failed");
      result.set("saved");
    } catch {
      result.set("failed");
    } finally {
      settle = null;
      saving.set(false);
    }
  }

  return (
    <View class="gap-3 bg-background p-4">
      <View class="self-start" onLayout={(event) => width.set(Math.round(event.bounds.size.width))}>
        <Button testID="save" label="Save" loading={saving()} onPress={() => void save()} />
      </View>
      <Button testID="settle-ok" variant="outlined" size="xs" label="Settle ok" onPress={() => settle?.(true)} />
      <Button testID="settle-fail" variant="outlined" size="xs" label="Settle fail" onPress={() => settle?.(false)} />
      <Button testID="toggle-held" variant="outlined" size="xs" label="Toggle held" onPress={() => held.set(!held())} />
      <Out name="runs" value={runs()} />
      <Out name="result" value={result()} />
      <Out name="width" value={width()} />
      {VARIANTS.map((variant) => (
        <View class="flex-row gap-2">
          <Button testID={`idle-${variant}`} variant={variant} label="Idle" />
          <Button testID={`held-${variant}`} variant={variant} label="Held" loading={held()} />
          <Button testID={`icon-${variant}`} variant={variant} size="xs" icon="PhArrowClockwise" iconOnly title="Refresh" loading={held()} />
        </View>
      ))}
    </View>
  );
}

mount(() => <Gallery />);
