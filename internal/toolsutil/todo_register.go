package toolsutil

import (
	"github.com/quailyquaily/mistermorph/internal/todo"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
	"github.com/quailyquaily/mistermorph/tools/builtin"
)

func BindTodoUpdateToolLLM(reg *tools.Registry, client llm.Client, model string) {
	if reg == nil {
		return
	}
	raw, ok := reg.Get("todo_update")
	if !ok {
		return
	}
	tool, ok := raw.(*builtin.TodoUpdateTool)
	if !ok {
		return
	}
	cloned := tool.Clone()
	if cloned == nil {
		return
	}
	cloned.BindLLM(client, model)
	reg.Register(cloned)
}

func SetTodoUpdateToolAddContext(reg *tools.Registry, ctx todo.AddResolveContext) {
	if reg == nil {
		return
	}
	raw, ok := reg.Get("todo_update")
	if !ok {
		return
	}
	tool, ok := raw.(*builtin.TodoUpdateTool)
	if !ok || tool == nil {
		return
	}
	tool.SetAddContext(ctx)
}
