package statepaths

import (
	"path/filepath"

	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/spf13/viper"
)

const (
	HeartbeatChecklistFilename = "HEARTBEAT.md"
	CronFilename               = "cron.yaml"
	JournalDirName             = "journal"
	MemoryDBFilename           = "memory.db"
	// AgentDBFilename is the database for the agent's own state: config, persona, contacts,
	// Console sessions, Agent Link peers and topic state.
	AgentDBFilename = "agent.db"
	// JobsDBFilename is the job store: the TODO list's jobs, which the scheduler, the Console and
	// the tools share. It replaces cron.yaml (and the cron_tasks table agent.db had).
	JobsDBFilename = "jobs.db"
	// UsageDBFilename is the database for LLM usage, written on every model call.
	UsageDBFilename  = "usage.db"
	PersonaDirName   = "persona"
	IdentityFilename = "identity.yaml"
	SoulFilename     = "soul.md"
	AvatarFilename   = "avatar.webp"
)

func FileStateDir() string {
	return pathutil.ResolveStateDir(viper.GetString("file_state_dir"))
}

func SkillsDir() string {
	return pathutil.ResolveStateChildDir(
		viper.GetString("file_state_dir"),
		viper.GetString("skills.dir_name"),
		"skills",
	)
}

func PersonaDir() string {
	return filepath.Clean(filepath.Join(FileStateDir(), PersonaDirName))
}

func PersonaIdentityPath() string {
	return filepath.Clean(filepath.Join(PersonaDir(), IdentityFilename))
}

func PersonaSoulPath() string {
	return filepath.Clean(filepath.Join(PersonaDir(), SoulFilename))
}

func JournalDir() string {
	return filepath.Clean(filepath.Join(FileStateDir(), JournalDirName))
}

// MemoryDBPath is the SQLite database for memories and their reminder counts. The journal has its own.
func MemoryDBPath() string {
	return filepath.Clean(filepath.Join(FileStateDir(), MemoryDBFilename))
}

// AgentDBPath is the SQLite database for the agent's own state.
func AgentDBPath() string {
	return filepath.Clean(filepath.Join(FileStateDir(), AgentDBFilename))
}

// UsageDBPath is the SQLite database for LLM usage.
func UsageDBPath() string {
	return filepath.Clean(filepath.Join(FileStateDir(), UsageDBFilename))
}

func LLMUsageJournalDir() string {
	return filepath.Clean(filepath.Join(FileStateDir(), "stats", "llm_usage"))
}

func HeartbeatChecklistPath() string {
	return pathutil.ResolveStateFile(viper.GetString("file_state_dir"), HeartbeatChecklistFilename)
}

func TopicContextPath() string {
	return pathutil.ResolveStateFile(viper.GetString("file_state_dir"), "topic_context.json")
}

func DefaultSkillsRoots() []string {
	return []string{SkillsDir()}
}
