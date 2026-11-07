// A field whose value comes from an environment variable (the Vue console's EnvManagedField): a
// locked, read-only box with the variable's name (and value, for a field that is not secret).
// Pressing it copies the name. Children sit at its end, such as the secret picker's button.
import type { JSX } from "nsh";
import { cleanup, signal, Text, View } from "nsh";
import { Button as BaseButton, Tooltip } from "nsh/base";
import { translate } from "../../lib/core/context.js";
import { copyText } from "../../lib/platform";
import { Icon } from "../ui";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

export interface EnvManagedFieldProps {
  /** "NAME" or "NAME=value". */
  name: string;
  /** Replaces the tooltip (the Vue `title` attribute). */
  title?: string;
  children?: JSX.Element;
  class?: string;
  testID?: string;
}

export function EnvManagedField(props: EnvManagedFieldProps) {
  const copied = signal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(timer));

  const variable = () => String(props.name || "").split("=")[0].trim();
  const label = () => String(props.name || "").trim() || t("settings_env_managed_tag");
  const title = () =>
    copied()
      ? t("settings_env_managed_copied")
      : props.title || t("settings_env_managed_title", { name: variable() || t("settings_env_managed_tag") });

  const copy = async () => {
    if (!variable()) return;
    try {
      await copyText(variable());
    } catch (error) {
      console.warn("[EnvManagedField] copy failed", error);
      return;
    }
    copied.set(true);
    clearTimeout(timer);
    timer = setTimeout(() => copied.set(false), 1600);
  };

  return (
    <View
      testID={props.testID}
      class={`min-h-9 flex-row items-center gap-0.5 rounded-(--radius) border border-line-faint bg-muted pr-1 hover:border-line ${
        props.class ?? ""
      }`}
    >
      <BaseButton
        onPress={() => void copy()}
        accessibilityLabel={title()}
        tooltip={
          <Tooltip class="bg-foreground px-2 py-1">
            <Text class="text-xs text-background">{title()}</Text>
          </Tooltip>
        }
        class="flex-1 min-w-0 flex-row items-center gap-2 py-2 pl-3 pr-2"
      >
        <Icon name="PhLockSimple" size={15} color="muted-foreground" />
        <Text class="flex-1 font-mono text-xs text-subtle" style={{ numberOfLines: 1 }}>
          {label()}
        </Text>
        <Text class={`font-mono text-xs uppercase tracking-wide ${copied() ? "text-ok" : "text-muted-foreground"}`}>
          {copied() ? t("settings_env_managed_copied") : t("settings_env_managed_tag")}
        </Text>
      </BaseButton>
      {props.children}
    </View>
  );
}
