// Auth profiles (the Vue console's AuthProfilesPanel): credentials and request limits used by the
// authenticated HTTP tools, edited as a list and saved together. Save stays off until every profile
// has a name, a credential kind, a secret (or one already stored), URL prefixes and methods.
//
// Vue to nsh: `save` is `onSave(profiles)`.
import { batch, effect, signal, Text, untracked, View } from "nsh";
import { Collapsible } from "nsh/base";
import { HTTP_METHOD_OPTIONS } from "../../lib/core/config-options.js";
import { Button, Icon, Section, TextField, Toggle } from "../ui";
import { SettingChoices, SettingField, SettingFieldGrid, SettingSelect } from "./SettingFields";

/** An auth profile as the runtime reports it. */
export interface AuthProfile {
  name?: string;
  original_name?: string;
  credential_kind?: string;
  credential_secret_configured?: boolean;
  url_prefixes?: string[];
  methods?: string[];
  follow_redirects?: boolean;
  allow_proxy?: boolean;
  deny_private_ips?: boolean;
  bindings?: Record<string, any>;
  [key: string]: unknown;
}

/** An auth profile as a save sends it. */
export interface AuthProfileUpdate {
  original_name: string;
  name: string;
  credential_kind: string;
  credential_secret: string;
  url_prefixes: string[];
  methods: string[];
  follow_redirects: boolean;
  allow_proxy: boolean;
  deny_private_ips: boolean;
  bindings: Record<string, any>;
}

export interface AuthProfilesPanelProps {
  profiles: AuthProfile[];
  loading?: boolean;
  saving?: boolean;
  onSave?: (profiles: AuthProfileUpdate[]) => void;
  testID?: string;
}

interface ProfileDraft {
  _key: string;
  _originalName: string;
  _configured: boolean;
  name: string;
  credential_kind: string;
  credential_secret: string;
  url_prefixes_text: string;
  methods_text: string;
  follow_redirects: boolean;
  allow_proxy: boolean;
  deny_private_ips: boolean;
  bindings_text: string;
}

let profileKey = 0;

function listText(values: unknown) {
  return Array.isArray(values) ? values.join("\n") : "";
}

function parseList(value: string) {
  return String(value || "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function profileDraft(item: AuthProfile = {}): ProfileDraft {
  profileKey += 1;
  const name = String(item?.name || "");
  return {
    _key: `auth-profile-${profileKey}`,
    _originalName: String(item?.original_name || name),
    _configured: item?.credential_secret_configured === true,
    name,
    credential_kind: String(item?.credential_kind || "bearer"),
    credential_secret: "",
    url_prefixes_text: listText(item?.url_prefixes),
    methods_text: listText(item?.methods),
    follow_redirects: item?.follow_redirects === true,
    allow_proxy: item?.allow_proxy === true,
    deny_private_ips: item?.deny_private_ips !== false,
    bindings_text: JSON.stringify(
      item?.bindings && typeof item.bindings === "object"
        ? item.bindings
        : { url_fetch: { inject: { location: "header", name: "Authorization", format: "bearer" } } },
      null,
      2,
    ),
  };
}

function bindingsFor(profile: ProfileDraft): Record<string, any> {
  try {
    const bindings = JSON.parse(profile.bindings_text || "{}");
    return bindings && typeof bindings === "object" && !Array.isArray(bindings) ? bindings : {};
  } catch {
    return {};
  }
}

export function AuthProfilesPanel(props: AuthProfilesPanelProps) {
  const draft = signal<ProfileDraft[]>([]);
  const error = signal("");
  // Which profiles show their bindings as JSON, by key.
  const advancedOpen = signal<Record<string, boolean>>({});

  effect(() => {
    const profiles = props.profiles || [];
    untracked(() =>
      batch(() => {
        draft.set(profiles.map(profileDraft));
        error.set("");
      }),
    );
  });

  const complete = () =>
    draft().every(
      (item) =>
        item.name.trim() &&
        item.credential_kind.trim() &&
        (item._configured || item.credential_secret.trim()) &&
        parseList(item.url_prefixes_text).length > 0 &&
        parseList(item.methods_text).length > 0,
    );
  const busy = () => Boolean(props.loading || props.saving);

  const update = (key: string, change: Partial<ProfileDraft>) =>
    draft.update((list) => list.map((item) => (item._key === key ? { ...item, ...change } : item)));
  const byKey = (key: string) => draft().find((item) => item._key === key);
  const add = () => draft.update((list) => [...list, profileDraft()]);
  const remove = (key: string) => draft.update((list) => list.filter((item) => item._key !== key));

  const updateInjection = (key: string, tool: string, field: string, value: string) => {
    const profile = untracked(() => byKey(key));
    if (!profile) return;
    const bindings = bindingsFor(profile);
    bindings[tool] = { ...bindings[tool], inject: { ...bindings[tool]?.inject, [field]: value } };
    update(key, { bindings_text: JSON.stringify(bindings, null, 2) });
  };

  const save = () => {
    try {
      const profiles = draft().map((item) => ({
        original_name: item._originalName,
        name: item.name.trim(),
        credential_kind: item.credential_kind.trim(),
        credential_secret: item.credential_secret.trim(),
        url_prefixes: parseList(item.url_prefixes_text),
        methods: parseList(item.methods_text).map((method) => method.toUpperCase()),
        follow_redirects: item.follow_redirects,
        allow_proxy: item.allow_proxy,
        deny_private_ips: item.deny_private_ips,
        bindings: JSON.parse(item.bindings_text || "{}"),
      }));
      error.set("");
      props.onSave?.(profiles);
    } catch {
      error.set("Bindings must be valid JSON.");
    }
  };

  return (
    <Section
      variant="card"
      title="Auth profiles"
      meta="Credentials and request limits used by authenticated HTTP tools."
      actions={
        <Button
          variant="plain"
          size="xs"
          label="Save"
          loading={props.saving}
          disabled={busy() || !complete()}
          onPress={save}
          testID={props.testID ? `${props.testID}-save` : "auth-profiles-save"}
        />
      }
    >
      <View class="gap-4" testID={props.testID}>
        <If when={error()}>
          <View class="rounded-(--radius) border border-danger bg-card px-3 py-2" role="alert">
            <Text class="text-sm text-danger">{error()}</Text>
          </View>
        </If>
        <Each of={draft()} key={(item) => item._key}>
          {(profile, index) => {
            const key = untracked(() => profile()._key);
            const label = (text: string) => `${text} ${index() + 1}`;
            return (
              <View class="gap-3 rounded-(--radius) border border-line-faint p-3">
                <SettingFieldGrid>
                  <SettingField label="Name">
                    <TextField
                      value={profile().name}
                      disabled={busy()}
                      accessibilityLabel={label("Name")}
                      onChange={(value) => update(key, { name: value })}
                    />
                  </SettingField>
                  <SettingField label="Credential kind">
                    <TextField
                      value={profile().credential_kind}
                      disabled={busy()}
                      accessibilityLabel={label("Credential kind")}
                      onChange={(value) => update(key, { credential_kind: value })}
                    />
                  </SettingField>
                  <SettingField label="Credential secret" wide>
                    <TextField
                      value={profile().credential_secret}
                      masked
                      placeholder={profile()._configured ? "Configured — enter a new value to replace" : "Required"}
                      disabled={busy()}
                      accessibilityLabel={label("Credential secret")}
                      onChange={(value) => update(key, { credential_secret: value })}
                    />
                  </SettingField>
                  <SettingField label="Allowed URL prefixes">
                    <TextField
                      value={profile().url_prefixes_text}
                      multiline
                      rows={4}
                      mono
                      disabled={busy()}
                      accessibilityLabel={label("Allowed URL prefixes")}
                      onChange={(value) => update(key, { url_prefixes_text: value })}
                    />
                  </SettingField>
                  <SettingField label="Allowed methods">
                    <SettingChoices
                      value={parseList(profile().methods_text).map((method) => method.toUpperCase())}
                      options={HTTP_METHOD_OPTIONS}
                      label="Allowed methods"
                      disabled={busy()}
                      onChange={(methods) => update(key, { methods_text: methods.join("\n") })}
                    />
                  </SettingField>
                  <SettingField label="Bindings" wide>
                    <Each of={Object.entries(bindingsFor(profile()))} key={(entry) => entry[0]}>
                      {(entry) => (
                        <View class="gap-2 border-l-2 border-line-faint pl-3">
                          <Text class="font-mono text-xs font-medium text-subtle">{entry()[0]}</Text>
                          <SettingFieldGrid>
                            <SettingField label="Injection location">
                              <SettingSelect
                                value={entry()[1]?.inject?.location || ""}
                                options={["header"]}
                                label="Injection location"
                                disabled={busy()}
                                onChange={(value) => updateInjection(key, entry()[0], "location", value)}
                              />
                            </SettingField>
                            <SettingField label="Injection format">
                              <SettingSelect
                                value={entry()[1]?.inject?.format || ""}
                                options={["", "raw", "bearer", "basic"]}
                                placeholder="Default (raw)"
                                label="Injection format"
                                disabled={busy()}
                                onChange={(value) => updateInjection(key, entry()[0], "format", value)}
                              />
                            </SettingField>
                            <SettingField label="Header name" wide>
                              <TextField
                                value={entry()[1]?.inject?.name || ""}
                                disabled={busy()}
                                accessibilityLabel="Header name"
                                onChange={(value) => updateInjection(key, entry()[0], "name", value)}
                              />
                            </SettingField>
                          </SettingFieldGrid>
                        </View>
                      )}
                    </Each>
                    <Collapsible
                      class="gap-2"
                      open={advancedOpen()[key] === true}
                      content={
                        <TextField
                          value={profile().bindings_text}
                          multiline
                          rows={8}
                          mono
                          disabled={busy()}
                          accessibilityLabel={label("Advanced bindings")}
                          onChange={(value) => update(key, { bindings_text: value })}
                        />
                      }
                    >
                      <View
                        role="button"
                        accessibilityState={{ expanded: advancedOpen()[key] === true }}
                        onPress={() => advancedOpen.update((open) => ({ ...open, [key]: !open[key] }))}
                        class="flex-row items-center gap-1.5 self-start py-1"
                      >
                        <Icon name={advancedOpen()[key] ? "PhCaretDown" : "PhCaretRight"} size={12} color="muted-foreground" />
                        <Text class="text-xs text-subtle">Advanced bindings (JSON)</Text>
                      </View>
                    </Collapsible>
                  </SettingField>
                  <View class="w-full flex-row flex-wrap gap-4">
                    <Toggle
                      class="grow basis-40"
                      checked={profile().deny_private_ips}
                      label="Deny private IPs"
                      disabled={busy()}
                      onChange={(checked) => update(key, { deny_private_ips: checked })}
                    />
                    <Toggle
                      class="grow basis-40"
                      checked={profile().follow_redirects}
                      label="Follow redirects"
                      disabled={busy()}
                      onChange={(checked) => update(key, { follow_redirects: checked })}
                    />
                    <Toggle
                      class="grow basis-40"
                      checked={profile().allow_proxy}
                      label="Allow proxy"
                      disabled={busy()}
                      onChange={(checked) => update(key, { allow_proxy: checked })}
                    />
                  </View>
                </SettingFieldGrid>
                <Button
                  variant="ghost-danger"
                  size="xs"
                  label="Remove"
                  disabled={busy()}
                  onPress={() => remove(key)}
                  testID={`auth-profile-remove-${index() + 1}`}
                />
              </View>
            );
          }}
        </Each>
        <Button variant="outlined" label="Add auth profile" icon="PhPlus" disabled={busy()} onPress={add} />
      </View>
    </Section>
  );
}
