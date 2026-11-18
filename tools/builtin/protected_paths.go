package builtin

import (
	"strings"

	"github.com/quailyquaily/mistermorph/internal/statepaths"
)

// protectedStateFiles are denied to read_file, send_file, bash and powershell whatever their
// deny_paths say. They are the files the agent keeps its own secrets in: agent.db (LLM API keys,
// auth and endpoint tokens, and the job list with the literal values of its bash_env), jobs.db (the
// job store of an earlier build, left in the state folder) and config.yaml.imported (the config
// file agent.db imported, renamed). A deny list written out before one of them existed, as older
// config templates did, still covers it.
var protectedStateFiles = []string{
	statepaths.AgentDBFilename,
	statepaths.JobsDBFilename,
	"config.yaml.imported",
}

// sqliteSidecarSuffixes name the files SQLite keeps beside a database: the write-ahead log (recent
// commits not yet checkpointed into the database), its index, and a rollback journal. They hold
// the database's data, so a denied file's sidecars are denied with it.
var sqliteSidecarSuffixes = []string{"-wal", "-shm", "-journal"}

// EffectiveDenyPaths is the deny list a tool applies for its configured deny_paths: the entries
// configured, the protected state files, and the SQLite sidecar files of each of them.
func EffectiveDenyPaths(configured []string) []string {
	out := make([]string, 0, (len(configured)+len(protectedStateFiles))*(1+len(sqliteSidecarSuffixes)))
	seen := map[string]bool{}
	add := func(entry string) {
		if entry == "" || seen[entry] {
			return
		}
		seen[entry] = true
		out = append(out, entry)
	}
	entries := make([]string, 0, len(configured)+len(protectedStateFiles))
	for _, entry := range configured {
		if entry = strings.TrimSpace(entry); entry != "" {
			entries = append(entries, entry)
		}
	}
	entries = append(entries, protectedStateFiles...)
	for _, entry := range entries {
		add(entry)
	}
	for _, entry := range entries {
		trimmed := strings.TrimRight(entry, `/\`)
		if trimmed == "" {
			continue
		}
		for _, suffix := range sqliteSidecarSuffixes {
			add(trimmed + suffix)
		}
	}
	return out
}
