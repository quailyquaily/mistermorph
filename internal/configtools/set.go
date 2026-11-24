package configtools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/audience"
	"github.com/quailyquaily/mistermorph/internal/configbootstrap"
	"github.com/quailyquaily/mistermorph/internal/configdefaults"
	"github.com/quailyquaily/mistermorph/internal/configrevision"
	"github.com/quailyquaily/mistermorph/internal/configsettings"
	"github.com/quailyquaily/mistermorph/internal/configstore"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/secref"
	"github.com/quailyquaily/mistermorph/internal/secretkeys"
	"github.com/quailyquaily/mistermorph/tools"
	"github.com/spf13/viper"
	"gopkg.in/yaml.v3"
)

// writeMu keeps this process's config_set read-modify-writes apart.
var writeMu sync.Mutex

// setRequest is one config_set call, checked.
type setRequest struct {
	path  string
	field configsettings.Field
	unset bool
	// value is the new value, decoded (JSON types), when not unset.
	value any
	// raw is value as JSON, for configsettings.Apply.
	raw json.RawMessage
}

// checkCaller refuses a caller that is not the owner in a private conversation of a top-level run:
// a group chat, a contact, a subtask, or a run that does not say who it talks to.
func checkCaller(ctx context.Context) error {
	if agent.SubtaskDepthFromContext(ctx) > 0 {
		return errors.New("config_set is not available in subtasks; the agent that started this one can ask the user")
	}
	if audience.FromContext(ctx).Kind != audience.KindOwner {
		return errors.New("config_set changes the config only in a private conversation with the owner; " +
			"tell the user what to change instead (Console settings or morph config set)")
	}
	return nil
}

// parseSetRequest checks a call's parameters, the path's policy and the value's shape. It never
// echoes the value: it may be a secret.
func parseSetRequest(params map[string]any) (setRequest, error) {
	rawPath, _ := params["path"].(string)
	path, err := normalizePath(rawPath)
	if err != nil {
		return setRequest{}, err
	}
	if path == "" {
		return setRequest{}, errors.New("path is required, such as llm.model")
	}
	if reason := deniedReason(path); reason != "" {
		return setRequest{}, fmt.Errorf("%s cannot be changed by the agent: %s. Only the user can change it (Console settings or morph config set)", path, reason)
	}
	field, ok := loadCatalog().field(path)
	if !ok {
		return setRequest{}, fmt.Errorf("%s is not a field config_set changes; config_get lists the keys it may change (settable: true)", path)
	}
	if envName := fieldEnvName(path); envName != "" {
		if _, set := os.LookupEnv(envName); set {
			return setRequest{}, fmt.Errorf("%s is set by the environment variable %s, which overrides the config; the user has to change that variable", path, envName)
		}
	}
	unset, _ := params["unset"].(bool)
	rawValue, hasValue := params["value"]
	if unset {
		if hasValue && rawValue != nil {
			return setRequest{}, errors.New("pass either value or unset: true, not both")
		}
		return setRequest{path: path, field: field, unset: true}, nil
	}
	if !hasValue || rawValue == nil {
		return setRequest{}, errors.New("value is required (or unset: true to remove the key)")
	}
	value, err := decodeInput(field, rawValue)
	if err != nil {
		return setRequest{}, fmt.Errorf("%s: %w", path, err)
	}
	if err := valueProblem(field, value); err != nil {
		return setRequest{}, fmt.Errorf("%s: %w", path, err)
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return setRequest{}, fmt.Errorf("%s: the value cannot be stored", path)
	}
	return setRequest{path: path, field: field, value: value, raw: raw}, nil
}

// decodeInput reads a value as `morph config set` does: text is YAML (90s, true, 8, [a, b],
// "text"); a value the model passed as JSON is taken as it is. A text field keeps a scalar's text.
func decodeInput(field configsettings.Field, raw any) (any, error) {
	text, isText := raw.(string)
	textKind := field.Kind == configsettings.KindString || field.Kind == configsettings.KindDuration
	if !isText {
		if textKind {
			switch raw.(type) {
			case bool, float64, int, int64, json.Number:
				return fmt.Sprint(raw), nil
			}
			return nil, errors.New("must be text")
		}
		return normalizeJSON(raw)
	}
	var node yaml.Node
	if err := yaml.Unmarshal([]byte(text), &node); err != nil {
		return nil, errors.New("the value is not valid YAML")
	}
	if len(node.Content) == 0 {
		if textKind {
			return "", nil
		}
		return nil, errors.New("the value is empty; use unset: true to remove the key")
	}
	value := node.Content[0]
	if textKind {
		if value.Kind != yaml.ScalarNode {
			return nil, errors.New("must be text")
		}
		if value.ShortTag() == "!!null" {
			return "", nil
		}
		return value.Value, nil
	}
	var decoded any
	if err := value.Decode(&decoded); err != nil {
		return nil, errors.New("the value is not valid YAML")
	}
	return normalizeJSON(decoded)
}

// normalizeJSON gives a value JSON's types (maps with string keys).
func normalizeJSON(value any) (any, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, errors.New("the value has a shape config values cannot have")
	}
	var out any
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, errors.New("the value has a shape config values cannot have")
	}
	return out, nil
}

// setPlan is a checked change against the config as it is now.
type setPlan struct {
	req      setRequest
	doc      *document
	snapshot configrevision.Snapshot
	current  any
	proposed any
	result   []byte
}

func (p setPlan) mode() configsettings.ApplyMode {
	if p.req.field.ApplyMode == "" {
		return configsettings.ApplyNextGeneration
	}
	return p.req.field.ApplyMode
}

func (p setPlan) update() configsettings.Update {
	if p.req.unset {
		return configsettings.Update{Reset: []string{p.req.path}}
	}
	return configsettings.Update{Changes: map[string]json.RawMessage{p.req.path: p.req.raw}}
}

// planSet checks a change against the config: the field's kind, allowed values and range
// (configsettings.Apply), the state folder rule, and the LLM routes.
func planSet(opts Options, req setRequest) (setPlan, error) {
	if strings.TrimSpace(opts.ConfigPath) == "" {
		return setPlan{}, errors.New("this runtime has no config to change")
	}
	snapshot, err := configrevision.Read(opts.ConfigPath)
	if err != nil {
		return setPlan{}, fmt.Errorf("the config could not be read: %s", safeError(err))
	}
	doc, err := loadDocument(opts.ConfigPath)
	if err != nil {
		return setPlan{}, err
	}
	plan := setPlan{req: req, doc: doc, snapshot: snapshot}
	info := doc.keyInfo(req.path)
	plan.current = displayValue(info)
	if req.unset {
		plan.proposed = "(unset: the default applies)"
	} else if req.field.Sensitive {
		plan.proposed = MaskedText(fmt.Sprint(req.value))
	} else {
		plan.proposed = req.value
	}
	result, err := configsettings.Apply(snapshot.Data, plan.update(), loadCatalog().list)
	if err != nil {
		if req.field.Sensitive {
			return setPlan{}, fmt.Errorf("%s: the value is not accepted for this key", req.path)
		}
		return setPlan{}, err
	}
	if err := configstore.CheckBootstrapKeys(opts.ConfigPath, result); err != nil {
		return setPlan{}, fmt.Errorf("%s cannot be changed here: start morph with --state-dir instead", req.path)
	}
	if err := checkRoutes(req.path, result); err != nil {
		return setPlan{}, err
	}
	plan.result = result
	return plan, nil
}

// checkRoutes resolves a changed LLM route, so a route that names a missing profile or has the
// wrong shape is refused rather than breaking the next task.
func checkRoutes(path string, data []byte) error {
	purpose, ok := strings.CutPrefix(path, "llm.routes.")
	if !ok {
		return nil
	}
	reader := viper.New()
	configdefaults.Apply(reader)
	reader.SetConfigType("yaml")
	if len(bytes.TrimSpace(data)) > 0 {
		if err := reader.ReadConfig(bytes.NewReader(data)); err != nil {
			return errConfigInvalid
		}
	}
	values, err := llmutil.RuntimeValuesFromReader(reader)
	if err != nil {
		return fmt.Errorf("%s: %s", path, safeError(err))
	}
	if _, err := llmutil.ResolveRoute(values, purpose); err != nil {
		return fmt.Errorf("%s: %s", path, safeError(err))
	}
	return nil
}

// displayValue is a key's value as an approval or result shows it.
func displayValue(info KeyInfo) any {
	if info.Secret != nil {
		if !info.Secret.Set {
			return "(not set)"
		}
		return Mask + " (" + info.Secret.Source + ")"
	}
	if !info.Set {
		if info.Default != nil {
			return map[string]any{"unset": true, "default": info.Default}
		}
		return "(not set)"
	}
	return info.Value
}

func compactJSON(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	text := string(data)
	if len(text) > 300 {
		text = text[:300] + "…"
	}
	return text
}

// applyNote tells the agent what the user still has to do for a change to apply.
func applyNote(mode configsettings.ApplyMode) string {
	switch mode {
	case configsettings.ApplyImmediate:
		return "Applied."
	case configsettings.ApplyRuntimeRestart:
		return "Applies when the channel runtimes restart: the Console restarts the runtimes it manages when it reloads the config; " +
			"a runtime started on its own (morph telegram, ...) needs a restart. Tell the user."
	case configsettings.ApplyProcessRestart:
		return "Applies after morph is restarted. Tell the user to restart it."
	default:
		return "Applies from the next task once the runtime reloads the config (the Console and channel runtimes reload it within seconds; " +
			"morph chat and morph run read it when they start)."
	}
}

// SetTool is config_set.
type SetTool struct {
	opts func() Options
}

// NewSetTool returns config_set changing the config opts name.
func NewSetTool(opts Options) *SetTool {
	return &SetTool{opts: func() Options { return opts }}
}

func (t *SetTool) Name() string { return SetToolName }

// Deferred: config_set stays out of requests until the model finds it with tool_search.
func (t *SetTool) Deferred() bool { return true }

// CodeModeExcluded: the user approves each change, so the model calls it directly.
func (t *SetTool) CodeModeExcluded() bool { return true }

func (t *SetTool) Description() string {
	return "Change one key of the agent's own config (settings), or remove it so its default applies. " +
		"Every call asks the user to approve, showing the key, its current value and the new one (secrets masked); a denied call changes nothing. " +
		"Use it only when the user asks for the change, in a private conversation with the owner. Call config_get first: it shows which keys are settable, their types and allowed values. " +
		"The value is read as YAML like `morph config set`: 90s, true, 8, [a, b], \"text\". " +
		"For a secret key (API key, token) pass the user's real value, which is stored in the system keyring, or a whole ${ENV_NAME} reference; never pass the " + Mask + " mask config_get shows. " +
		"The guard, secrets, Console, endpoints, MCP servers, owners and similar keys can only be changed by the user. " +
		"The result says when the change applies (next task, runtime restart, process restart); tell the user what is still needed."
}

func (t *SetTool) ParameterSchema() string {
	return `{"type":"object","properties":{"path":{"type":"string","description":"Dotted config key, such as llm.model or tools.bash.timeout."},"value":{"type":"string","description":"New value, read as YAML: 90s, true, 8, [a, b], \"text\". Leave out with unset."},"unset":{"type":"boolean","description":"Remove the key so its default applies."}},"required":["path"],"additionalProperties":false}`
}

// ApprovalPreview checks a call before the user is asked, and describes it: the key, its current
// value and the new one, secrets masked, and when the change applies.
func (t *SetTool) ApprovalPreview(ctx context.Context, params map[string]any) (tools.ApprovalPreview, error) {
	if err := checkCaller(ctx); err != nil {
		return tools.ApprovalPreview{}, err
	}
	req, err := parseSetRequest(params)
	if err != nil {
		return tools.ApprovalPreview{}, err
	}
	opts := t.opts()
	if err := checkSecretStorage(req, opts); err != nil {
		return tools.ApprovalPreview{}, err
	}
	plan, err := planSet(opts, req)
	if err != nil {
		return tools.ApprovalPreview{}, err
	}
	mode := plan.mode()
	display := map[string]any{
		"path":          req.path,
		"current_value": plan.current,
		"apply_mode":    string(mode),
	}
	if req.unset {
		display["unset"] = true
	} else {
		display["new_value"] = plan.proposed
	}
	summary := fmt.Sprintf("Change config %s: %s → %s (applies: %s)", req.path, compactJSON(plan.current), compactJSON(plan.proposed), mode)
	return tools.ApprovalPreview{Summary: summary, Params: display}, nil
}

// checkSecretStorage refuses, before asking, a plain-text secret that cannot be kept out of the
// config.
func checkSecretStorage(req setRequest, opts Options) error {
	if req.unset || !req.field.Sensitive {
		return nil
	}
	text, _ := req.value.(string)
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	if _, isRef := secref.ParseSingleRef(text); isRef {
		return nil
	}
	if opts.SecretStore == nil {
		return fmt.Errorf("%s: the system keyring is not available here, so config_set cannot store the key; "+
			"pass a whole environment variable reference such as ${NAME}, or ask the user to set it in the Console or with morph config set", req.path)
	}
	return nil
}

func (t *SetTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if !tools.UserApproved(ctx) {
		return "", errors.New("config_set runs only after the user approves the call; nothing was changed")
	}
	if err := checkCaller(ctx); err != nil {
		return "", err
	}
	req, err := parseSetRequest(params)
	if err != nil {
		return "", err
	}
	opts := t.opts()
	if err := checkSecretStorage(req, opts); err != nil {
		return "", err
	}
	out, err := applySet(ctx, opts, req)
	if err != nil {
		return "", err
	}
	data, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// applySet writes an approved change: a plain-text secret goes to the system keyring and the
// config keeps a reference to it; the config is saved as the agent's change (configstore.ByAgent);
// the runtime is asked to reload it.
func applySet(ctx context.Context, opts Options, req setRequest) (map[string]any, error) {
	writeMu.Lock()
	defer writeMu.Unlock()

	var created []string
	committed := false
	defer func() {
		if !committed {
			secref.DeleteOSSecrets(context.WithoutCancel(ctx), opts.SecretStore, created)
		}
	}()
	if !req.unset && req.field.Sensitive && opts.SecretStore != nil {
		update := configsettings.Update{Changes: map[string]json.RawMessage{req.path: req.raw}}
		ids, err := configsettings.ProtectSecrets(ctx, &update, loadCatalog().list, opts.SecretStore)
		if err != nil {
			return nil, fmt.Errorf("%s: the key could not be stored in the system keyring (%s); nothing was changed", req.path, safeKeyringError(err))
		}
		created = ids
		req.raw = update.Changes[req.path]
	}
	if !req.unset && req.field.Sensitive {
		var stored string
		if err := json.Unmarshal(req.raw, &stored); err != nil {
			return nil, fmt.Errorf("%s: the key could not be stored; nothing was changed", req.path)
		}
		if stored = strings.TrimSpace(stored); stored != "" {
			if _, isRef := secref.ParseSingleRef(stored); !isRef {
				return nil, fmt.Errorf("%s: the key could not be kept out of the config; nothing was changed", req.path)
			}
		}
	}

	plan, err := planSet(opts, req)
	if err != nil {
		return nil, err
	}
	if latest, err := configrevision.Read(opts.ConfigPath); err != nil || latest.Revision != plan.snapshot.Revision {
		return nil, errors.New("the config changed while this change was prepared; nothing was changed, call config_set again")
	}
	if !configstore.IsDBConfigPath(opts.ConfigPath) {
		if err := os.MkdirAll(filepath.Dir(opts.ConfigPath), 0o755); err != nil {
			return nil, fmt.Errorf("the config could not be saved (%s); nothing was changed", safeError(err))
		}
	}
	if err := configstore.WriteFileBy(opts.ConfigPath, plan.result, configstore.ByAgent); err != nil {
		return nil, fmt.Errorf("the config could not be saved (%s); nothing was changed", safeError(err))
	}
	committed = true
	cleanupSecrets(ctx, opts, plan.snapshot.Data, plan.result)

	saved, err := loadDocument(opts.ConfigPath)
	var value any = "(saved)"
	if err == nil {
		value = displayValue(saved.keyInfo(req.path))
	}
	mode := plan.mode()
	out := map[string]any{
		"saved":          true,
		"path":           req.path,
		"previous_value": plan.current,
		"value":          value,
		"apply_mode":     string(mode),
		"apply_note":     applyNote(mode),
		"config":         configstore.Source(opts.ConfigPath),
	}
	if reload := reloaderFrom(ctx); reload != nil {
		if err := reload(ctx); err != nil {
			out["reload"] = "failed: " + safeError(err) + "; the runtime reloads the saved config on its next check or restart"
		} else {
			out["reload"] = "requested"
		}
	}
	return out, nil
}

// cleanupSecrets deletes the keyring entries the change left unused and records the saved keys,
// as the Console does after a settings save.
func cleanupSecrets(ctx context.Context, opts Options, previous, next []byte) {
	if opts.SecretStore != nil {
		prevDoc, errPrev := configbootstrap.LoadDocumentBytes(previous)
		nextDoc, errNext := configbootstrap.LoadDocumentBytes(next)
		if errPrev == nil && errNext == nil {
			still := secref.OSSecretIDsInYAML(nextDoc)
			for id := range secref.OSSecretIDsInYAML(prevDoc) {
				if !still[id] {
					_ = opts.SecretStore.Delete(context.WithoutCancel(ctx), id)
				}
			}
		}
	}
	if dir := strings.TrimSpace(opts.StateDir); dir != "" {
		_, _ = secretkeys.Sync(secretkeys.LedgerPath(dir), secretkeys.CollectBytes(previous), secretkeys.CollectBytes(next), time.Now())
	}
}

// safeKeyringError names a keyring failure without details that could carry a value.
func safeKeyringError(err error) string {
	if errors.Is(err, secref.ErrOSStoreUnavailable) {
		return "the system keyring is unavailable"
	}
	return "keyring error"
}
