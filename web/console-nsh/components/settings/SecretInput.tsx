// A password field for an API key or token (the Vue console's SecretInput), and the secret picker
// dialog (SecretKeyPicker).
//
// Once a secret is stored it shows as a filled field: the value masked, and a small tag naming where
// it is kept (the system's secret storage, config.yaml in plain text, an environment variable, AWS
// Secrets Manager), with the full explanation in its tooltip. The eye shows the stored value (asking
// for the console password first when it has one) and hides it again after 30 seconds; the pencil
// opens an empty field for a new value, and the undo arrow beside it keeps the current one. While
// typing, the eye shows what is typed.
//
// Where a settings page provides SecretPicker ({ enabled }), the key button opens the secret picker
// to use a key another field already has. A field that points at a variable, a stored secret or an
// AWS secret offers it only while another field uses the same one. The undo arrow drops a picked key.
//
// Vue to nsh: `modelValue` is `value`, `update:modelValue` is `onChange(value)`. The Vue
// `provide("secretPicker", { enabled })` is the SecretPicker context, given an accessor.
import type { InputRef, JSX } from "nsh";
import { batch, cleanup, context, effect, keymap, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton, Tooltip } from "nsh/base";
import { translate } from "../../lib/core/context.js";
import { canSwapReference, pickerKeys, referenceEnvName, secretFieldLabel } from "../../lib/core/secret-keys.js";
import { loadSecretInfo, loadSecretKeys, loadSecretKeysShared, revealSecret } from "../../lib/core/secret-reveal.js";
import { secretStorageKind } from "../../lib/core/secret-storage.js";
import { Button, Icon, type IconName, Modal, TextField } from "../ui";
import { EnvManagedField } from "./EnvManagedField";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

/** Status of a secret field, as the runtime reports it. */
export interface SecretStatus {
  configured?: boolean;
  source?: string;
  editable?: boolean;
  [key: string]: unknown;
}

/** A key picked from another field: { value, kind, hint, from }. */
export interface PickedSecret {
  value: string;
  kind: string;
  hint: string;
  from: string;
}

/**
 * Where a settings page offers the secret picker: `<SecretPicker.Provider value={{ enabled: () => local() }}>`.
 * Without a provider the picker is off.
 */
export const SecretPicker = context<{ enabled: () => boolean } | null>(null);

const KIND_ICONS: Record<string, IconName> = {
  os: "PhShieldCheck",
  file: "PhWarningCircle",
  env: "PhTerminalWindow",
  aws: "PhCloud",
  stored: "PhLockSimple",
};

// Where a field points at a key kept elsewhere; it can be pointed at another key only while another
// field still uses the one it has.
const REFERENCE_KINDS = new Set(["os", "env", "aws"]);

// A shown secret hides itself again after this long.
const REVEAL_MS = 30000;

const MASK = "••••••••••••";

interface SecretInfo {
  reveal?: boolean;
  password_required?: boolean;
  store?: string;
}

function revealErrorText(error: any) {
  return error?.status === 403 ? t("secret_reveal_wrong_password") : error?.message || t("secret_reveal_failed");
}

function kindTagText(kind: string, info: SecretInfo | null) {
  return kind === "os" && info?.store ? t("secret_store_" + info.store) : t("secret_tag_" + kind);
}

export interface SecretInputProps {
  value: string;
  onChange?: (value: string) => void;
  status?: SecretStatus | null;
  placeholder?: string;
  disabled?: boolean;
  /** The secret's config path ("llm.api_key"); empty when it cannot be revealed. */
  revealPath?: string;
  /** For a field taken from an environment variable: "NAME" or "NAME=value"; it then shows locked. */
  envName?: string;
  testID?: string;
}

/** A small icon button at the end of a secret field. */
function ActionButton(props: { icon: IconName; title: string; disabled?: boolean; loading?: boolean; selected?: boolean; testID?: string; onPress: () => void }) {
  return (
    <Button
      variant="plain"
      size="xs"
      iconOnly
      icon={props.icon}
      title={props.title}
      disabled={props.disabled}
      loading={props.loading}
      selected={props.selected}
      testID={props.testID}
      onPress={props.onPress}
    />
  );
}

/** The kept-elsewhere tag: an icon and where the key is, with its explanation as a tooltip. */
function KindTag(props: { icon: IconName; label: string; tooltip?: string; warn?: boolean }) {
  return (
    <View
      class="shrink flex-row items-center gap-1"
      tooltip={
        props.tooltip ? (
          <Tooltip class="max-w-xs bg-foreground px-2 py-1">
            <Text class="text-xs text-background">{props.tooltip}</Text>
          </Tooltip>
        ) : undefined
      }
    >
      <Icon name={props.icon} size={13} color={props.warn ? "warn-dark" : "muted-foreground"} />
      <Text
        class={`font-mono text-xs font-medium uppercase tracking-wide ${props.warn ? "text-warn-dark" : "text-muted-foreground"}`}
        style={{ numberOfLines: 1 }}
      >
        {props.label}
      </Text>
    </View>
  );
}

/** Asks for the console password before a secret is shown: the field, then an action and Cancel. */
function PasswordAsk(props: {
  busy: boolean;
  actionLabel: string;
  onSubmit: (password: string) => void;
  onCancel: () => void;
  testID?: string;
}) {
  const password = signal("");
  let input: InputRef | undefined;
  keymap.bind("escape", () => props.onCancel(), { when: "always" });
  queueMicrotask(() => input?.focus());
  const submit = (text?: string) => {
    const value = typeof text === "string" ? text : password();
    props.onSubmit(value);
    password.set("");
  };
  return (
    <View class="flex-row items-center gap-1.5">
      <TextField
        class="flex-1"
        value={password()}
        clearable={Boolean(password())}
        onChange={(value) => password.set(value)}
        onSubmit={(text) => submit(text)}
        masked
        placeholder={t("secret_reveal_password")}
        disabled={props.busy}
        testID={props.testID}
        inputRef={(node) => {
          input = node;
        }}
      />
      <Button variant="outlined" size="sm" label={props.actionLabel} loading={props.busy} onPress={() => submit()} />
      <Button variant="plain" size="sm" label={t("secret_reveal_cancel")} disabled={props.busy} onPress={props.onCancel} />
    </View>
  );
}

export function SecretInput(props: SecretInputProps) {
  const secretPicker = SecretPicker();
  const replacing = signal(false);
  const typedVisible = signal(false);
  const info = signal<SecretInfo | null>(null);
  const revealed = signal<string | null>(null);
  const asking = signal(false);
  const revealing = signal(false);
  const revealError = signal("");
  const pickerOpen = signal(false);
  // The key picked from another field, while it is the field's value.
  const picked = signal<PickedSecret | null>(null);
  // How each secret field holds its key (GET /secrets/keys fields), to know whether this one may
  // swap its reference.
  const keyFields = signal<Record<string, any> | null>(null);
  let input: InputRef | undefined;
  let focusTyping = false;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  const value = () => String(props.value || "");
  const configured = () => props.status?.configured === true;
  const kind = () => secretStorageKind(props.status?.source) as string;
  const replaceable = () => !props.envName && props.status?.editable !== false && !props.disabled;
  const showEnvLocked = () => Boolean(props.envName) && !value();
  const showStored = () => configured() && !replacing() && !value();
  const pickerOn = () => Boolean(secretPicker?.enabled()) && !props.disabled;
  const holdsReference = () => Boolean(props.envName) || REFERENCE_KINDS.has(kind());
  // The key button on a stored key: a reference is swapped only while another field keeps it.
  const canPickStored = () =>
    pickerOn() &&
    (holdsReference() ? canSwapReference(keyFields(), props.revealPath || "", props.envName || "") : replaceable());
  const canPickTyping = () => pickerOn() && replaceable();
  const showPicked = () => picked() !== null && value() === picked()!.value;
  const pickedEnvName = () => (picked() ? (referenceEnvName(picked()!.value) as string) : "");
  const pickedTitle = () => (picked() ? t("secret_picker_from", { field: picked()!.from }) : "");
  const canReveal = () => Boolean(props.revealPath) && info()?.reveal === true;
  // The system store by name (macOS Keychain, ...) once the console has said which it uses.
  const storeName = () => (kind() === "os" && info()?.store ? t("secret_store_" + info()!.store) : "");
  const tagLabel = () => storeName() || t("secret_tag_" + kind());
  const tooltip = () =>
    t("secret_stored_" + kind()) + (storeName() ? ` (${storeName()})` : "") + ". " + t("secret_stored_" + kind() + "_detail");

  void (loadSecretInfo() as Promise<SecretInfo | null>).then((data) => info.set(data));

  // Whether this field's reference is shared, for a field holding one (reloaded after a save).
  effect(() => {
    const on = pickerOn();
    const reference = holdsReference();
    const path = props.revealPath;
    void props.status?.source;
    void props.envName;
    if (!on || !reference || !path) return;
    void (loadSecretKeysShared() as Promise<any>).then((data) => {
      keyFields.set(data?.fields && typeof data.fields === "object" ? data.fields : null);
    });
  });

  const hide = () => {
    clearTimeout(hideTimer);
    revealed.set(null);
  };
  const resetReveal = () => {
    batch(() => {
      hide();
      asking.set(false);
      revealError.set("");
    });
  };
  cleanup(() => clearTimeout(hideTimer));

  // A saved or reloaded secret starts from its stored state again.
  let firstStatus = true;
  effect(() => {
    void props.status?.configured;
    void props.status?.source;
    void props.revealPath;
    if (firstStatus) {
      firstStatus = false;
      return;
    }
    untracked(() => {
      replacing.set(false);
      resetReveal();
    });
  });
  effect(() => {
    const current = value();
    untracked(() => {
      if (picked() && current !== picked()!.value) picked.set(null);
    });
  });

  const doReveal = async (password = "") => {
    revealing.set(true);
    revealError.set("");
    try {
      const data: any = await revealSecret(props.revealPath, password);
      batch(() => {
        revealed.set(String(data?.value ?? ""));
        asking.set(false);
      });
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, REVEAL_MS);
    } catch (error) {
      console.warn("[SecretInput] reveal failed", error);
      revealError.set(revealErrorText(error));
    } finally {
      revealing.set(false);
    }
  };

  const toggleReveal = () => {
    if (revealed() !== null) {
      hide();
      return;
    }
    if (info()?.password_required) {
      batch(() => {
        asking.set(true);
        revealError.set("");
      });
      return;
    }
    void doReveal();
  };
  const cancelAsk = () => {
    batch(() => {
      asking.set(false);
      revealError.set("");
    });
  };
  const replace = () => {
    resetReveal();
    focusTyping = true;
    replacing.set(true);
    queueMicrotask(() => {
      if (focusTyping) {
        focusTyping = false;
        input?.focus();
      }
    });
  };
  const openPicker = () => {
    resetReveal();
    pickerOpen.set(true);
  };
  const pick = (payload: PickedSecret) => {
    batch(() => {
      picked.set(payload);
      replacing.set(false);
      typedVisible.set(false);
    });
    props.onChange?.(payload.value);
  };
  const keepCurrent = () => {
    batch(() => {
      replacing.set(false);
      typedVisible.set(false);
    });
    props.onChange?.("");
  };

  const mode = () => {
    if (showPicked() && pickedEnvName()) return "picked-env";
    if (showPicked()) return "picked";
    if (showEnvLocked()) return "env";
    if (showStored() && asking()) return "ask";
    if (showStored()) return "stored";
    return "typing";
  };

  const storedBox = (content: JSX.Element) => (
    <View class="min-h-9 flex-row items-center gap-2.5 rounded-(--radius) border border-input bg-field py-0.5 pl-3 pr-1">
      {content}
    </View>
  );

  const undoButton = () => (
    <ActionButton icon="PhArrowCounterClockwise" title={t("secret_picker_undo")} disabled={props.disabled} onPress={keepCurrent} />
  );

  return (
    <View class="gap-1.5" testID={props.testID}>
      <If when={mode() === "picked-env"}>
        <EnvManagedField name={pickedEnvName()} title={pickedTitle()}>
          {undoButton()}
        </EnvManagedField>
      </If>
      <If when={mode() === "picked"}>
        {storedBox(
          <>
            <If
              when={picked()?.kind === "file"}
              else={
                <Text class="flex-1 text-sm tracking-widest text-muted-foreground" accessibilityElementsHidden>
                  {MASK}
                </Text>
              }
            >
              <Text class="flex-1 font-mono text-sm text-foreground" style={{ numberOfLines: 1 }}>
                {picked()?.hint || "…"}
              </Text>
            </If>
            <KindTag
              icon={picked()?.kind === "file" ? "PhKey" : KIND_ICONS[picked()?.kind ?? ""] || KIND_ICONS.stored}
              label={picked()?.kind === "file" ? pickedTitle() : kindTagText(picked()?.kind ?? "", info())}
              tooltip={pickedTitle()}
            />
            {undoButton()}
          </>,
        )}
      </If>
      <If when={mode() === "env"}>
        <EnvManagedField name={props.envName || ""}>
          <If when={canPickStored()}>
            <ActionButton icon="PhKey" title={t("secret_picker_open")} onPress={openPicker} />
          </If>
        </EnvManagedField>
      </If>
      <If when={mode() === "ask"}>
        <PasswordAsk
          busy={revealing()}
          actionLabel={t("secret_reveal")}
          onSubmit={(password) => void doReveal(password)}
          onCancel={cancelAsk}
          testID={props.testID ? `${props.testID}-password` : undefined}
        />
      </If>
      <If when={mode() === "stored"}>
        {storedBox(
          <>
            <If
              when={revealed() !== null}
              else={
                <Text class="flex-1 text-sm tracking-widest text-muted-foreground" accessibilityLabel={t("secret_stored_" + kind())}>
                  {MASK}
                </Text>
              }
            >
              <View class="flex-1 min-w-0" selectable>
                <Text class="font-mono text-sm text-foreground" style={{ numberOfLines: 1 }}>
                  {revealed() ?? ""}
                </Text>
              </View>
            </If>
            <If when={revealed() === null}>
              <KindTag icon={KIND_ICONS[kind()] || KIND_ICONS.stored} label={tagLabel()} tooltip={tooltip()} warn={kind() === "file"} />
            </If>
            <View class="flex-row items-center">
              <If when={canReveal()}>
                <ActionButton
                  icon={revealed() !== null ? "PhEyeSlash" : "PhEye"}
                  title={revealed() !== null ? t("secret_hide") : t("secret_reveal")}
                  selected={revealed() !== null}
                  loading={revealing()}
                  onPress={toggleReveal}
                />
              </If>
              <If when={canPickStored()}>
                <ActionButton icon="PhKey" title={t("secret_picker_open")} onPress={openPicker} />
              </If>
              <If when={replaceable()}>
                <ActionButton icon="PhPencilSimple" title={t("secret_replace")} onPress={replace} />
              </If>
            </View>
          </>,
        )}
      </If>
      <If when={mode() === "typing"}>
        <TextField
          value={value()}
          clearable={Boolean(value())}
          onChange={(next) => props.onChange?.(next)}
          masked={!typedVisible()}
          placeholder={props.placeholder}
          disabled={props.disabled}
          mono={typedVisible()}
          testID={props.testID ? `${props.testID}-input` : undefined}
          accessibilityLabel={props.placeholder || t("secret_value")}
          inputRef={(node) => {
            input = node;
          }}
          trailing={
            <View class="-mr-1.5 flex-row items-center">
              <ActionButton
                icon={typedVisible() ? "PhEyeSlash" : "PhEye"}
                title={typedVisible() ? t("secret_hide") : t("secret_reveal")}
                selected={typedVisible()}
                disabled={props.disabled}
                onPress={() => typedVisible.update((on) => !on)}
              />
              <If when={canPickTyping()}>
                <ActionButton icon="PhKey" title={t("secret_picker_open")} disabled={props.disabled} onPress={openPicker} />
              </If>
              <If when={configured() && replacing()}>
                <ActionButton
                  icon="PhArrowCounterClockwise"
                  title={t("secret_keep_current")}
                  disabled={props.disabled}
                  onPress={keepCurrent}
                />
              </If>
            </View>
          }
        />
      </If>
      <If when={revealError()}>
        <Text class="text-xs text-danger" role="alert">
          {revealError()}
        </Text>
      </If>
      <SecretKeyPicker
        open={pickerOpen()}
        onOpenChange={(open) => pickerOpen.set(open)}
        currentPath={props.revealPath}
        onPick={pick}
      />
    </View>
  );
}

/* ---------- the secret picker ---------- */

export interface SecretKeyPickerProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The config path of the field picking; its own key is left out. Empty for a field not saved yet. */
  currentPath?: string;
  onPick?: (picked: PickedSecret) => void;
}

interface SecretKey {
  id: string;
  kind: string;
  hint?: string;
  ref?: string;
  reveal_path?: string;
  used_by?: string[];
  unavailable?: boolean;
}

/**
 * The secret picker: a dialog listing the keys already in config.yaml, so a field can use one of
 * them instead of having the key pasted again. Each key shows a masked hint ("sk-proj-…a1b2"), where
 * it is kept and the fields that use it. Picking a key hands over its reference (${secret:...},
 * ${ENV}, ...); a key kept in config.yaml as plain text has none, so it is revealed (asking for the
 * console password when there is one) and its value is handed over instead.
 */
export function SecretKeyPicker(props: SecretKeyPickerProps) {
  const loading = signal(false);
  const loadError = signal("");
  const keys = signal<SecretKey[]>([]);
  const info = signal<SecretInfo | null>(null);
  const asking = signal("");
  const revealing = signal(false);
  const revealError = signal("");
  let loadSeq = 0;

  const offered = (): SecretKey[] => pickerKeys(keys(), props.currentPath || "");

  const load = async () => {
    const seq = ++loadSeq;
    batch(() => {
      loading.set(true);
      loadError.set("");
      asking.set("");
      revealError.set("");
    });
    try {
      const [data, secretInfo]: any[] = await Promise.all([loadSecretKeys(), loadSecretInfo()]);
      if (seq !== loadSeq) return;
      batch(() => {
        keys.set(Array.isArray(data?.keys) ? data.keys : []);
        info.set(secretInfo);
      });
    } catch (error: any) {
      if (seq !== loadSeq) return;
      console.warn("[SecretKeyPicker] load failed", error);
      batch(() => {
        keys.set([]);
        loadError.set(error?.message || t("secret_picker_load_failed"));
      });
    } finally {
      if (seq === loadSeq) loading.set(false);
    }
  };

  effect(() => {
    if (props.open) untracked(() => void load());
  });

  const close = () => props.onOpenChange?.(false);

  // What to recognize a key by: its masked hint, or for a plain-text key too short to show any of
  // it, that it is kept as plain text.
  const hintText = (key: SecretKey) => {
    if (key.unavailable) return t("secret_picker_unavailable");
    if (key.kind === "file" && (!key.hint || key.hint === "…")) return t("secret_picker_plain_hint");
    return key.hint || "…";
  };
  const usedByText = (key: SecretKey) =>
    t("secret_picker_used_by", { fields: (key.used_by || []).map((path) => secretFieldLabel(path, t)).join(", ") });
  const payload = (key: SecretKey, value: string): PickedSecret => ({
    value,
    kind: key.kind,
    hint: key.hint || "",
    from: secretFieldLabel((key.used_by || [])[0], t),
  });

  const reveal = async (key: SecretKey, password = "") => {
    revealing.set(true);
    revealError.set("");
    try {
      const data: any = await revealSecret(key.reveal_path, password);
      const value = String(data?.value ?? "");
      if (!value) throw new Error(t("secret_reveal_failed"));
      props.onPick?.(payload(key, value));
      close();
    } catch (error) {
      console.warn("[SecretKeyPicker] reveal failed", error);
      revealError.set(revealErrorText(error));
    } finally {
      revealing.set(false);
    }
  };

  const choose = (key: SecretKey) => {
    if (!key || key.unavailable || revealing()) return;
    if (key.ref) {
      props.onPick?.(payload(key, key.ref));
      close();
      return;
    }
    if (info()?.password_required) {
      batch(() => {
        asking.set(key.id);
        revealError.set("");
      });
      return;
    }
    void reveal(key);
  };
  const cancelAsk = () => {
    batch(() => {
      asking.set("");
      revealError.set("");
    });
  };

  return (
    <Modal open={props.open} onClose={close} title={t("secret_picker_title")} size="md" testID="secret-key-picker">
      <If when={loading()}>
        <Text class="text-sm text-muted-foreground">{t("secret_picker_loading")}</Text>
      </If>
      <If when={!loading() && loadError()}>
        <Text class="text-sm text-danger" role="alert">
          {loadError()}
        </Text>
      </If>
      <If when={!loading() && !loadError() && offered().length === 0}>
        <Text class="text-sm text-muted-foreground">{t("secret_picker_empty")}</Text>
      </If>
      <If when={!loading() && !loadError() && offered().length > 0}>
        <View class="gap-1.5">
          <Each of={offered()} key={(key) => key.id}>
            {(key) => (
              <View class="gap-1.5">
                <BaseButton
                  disabled={key().unavailable || revealing()}
                  onPress={() => choose(key())}
                  accessibilityLabel={`${hintText(key())}, ${kindTagText(key().kind, info())}`}
                  class="gap-1 rounded-(--radius) border border-line-faint bg-card px-3 py-2 hover:border-ring hover:bg-hover active:bg-selection disabled:opacity-50"
                >
                  <View class="flex-row items-center justify-between gap-3">
                    <Text class="flex-1 font-mono text-sm text-foreground" style={{ numberOfLines: 1 }}>
                      {hintText(key())}
                    </Text>
                    <KindTag
                      icon={KIND_ICONS[key().kind] || "PhLockSimple"}
                      label={kindTagText(key().kind, info())}
                      warn={key().kind === "file"}
                    />
                  </View>
                  <Text class="text-xs text-muted-foreground">{usedByText(key())}</Text>
                </BaseButton>
                <If when={asking() === key().id}>
                  <PasswordAsk
                    busy={revealing()}
                    actionLabel={t("secret_picker_use")}
                    onSubmit={(password) => void reveal(key(), password)}
                    onCancel={cancelAsk}
                    testID="secret-key-picker-password"
                  />
                  <If when={revealError()}>
                    <Text class="text-xs text-danger" role="alert">
                      {revealError()}
                    </Text>
                  </If>
                </If>
              </View>
            )}
          </Each>
        </View>
      </If>
      <If when={revealError() && !asking()}>
        <Text class="text-xs text-danger" role="alert">
          {revealError()}
        </Text>
      </If>
    </Modal>
  );
}
