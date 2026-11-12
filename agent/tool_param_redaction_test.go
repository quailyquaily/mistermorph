package agent

import (
	"encoding/json"
	"reflect"
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

// A codemode script may pass bash_env values to todo_update, written as literals or built in any
// expression, so its source is never shown: only its size.
func TestCodeModeSourceIsWithheldFromLogsAndEvents(t *testing.T) {
	const secret = "synthetic-secret-value-0005"
	code := "const v = \"synthetic-secret\" + \"-value-0005\";\n" +
		"return await tools.todo_update({action: \"update\", id: \"r\", bash_env: [{name: \"API_TOKEN\", value: \"" + secret + "\"}]});\n"
	params := map[string]any{"code": code, "bash_env": secret}
	opts := normalizeLogOptions(DefaultLogOptions())

	display := toolDisplayArgsSummary(codeModeToolName, params, opts)
	logged := paramsAsJSON(redactToolParamValues(codeModeToolName, params), opts.MaxJSONBytes, opts.MaxStringValueChars, opts.RedactKeys)
	shown, _ := json.Marshal(display)
	for _, out := range []string{string(shown), logged} {
		if strings.Contains(out, "synthetic-secret") || strings.Contains(out, "todo_update") {
			t.Fatalf("codemode params show the source: %s", out)
		}
	}
	if display["code"] != "[withheld]" || display["code_lines"] != 2 || display["code_chars"] != len([]rune(code)) {
		t.Fatalf("display = %#v, want the withheld source and its size", display)
	}
	if params["code"] != code {
		t.Fatal("redaction changed the tool's own parameters")
	}
	if out, _ := json.Marshal(toolDisplayArgsSummary(codeModeToolName, map[string]any{"code": []any{secret}}, opts)); strings.Contains(string(out), secret) {
		t.Fatalf("malformed code shown: %s", out)
	}
}

func TestRedactToolParamsForDisplayIsIdempotentAndLeavesTheCallAlone(t *testing.T) {
	const secret = "synthetic-secret-value-0004"
	todo := map[string]any{"action": "update", "id": "report",
		"bash_env": []any{map[string]any{"name": "API_TOKEN", "value": secret}}}
	code := "const t = \"" + secret + "\";\nreturn t.length"
	script := map[string]any{"code": code}

	for name, params := range map[string]map[string]any{"todo_update": todo, "codemode": script} {
		once := RedactToolParamsForDisplay(name, params)
		twice := RedactToolParamsForDisplay(name, once)
		first, _ := json.Marshal(once)
		second, _ := json.Marshal(twice)
		if strings.Contains(string(first), secret) || string(first) != string(second) {
			t.Fatalf("%s: once = %s, twice = %s", name, first, second)
		}
		// Through JSON, as a remote tool event arrives, sizes stay the same too.
		var decoded map[string]any
		_ = json.Unmarshal(first, &decoded)
		if again, _ := json.Marshal(RedactToolParamsForDisplay(name, decoded)); string(again) != string(first) {
			t.Fatalf("%s: after JSON = %s, want %s", name, again, first)
		}
	}
	if todo["bash_env"].([]any)[0].(map[string]any)["value"] != secret || script["code"] != code {
		t.Fatal("display redaction changed the call's parameters")
	}
	if got := RedactToolParamsForDisplay("codemode", script); got["code_chars"] != len([]rune(code)) || got["code_lines"] != 2 {
		t.Fatalf("codemode display = %#v", got)
	}

	// Sizes that are not plain numbers are dropped, not shown.
	odd := RedactToolParamsForDisplay("codemode", map[string]any{"code": "[withheld]", "code_chars": secret, "code_lines": json.Number(secret)})
	if shown, _ := json.Marshal(odd); strings.Contains(string(shown), secret) || len(odd) != 1 {
		t.Fatalf("odd codemode display = %s", shown)
	}
	// Other tools pass through as they are.
	plain := map[string]any{"path": "a.txt"}
	if got := RedactToolParamsForDisplay("read_file", plain); !reflect.DeepEqual(got, plain) {
		t.Fatalf("read_file display = %#v", got)
	}
	if got := RedactToolParamsForDisplay("todo_update", nil); got != nil {
		t.Fatalf("nil params display = %#v", got)
	}
}
