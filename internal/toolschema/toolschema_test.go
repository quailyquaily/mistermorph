package toolschema

import (
	"encoding/json"
	"testing"
)

func TestBuildListsEveryToolOnTheToolsPage(t *testing.T) {
	catalog := Build()
	for _, name := range []string{
		"read_file", "write_file", "bash", "powershell", "url_fetch", "web_search",
		"plan_create", "todo_update", "codemode", "tool_search", "spawn", "coder",
		"contacts_send", "agent_send", "image_generate", "image_edit",
	} {
		tool, ok := catalog.Tools[name]
		if !ok {
			t.Errorf("tool %s missing", name)
			continue
		}
		checkTool(t, tool)
	}
	channels := map[string][]string{
		"console":  {"skill_install_preview", "skill_install"},
		"telegram": {"telegram_send_file", "telegram_send_photo", "telegram_send_voice", "message_react"},
		"slack":    {"slack_send_file", "message_react"},
		"lark":     {"lark_send_file", "lark_send_photo", "lark_send_voice", "message_react"},
		"discord":  {"discord_send_file", "message_react"},
		"mixin":    {"mixin_send_file", "mixin_send_photo", "mixin_send_audio"},
		"wechat":   {"wechat_send_file"},
		"whatsapp": {"whatsapp_send_file"},
	}
	for channel, names := range channels {
		got := catalog.Channels[channel]
		if len(got) != len(names) {
			t.Errorf("%s tools = %d, want %d", channel, len(got), len(names))
			continue
		}
		for i, name := range names {
			if got[i].Name != name {
				t.Errorf("%s tool %d = %s, want %s", channel, i, got[i].Name, name)
			}
			checkTool(t, got[i])
		}
	}
}

func checkTool(t *testing.T, tool Tool) {
	t.Helper()
	if tool.Description == "" {
		t.Errorf("%s has no description", tool.Name)
	}
	var schema map[string]any
	if err := json.Unmarshal(tool.Parameters, &schema); err != nil || schema["type"] != "object" {
		t.Errorf("%s schema = %s (%v)", tool.Name, tool.Parameters, err)
	}
}
