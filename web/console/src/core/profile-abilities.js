// The i18n keys of the sentences that say what a profile's checked abilities let it do.
export function profileAbilitySummaryKeys(abilities) {
  const list = Array.isArray(abilities) ? abilities : [];
  const text = list.includes("text");
  const image = list.includes("image");
  const decision = list.includes("decision");
  if (text) {
    return [
      "settings_llm_abilities_summary_text",
      ...(image ? ["settings_llm_abilities_summary_also_image"] : []),
      ...(decision ? ["settings_llm_abilities_summary_also_decision"] : []),
    ];
  }
  if (decision) {
    return [
      "settings_llm_abilities_summary_decision_only",
      ...(image ? ["settings_llm_abilities_summary_also_image"] : []),
    ];
  }
  return image ? ["settings_llm_abilities_summary_image_only"] : [];
}
