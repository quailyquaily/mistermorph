package topicstate

import (
	"bytes"
	"compress/gzip"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/agentdb"
	"github.com/quailyquaily/mistermorph/internal/stateimport"
)

// Files a topic folder held before agent.db; a checkpoint, found tools and the layout stay files.
const (
	ContextFileName         = "context.json"
	ContextSnapshotFileName = "context_snapshot.json"
	ContextRequestFileName  = "context_request.json"
	WorkspaceFileName       = "workspace.json"

	// LegacyContextFile and LegacyWorkspaceFile are the shared files that came before the topic
	// folders, in the state folder.
	LegacyContextFile   = "topic_context.json"
	LegacyWorkspaceFile = "workspace_attachments.json"

	// StoredRequestLimit is the largest request, as JSON, a snapshot keeps for counting.
	StoredRequestLimit = 8 << 20
)

func init() {
	agentdb.Register(agentdb.Importer{Name: "topic_state", Order: 60, Run: importTopicState})
}

// contextItem is context.json: the fields topic_contexts has.
type contextItem struct {
	ConversationKey          string  `json:"conversation_key"`
	TopicID                  string  `json:"topic_id"`
	Runtime                  string  `json:"runtime"`
	Model                    string  `json:"model"`
	NormalizedModel          string  `json:"normalized_model"`
	ContextWindowTokens      int64   `json:"context_window_tokens"`
	ContextWindowSource      string  `json:"context_window_source"`
	UsedInputTokens          int64   `json:"used_input_tokens"`
	CachedInputTokens        int64   `json:"cached_input_tokens"`
	CacheCreationInputTokens int64   `json:"cache_creation_input_tokens"`
	UsageRatio               float64 `json:"usage_ratio"`
	LastRunID                string  `json:"last_run_id"`
	LastOriginEventID        string  `json:"last_origin_event_id"`
	UpdatedAt                string  `json:"updated_at"`
}

// snapshotHead is the part of context_snapshot.json topic_context_snapshots has columns for.
type snapshotHead struct {
	ConversationKey string `json:"conversation_key"`
	TopicID         string `json:"topic_id"`
	RunID           string `json:"run_id"`
	Model           string `json:"model"`
	CapturedAt      string `json:"captured_at"`
}

// importTopicState copies context.json, context_snapshot.json, context_request.json and
// workspace.json of every topic folder, and the older shared topic_context.json and
// workspace_attachments.json, into their tables. Rows are keyed by the conversation key, read from
// the files. A workspace.json in a folder with no other file naming its key stays in place: the
// workspace store imports it the first time it is asked for that key.
func importTopicState(ctx context.Context, tx *sql.Tx, env agentdb.ImportEnv) (agentdb.ImportResult, error) {
	var result agentdb.ImportResult
	root := filepath.Join(env.StateDir, DirName)
	entries, err := os.ReadDir(root)
	if err != nil && !os.IsNotExist(err) {
		return result, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() && !strings.HasSuffix(entry.Name(), stateimport.ImportedSuffix) {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	reject := func(rel string, err error, raw []byte) {
		result.Rejects = append(result.Rejects, stateimport.Reject{Source: rel, Error: err.Error(), Raw: string(raw)})
	}
	for _, name := range names {
		dir := filepath.Join(root, name)
		rel := func(file string) string { return filepath.ToSlash(filepath.Join(DirName, name, file)) }
		key := ""
		if raw, err := os.ReadFile(filepath.Join(dir, ContextFileName)); err == nil {
			var item contextItem
			if err := json.Unmarshal(raw, &item); err != nil || strings.TrimSpace(item.ConversationKey) == "" {
				reject(rel(ContextFileName), orMissingKey(err), raw)
			} else if err := upsertContext(ctx, tx, item, true); err != nil {
				return result, err
			} else {
				key = strings.TrimSpace(item.ConversationKey)
			}
			result.Rename = append(result.Rename, rel(ContextFileName))
		}
		if raw, err := os.ReadFile(filepath.Join(dir, ContextSnapshotFileName)); err == nil {
			var head snapshotHead
			if err := json.Unmarshal(raw, &head); err != nil || strings.TrimSpace(head.ConversationKey) == "" {
				reject(rel(ContextSnapshotFileName), orMissingKey(err), raw)
			} else {
				var request []byte
				if body, err := os.ReadFile(filepath.Join(dir, ContextRequestFileName)); err == nil && len(body) <= StoredRequestLimit {
					request, err = Gzip(body)
					if err != nil {
						return result, err
					}
				}
				if err := upsertSnapshot(ctx, tx, head, string(raw), request); err != nil {
					return result, err
				}
				if key == "" {
					key = strings.TrimSpace(head.ConversationKey)
				}
			}
			result.Rename = append(result.Rename, rel(ContextSnapshotFileName))
		}
		if _, err := os.Stat(filepath.Join(dir, ContextRequestFileName)); err == nil {
			result.Rename = append(result.Rename, rel(ContextRequestFileName))
		}
		if raw, err := os.ReadFile(filepath.Join(dir, WorkspaceFileName)); err == nil && key != "" && Key(key) == name {
			var att struct {
				WorkspaceDir string `json:"workspace_dir"`
			}
			if err := json.Unmarshal(raw, &att); err != nil || strings.TrimSpace(att.WorkspaceDir) == "" {
				reject(rel(WorkspaceFileName), orMissing(err, "workspace_dir is empty"), raw)
			} else if err := upsertWorkspace(ctx, tx, key, att.WorkspaceDir, false); err != nil {
				return result, err
			}
			result.Rename = append(result.Rename, rel(WorkspaceFileName))
		}
	}

	// The shared files: a topic folder's own row, imported above, is newer and wins.
	if raw, err := os.ReadFile(filepath.Join(env.StateDir, LegacyContextFile)); err == nil {
		var file struct {
			Items map[string]contextItem `json:"items"`
		}
		if err := json.Unmarshal(raw, &file); err != nil {
			reject(LegacyContextFile, err, raw)
		}
		for key, item := range file.Items {
			if strings.TrimSpace(item.ConversationKey) == "" {
				item.ConversationKey = key
			}
			if strings.TrimSpace(item.ConversationKey) == "" {
				continue
			}
			if err := upsertContext(ctx, tx, item, false); err != nil {
				return result, err
			}
		}
		result.Rename = append(result.Rename, LegacyContextFile)
	}
	if raw, err := os.ReadFile(filepath.Join(env.StateDir, LegacyWorkspaceFile)); err == nil {
		var file struct {
			Attachments map[string]struct {
				WorkspaceDir string `json:"workspace_dir"`
			} `json:"attachments"`
		}
		if err := json.Unmarshal(raw, &file); err != nil {
			reject(LegacyWorkspaceFile, err, raw)
		}
		for key, att := range file.Attachments {
			if strings.TrimSpace(key) == "" || strings.TrimSpace(att.WorkspaceDir) == "" {
				continue
			}
			if err := upsertWorkspace(ctx, tx, key, att.WorkspaceDir, false); err != nil {
				return result, err
			}
		}
		result.Rename = append(result.Rename, LegacyWorkspaceFile)
	}
	return result, nil
}

func orMissingKey(err error) error {
	return orMissing(err, "conversation_key is empty")
}

func orMissing(err error, msg string) error {
	if err != nil {
		return err
	}
	return fmt.Errorf("%s", msg)
}

type execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func upsertContext(ctx context.Context, db execer, item contextItem, replace bool) error {
	updatedAt := strings.TrimSpace(item.UpdatedAt)
	if updatedAt == "" {
		updatedAt = agentdb.Now()
	}
	conflict := `DO NOTHING`
	if replace {
		conflict = `DO UPDATE SET topic_id = excluded.topic_id, runtime = excluded.runtime, model = excluded.model,
			normalized_model = excluded.normalized_model, context_window_tokens = excluded.context_window_tokens,
			context_window_source = excluded.context_window_source, used_input_tokens = excluded.used_input_tokens,
			cached_input_tokens = excluded.cached_input_tokens, cache_creation_input_tokens = excluded.cache_creation_input_tokens,
			usage_ratio = excluded.usage_ratio, last_run_id = excluded.last_run_id,
			last_origin_event_id = excluded.last_origin_event_id, updated_at = excluded.updated_at`
	}
	_, err := db.ExecContext(ctx, `INSERT INTO topic_contexts (conversation_key, topic_id, runtime, model, normalized_model,
		context_window_tokens, context_window_source, used_input_tokens, cached_input_tokens, cache_creation_input_tokens,
		usage_ratio, last_run_id, last_origin_event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (conversation_key) `+conflict,
		strings.TrimSpace(item.ConversationKey), strings.TrimSpace(item.TopicID), strings.TrimSpace(item.Runtime),
		strings.TrimSpace(item.Model), strings.TrimSpace(item.NormalizedModel), item.ContextWindowTokens,
		strings.TrimSpace(item.ContextWindowSource), item.UsedInputTokens, item.CachedInputTokens,
		item.CacheCreationInputTokens, item.UsageRatio, strings.TrimSpace(item.LastRunID),
		strings.TrimSpace(item.LastOriginEventID), updatedAt)
	return err
}

func upsertSnapshot(ctx context.Context, db execer, head snapshotHead, snapshot string, request []byte) error {
	capturedAt := strings.TrimSpace(head.CapturedAt)
	if capturedAt == "" {
		capturedAt = agentdb.Now()
	}
	var requestArg any
	if request != nil {
		requestArg = request
	}
	_, err := db.ExecContext(ctx, `INSERT INTO topic_context_snapshots (conversation_key, topic_id, run_id, model, captured_at,
		snapshot, request) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (conversation_key) DO UPDATE SET topic_id = excluded.topic_id, run_id = excluded.run_id,
		model = excluded.model, captured_at = excluded.captured_at, snapshot = excluded.snapshot, request = excluded.request`,
		strings.TrimSpace(head.ConversationKey), strings.TrimSpace(head.TopicID), strings.TrimSpace(head.RunID),
		strings.TrimSpace(head.Model), capturedAt, snapshot, requestArg)
	return err
}

func upsertWorkspace(ctx context.Context, db execer, key, dir string, replace bool) error {
	conflict := `DO NOTHING`
	if replace {
		conflict = `DO UPDATE SET workspace_dir = excluded.workspace_dir, updated_at = excluded.updated_at`
	}
	_, err := db.ExecContext(ctx, `INSERT INTO workspace_attachments (scope_key, workspace_dir, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (scope_key) `+conflict, strings.TrimSpace(key), strings.TrimSpace(dir), agentdb.Now())
	return err
}

// ImportFolderWorkspace imports the workspace.json in the topic folder of scopeKey, if it is still
// there, and renames it workspace.json.imported. It is how an attachment whose folder held nothing
// else naming its key reaches agent.db. It reports the imported folder, "" when there was none.
func ImportFolderWorkspace(ctx context.Context, db *agentdb.DB, scopeKey string) (string, error) {
	scopeKey = strings.TrimSpace(scopeKey)
	if db == nil || scopeKey == "" {
		return "", nil
	}
	path := filepath.Join(db.StateDir(), DirName, Key(scopeKey), WorkspaceFileName)
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	var att struct {
		WorkspaceDir string `json:"workspace_dir"`
	}
	if err := json.Unmarshal(raw, &att); err != nil || strings.TrimSpace(att.WorkspaceDir) == "" {
		return "", nil
	}
	if err := upsertWorkspace(ctx, db, scopeKey, att.WorkspaceDir, false); err != nil {
		return "", err
	}
	if _, err := os.Stat(path + stateimport.ImportedSuffix); os.IsNotExist(err) {
		_ = os.Rename(path, path+stateimport.ImportedSuffix)
	}
	return strings.TrimSpace(att.WorkspaceDir), nil
}

// RemoveRows deletes a conversation's rows in all three topic tables, in one transaction.
func RemoveRows(ctx context.Context, db *agentdb.DB, conversationKey string) error {
	conversationKey = strings.TrimSpace(conversationKey)
	if db == nil || conversationKey == "" {
		return nil
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, query := range []string{
		`DELETE FROM topic_contexts WHERE conversation_key = ?`,
		`DELETE FROM topic_context_snapshots WHERE conversation_key = ?`,
		`DELETE FROM workspace_attachments WHERE scope_key = ?`,
	} {
		if _, err := tx.ExecContext(ctx, query, conversationKey); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Gzip compresses data.
func Gzip(data []byte) ([]byte, error) {
	var buf bytes.Buffer
	writer := gzip.NewWriter(&buf)
	if _, err := writer.Write(data); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// Gunzip decompresses data, refusing more than limit bytes.
func Gunzip(data []byte, limit int64) ([]byte, error) {
	reader, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer func() { _ = reader.Close() }()
	out, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(out)) > limit {
		return nil, fmt.Errorf("stored request is over %d bytes", limit)
	}
	return out, nil
}
