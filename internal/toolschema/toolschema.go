// Package toolschema lists the built-in tools' names, descriptions and parameter schemas for the
// Console's Tools settings page. Each tool is built with empty dependencies only to read these;
// nothing here can run a tool.
package toolschema

import (
	"encoding/json"
	"strings"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/skillinstall"
	"github.com/quailyquaily/mistermorph/tools"
	dmtools "github.com/quailyquaily/mistermorph/tools/accountdm"
	"github.com/quailyquaily/mistermorph/tools/builtin"
	discordtools "github.com/quailyquaily/mistermorph/tools/discord"
	larktools "github.com/quailyquaily/mistermorph/tools/lark"
	mixintools "github.com/quailyquaily/mistermorph/tools/mixin"
	slacktools "github.com/quailyquaily/mistermorph/tools/slack"
	telegramtools "github.com/quailyquaily/mistermorph/tools/telegram"
)

// Tool is one tool as the model sees it.
type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

// Catalog is every built-in tool. Channel tools are listed per channel, since one name (such as
// message_react) can take different parameters in different channels.
type Catalog struct {
	Tools    map[string]Tool   `json:"tools"`
	Channels map[string][]Tool `json:"channels"`
}

// Build lists the built-in tools.
func Build() Catalog {
	var roots pathroots.PathRoots
	general := []tools.Tool{
		builtin.NewReadFileTool(0),
		builtin.NewWriteFileTool(true, 0, roots),
		builtin.NewBashTool(true, 0, 0, roots),
		builtin.NewPowerShellTool(true, 0, 0, roots),
		builtin.NewURLFetchTool(true, 0, 0, "", ""),
		builtin.NewWebSearchTool(true, "", 0, 0, ""),
		builtin.NewContactsSendTool(builtin.ContactsSendToolOptions{}),
		builtin.NewAgentSendTool(builtin.ContactsSendToolOptions{}),
		builtin.NewTodoUpdateTool(true, "", ""),
		builtin.NewPlanCreateTool(nil, "", nil, 0),
		builtin.NewImageGenerateTool(builtin.ImageToolConfig{}),
		builtin.NewImageEditTool(builtin.ImageToolConfig{}),
	}
	general = append(general, agent.EngineTools()...)

	preview, install := skillinstall.NewTools(skillinstall.ToolDeps{})
	channels := map[string][]tools.Tool{
		"console": {preview, install},
		"telegram": {
			telegramtools.NewSendFileTool(nil, 0, 0, "", 0),
			telegramtools.NewSendPhotoTool(nil, 0, 0, "", 0),
			telegramtools.NewSendVoiceTool(nil, 0, 0, "", 0, nil),
			telegramtools.NewReactTool(nil, 0, 0, nil),
		},
		"slack": {
			slacktools.NewSendFileTool(nil, "", "", nil, "", 0),
			slacktools.NewReactTool(nil, "", "", nil, nil),
		},
		"lark": {
			larktools.NewSendFileTool(nil, "", "", 0),
			larktools.NewSendPhotoTool(nil, "", "", 0),
			larktools.NewSendVoiceTool(nil, "", "", 0),
			larktools.NewReactTool(nil, ""),
		},
		"discord": {
			discordtools.NewSendFileTool(nil, "", "", "", 0),
			discordtools.NewReactTool(nil, "", ""),
		},
		"mixin": {
			mixintools.NewSendAttachmentTool(nil, "", "", "", 0, mixintools.AttachmentFile),
			mixintools.NewSendAttachmentTool(nil, "", "", "", 0, mixintools.AttachmentPhoto),
			mixintools.NewSendAttachmentTool(nil, "", "", "", 0, mixintools.AttachmentAudio),
		},
		"wechat":   {dmtools.NewSendFileTool("wechat", "WeChat", nil, "", 0)},
		"whatsapp": {dmtools.NewSendFileTool("whatsapp", "WhatsApp", nil, "", 0)},
	}

	out := Catalog{Tools: map[string]Tool{}, Channels: map[string][]Tool{}}
	for _, tool := range general {
		out.Tools[tool.Name()] = describe(tool)
	}
	for channel, list := range channels {
		for _, tool := range list {
			out.Channels[channel] = append(out.Channels[channel], describe(tool))
		}
	}
	return out
}

func describe(tool tools.Tool) Tool {
	schema := json.RawMessage(strings.TrimSpace(tool.ParameterSchema()))
	if !json.Valid(schema) {
		schema = json.RawMessage(`{}`)
	}
	return Tool{Name: tool.Name(), Description: strings.TrimSpace(tool.Description()), Parameters: schema}
}
