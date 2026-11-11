// A test entry for tests/rolling-number.test.tsx: a RollingNumber and a button that changes its value.
import { mount, signal, View } from "nsh";
import { Button } from "../../components/ui";
import { RollingNumber } from "../../components/shared/RollingNumber";

const value = signal("1,239");

mount(() => (
  <View class="flex-1 items-start gap-4 p-6">
    <RollingNumber value={value()} class="text-base" testID="number" />
    <Button label="Next" onPress={() => value.set("1,302")} testID="next" />
  </View>
));
