package toolsutil

import (
	"strings"

	"github.com/quailyquaily/mistermorph/internal/jobconfig"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"github.com/quailyquaily/mistermorph/internal/todo"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
	"github.com/quailyquaily/mistermorph/tools/builtin"
)

type JobManageRegisterConfig struct {
	Enabled  bool
	CronPath string
	// StateDir is the state folder whose agent.db keeps the contacts of ContactsDir.
	StateDir    string
	ContactsDir string
}

type todoRegisterConfigReader interface {
	GetBool(string) bool
	GetString(string) string
	IsSet(string) bool
}

func BuildJobManageRegisterConfig(enabled bool, fileStateDir, contactsDirName string) JobManageRegisterConfig {
	fileStateDir = strings.TrimSpace(fileStateDir)
	return JobManageRegisterConfig{
		Enabled:     enabled,
		CronPath:    pathutil.ResolveStateFile(fileStateDir, statepaths.CronFilename),
		StateDir:    pathutil.ResolveStateDir(fileStateDir),
		ContactsDir: pathutil.ResolveStateChildDir(fileStateDir, strings.TrimSpace(contactsDirName), "contacts"),
	}
}

func LoadJobManageRegisterConfigFromReader(r todoRegisterConfigReader) JobManageRegisterConfig {
	if r == nil {
		return BuildJobManageRegisterConfig(false, "", "")
	}
	return BuildJobManageRegisterConfig(
		jobconfig.ToolEnabled(r),
		r.GetString("file_state_dir"),
		r.GetString("contacts.dir_name"),
	)
}

func RegisterJobManageTool(reg *tools.Registry, cfg JobManageRegisterConfig, client llm.Client, model string) {
	if reg == nil {
		return
	}
	if !cfg.Enabled {
		return
	}
	tool := builtin.NewJobManageToolWithLLM(
		true,
		cfg.CronPath,
		cfg.ContactsDir,
		client,
		model,
	)
	tool.StateDir = strings.TrimSpace(cfg.StateDir)
	_ = reg.Replace(tool)
}

func SetJobManageToolAddContext(reg *tools.Registry, ctx todo.AddResolveContext) {
	if reg == nil {
		return
	}
	raw, ok := reg.Get(BuiltinJobManage)
	if !ok {
		return
	}
	tool, ok := raw.(*builtin.JobManageTool)
	if !ok || tool == nil {
		return
	}
	tool.SetAddContext(ctx)
}
