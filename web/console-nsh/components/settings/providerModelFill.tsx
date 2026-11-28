// What a model form does when its provider changes (lib/core/provider-models.js has the rules):
// the model field takes the model last set for that provider on this agent, or the provider's
// default; then, where the provider lists its models and the form can ask now, the list is read
// once: a remembered model that is gone from it is reported in a dialog that offers the list's
// suggestion, and a provider without a remembered model takes the suggestion.
//
// `target` names the form: "" for the one model form of a page, a profile's key in Settings.
import { signal, untracked } from "nsh";
import { translate } from "../../lib/core/context.js";
import { checkProviderModel, initialProviderModel } from "../../lib/core/provider-models.js";
import { MessageDialog } from "../ui";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

/** A remembered model its provider no longer lists. */
export interface MissingModel {
  target: string;
  provider: string;
  providerTitle: string;
  model: string;
  /** The model to offer instead; "" when this console knows none for the provider. */
  suggestion: string;
}

export interface ProviderModelFillDeps {
  /** The agent's record: the model last set per provider. */
  lastModels: () => Record<string, string> | null | undefined;
  /** The provider's name as the form shows it. */
  providerTitle: (provider: string) => string;
  /** Whether the provider lists its models and the form has what the list needs (a key, a sign-in). */
  canList: (target: string, provider: string) => boolean;
  /** The provider's model ids, as the form's own model picker reads them. */
  listModels: (target: string, provider: string) => Promise<string[]>;
  provider: (target: string) => string;
  model: (target: string) => string;
  setModel: (target: string, model: string) => void;
  /** Opens the form's model picker. */
  choose: (target: string) => void;
}

export function createProviderModelFill(deps: ProviderModelFillDeps) {
  const missing = signal<MissingModel | null>(null);
  // The check a form still owes: its provider changed while the list could not be read yet (not
  // signed in). `settle` runs it once the list can be read.
  const owed = new Map<string, { provider: string; model: string; remembered: boolean }>();

  async function check(target: string) {
    const due = owed.get(target);
    if (!due) return;
    if (!untracked(() => deps.canList(target, due.provider))) return;
    owed.delete(target);
    let ids: string[] = [];
    try {
      ids = await deps.listModels(target, due.provider);
    } catch {
      // A list that cannot be read says nothing about the model: the field keeps what it took.
      return;
    }
    // The form moved on while the list loaded: another provider, or a model typed by hand.
    if (untracked(() => deps.provider(target)) !== due.provider || untracked(() => deps.model(target)) !== due.model) return;
    const result = checkProviderModel({ provider: due.provider, model: due.model, remembered: due.remembered, ids });
    if (typeof result.model === "string") deps.setModel(target, result.model);
    if (result.missing) {
      missing.set({
        target,
        provider: due.provider,
        providerTitle: untracked(() => deps.providerTitle(due.provider)) || due.provider,
        model: result.missing.model,
        suggestion: result.missing.suggestion,
      });
    }
  }

  return {
    missing,
    /** The form's provider changed to `provider`: fill its model, then check it against the provider's list. */
    providerChanged(target: string, provider: string) {
      const pick = initialProviderModel(provider, untracked(deps.lastModels) ?? null);
      deps.setModel(target, pick.model);
      owed.set(target, { provider, model: pick.model, remembered: pick.remembered });
      void check(target);
    },
    /** The list may be readable now (a sign-in finished): run the check a form still owes. */
    settle(target: string) {
      void check(target);
    },
    /** Takes the suggested model. */
    useSuggestion() {
      const item = untracked(missing);
      if (!item) return;
      missing.set(null);
      if (item.suggestion) deps.setModel(item.target, item.suggestion);
    },
    /** Closes the notice and opens the model picker. */
    chooseAnother() {
      const item = untracked(missing);
      if (!item) return;
      missing.set(null);
      deps.choose(item.target);
    },
    dismiss() {
      missing.set(null);
    },
  };
}

export type ProviderModelFill = ReturnType<typeof createProviderModelFill>;

/** The notice that a remembered model is gone from its provider's list. */
export function MissingModelDialog(props: { fill: ProviderModelFill }) {
  const item = () => props.fill.missing();
  return (
    <MessageDialog
      open={item() !== null}
      onClose={() => props.fill.dismiss()}
      icon="PhWarning"
      tone="warn"
      title={t("settings_model_missing_title")}
      text={t("settings_model_missing_text", { model: item()?.model ?? "", provider: item()?.providerTitle ?? "" })}
      testID="model-missing-dialog"
      actions={
        item()?.suggestion
          ? [
              { id: "choose", label: t("settings_model_missing_choose"), variant: "outlined", onPress: () => props.fill.chooseAnother() },
              { id: "use", label: t("settings_model_missing_use", { model: item()?.suggestion ?? "" }), variant: "primary", onPress: () => props.fill.useSuggestion() },
            ]
          : [
              { id: "keep", label: t("settings_model_missing_keep"), variant: "outlined", onPress: () => props.fill.dismiss() },
              { id: "choose", label: t("settings_model_missing_choose"), variant: "primary", onPress: () => props.fill.chooseAnother() },
            ]
      }
    />
  );
}
