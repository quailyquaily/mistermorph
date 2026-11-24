package configtools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/configbootstrap"
	"github.com/quailyquaily/mistermorph/internal/configsettings"
	"gopkg.in/yaml.v3"
)

// configWith is a config document with value at the dotted path.
func configWith(t *testing.T, path, value string) string {
	t.Helper()
	doc := configbootstrap.NewEmptyDocument()
	node := doc.Content[0]
	parts := strings.Split(path, ".")
	for _, part := range parts[:len(parts)-1] {
		node = configbootstrap.EnsureMappingValue(node, part)
	}
	node.Content = append(node.Content,
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: parts[len(parts)-1]},
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value, Style: yaml.DoubleQuotedStyle},
	)
	out, err := configbootstrap.MarshalDocument(doc)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

// readsOf is every config_get a secret at path can be read through: the overview, each section
// that holds it, and the key itself.
func readsOf(path string) []string {
	reads := []string{""}
	parts := strings.Split(path, ".")
	for i := 1; i <= len(parts); i++ {
		reads = append(reads, strings.Join(parts[:i], "."))
	}
	return reads
}

func sensitiveFields() []configsettings.Field {
	var out []configsettings.Field
	for _, field := range Fields() {
		if field.Sensitive {
			out = append(out, field)
		}
	}
	return out
}

// Every Sensitive field, set as plain text, an environment reference, a system keyring reference
// or an AWS Secrets Manager reference, read directly or through any section that holds it: no
// output holds the secret, the variable's value or name, or the reference's id.
func TestGetNeverReturnsASensitiveValue(t *testing.T) {
	fields := sensitiveFields()
	if len(fields) < 20 {
		t.Fatalf("only %d sensitive fields: the registry changed shape", len(fields))
	}
	const envName = "FT179_TEST_SECRET_VARIABLE"
	const envValue = "env-resolved-secret-value-7f3a"
	t.Setenv(envName, envValue)
	forms := []struct {
		name, raw, source string
		forbidden         []string
	}{
		{"literal", "plain-literal-secret-value-91b2", SourceLiteral, []string{"plain-literal-secret-value-91b2", "91b2"}},
		{"env", "${" + envName + "}", SourceEnv, []string{envName, envValue}},
		{"secret_store", "${secret:AbCdEfGhIjKlMnOpQrStUvWx12}", SourceSecretStore, []string{"AbCdEfGhIjKlMnOpQrStUvWx12"}},
		{"aws", "${aws-sm:prod/morph-keys#field_name_x}", SourceAWS, []string{"prod/morph-keys", "field_name_x"}},
	}
	for _, field := range fields {
		for _, form := range forms {
			t.Run(field.Path+"/"+form.name, func(t *testing.T) {
				path := dbConfig(t, configWith(t, field.Path, form.raw))
				// The whole document rendered as one value, as a parent mapping is.
				doc, err := loadDocument(path)
				if err != nil {
					t.Fatal(err)
				}
				whole, _ := json.Marshal(doc.masker.render(doc.root, nil))
				mustNotContain(t, "the rendered document", string(whole), form.forbidden...)
				for _, read := range readsOf(field.Path) {
					out, text := runGet(t, path, read)
					mustNotContain(t, fmt.Sprintf("config_get(%q)", read), text, form.forbidden...)
					if read != field.Path {
						continue
					}
					if out.Key == nil || out.Key.Value != Mask || out.Key.Secret == nil || !out.Key.Secret.Set || out.Key.Secret.Source != form.source || !out.Key.Sensitive {
						t.Fatalf("config_get(%q).key = %+v, want masked and set from %s", read, out.Key, form.source)
					}
				}
			})
		}
	}
}

// Secrets inside values: routes and profiles, Console endpoints, MCP headers and environment,
// auth profiles, secrets.*, YAML aliases, and copies of a secret in other keys.
func TestGetMasksSecretsInsideMappingsListsAndCopies(t *testing.T) {
	const literal = "sk-nested-literal-secret-5150"
	const envName = "FT179_NESTED_ENV"
	const envValue = "nested-env-value-secret-2468"
	t.Setenv(envName, envValue)
	t.Setenv("FT179_HEADER_TOKEN", "header-token-value-1357")
	config := `llm:
  api_key: &key "` + literal + `"
  headers:
    X-Custom: "custom-header-value-8642"
    Authorization: "Bearer ${FT179_HEADER_TOKEN}"
  profiles:
    cheap:
      model: gpt-mini
      api_key: "${` + envName + `}"
      bedrock:
        aws_secret: "${secret:ZZZZZZZZZZZZZZZZZZZZZZZZ99}"
  routes:
    main_loop:
      profile: cheap
user_agent: *key
tools:
  web_search:
    base_url: "https://example.invalid/?k=` + literal + `"
  bash:
    injected_env_vars:
      - OPENAI_API_BASE
      - name: MY_FIXED_TOKEN
        value: "injected-env-literal-0007"
console:
  endpoints:
    - name: remote
      url: http://127.0.0.1:8787/runtime
      auth_token: "endpoint-token-literal-3141"
mcp:
  servers:
    - name: remote
      url: https://mcp.example.invalid/mcp
      headers:
        Authorization: "Bearer mcp-header-literal-2718"
      env:
        GITHUB_PAT: "mcp-env-literal-1618"
auth_profiles:
  jsonbill:
    credential:
      kind: api_key
      secret: "auth-profile-literal-1414"
secrets:
  aws_secrets_manager:
    profile: "aws-profile-name-1732"
`
	forbidden := []string{literal, envName, envValue, "header-token-value-1357", "custom-header-value-8642",
		"ZZZZZZZZZZZZZZZZZZZZZZZZ99", "injected-env-literal-0007", "endpoint-token-literal-3141",
		"mcp-header-literal-2718", "mcp-env-literal-1618", "auth-profile-literal-1414", "aws-profile-name-1732"}
	for _, configPath := range []string{fileConfig(t, config), dbConfig(t, config)} {
		reads := []string{"", "llm", "llm.headers", "llm.profiles", "llm.profiles.cheap", "llm.routes", "llm.routes.main_loop",
			"user_agent", "tools", "tools.web_search", "tools.web_search.base_url", "tools.bash", "tools.bash.injected_env_vars",
			"console", "console.endpoints", "console.endpoints.0", "mcp", "mcp.servers", "mcp.servers.0", "mcp.servers.0.headers",
			"auth_profiles", "auth_profiles.jsonbill", "secrets", "secrets.aws_secrets_manager"}
		for _, read := range reads {
			_, text := runGet(t, configPath, read)
			mustNotContain(t, fmt.Sprintf("config_get(%q) of %s", read, configPath), text, forbidden...)
		}
		// What is not secret stays readable.
		out, _ := runGet(t, configPath, "llm.routes.main_loop")
		// agent.db keeps a profile-only route as its profile's name.
		if route, _ := out.Key.Value.(map[string]any); route["profile"] != "cheap" && out.Key.Value != "cheap" {
			t.Fatalf("llm.routes.main_loop = %#v, want profile cheap", out.Key.Value)
		}
		profiles, _ := runGet(t, configPath, "llm.profiles.cheap.model")
		if profiles.Key == nil || profiles.Key.Value != "gpt-mini" {
			t.Fatalf("llm.profiles.cheap.model = %+v", profiles.Key)
		}
	}
}

// A non-secret ${VAR} stays as written; only secrets are masked.
func TestGetKeepsNonSecretReferencesAsWritten(t *testing.T) {
	path := dbConfig(t, "llm:\n  model: \"${FT179_MODEL}\"\n")
	out, _ := runGet(t, path, "llm.model")
	if out.Key.Value != "${FT179_MODEL}" {
		t.Fatalf("llm.model = %#v, want the reference as written", out.Key.Value)
	}
}

// An environment override of a secret key reports itself, never its value.
func TestGetReportsAnEnvironmentOverrideOfASecret(t *testing.T) {
	t.Setenv("MISTER_MORPH_LLM_API_KEY", "override-secret-value-4321")
	path := dbConfig(t, "llm:\n  model: gpt\n  user_note: override-secret-value-4321\n")
	for _, read := range []string{"", "llm", "llm.api_key", "llm.user_note"} {
		_, text := runGet(t, path, read)
		mustNotContain(t, "config_get("+read+")", text, "override-secret-value-4321")
	}
	out, _ := runGet(t, path, "llm.api_key")
	if out.Key.EnvOverride != "MISTER_MORPH_LLM_API_KEY" || out.Key.Secret == nil || out.Key.Secret.Source != SourceEnvOverride || out.Key.Settable {
		t.Fatalf("llm.api_key = %+v", out.Key)
	}
}

// A config that does not parse is reported without its text.
func TestGetHidesParseErrors(t *testing.T) {
	path := fileConfig(t, "llm:\n  api_key: \"unterminated-secret-0042\n  model: [\n")
	_, err := Get(Options{ConfigPath: path}, "llm")
	if err == nil {
		t.Fatal("config_get of an invalid config succeeded")
	}
	mustNotContain(t, "error", err.Error(), "unterminated-secret-0042")
	_, err = NewGetTool(Options{ConfigPath: path}).Execute(context.Background(), map[string]any{})
	if err == nil {
		t.Fatal("config_get of an invalid config succeeded")
	}
}
