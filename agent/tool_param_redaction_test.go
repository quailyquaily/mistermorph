package agent

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestTodoUpdateBashEnvValuesAreRedactedFromLogsAndEvents(t *testing.T) {
	const secret = "synthetic-secret-value-0003"
	var params map[string]any
	if err := json.Unmarshal([]byte(`{"action":"update","id":"report","content":"Edited",
		"bash_env":[{"name":"API_TOKEN","value":"`+secret+`"},{"name":"MODE","value":"weekly"}]}`), &params); err != nil {
		t.Fatal(err)
	}
	opts := normalizeLogOptions(DefaultLogOptions())

	display := toolDisplayArgsSummary("todo_update", params, opts)
	shown, _ := json.Marshal(display)
	if strings.Contains(string(shown), secret) || strings.Contains(string(shown), "weekly") {
		t.Fatalf("display args show a bash_env value: %s", shown)
	}
	if !strings.Contains(string(shown), "API_TOKEN") || !strings.Contains(string(shown), "Edited") {
		t.Fatalf("display args lost the names or other fields: %s", shown)
	}
	logged := paramsAsJSON(redactToolParamValues("todo_update", params), opts.MaxJSONBytes, opts.MaxStringValueChars, opts.RedactKeys)
	if strings.Contains(logged, secret) || !strings.Contains(logged, "MODE") {
		t.Fatalf("logged params = %s", logged)
	}
	// The call itself is left as the model made it.
	if params["bash_env"].([]any)[0].(map[string]any)["value"] != secret {
		t.Fatal("redaction changed the tool's own parameters")
	}

	// An unexpected shape shows nothing of bash_env.
	odd := map[string]any{"action": "update", "bash_env": "API_TOKEN=" + secret}
	if out, _ := json.Marshal(toolDisplayArgsSummary("todo_update", odd, opts)); strings.Contains(string(out), secret) {
		t.Fatalf("odd bash_env shown: %s", out)
	}
	// Other tools are untouched.
	other := map[string]any{"bash_env": []any{map[string]any{"name": "A", "value": "kept"}}}
	if out, _ := json.Marshal(toolDisplayArgsSummary("some_tool", other, opts)); !strings.Contains(string(out), "kept") {
		t.Fatalf("another tool's params redacted: %s", out)
	}
}
