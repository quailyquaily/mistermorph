// A panel of config fields by group (the Vue console's ConfigSettingsPanel): each field gets the
// editor its type asks for, a draft is kept, and the changes are saved as one config update.
//
// A field with `dependsOn` is inactive while that switch (or one it depends on in turn) is off in the
// draft. A clearable field not set in the config reads as empty, not as its zero value. With a
// `saveScope` and a SettingsSaveRegistry from the Settings page, the panel hands its changes to the
// section's save bar instead of showing its own Save button.
//
// Vue to nsh: `save` is `onSave(update)`, `update:dirty` is `onDirtyChange(dirty)`. The Vue
// `provide("settingsSaveRegistry", ...)` is the SettingsSaveRegistry context.
import { batch, cleanup, computed, context, effect, signal, Text, untracked, View } from "nsh";
import { buildConfigUpdate, createConfigDraft } from "../../lib/core/config-fields.js";
import { Button, ProgressBar, Section, TextField, Toggle } from "../ui";
import { useRevealRow } from "../settings-page/reveal";
import { EnvManagedField } from "./EnvManagedField";
import { SecretInput } from "./SecretInput";
import {
  SettingBytes,
  SettingChoices,
  SettingDuration,
  SettingField,
  SettingFieldGrid,
  SettingLimit,
  SettingPath,
  SettingPercent,
  SettingRows,
  type SettingRowsMode,
  SettingSelect,
} from "./SettingFields";

/** A config field (lib/core/config-field-groups.js). */
export interface ConfigField {
  path: string;
  label?: string;
  type?: string;
  editor?: string;
  note?: string;
  placeholder?: string;
  secret?: boolean;
  clearable?: boolean;
  dependsOn?: string;
  wide?: boolean;
  options?: any[];
  allowCustom?: boolean;
  duration?: boolean;
  zeroLabel?: string;
  defaultLimit?: string;
  rows?: string;
  platforms?: any[];
  addLabel?: string;
  [key: string]: unknown;
}

export interface ConfigGroup {
  id: string;
  title?: string;
  note?: string;
  fields: ConfigField[];
  [key: string]: unknown;
}

/** A field's state as the runtime reports it (GET /settings/... field_states). */
export interface ConfigFieldState {
  explicit?: boolean;
  editable?: boolean;
  source?: string;
  env_name?: string;
  apply_mode?: string;
  configured?: boolean;
  [key: string]: unknown;
}

/** What a save sends: { config_changes, reset }. */
export type ConfigUpdate = { config_changes: Record<string, unknown>; reset: string[]; [key: string]: unknown };

/** A panel registered with the section save bar. */
export interface SettingsSaveEntry {
  key: string;
  scope: string;
  label: () => string;
  dirty: () => boolean;
  /** Validated changes, null when there is nothing to save; throws (and shows the error) when invalid. */
  collectUpdate: () => ConfigUpdate | null;
}

export interface SettingsSaveRegistry {
  register(entry: SettingsSaveEntry): void;
  unregister(key: string): void;
}

/** Provided by the Settings page: panels with a `saveScope` hand their changes to its save bar. */
export const SettingsSaveRegistryContext = context<SettingsSaveRegistry | null>(null);

export interface ConfigSettingsPanelProps {
  groups: ConfigGroup[];
  values?: Record<string, unknown>;
  fieldStates?: Record<string, ConfigFieldState | undefined>;
  loading?: boolean;
  saving?: boolean;
  embedded?: boolean;
  hideSingleGroupHeading?: boolean;
  /** Where the panel's own Save button goes: "header" (default), "footer", or "none". */
  savePlacement?: "header" | "footer" | "none";
  /** Group id -> note. A listed group shows dimmed and read-only, with the note. */
  inactiveGroups?: Record<string, string>;
  /** "agent", "console" or "system": with a registry, the panel saves through the section save bar. */
  saveScope?: string;
  /** Field paths not shown right now; their drafts are kept. */
  hiddenPaths?: string[];
  onSave?: (update: ConfigUpdate) => void;
  onDirtyChange?: (dirty: boolean) => void;
  class?: string;
  testID?: string;
}

let panelSeq = 0;

export function ConfigSettingsPanel(props: ConfigSettingsPanelProps) {
  const registry = SettingsSaveRegistryContext();
  const registered = () => Boolean(registry && props.saveScope);
  const showHeading = () => !props.hideSingleGroupHeading || props.groups.length > 1;
  const draft = signal<Record<string, any>>({});
  const original = signal<Record<string, any>>({});
  const reset = signal<Record<string, boolean>>({});
  const validationError = signal("");

  const fields = computed<ConfigField[]>(() =>
    (props.groups || []).flatMap((group) => (Array.isArray(group.fields) ? group.fields : [])),
  );
  // Reset only when the set of fields changes: a parent that builds `groups` inline makes a new
  // array each time, which must not wipe edits.
  const fieldsKey = computed(() => fields().map((field) => field.path).join("\n"));
  const fieldsByPath = computed(() => new Map(fields().map((field) => [field.path, field])));

  const stateFor = (field: ConfigField): ConfigFieldState => props.fieldStates?.[field.path] || {};

  // A clearable field that is not set in the config reads as empty, not as its zero value (an unset
  // temperature is "provider default", not 0).
  const effectiveValues = () => {
    const values: Record<string, unknown> = { ...(props.values || {}) };
    for (const field of fields()) {
      if (field.clearable && props.fieldStates?.[field.path]?.explicit !== true) values[field.path] = "";
    }
    return values;
  };

  const replaceDraft = () => {
    const next = createConfigDraft(effectiveValues(), fields());
    batch(() => {
      draft.set(next);
      original.set({ ...next });
      reset.set({});
      validationError.set("");
    });
  };

  effect(() => {
    void props.values;
    void fieldsKey();
    untracked(replaceDraft);
  });

  const dirty = computed(() => {
    if (Object.values(reset()).some(Boolean)) return true;
    const current = draft();
    const saved = original();
    return fields().some((field) => !Object.is(current[field.path], saved[field.path]));
  });

  let firstDirty = true;
  effect(() => {
    const value = dirty();
    if (firstDirty) {
      firstDirty = false;
      if (!value) return;
    }
    untracked(() => props.onDirtyChange?.(value));
  });

  // The outermost switch that is off (the one to turn on first), or "" when the field is active.
  const blockingSwitch = (field: ConfigField) => {
    const seen = new Set<string>();
    let blocking = "";
    const current = draft();
    for (let path = field.dependsOn; path && !seen.has(path); path = fieldsByPath().get(path)?.dependsOn) {
      seen.add(path);
      if (!current[path]) blocking = path;
    }
    return blocking;
  };
  const fieldInactive = (field: ConfigField) => Boolean(blockingSwitch(field));
  const dependencyNote = (field: ConfigField) => {
    const path = blockingSwitch(field);
    const parent = fieldsByPath().get(path);
    return `Turn on ${parent?.label || path} to change this.`;
  };
  const visibleFields = (group: ConfigGroup) => {
    const hidden = new Set(props.hiddenPaths || []);
    return (Array.isArray(group.fields) ? group.fields : []).filter((field) => !hidden.has(field.path));
  };
  const groupInactiveNote = (group: ConfigGroup) => props.inactiveGroups?.[group.id] || "";
  const fieldDisabled = (field: ConfigField, group: ConfigGroup | null = null) =>
    Boolean(
      props.loading ||
        props.saving ||
        stateFor(field).editable === false ||
        fieldInactive(field) ||
        (group && groupInactiveNote(group)),
    );
  const restartRequired = (field: ConfigField) => {
    const mode = stateFor(field).apply_mode;
    return mode === "runtime_restart" || mode === "process_restart";
  };
  const environmentManaged = (field: ConfigField) => {
    const source = stateFor(field).source;
    return source === "environment_override" || source === "config_env_ref";
  };
  const environmentManagedName = (field: ConfigField) => stateFor(field).env_name || "Environment variable";
  // Secrets, and fields whose empty value means "use the default", can be cleared from the config.
  const showClear = (field: ConfigField) => {
    const state = stateFor(field);
    return (field.secret === true || field.clearable === true) && state.explicit === true && state.editable !== false;
  };
  const sourceLabel = (field: ConfigField) => {
    const source = stateFor(field).source;
    if (source === "runtime_override") return "Managed by a command-line flag";
    if (source === "config_aws_ref") return "AWS Secrets Manager reference";
    if (source === "config_os_ref") return "System secret store";
    return "";
  };

  const updateField = (field: ConfigField, value: unknown) => {
    batch(() => {
      draft.update((current) => ({ ...current, [field.path]: value }));
      reset.update((current) => {
        if (!current[field.path]) return current;
        const next = { ...current };
        delete next[field.path];
        return next;
      });
      validationError.set("");
    });
  };
  const resetField = (field: ConfigField) => {
    batch(() => {
      reset.update((current) => ({ ...current, [field.path]: true }));
      // A cleared non-secret field shows empty, so its placeholder ("Provider default") explains the result.
      if (field.clearable) draft.update((current) => ({ ...current, [field.path]: "" }));
      validationError.set("");
    });
  };

  const build = (): ConfigUpdate =>
    buildConfigUpdate(
      untracked(draft),
      untracked(original),
      Object.keys(untracked(reset)).filter((path) => untracked(reset)[path]),
      untracked(fields),
    ) as ConfigUpdate;

  // Validated changes for the section save bar: null when there is nothing to save. Throws (and
  // shows the error in the panel) when a value is invalid.
  const collectUpdate = () => {
    if (!untracked(dirty)) return null;
    try {
      const update = build();
      validationError.set("");
      return update;
    } catch (error: any) {
      validationError.set(error?.message || "Invalid setting");
      throw error;
    }
  };

  const save = () => {
    try {
      const update = build();
      validationError.set("");
      props.onSave?.(update);
    } catch (error: any) {
      validationError.set(error?.message || "Invalid setting");
    }
  };

  const registryKey = `config-panel-${++panelSeq}`;
  if (untracked(registered)) {
    registry!.register({
      key: registryKey,
      scope: untracked(() => props.saveScope || ""),
      label: () => props.groups[0]?.title || "Settings",
      dirty: () => dirty(),
      collectUpdate,
    });
    cleanup(() => registry!.unregister(registryKey));
  }

  const saveButton = (variant: "plain" | "primary") => (
    <Button
      variant={variant}
      size={variant === "plain" ? "xs" : "sm"}
      label="Save"
      loading={props.saving}
      disabled={props.loading || props.saving || !dirty()}
      onPress={save}
      testID={props.testID ? `${props.testID}-save` : undefined}
    />
  );

  const restartTag = () => <Text class="font-mono text-xs uppercase tracking-wide text-warn-dark">Restart required</Text>;

  const editor = (field: ConfigField, group: ConfigGroup) => (
    <If when={environmentManaged(field) && !field.secret} else={typedEditor(field, group)}>
      <EnvManagedField name={environmentManagedName(field)} />
    </If>
  );

  // The editor a field's type asks for (types do not change while the panel lives).
  const typedEditor = (field: ConfigField, group: ConfigGroup) => {
    const disabled = () => fieldDisabled(field, group);
    const value = () => draft()[field.path];
    const text = () => String(value() ?? "");
    const set = (next: unknown) => updateField(field, next);
    switch (field.editor) {
      case "bytes":
        return <SettingBytes value={text()} label={field.label} disabled={disabled()} onChange={set} />;
      case "duration":
        return <SettingDuration value={text()} label={field.label} zeroLabel={field.zeroLabel || ""} disabled={disabled()} onChange={set} />;
      case "percent":
        return <SettingPercent value={text()} label={field.label} disabled={disabled()} onChange={set} />;
      case "limit":
        return <SettingLimit value={text()} label={field.label} defaultLimit={field.defaultLimit || ""} disabled={disabled()} onChange={set} />;
      case "directory":
        return <SettingPath value={text()} label={field.label} placeholder={field.placeholder || ""} disabled={disabled()} onChange={set} />;
      case "rows":
        return (
          <SettingRows
            value={text()}
            mode={(field.rows || "list") as SettingRowsMode}
            platforms={field.platforms || []}
            label={field.label}
            placeholder={field.placeholder || ""}
            addLabel={field.addLabel || "Add"}
            disabled={disabled()}
            onChange={set}
            fallback={<TextField value={text()} multiline rows={7} mono disabled={disabled()} onChange={set} />}
          />
        );
    }
    if (field.type === "select") {
      return (
        <SettingSelect
          value={text()}
          options={field.options || []}
          allowCustom={field.allowCustom}
          customLabel={field.duration ? "Custom duration" : "Custom value"}
          customPlaceholder={field.duration ? "e.g. 5m or 1h" : ""}
          label={field.label}
          placeholder={field.placeholder || "Default"}
          disabled={disabled()}
          onChange={set}
        />
      );
    }
    if (field.type === "string_list" && field.options) {
      return (
        <SettingChoices
          value={text()
            .split(/\r?\n/)
            .map((item) => item.trim())
            .filter(Boolean)}
          options={field.options as string[]}
          label={field.label}
          disabled={disabled()}
          onChange={(items) => set(items.join("\n"))}
        />
      );
    }
    if (field.type === "string_list" || field.type === "json") {
      return (
        <TextField
          value={text()}
          multiline
          rows={field.type === "json" ? 7 : 4}
          mono={field.type === "json"}
          placeholder={field.placeholder || ""}
          disabled={disabled()}
          accessibilityLabel={field.label}
          onChange={set}
        />
      );
    }
    if (field.secret) {
      return (
        <SecretInput
          envName={environmentManaged(field) ? environmentManagedName(field) : ""}
          value={text()}
          status={stateFor(field)}
          revealPath={field.path}
          placeholder={field.placeholder || ""}
          disabled={disabled()}
          onChange={set}
        />
      );
    }
    return (
      <TextField
        value={text()}
        keyboardType={field.type === "int" ? "number-pad" : field.type === "float" ? "decimal-pad" : undefined}
        placeholder={field.placeholder || ""}
        disabled={disabled()}
        accessibilityLabel={field.label}
        onChange={set}
      />
    );
  };

  // A switch's row: text on the left, the switch on the right; found by the page's search.
  const ToggleRow = (rowProps: { field: ConfigField; group: ConfigGroup }) => {
    const field = rowProps.field;
    const reveal = useRevealRow(() => field.label);
    return (
      <View
        ref={reveal.ref}
        testID={`setting-${field.path}`}
        class={`w-full flex-row items-center justify-between gap-4 rounded-(--radius) py-1 ${fieldInactive(field) ? "opacity-60" : ""} ${
          reveal.marked() ? "bg-selection" : ""
        }`}
      >
        <View class="flex-1 gap-0.5">
          <Text class="text-sm font-medium text-foreground">{field.label ?? ""}</Text>
          <If when={field.note}>
            <Text class="text-xs text-muted-foreground">{field.note}</Text>
          </If>
          <If when={fieldInactive(field)}>
            <Text class="text-xs italic text-muted-foreground">{dependencyNote(field)}</Text>
          </If>
          <If when={restartRequired(field)}>{restartTag()}</If>
        </View>
        <Toggle
          checked={Boolean(draft()[field.path])}
          disabled={fieldDisabled(field, rowProps.group)}
          onChange={(checked) => updateField(field, checked)}
          testID={`setting-${field.path}-switch`}
        />
      </View>
    );
  };

  const fieldView = (field: ConfigField, group: ConfigGroup) => {
    const wide = () => Boolean(field.wide || field.type === "json" || field.type === "string_list" || field.type === "bool");
    return (
      <If
        when={field.type === "bool" && !environmentManaged(field)}
        else={
          <SettingField
            label={field.label}
            labelRight={restartRequired(field) ? restartTag() : undefined}
            wide={wide()}
            inactive={fieldInactive(field)}
            note={fieldInactive(field) ? dependencyNote(field) : field.note}
            noteItalic={fieldInactive(field)}
            testID={`setting-${field.path}`}
          >
            {editor(field, group)}
            <If when={sourceLabel(field) || showClear(field)}>
              <View class="min-h-6 flex-row items-center justify-between gap-3">
                <Text class="text-xs text-muted-foreground">{sourceLabel(field)}</Text>
                <If when={showClear(field)}>
                  <Button
                    variant="plain"
                    size="xs"
                    label="Clear"
                    disabled={props.loading || props.saving}
                    onPress={() => resetField(field)}
                    testID={`setting-${field.path}-clear`}
                  />
                </If>
              </View>
            </If>
          </SettingField>
        }
      >
        <ToggleRow field={field} group={group} />
      </If>
    );
  };

  return (
    <View class={`gap-4 ${props.class ?? ""}`} testID={props.testID}>
      <If when={props.loading}>
        <ProgressBar indeterminate label="Loading" />
      </If>
      <If when={validationError()}>
        <View class="rounded-(--radius) border border-danger bg-card px-3 py-2" role="alert">
          <Text class="text-sm text-danger">{validationError()}</Text>
        </View>
      </If>
      <Each of={props.groups || []} key={(group) => group.id}>
        {(group, index) => (
          <Section
            variant={props.embedded ? "plain" : "card"}
            title={showHeading() ? group().title || "" : ""}
            meta={showHeading() ? group().note || "" : ""}
            actions={
              !registered() && (props.savePlacement ?? "header") === "header" && index() === 0 ? saveButton("plain") : undefined
            }
          >
            <If when={groupInactiveNote(group())}>
              <Text class="text-xs italic text-muted-foreground">{groupInactiveNote(group())}</Text>
            </If>
            <View class={groupInactiveNote(group()) ? "opacity-60" : ""}>
              <SettingFieldGrid>
                <Each of={visibleFields(group())} key={(field) => field.path}>
                  {(field) => fieldView(field(), group())}
                </Each>
              </SettingFieldGrid>
            </View>
          </Section>
        )}
      </Each>
      <If when={!registered() && props.savePlacement === "footer"}>
        <View class="flex-row justify-end">{saveButton("primary")}</View>
      </If>
    </View>
  );
}
