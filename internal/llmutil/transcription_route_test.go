package llmutil

import (
	"errors"
	"strings"
	"testing"

	"github.com/spf13/viper"
)

func transcriptionTestValues(t *testing.T, yaml string) RuntimeValues {
	t.Helper()
	v := viper.New()
	v.SetConfigType("yaml")
	if err := v.ReadConfig(strings.NewReader(yaml)); err != nil {
		t.Fatalf("ReadConfig() error = %v", err)
	}
	return requireRuntimeValues(t, v)
}

func TestTranscriptionRouteValuesUsesTheRoutedProfile(t *testing.T) {
	values := transcriptionTestValues(t, `
llm:
  provider: anthropic
  api_key: chat-key
  model: claude-sonnet-5-5
  transcription:
    request_timeout: 30s
  profiles:
    ears:
      abilities: ["transcription"]
      inference_provider: openai
      api_key: openai-key
      model: gpt-4o-mini-transcribe
  routes:
    transcription: ears
`)
	routeValues, err := TranscriptionRouteValues(values)
	if err != nil {
		t.Fatalf("TranscriptionRouteValues() error = %v", err)
	}
	if routeValues.Model != "gpt-4o-mini-transcribe" || routeValues.APIKey != "openai-key" {
		t.Fatalf("route values = %#v, want the ears profile", routeValues)
	}
	if routeValues.TranscriptionTimeoutRaw != "30s" {
		t.Fatalf("TranscriptionTimeoutRaw = %q, want 30s", routeValues.TranscriptionTimeoutRaw)
	}
	meta, err := ResolveTranscriptionClientMetadata(routeValues)
	if err != nil {
		t.Fatalf("ResolveTranscriptionClientMetadata() error = %v", err)
	}
	if meta.Provider != "openai" || meta.Model != "gpt-4o-mini-transcribe" {
		t.Fatalf("metadata = %#v, want openai/gpt-4o-mini-transcribe", meta)
	}
	if _, err := TranscriptionClientFromValues(routeValues); err != nil {
		t.Fatalf("TranscriptionClientFromValues() error = %v", err)
	}
}

func TestTranscriptionRouteValuesIsOffWithoutARoute(t *testing.T) {
	values := RuntimeValues{Provider: "openai", APIKey: "key", Model: "gpt-5.5"}
	if _, err := TranscriptionRouteValues(values); !errors.Is(err, ErrTranscriptionRouteUnset) {
		t.Fatalf("TranscriptionRouteValues() error = %v, want ErrTranscriptionRouteUnset", err)
	}
}

func TestTranscriptionRouteValuesRejectsBadRoutes(t *testing.T) {
	withFallbacks := RuntimeValues{Routes: RoutesConfig{PurposeRoutes: PurposeRoutes{Transcription: RoutePolicyConfig{
		Profile: "ears", FallbackProfiles: []string{"other"},
	}}}}
	if _, err := TranscriptionRouteValues(withFallbacks); err == nil || !strings.Contains(err.Error(), "llm.routes.transcription") {
		t.Fatalf("TranscriptionRouteValues() error = %v, want an llm.routes.transcription error", err)
	}
	missing := RuntimeValues{Routes: RoutesConfig{PurposeRoutes: PurposeRoutes{Transcription: RoutePolicyConfig{Profile: "nope"}}}}
	var missingErr *MissingProfileError
	if _, err := TranscriptionRouteValues(missing); !errors.As(err, &missingErr) {
		t.Fatalf("TranscriptionRouteValues() error = %v, want MissingProfileError", err)
	}
}

func TestResolveTranscriptionClientMetadataProviders(t *testing.T) {
	cases := []struct {
		name         string
		values       RuntimeValues
		wantProvider string
		wantEndpoint string
		wantErr      bool
	}{
		{name: "openai", values: RuntimeValues{InferenceProvider: InferenceProviderOpenAI, Model: "whisper-1"}, wantProvider: "openai", wantEndpoint: DefaultOpenAIEndpoint},
		{name: "groq", values: RuntimeValues{InferenceProvider: InferenceProviderGroq, Model: "whisper-large-v3-turbo"}, wantProvider: "openai", wantEndpoint: DefaultGroqEndpoint},
		{name: "compatible", values: RuntimeValues{InferenceProvider: InferenceProviderOpenAIChatCompatible, Endpoint: "http://127.0.0.1:9000/v1", Model: "whisper"}, wantProvider: "openai", wantEndpoint: "http://127.0.0.1:9000/v1"},
		{name: "cloudflare", values: RuntimeValues{InferenceProvider: InferenceProviderCloudflare, Model: "@cf/openai/whisper-large-v3-turbo"}, wantProvider: "cloudflare"},
		{name: "anthropic", values: RuntimeValues{InferenceProvider: InferenceProviderAnthropic, Model: "claude-sonnet-5-5"}, wantErr: true},
		{name: "gemini", values: RuntimeValues{InferenceProvider: InferenceProviderGemini, Model: "gemini-3-flash"}, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			meta, err := ResolveTranscriptionClientMetadata(tc.values)
			if tc.wantErr {
				if err == nil || !strings.Contains(err.Error(), "does not support transcription") {
					t.Fatalf("error = %v, want unsupported provider", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("error = %v", err)
			}
			if meta.Provider != tc.wantProvider {
				t.Fatalf("provider = %q, want %q", meta.Provider, tc.wantProvider)
			}
			if tc.wantEndpoint != "" && meta.Endpoint != tc.wantEndpoint {
				t.Fatalf("endpoint = %q, want %q", meta.Endpoint, tc.wantEndpoint)
			}
		})
	}
}

func TestNormalizeAbilitiesAcceptsTranscription(t *testing.T) {
	got, err := NormalizeAbilities([]string{" Transcription "})
	if err != nil || len(got) != 1 || got[0] != AbilityTranscription {
		t.Fatalf("NormalizeAbilities() = %v, %v; want [transcription]", got, err)
	}
	if HasAbility(got, AbilityText) {
		t.Fatalf("a transcription-only profile must not have the text ability")
	}
}
