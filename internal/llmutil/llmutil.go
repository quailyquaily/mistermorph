package llmutil

import (
	"fmt"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/llm"
	uniaiProvider "github.com/quailyquaily/mistermorph/providers/uniai"
	"github.com/spf13/viper"
)

func ProviderFromViper() string {
	return strings.TrimSpace(viper.GetString("llm.provider"))
}

func EndpointFromViper() string {
	return EndpointForProvider(ProviderFromViper())
}

func APIKeyFromViper() string {
	return APIKeyForProvider(ProviderFromViper())
}

func ModelFromViper() string {
	return ModelForProvider(ProviderFromViper())
}

func EndpointForProvider(provider string) string {
	provider = normalizeProvider(provider)
	switch provider {
	case "cloudflare":
		generic := strings.TrimSpace(viper.GetString("llm.endpoint"))
		if generic != "" && generic != "https://api.openai.com" && generic != "https://api.openai.com/v1" {
			return generic
		}
		return ""
	default:
		return strings.TrimSpace(viper.GetString("llm.endpoint"))
	}
}

func APIKeyForProvider(provider string) string {
	provider = normalizeProvider(provider)
	switch provider {
	case "cloudflare":
		return firstNonEmpty(viper.GetString("llm.cloudflare.api_token"), viper.GetString("llm.api_key"))
	default:
		return strings.TrimSpace(viper.GetString("llm.api_key"))
	}
}

func ModelForProvider(provider string) string {
	provider = normalizeProvider(provider)
	switch provider {
	case "azure":
		return firstNonEmpty(
			viper.GetString("llm.azure.deployment"),
			viper.GetString("llm.model"),
		)
	default:
		return strings.TrimSpace(viper.GetString("llm.model"))
	}
}

func ClientFromConfig(cfg llmconfig.ClientConfig) (llm.Client, error) {
	toolsEmulationMode, err := toolsEmulationModeFromViper()
	if err != nil {
		return nil, err
	}
	switch strings.ToLower(strings.TrimSpace(cfg.Provider)) {
	case "openai", "openai_custom", "deepseek", "xai", "gemini", "azure", "anthropic", "bedrock", "susanoo", "cloudflare":
		c := uniaiProvider.New(uniaiProvider.Config{
			Provider:           strings.ToLower(strings.TrimSpace(cfg.Provider)),
			Endpoint:           strings.TrimSpace(cfg.Endpoint),
			APIKey:             strings.TrimSpace(cfg.APIKey),
			Model:              strings.TrimSpace(cfg.Model),
			RequestTimeout:     cfg.RequestTimeout,
			ToolsEmulationMode: toolsEmulationMode,
			AzureAPIKey:        strings.TrimSpace(cfg.APIKey),
			AzureEndpoint:      strings.TrimSpace(cfg.Endpoint),
			AzureDeployment:    strings.TrimSpace(cfg.Model),
			AwsKey:             firstNonEmpty(viper.GetString("llm.bedrock.aws_key"), viper.GetString("llm.aws.key")),
			AwsSecret:          firstNonEmpty(viper.GetString("llm.bedrock.aws_secret"), viper.GetString("llm.aws.secret")),
			AwsRegion:          firstNonEmpty(viper.GetString("llm.bedrock.region"), viper.GetString("llm.aws.region")),
			AwsBedrockModelArn: firstNonEmpty(viper.GetString("llm.bedrock.model_arn"), viper.GetString("llm.aws.bedrock_model_arn")),
			CloudflareAccountID: firstNonEmpty(
				viper.GetString("llm.cloudflare.account_id"),
			),
			CloudflareAPIToken: firstNonEmpty(
				viper.GetString("llm.cloudflare.api_token"),
				viper.GetString("llm.api_key"),
			),
			CloudflareAPIBase: strings.TrimSpace(cfg.Endpoint),
		})
		return c, nil
	default:
		return nil, fmt.Errorf("unknown provider: %s", cfg.Provider)
	}
}

func toolsEmulationModeFromViper() (string, error) {
	mode := strings.ToLower(strings.TrimSpace(viper.GetString("llm.tools_emulation_mode")))
	if mode == "" {
		return "off", nil
	}
	switch mode {
	case "off", "fallback", "force":
		return mode, nil
	default:
		return "", fmt.Errorf("invalid llm.tools_emulation_mode %q (expected off|fallback|force)", mode)
	}
}

func normalizeProvider(provider string) string {
	provider = strings.ToLower(strings.TrimSpace(provider))
	if provider == "" {
		return "openai"
	}
	return provider
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}
