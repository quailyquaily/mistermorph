package toolsutil

import (
	"strings"

	"github.com/quailyquaily/mistermorph/internal/imagesession"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
	"github.com/quailyquaily/mistermorph/tools/builtin"
	"github.com/spf13/viper"
)

type RuntimeToolsRegisterConfig struct {
	PlanCreate PlanCreateRegisterConfig
	TodoUpdate TodoUpdateRegisterConfig
	Image      ImageToolsRegisterConfig
	ToolSearch ToolSearchConfig
}

// ToolSearchConfig is tools.tool_search: when enabled, MCP tools stay hidden until the model
// finds them with tool_search, except AlwaysLoaded.
type ToolSearchConfig struct {
	Enabled      bool
	AlwaysLoaded []string
}

type runtimeRegisterConfigReader interface {
	GetBool(string) bool
	GetInt(string) int
	GetString(string) string
	GetStringSlice(string) []string
	IsSet(string) bool
}

type RuntimeToolLLMOptions struct {
	DefaultClient    llm.Client
	DefaultModel     string
	PlanCreateClient llm.Client
	PlanCreateModel  string
	ImageClient      llm.ImageClient
	ImageSession     *imagesession.Store
	ImageScope       imagesession.Scope
	ImageRetained    bool
	ToolTriggers     map[string]bool
	PersonaDir       string
	// DecisionClient, when set, is the decision route's own client, for structured judgments
	// such as matching a TODO to delete.
	DecisionClient llm.Client
	DecisionModel  string
}

func LoadRuntimeToolsRegisterConfigFromViper() RuntimeToolsRegisterConfig {
	return LoadRuntimeToolsRegisterConfigFromReader(viper.GetViper())
}

func LoadRuntimeToolsRegisterConfigFromReader(r runtimeRegisterConfigReader) RuntimeToolsRegisterConfig {
	return RuntimeToolsRegisterConfig{
		PlanCreate: LoadPlanCreateRegisterConfigFromReader(r),
		TodoUpdate: LoadTodoUpdateRegisterConfigFromReader(r),
		Image:      LoadImageToolsRegisterConfigFromReader(r),
		ToolSearch: ToolSearchConfig{
			Enabled:      r.GetBool("tools.tool_search.enabled"),
			AlwaysLoaded: normalizeToolNames(r.GetStringSlice("tools.tool_search.always_loaded")),
		},
	}
}

func normalizeToolNames(names []string) []string {
	out := make([]string, 0, len(names))
	seen := make(map[string]bool, len(names))
	for _, name := range names {
		if name = strings.TrimSpace(name); name != "" && !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	return out
}

func RegisterRuntimeTools(reg *tools.Registry, cfg RuntimeToolsRegisterConfig, opts RuntimeToolLLMOptions) {
	if reg == nil {
		return
	}
	planClient := opts.PlanCreateClient
	if planClient == nil {
		planClient = opts.DefaultClient
	}
	planModel := opts.PlanCreateModel
	if strings.TrimSpace(planModel) == "" {
		planModel = strings.TrimSpace(opts.DefaultModel)
	}
	if opts.ToolTriggers[BuiltinPlanCreate] {
		cfg.PlanCreate.Enabled = true
	}
	if opts.ToolTriggers[BuiltinTodoUpdate] {
		cfg.TodoUpdate.Enabled = true
	}
	imageCfg := cfg.Image
	if opts.ToolTriggers[BuiltinImageGenerate] {
		imageCfg.GenerateEnabled = true
	}
	if opts.ToolTriggers[BuiltinImageEdit] {
		imageCfg.EditEnabled = true
	}
	if strings.TrimSpace(imageCfg.Model) == "" {
		imageCfg.Model = strings.TrimSpace(opts.DefaultModel)
	}
	imageCfg.SessionStore = opts.ImageSession
	imageCfg.SessionScope = opts.ImageScope
	imageTriggered := opts.ImageRetained ||
		opts.ToolTriggers[BuiltinImageGenerate] ||
		opts.ToolTriggers[BuiltinImageEdit]
	RegisterImageTools(reg, imageCfg, opts.ImageClient, imageTriggered)
	RegisterPlanTool(reg, cfg.PlanCreate, planClient, planModel, opts.PersonaDir)
	RegisterTodoUpdateTool(reg, cfg.TodoUpdate, opts.DefaultClient, opts.DefaultModel)
	if opts.DecisionClient != nil {
		if tool, ok := reg.Get(BuiltinTodoUpdate); ok {
			if todoTool, ok := tool.(*builtin.TodoUpdateTool); ok {
				todoTool.DecisionClient = opts.DecisionClient
				todoTool.DecisionModel = opts.DecisionModel
			}
		}
	}
}
