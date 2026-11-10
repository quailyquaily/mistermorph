// A test entry for tests/fade-text.test.tsx: FadeTexts as the topic list draws its titles (text
// classes, 34pt fade), in boxes of a width the test changes, with how each is drawn letter by letter
// (`onGlyphFade`, Android) read out beside them. Buttons change the live one's width and text.
import { mount, signal, Text, View } from "nsh";
import { FadeText } from "../../components/motion/FadeText";
import type { GlyphFadePlan } from "../../components/motion/glyphFade";

const LATIN = "Plan the quarterly roadmap review with the platform and design teams";
const CHINESE = "整理下季度产品路线图评审会议纪要并同步给平台组和设计组的同事们";
const TITLE_CLASS = "text-sm leading-5 tracking-[-0.025em] text-foreground";

const plans = signal<Record<string, GlyphFadePlan | null | "unset">>({});
const width = signal(200);
const live = signal(LATIN);

function put(name: string) {
  return (plan: GlyphFadePlan | null) => plans.update((all) => ({ ...all, [name]: plan }));
}

function Case(props: { name: string; text: string; width: number }) {
  return (
    <View style={{ width: props.width }} class="flex-row items-center gap-2.5">
      <View class="size-5 bg-muted" />
      <View class="flex-1 gap-px">
        <FadeText text={props.text} class={TITLE_CLASS} noTooltip testID={`fade-${props.name}`} onGlyphFade={put(props.name)} />
      </View>
      <View class="size-2 rounded-full bg-muted" testID={`dot-${props.name}`} />
    </View>
  );
}

function Button(props: { id: string; onPress: () => void }) {
  return (
    <View testID={props.id} onPress={props.onPress} class="h-6 w-6 bg-muted">
      <Text class="text-xs">{props.id}</Text>
    </View>
  );
}

function Gallery() {
  return (
    <View class="gap-2 p-2">
      <Case name="latin" text={LATIN} width={220} />
      <Case name="chinese" text={CHINESE} width={220} />
      <Case name="fits" text="Trip plans" width={220} />
      <Case name="empty" text="" width={220} />
      <Case name="narrow" text={CHINESE} width={60} />
      <Case name="live" text={live()} width={width()} />
      <View class="flex-row gap-2">
        <Button id="widen" onPress={() => width.set(1200)} />
        <Button id="narrow" onPress={() => width.set(200)} />
        <Button id="short" onPress={() => live.set("Recipes")} />
        <Button id="chinese" onPress={() => live.set(CHINESE)} />
      </View>
      <Text testID="plans">{JSON.stringify(plans())}</Text>
    </View>
  );
}

mount(() => <Gallery />);
