package agentsettings

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/llmbench"
	"github.com/quailyquaily/mistermorph/internal/llminspect"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/secref"
	uniaiapi "github.com/quailyquaily/uniai"
)

type ConnectionTestOptions struct {
	InspectPrompt  bool
	InspectRequest bool
	DumpDir        string
}

type ConnectionTestResult struct {
	Provider   string
	APIBase    string
	Model      string
	Benchmarks []llmbench.BenchmarkResult
}

func ResolveConnectionTestFieldValue(value string, source secref.Source) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	resolved, err := secref.ResolveString(context.Background(), value, source, secref.Options{
		EnvMissing: secref.EnvMissingError,
	})
	if err != nil {
		if missingErr, ok := err.(secref.MissingEnvError); ok {
			return "", fmt.Errorf("missing env %q", strings.Join(missingErr.Names, ", "))
		}
		return "", err
	}
	return strings.TrimSpace(resolved.Value), nil
}

func RunConnectionTest(ctx context.Context, values llmutil.RuntimeValues, opts ConnectionTestOptions) (ConnectionTestResult, error) {
	route, err := llmutil.ResolveRoute(values, llmutil.RoutePurposeMainLoop)
	if err != nil {
		return ConnectionTestResult{}, err
	}
	client, err := llmutil.ClientFromConfigWithValues(route.ClientConfig, route.Values)
	if err != nil {
		return ConnectionTestResult{}, err
	}
	closeClient := func() error {
		if closer, ok := client.(io.Closer); ok {
			return closer.Close()
		}
		return nil
	}
	var requestInspector *llminspect.RequestInspector
	var promptInspector *llminspect.PromptInspector
	cleanup := func() error {
		var requestErr, promptErr error
		if requestInspector != nil {
			requestErr = requestInspector.Close()
		}
		if promptInspector != nil {
			promptErr = promptInspector.Close()
		}
		return errors.Join(closeClient(), requestErr, promptErr)
	}
	defer cleanup()
	inspectOptions := llminspect.Options{
		Mode:            "console_settings_test",
		Task:            "settings_test",
		TimestampFormat: "20060102_150405.000000000",
		DumpDir:         strings.TrimSpace(opts.DumpDir),
	}
	if opts.InspectRequest {
		requestInspector, err = llminspect.NewRequestInspector(inspectOptions)
		if err != nil {
			return ConnectionTestResult{}, err
		}
	}
	if opts.InspectPrompt {
		promptInspector, err = llminspect.NewPromptInspector(inspectOptions)
		if err != nil {
			return ConnectionTestResult{}, err
		}
	}
	client = llminspect.WrapClient(client, llminspect.ClientOptions{
		PromptInspector:  promptInspector,
		RequestInspector: requestInspector,
		APIBase:          route.ClientConfig.Endpoint,
		Model:            strings.TrimSpace(route.ClientConfig.Model),
	})
	metadata := llmbench.ProfileMetadata{
		Provider: route.ClientConfig.Provider,
		APIBase:  strings.TrimSpace(route.ClientConfig.Endpoint),
		Model:    route.ClientConfig.Model,
	}
	return ConnectionTestResult{
		Provider:   metadata.Provider,
		APIBase:    metadata.APIBase,
		Model:      metadata.Model,
		Benchmarks: llmbench.Run(ctx, client, metadata).Benchmarks,
	}, nil
}

// ModelInfo is one model a provider lists. Created is when the provider published it (Unix
// seconds), or 0 when the provider does not say.
type ModelInfo struct {
	ID      string `json:"id"`
	Created int64  `json:"created,omitempty"`
}

// FetchModels lists the provider's models, newest first; models without a date come
// last, in name order.
func FetchModels(ctx context.Context, lookup ModelLookupConfig) ([]ModelInfo, error) {
	cfg := uniaiapi.Config{Provider: lookup.Provider, ModelsHTTPClient: &http.Client{Timeout: 15 * time.Second}}
	endpoint := strings.TrimRight(strings.TrimSpace(lookup.Endpoint), "/")
	apiKey := strings.TrimSpace(lookup.APIKey)
	switch lookup.Provider {
	case "anthropic":
		modelsURL, err := NormalizeOpenAICompatibleModelsURL(endpoint)
		if err != nil {
			return nil, err
		}
		cfg.AnthropicAPIBase = strings.TrimSuffix(modelsURL, "/models")
		cfg.AnthropicAPIKey = apiKey
	case "gemini":
		cfg.GeminiAPIBase = strings.TrimSuffix(endpoint, "/v1beta")
		cfg.GeminiAPIKey = apiKey
	case "cloudflare":
		cfg.CloudflareAPIBase = endpoint
		cfg.CloudflareAPIToken = apiKey
		cfg.CloudflareAccountID = lookup.CloudflareAccountID
	case "", "openai", "openai_resp", "xai", "deepseek", "meta", "sakana":
		modelsURL, err := NormalizeOpenAICompatibleModelsURL(endpoint)
		if err != nil {
			return nil, err
		}
		// These routes use the OpenAI catalog format at the resolved endpoint.
		cfg.Provider = "openai"
		cfg.OpenAIAPIBase = strings.TrimSuffix(modelsURL, "/models")
		cfg.OpenAIAPIKey = apiKey
	default:
		return nil, fmt.Errorf("model lookup is not supported for provider %q", lookup.Provider)
	}
	client := uniaiapi.New(cfg)
	catalog, err := client.ListModels(ctx, "")
	if err != nil {
		return nil, fmt.Errorf("model lookup failed: %w", err)
	}
	seen := make(map[string]struct{}, len(catalog))
	models := make([]ModelInfo, 0, len(catalog))
	for _, item := range catalog {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		// uniai preserves provider-specific creation timestamps in Raw.
		var metadata struct {
			Created   json.RawMessage `json:"created"`
			CreatedAt string          `json:"created_at"`
		}
		if err := json.Unmarshal(item.Raw, &metadata); err != nil {
			return nil, fmt.Errorf("invalid model metadata: %w", err)
		}
		created := parseModelCreated(metadata.Created)
		if created == 0 && metadata.CreatedAt != "" {
			if timestamp, err := time.Parse(time.RFC3339, metadata.CreatedAt); err == nil {
				created = timestamp.Unix()
			}
		}
		models = append(models, ModelInfo{ID: id, Created: created})
	}
	sortModelsNewestFirst(models)
	return models, nil
}

// parseModelCreated reads a model's created time: Unix seconds as a number (OpenAI and most
// others), or milliseconds, or a numeric string. Anything else is 0.
func parseModelCreated(raw json.RawMessage) int64 {
	text := strings.Trim(strings.TrimSpace(string(raw)), `"`)
	if text == "" || text == "null" {
		return 0
	}
	value, err := strconv.ParseFloat(text, 64)
	if err != nil || value <= 0 {
		return 0
	}
	created := int64(value)
	if created > 1e12 {
		created /= 1000
	}
	return created
}

func sortModelsNewestFirst(models []ModelInfo) {
	sort.SliceStable(models, func(i, j int) bool {
		if models[i].Created != models[j].Created {
			return models[i].Created > models[j].Created
		}
		return models[i].ID < models[j].ID
	})
}

func NormalizeOpenAICompatibleModelsURL(endpoint string) (string, error) {
	base := strings.TrimSpace(endpoint)
	if base == "" {
		base = "https://api.openai.com"
	}
	parsed, err := url.Parse(base)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || strings.TrimSpace(parsed.Host) == "" {
		return "", fmt.Errorf("invalid api base")
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	switch {
	case strings.HasSuffix(parsed.Path, "/models"):
	case strings.HasSuffix(parsed.Path, "/v1"):
		parsed.Path += "/models"
	default:
		parsed.Path += "/v1/models"
	}
	return parsed.String(), nil
}
