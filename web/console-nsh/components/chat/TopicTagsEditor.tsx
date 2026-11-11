// Edits a topic's ordinary tags as chips. Each change is reported at once as the whole new list;
// the page saves it. A comma or Enter adds the typed tag; Backspace in the empty field removes the
// last one. While the field has focus, tags used on other topics are offered in a list that the
// arrow keys, Enter, Tab and presses pick from; Escape closes it. A press anywhere on the box (its
// chips, its padding) focuses the field, which opens that list. Ported from
// web/console/src/components/TopicTagsEditor.js.
import type { InputRef } from "nsh";
import { cleanup, effect, keymap, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";
import { Button, Icon } from "../ui";
import {
  MAX_TOPIC_TAG_LENGTH,
  MAX_TOPIC_TAGS,
  mergeTopicTags,
  parseTopicTagInput,
  suggestTopicTags,
} from "../../lib/core/topic-tags.js";
import { t } from "./i18n";

export function TopicTagsEditor(props: {
  tags: string[];
  known: string[];
  disabled?: boolean;
  saving?: boolean;
  onChange: (tags: string[]) => void;
}) {
  let field: InputRef | undefined;
  const draft = signal("");
  const focused = signal(false);
  const dismissed = signal(false);
  const active = signal(-1);

  const full = () => props.tags.length >= MAX_TOPIC_TAGS;
  const suggestions = (): string[] => suggestTopicTags(props.known, props.tags, draft());
  const open = () => focused() && !dismissed() && !props.disabled && suggestions().length > 0;

  effect(() => {
    void suggestions();
    untracked(() => active.set(-1));
  });

  function add(additions: string[]) {
    draft.set("");
    dismissed.set(false);
    if (additions.length === 0) return;
    const current = untracked(() => props.tags);
    const next = mergeTopicTags(current, additions).slice(0, MAX_TOPIC_TAGS);
    if (next.length !== current.length) props.onChange(next);
  }

  const commit = (text: string) => add(parseTopicTagInput(text));

  // Leaving the field adds what was typed, a moment later: a press on a suggestion takes the focus
  // first and must not add the half-typed text before the tag it picks.
  let blurTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(blurTimer));

  // The field takes the focus once the press that asks for it is over. On the web a tap's press
  // fires before the browser's mouse events for it, and their focus went to the box or the option
  // pressed (Tab stops, as pressables are), so a field focused at once lost it again: tapping the
  // box opened nothing, and a tapped suggestion closed the list and the keyboard. The box and the
  // options are no Tab stops either (the field's arrow keys walk the list).
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(focusTimer));
  function focusField() {
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => field?.focus(), 0);
  }

  function pick(tag: string) {
    clearTimeout(blurTimer);
    add([tag]);
    focusField();
  }

  function remove(index: number) {
    if (props.disabled) return;
    props.onChange(props.tags.filter((_, i) => i !== index));
    focusField();
  }

  function move(step: number) {
    const count = untracked(suggestions).length;
    if (count === 0) return;
    dismissed.set(false);
    const current = untracked(active);
    active.set(current < 0 ? (step > 0 ? 0 : count - 1) : (current + step + count) % count);
  }

  // The list's keys, while the field has the focus.
  effect(() => {
    if (!focused() || props.disabled) return;
    const bindings: Record<string, () => void> = {
      down: () => move(1),
      up: () => move(-1),
      escape: () => {
        if (untracked(open)) dismissed.set(true);
        else draft.set("");
      },
    };
    if (open() && active() >= 0) bindings.tab = () => pick(untracked(suggestions)[untracked(active)]);
    cleanup(keymap.bind(bindings, { when: "always" }));
  });

  return (
    <View class="gap-1">
      <View
        class={`min-h-8 flex-row flex-wrap items-center gap-1 rounded-(--radius) border border-input bg-field px-1.5 py-1 ${
          props.disabled ? "opacity-60" : ""
        }`}
        focusable={false}
        onPress={() => focusField()}
        testID="chat-topic-tags"
      >
        <Each of={props.tags} key={(tag) => tag}>
          {(tag, index) => (
            <View class="flex-row items-center gap-0.5 rounded-(--radius) bg-selection pl-1.5">
              <Text class="text-xs text-foreground">{tag()}</Text>
              <Button
                variant="plain"
                size="xxs"
                iconOnly
                icon="PhX"
                title={t("chat_topic_tags_remove", { tag: tag() })}
                disabled={props.disabled}
                onPress={() => remove(index())}
              />
            </View>
          )}
        </Each>
        <If
          when={!full()}
          else={<Text class="text-xs text-muted-foreground">{t("chat_topic_tags_full", { max: MAX_TOPIC_TAGS })}</Text>}
        >
          <Input
            ref={field}
            value={draft()}
            maxLength={MAX_TOPIC_TAG_LENGTH}
            placeholder={props.tags.length ? t("chat_topic_tags_more") : t("chat_topic_tags_placeholder")}
            accessibilityLabel={t("chat_topic_tags_add")}
            readonly={props.disabled}
            autoCapitalize="none"
            autoCorrect={false}
            submitBehavior="submit"
            returnKeyType="done"
            testID="chat-topic-tags-input"
            onFocus={() => {
              clearTimeout(blurTimer);
              focused.set(true);
              dismissed.set(false);
            }}
            onBlur={() => {
              clearTimeout(blurTimer);
              blurTimer = setTimeout(() => {
                focused.set(false);
                commit(untracked(draft));
              }, 150);
            }}
            onKeyPress={({ key }) => {
              if (key === "Backspace" && untracked(draft) === "" && props.tags.length > 0) remove(props.tags.length - 1);
            }}
            onChange={({ value }) => {
              dismissed.set(false);
              // A typed or pasted comma ends a tag.
              if (/[,，、]/u.test(value)) {
                commit(value);
                return;
              }
              draft.set(value);
            }}
            onSubmit={() => {
              if (untracked(open) && untracked(active) >= 0) pick(untracked(suggestions)[untracked(active)]);
              else commit(untracked(draft));
            }}
            class="min-w-24 flex-1 px-1 py-0.5 text-sm text-foreground placeholder:text-placeholder"
          />
        </If>
      </View>
      <If when={open()}>
        <View role="listbox" accessibilityLabel={t("chat_topic_tags_suggestions")} class="rounded-(--radius) border border-border bg-popover py-1 shadow-md">
          <Each of={suggestions()} key={(tag) => tag}>
            {(tag, index) => (
              <View
                role="option"
                accessibilityState={{ selected: index() === active() }}
                focusable={false}
                onPress={() => pick(tag())}
                accessibilityLabel={tag()}
                class={`flex-row items-center gap-1.5 px-2.5 py-1 ${index() === active() ? "bg-selection" : "hover:bg-hover"}`}
              >
                <Icon name="PhTag" size={12} color="subtle" />
                <Text class="text-sm text-foreground">{tag()}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}
