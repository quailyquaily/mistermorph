package personastore

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"

	"github.com/quailyquaily/mistermorph/internal/agentdb"
	"github.com/quailyquaily/mistermorph/internal/stateimport"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
)

func init() {
	agentdb.Register(agentdb.Importer{Name: "persona", Order: 10, Run: importPersona})
	agentdb.Register(agentdb.Importer{Name: "heartbeat", Order: 20, Run: importHeartbeat})
}

var (
	identityFile  = filepath.ToSlash(filepath.Join(statepaths.PersonaDirName, statepaths.IdentityFilename))
	soulFile      = filepath.ToSlash(filepath.Join(statepaths.PersonaDirName, statepaths.SoulFilename))
	heartbeatFile = statepaths.HeartbeatChecklistFilename
)

// importPersona reads persona/identity.yaml and persona/soul.md into the identity row. An
// identity.yaml that does not parse is listed as a reject and kept, and the soul is still
// imported.
func importPersona(ctx context.Context, tx *sql.Tx, env agentdb.ImportEnv) (agentdb.ImportResult, error) {
	var result agentdb.ImportResult
	identityRaw, identityErr := os.ReadFile(filepath.Join(env.StateDir, filepath.FromSlash(identityFile)))
	soulRaw, soulErr := os.ReadFile(filepath.Join(env.StateDir, filepath.FromSlash(soulFile)))
	if os.IsNotExist(identityErr) && os.IsNotExist(soulErr) {
		return result, nil
	}
	if identityErr != nil && !os.IsNotExist(identityErr) {
		return result, identityErr
	}
	if soulErr != nil && !os.IsNotExist(soulErr) {
		return result, soulErr
	}
	id := Identity{NameAlts: []string{}, Extra: Extra{}}
	write := soulErr == nil
	if identityErr == nil {
		parsed, err := ParseIdentityYAML(string(identityRaw))
		if err != nil {
			result.Rejects = append(result.Rejects, stateimport.Reject{Source: identityFile, Error: err.Error(), Raw: string(identityRaw)})
		} else {
			id = parsed
			write = true
			result.Rename = append(result.Rename, identityFile)
		}
	}
	if soulErr == nil {
		id.Soul = ParseSoul(string(soulRaw))
		result.Rename = append(result.Rename, soulFile)
	}
	// A rejected identity.yaml with no soul leaves no row, so the identity is still missing.
	if !write {
		return result, nil
	}
	if err := writeIdentity(ctx, tx, id, ByImport); err != nil {
		return result, err
	}
	return result, nil
}

// importHeartbeat reads HEARTBEAT.md into heartbeat_workflows.
func importHeartbeat(ctx context.Context, tx *sql.Tx, env agentdb.ImportEnv) (agentdb.ImportResult, error) {
	var result agentdb.ImportResult
	raw, err := os.ReadFile(filepath.Join(env.StateDir, heartbeatFile))
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	if err := replaceWorkflows(ctx, tx, ParseChecklist(string(raw))); err != nil {
		return result, err
	}
	result.Rename = append(result.Rename, heartbeatFile)
	return result, nil
}
