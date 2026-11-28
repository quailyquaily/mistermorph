package configstore

import (
	"context"
	"fmt"
	"strings"
)

// The model last set for each inference provider, kept per agent (one record per provider, shared
// by the default model and every profile): when someone comes back to a provider, the Console
// fills in the model they used with it. Recorded as the config is saved; never part of the config.

// providerModels is what a config says: for the default model and each profile, in that order,
// the inference provider and its model. A place without a provider or a model is left out.
func providerModels(r Rows) [][2]string {
	var out [][2]string
	add := func(provider, model string) {
		provider = strings.ToLower(strings.TrimSpace(provider))
		model = strings.TrimSpace(model)
		if provider != "" && model != "" {
			out = append(out, [2]string{provider, model})
		}
	}
	settings := map[string]string{}
	for _, s := range r.Settings {
		settings[s.Path] = s.Value
	}
	add(firstText(settings["llm.inference_provider"], settings["llm.provider"]), settings["llm.model"])
	for _, p := range r.Profiles {
		add(firstText(itemText(p, "inference_provider"), itemText(p, "provider")), itemText(p, "model"))
	}
	return out
}

func firstText(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func itemText(item itemRow, col string) string {
	text, _ := item.Cols[col].(string)
	return text
}

// recordProviderModels keeps, for each provider whose model this save set or changed, that model.
// A pair the config already had is not a new choice, so it does not replace a later one made in
// another place for the same provider; a provider with no record yet takes what the config has.
func recordProviderModels(ctx context.Context, q queryer, before, after Rows, now string) error {
	had := map[[2]string]bool{}
	for _, pair := range providerModels(before) {
		had[pair] = true
	}
	for _, pair := range providerModels(after) {
		var err error
		if had[pair] {
			_, err = q.ExecContext(ctx, `INSERT INTO llm_provider_models (inference_provider, model, updated_at) VALUES (?, ?, ?)
				ON CONFLICT (inference_provider) DO NOTHING`, pair[0], pair[1], now)
		} else {
			_, err = q.ExecContext(ctx, `INSERT INTO llm_provider_models (inference_provider, model, updated_at) VALUES (?, ?, ?)
				ON CONFLICT (inference_provider) DO UPDATE SET model = excluded.model, updated_at = excluded.updated_at`,
				pair[0], pair[1], now)
		}
		if err != nil {
			return fmt.Errorf("record the model of %s: %w", pair[0], err)
		}
	}
	return nil
}

// LastModels is the model last set for each inference provider in the agent.db beside path (the
// config's path), by provider. A config kept in a file has no record: an empty map.
func LastModels(ctx context.Context, path string) (map[string]string, error) {
	out := map[string]string{}
	if !IsDBConfigPath(path) {
		return out, nil
	}
	db, err := dbFor(ctx, path)
	if err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, `SELECT inference_provider, model FROM llm_provider_models`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var provider, model string
		if err := rows.Scan(&provider, &model); err != nil {
			return nil, err
		}
		out[provider] = model
	}
	return out, rows.Err()
}
