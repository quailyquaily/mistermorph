package toolsutil

import (
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
	"github.com/quailyquaily/mistermorph/tools/builtin"
	"github.com/spf13/viper"
)

func RegisterPlanTool(reg *tools.Registry, client llm.Client, defaultModel string) {
	if reg == nil {
		return
	}
	enabled := true
	if viper.IsSet("tools.plan_create.enabled") {
		enabled = viper.GetBool("tools.plan_create.enabled")
	}
	if !enabled {
		return
	}
	names := toolNames(reg)
	names = append(names, "plan_create")
	defaultMaxSteps := viper.GetInt("plan.max_steps")
	if defaultMaxSteps <= 0 {
		defaultMaxSteps = 6
	}
	reg.Register(builtin.NewPlanCreateTool(client, defaultModel, names, defaultMaxSteps))
}

func toolNames(reg *tools.Registry) []string {
	all := reg.All()
	out := make([]string, 0, len(all))
	for _, t := range all {
		out = append(out, t.Name())
	}
	return out
}
