// Package configstore is where the config is kept: a YAML file named with --config, or the config
// tables of agent.db. Every writer of the config goes through it.
//
// Both backends speak YAML documents, so the code that edits the config (the Console's settings,
// the model, route and MCP editors, logins, install) keeps editing a document. The agent.db
// backend renders the document from its rows, in config.example.yaml's order, and saves one by
// changing only the rows that differ, in one transaction. Values are kept as written: ${VAR} and
// secret references are expanded when the config is read, as the file's were.
//
// The agent.db config is named by a path like a file's, <state>/agent.db#config.yaml, so the code
// that resolves paths relative to the config (a pricing file, a keystore) finds them in the state
// folder. Importing a config file from another folder makes its relative ones absolute, so they
// keep naming the files beside it.
package configstore

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"sort"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/agentdb"
	"github.com/quailyquaily/mistermorph/internal/fsstore"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
	"github.com/quailyquaily/mistermorph/internal/stateimport"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"gopkg.in/yaml.v3"
)

// DBConfigName is the name of the agent.db config, as a file in the state folder.
const DBConfigName = statepaths.AgentDBFilename + "#config.yaml"

// Who saved a row, in updated_by.
const (
	ByConsole = "console"
	ByCLI     = "cli"
	ByImport  = "import"
	ByInstall = "install"
	ByLogin   = "login"
)

const savedKey = "config_saved_at"

// revisionKey counts the config's saves. config_saved_at is to the second, so two saves in one
// second would look the same to a watcher; the count never does.
const revisionKey = "config_revision"

// DBConfigPath is the agent.db config of the state folder.
func DBConfigPath(stateDir string) string {
	return filepath.Join(filepath.Clean(strings.TrimSpace(stateDir)), DBConfigName)
}

// IsDBConfigPath reports whether path names an agent.db config.
func IsDBConfigPath(path string) bool {
	return filepath.Base(strings.TrimSpace(path)) == DBConfigName
}

// Source says which config path names, for the Console's settings page: "agent_db" or "file".
func Source(path string) string {
	if IsDBConfigPath(path) {
		return "agent_db"
	}
	return "file"
}

func dbFor(ctx context.Context, path string) (*agentdb.DB, error) {
	return agentdb.CachedBeside(path).GetWithoutImports(ctx)
}

// ReadFile returns the config at path as YAML. A missing file, or an agent.db that holds no
// config yet, is an error that os.IsNotExist reports.
func ReadFile(path string) ([]byte, error) {
	if !IsDBConfigPath(path) {
		return os.ReadFile(path)
	}
	ctx := context.Background()
	db, err := dbFor(ctx, path)
	if err != nil {
		return nil, err
	}
	var rows Rows
	saved := false
	if err := readTx(ctx, db, func(q queryer) error {
		if saved, err = hasConfig(ctx, q); err != nil || !saved {
			return err
		}
		rows, err = loadRows(ctx, q)
		return err
	}); err != nil {
		return nil, err
	}
	if !saved {
		return nil, &fs.PathError{Op: "open", Path: path, Err: fs.ErrNotExist}
	}
	return rows.render()
}

// readTx runs fn in one read transaction, so the config's tables are read as one save left them,
// never half of one save and half of the next. A read-only transaction begins deferred: it does
// not take the write lock, and its snapshot is the database at its first read.
func readTx(ctx context.Context, db *agentdb.DB, fn func(q queryer) error) error {
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// Exists reports whether the config at path is there.
func Exists(path string) (bool, error) {
	if !IsDBConfigPath(path) {
		_, err := os.Stat(path)
		if err == nil {
			return true, nil
		}
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	ctx := context.Background()
	db, err := dbFor(ctx, path)
	if err != nil {
		return false, err
	}
	return hasConfig(ctx, db)
}

// Revision identifies the config's current version, so a watcher can tell a save happened. For a
// file it is a hash of its content; for agent.db, which writes through its WAL and so leaves its
// own file's time alone, it is the count of saves and the last save's time. It is "" when there is
// no config.
func Revision(path string) (string, error) {
	if !IsDBConfigPath(path) {
		data, err := os.ReadFile(path)
		if err != nil {
			if os.IsNotExist(err) {
				return "", nil
			}
			return "", err
		}
		sum := sha256.Sum256(data)
		return "file:" + hex.EncodeToString(sum[:]), nil
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(path), statepaths.AgentDBFilename)); os.IsNotExist(err) {
		return "", nil
	}
	ctx := context.Background()
	db, err := dbFor(ctx, path)
	if err != nil {
		return "", err
	}
	var saved, count string
	err = db.QueryRowContext(ctx, `SELECT
		COALESCE((SELECT value FROM meta WHERE key = ?), ''),
		COALESCE((SELECT value FROM meta WHERE key = ?), '')`, savedKey, revisionKey).Scan(&saved, &count)
	if err != nil {
		return "", err
	}
	if saved == "" {
		return "", nil
	}
	return "db:" + count + ":" + saved, nil
}

// WriteFile replaces the config at path with the YAML document data. A file is written
// atomically, owner-only; agent.db changes only the rows that differ, in one transaction.
func WriteFile(path string, data []byte) error {
	return WriteFileBy(path, data, ByConsole)
}

// WriteFileBy is WriteFile naming who saved, for agent.db's updated_by.
func WriteFileBy(path string, data []byte, by string) error {
	if !IsDBConfigPath(path) {
		return fsstore.WriteTextAtomic(path, string(data), fsstore.FileOptions{DirPerm: 0o755, FilePerm: 0o600})
	}
	rows, err := parseDocument(data)
	if err != nil {
		return err
	}
	// A whole document (an import, the install template, a login's rewrite) keeps what agent.db can
	// keep and leaves file_state_dir, as documented. Edits of one value (the Console's settings,
	// morph config set and edit) call CheckBootstrapKeys first, so a change is refused, not dropped.
	rows = dropBootstrapKeys(rows)
	ctx := context.Background()
	db, err := dbFor(ctx, path)
	if err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := saveRows(ctx, tx, rows, by); err != nil {
		return err
	}
	return tx.Commit()
}

func hasConfig(ctx context.Context, q queryer) (bool, error) {
	var found bool
	err := q.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM meta WHERE key = ?)`, savedKey).Scan(&found)
	return found, err
}

type queryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func columnNames(cols []column) []string {
	out := make([]string, 0, len(cols))
	for _, c := range cols {
		out = append(out, c.name)
	}
	return out
}

func loadItems(ctx context.Context, q queryer, table string, cols []string, hasPosition bool) ([]itemRow, error) {
	selectCols := append([]string{"name"}, cols...)
	if hasPosition {
		selectCols = append(selectCols, "position")
	}
	rows, err := q.QueryContext(ctx, `SELECT `+strings.Join(selectCols, ", ")+` FROM `+table+` ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []itemRow
	for rows.Next() {
		values := make([]any, len(selectCols))
		dest := make([]any, len(selectCols))
		for i := range values {
			dest[i] = &values[i]
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		item := itemRow{Name: fmt.Sprint(values[0]), Cols: map[string]any{}}
		for i, col := range cols {
			item.Cols[col] = normalizeSQLValue(values[i+1])
		}
		if hasPosition {
			if p, ok := values[len(values)-1].(int64); ok {
				item.Position = int(p)
			}
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func normalizeSQLValue(v any) any {
	switch x := v.(type) {
	case []byte:
		return string(x)
	default:
		return x
	}
}

func loadRows(ctx context.Context, q queryer) (Rows, error) {
	var r Rows
	rows, err := q.QueryContext(ctx, `SELECT path, kind, value FROM settings ORDER BY path`)
	if err != nil {
		return r, err
	}
	for rows.Next() {
		var s settingRow
		if err := rows.Scan(&s.Path, &s.Kind, &s.Value); err != nil {
			_ = rows.Close()
			return r, err
		}
		r.Settings = append(r.Settings, s)
	}
	if err := rows.Close(); err != nil {
		return r, err
	}
	profileCols := append(columnNames(profileColumns), "provider_options")
	if r.Profiles, err = loadItems(ctx, q, "llm_profiles", profileCols, true); err != nil {
		return r, err
	}
	mcpCols := columnNames(mcpColumns)
	if r.MCP, err = loadItems(ctx, q, "mcp_servers", mcpCols, true); err != nil {
		return r, err
	}
	if r.Endpoints, err = loadItems(ctx, q, "console_endpoints", columnNames(endpointColumns), true); err != nil {
		return r, err
	}
	routeRows, err := q.QueryContext(ctx, `SELECT purpose, profile, fallback_profiles FROM llm_routes ORDER BY purpose`)
	if err != nil {
		return r, err
	}
	for routeRows.Next() {
		var route routeRow
		if err := routeRows.Scan(&route.Purpose, &route.Profile, &route.Fallbacks); err != nil {
			_ = routeRows.Close()
			return r, err
		}
		r.Routes = append(r.Routes, route)
	}
	if err := routeRows.Close(); err != nil {
		return r, err
	}
	for i := range r.Routes {
		crows, err := q.QueryContext(ctx, `SELECT profile, weight FROM llm_route_candidates WHERE purpose = ? ORDER BY position`, r.Routes[i].Purpose)
		if err != nil {
			return r, err
		}
		for crows.Next() {
			var c candidateRow
			if err := crows.Scan(&c.Profile, &c.Weight); err != nil {
				_ = crows.Close()
				return r, err
			}
			r.Routes[i].Candidates = append(r.Routes[i].Candidates, c)
		}
		if err := crows.Close(); err != nil {
			return r, err
		}
	}
	arows, err := q.QueryContext(ctx, `SELECT name, credential_kind, credential_secret, allow, bindings FROM auth_profiles ORDER BY name`)
	if err != nil {
		return r, err
	}
	for arows.Next() {
		var a authRow
		if err := arows.Scan(&a.Name, &a.Kind, &a.Secret, &a.Allow, &a.Bindings); err != nil {
			_ = arows.Close()
			return r, err
		}
		r.Auth = append(r.Auth, a)
	}
	return r, arows.Close()
}

// itemDefaults are what a column holds when the document says nothing.
func itemDefaults(cols []column) map[string]any {
	out := map[string]any{}
	for _, c := range cols {
		switch c.typ {
		case colText:
			out[c.name] = ""
			if c.name == "type" {
				out[c.name] = "stdio"
			}
		case colBool:
			out[c.name] = c.def
		case colBoolNull, colIntNull, colRealNull:
			out[c.name] = nil
		case colJSONList:
			out[c.name] = "[]"
		case colJSONMap:
			out[c.name] = "{}"
		}
	}
	return out
}

func withDefaults(item itemRow, cols []column, extra map[string]any) itemRow {
	full := itemDefaults(cols)
	for k, v := range extra {
		full[k] = v
	}
	for k, v := range item.Cols {
		full[k] = v
	}
	item.Cols = full
	return item
}

// saveItems makes table hold exactly items, updating only the rows that differ.
func saveItems(ctx context.Context, q queryer, table string, cols []string, items, current []itemRow, now, by string) error {
	have := map[string]itemRow{}
	for _, item := range current {
		have[item.Name] = item
	}
	want := map[string]bool{}
	for _, item := range items {
		want[item.Name] = true
		old, ok := have[item.Name]
		if ok && old.Position == item.Position && reflect.DeepEqual(old.Cols, item.Cols) {
			continue
		}
		names := append([]string{"name", "position"}, cols...)
		names = append(names, "updated_at", "updated_by")
		args := []any{item.Name, item.Position}
		for _, col := range cols {
			args = append(args, item.Cols[col])
		}
		args = append(args, now, by)
		placeholders := strings.TrimSuffix(strings.Repeat("?, ", len(names)), ", ")
		if _, err := q.ExecContext(ctx, `INSERT OR REPLACE INTO `+table+` (`+strings.Join(names, ", ")+`) VALUES (`+placeholders+`)`, args...); err != nil {
			return fmt.Errorf("save %s %s: %w", table, item.Name, err)
		}
	}
	for name := range have {
		if !want[name] {
			if _, err := q.ExecContext(ctx, `DELETE FROM `+table+` WHERE name = ?`, name); err != nil {
				return err
			}
		}
	}
	return nil
}

// saveRows makes the tables hold exactly rows. Rows that do not change keep their updated_at.
func saveRows(ctx context.Context, q queryer, rows Rows, by string) error {
	current, err := loadRows(ctx, q)
	if err != nil {
		return err
	}
	now := agentdb.Now()

	have := map[string]settingRow{}
	for _, s := range current.Settings {
		have[s.Path] = s
	}
	want := map[string]bool{}
	for _, s := range rows.Settings {
		if want[s.Path] {
			return fmt.Errorf("config path %s is set twice", s.Path)
		}
		want[s.Path] = true
		if old, ok := have[s.Path]; ok && old.Kind == s.Kind && old.Value == s.Value {
			continue
		}
		if _, err := q.ExecContext(ctx, `INSERT INTO settings (path, kind, value, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (path) DO UPDATE SET kind = excluded.kind, value = excluded.value, updated_at = excluded.updated_at,
			updated_by = excluded.updated_by`, s.Path, s.Kind, s.Value, now, by); err != nil {
			return fmt.Errorf("save setting %s: %w", s.Path, err)
		}
	}
	for path := range have {
		if !want[path] {
			if _, err := q.ExecContext(ctx, `DELETE FROM settings WHERE path = ?`, path); err != nil {
				return err
			}
		}
	}

	profileCols := append(columnNames(profileColumns), "provider_options")
	var profiles []itemRow
	for _, p := range rows.Profiles {
		profiles = append(profiles, withDefaults(p, profileColumns, map[string]any{"provider_options": "{}"}))
	}
	if err := saveItems(ctx, q, "llm_profiles", profileCols, profiles, current.Profiles, now, by); err != nil {
		return err
	}
	var servers []itemRow
	for _, m := range rows.MCP {
		servers = append(servers, withDefaults(m, mcpColumns, nil))
	}
	if err := saveItems(ctx, q, "mcp_servers", columnNames(mcpColumns), servers, current.MCP, now, by); err != nil {
		return err
	}
	var endpoints []itemRow
	for _, e := range rows.Endpoints {
		endpoints = append(endpoints, withDefaults(e, endpointColumns, nil))
	}
	if err := saveItems(ctx, q, "console_endpoints", columnNames(endpointColumns), endpoints, current.Endpoints, now, by); err != nil {
		return err
	}

	haveRoutes := map[string]routeRow{}
	for _, r := range current.Routes {
		haveRoutes[r.Purpose] = r
	}
	wantRoutes := map[string]bool{}
	for _, route := range rows.Routes {
		wantRoutes[route.Purpose] = true
		if old, ok := haveRoutes[route.Purpose]; ok && reflect.DeepEqual(old, route) {
			continue
		}
		if _, err := q.ExecContext(ctx, `INSERT INTO llm_routes (purpose, profile, fallback_profiles, updated_at, updated_by)
			VALUES (?, ?, ?, ?, ?) ON CONFLICT (purpose) DO UPDATE SET profile = excluded.profile,
			fallback_profiles = excluded.fallback_profiles, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
			route.Purpose, route.Profile, route.Fallbacks, now, by); err != nil {
			return fmt.Errorf("save route %s: %w", route.Purpose, err)
		}
		if _, err := q.ExecContext(ctx, `DELETE FROM llm_route_candidates WHERE purpose = ?`, route.Purpose); err != nil {
			return err
		}
		for i, c := range route.Candidates {
			if _, err := q.ExecContext(ctx, `INSERT INTO llm_route_candidates (purpose, position, profile, weight) VALUES (?, ?, ?, ?)`,
				route.Purpose, i, c.Profile, c.Weight); err != nil {
				return err
			}
		}
	}
	for purpose := range haveRoutes {
		if !wantRoutes[purpose] {
			if _, err := q.ExecContext(ctx, `DELETE FROM llm_routes WHERE purpose = ?`, purpose); err != nil {
				return err
			}
		}
	}

	haveAuth := map[string]authRow{}
	for _, a := range current.Auth {
		haveAuth[a.Name] = a
	}
	wantAuth := map[string]bool{}
	for _, a := range rows.Auth {
		wantAuth[a.Name] = true
		if old, ok := haveAuth[a.Name]; ok && old == a {
			continue
		}
		if _, err := q.ExecContext(ctx, `INSERT OR REPLACE INTO auth_profiles (name, credential_kind, credential_secret, allow, bindings,
			updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)`, a.Name, a.Kind, a.Secret, a.Allow, a.Bindings, now, by); err != nil {
			return fmt.Errorf("save auth profile %s: %w", a.Name, err)
		}
	}
	for name := range haveAuth {
		if !wantAuth[name] {
			if _, err := q.ExecContext(ctx, `DELETE FROM auth_profiles WHERE name = ?`, name); err != nil {
				return err
			}
		}
	}
	if _, err = q.ExecContext(ctx, `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
		savedKey, now); err != nil {
		return err
	}
	_, err = q.ExecContext(ctx, `INSERT INTO meta (key, value) VALUES (?, '1')
		ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`, revisionKey)
	return err
}

// ---------- the import ----------

// ImportName is the config import's mark in meta.
const ImportName = "config"

// pendingRenameKey holds, in meta, the config file an import committed but has not renamed yet.
// The file may be outside the state folder (~/.morph/config.yaml beside another state folder), so
// it is not in the import mark, whose renames every open of agent.db finishes; ImportFile finishes
// this one.
const pendingRenameKey = "config_import_pending_rename"

// ImportFile imports the config file at filePath into agent.db in stateDir, once: unless the
// config was imported before or agent.db already holds a config. The file is renamed
// <name>.imported after the import commits; a rename a crash left undone is finished on the next
// call, without reading the file again. It reports whether it imported.
func ImportFile(ctx context.Context, stateDir, filePath string) (bool, error) {
	filePath = filepath.Clean(strings.TrimSpace(filePath))
	if abs, err := filepath.Abs(filePath); err == nil {
		filePath = abs
	}
	db, err := agentdb.CachedStateDir(stateDir).GetWithoutImports(ctx)
	if err != nil {
		return false, err
	}
	if err := finishPendingRename(ctx, db); err != nil {
		// The config is in agent.db: the file that should have been renamed is not read again.
		slog.Default().Warn("config_import_rename_failed", "error", err)
	}
	if done, err := stateimport.Imported(ctx, db, ImportName); err != nil || done {
		return false, err
	}
	raw, err := os.ReadFile(filePath)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if _, err := parseDocument(raw); err != nil {
		return false, fmt.Errorf("import %s: %w", filePath, err)
	}
	ran, err := agentdb.RunImport(ctx, db, agentdb.Importer{Name: ImportName, Run: func(ctx context.Context, tx *sql.Tx, env agentdb.ImportEnv) (agentdb.ImportResult, error) {
		var result agentdb.ImportResult
		if _, err := tx.ExecContext(ctx, `INSERT INTO meta (key, value) VALUES (?, ?)
			ON CONFLICT (key) DO UPDATE SET value = excluded.value`, pendingRenameKey, filePath); err != nil {
			return result, err
		}
		saved, err := hasConfig(ctx, tx)
		if err != nil || saved {
			return result, err
		}
		rows, err := parseDocument(raw)
		if err != nil {
			return result, err
		}
		rows = rebaseConfigRelativeFiles(rows, filepath.Dir(filePath), stateDir)
		if err := saveRows(ctx, tx, dropBootstrapKeys(rows), ByImport); err != nil {
			return result, err
		}
		return result, nil
	}})
	if err != nil || !ran {
		return ran, err
	}
	return true, finishPendingRename(ctx, db)
}

// ConfigRelativeFileKeys are the settings whose relative paths resolve from the config's folder:
// the folder of a config file, the state folder for the config in agent.db.
var ConfigRelativeFileKeys = []string{"llm.pricing_file", "mixin.keystore_file"}

// rebaseConfigRelativeFiles keeps the relative file settings of a config imported from configDir
// pointing at the same files once the config is in the agent.db of stateDir: a relative path is
// made absolute from configDir, unless the two folders are the same. A path that is absolute,
// starts with ~ or holds a ${VAR} or secret reference (known only when the config is read) is
// kept as written.
func rebaseConfigRelativeFiles(rows Rows, configDir, stateDir string) Rows {
	if sameFolder(configDir, stateDir) {
		return rows
	}
	base := filepath.Clean(pathutil.ExpandHomePath(strings.TrimSpace(configDir)))
	if abs, err := filepath.Abs(base); err == nil {
		base = abs
	}
	settings := append([]settingRow(nil), rows.Settings...)
	for i, s := range settings {
		if !slices.Contains(ConfigRelativeFileKeys, s.Path) {
			continue
		}
		var value string
		if err := json.Unmarshal([]byte(s.Value), &value); err != nil {
			continue
		}
		path := strings.TrimSpace(value)
		if path == "" || filepath.IsAbs(path) || strings.HasPrefix(path, "~") || strings.Contains(path, "${") {
			continue
		}
		encoded, err := json.Marshal(filepath.Join(base, path))
		if err != nil {
			continue
		}
		settings[i].Value = string(encoded)
	}
	rows.Settings = settings
	return rows
}

// finishPendingRename renames the config file a committed import named to <name>.imported, then
// forgets it. A file whose .imported name is taken is left in place rather than overwrite the
// earlier original; a rename that fails stays pending for the next call.
func finishPendingRename(ctx context.Context, db *agentdb.DB) error {
	var path string
	err := db.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, pendingRenameKey).Scan(&path)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if path = strings.TrimSpace(path); path != "" {
		if _, err := os.Lstat(path); err == nil {
			if _, err := os.Lstat(path + stateimport.ImportedSuffix); os.IsNotExist(err) {
				if err := os.Rename(path, path+stateimport.ImportedSuffix); err != nil {
					return fmt.Errorf("rename imported config %s: %w", path, err)
				}
			}
		}
	}
	_, err = db.ExecContext(ctx, `DELETE FROM meta WHERE key = ?`, pendingRenameKey)
	return err
}

// ---------- reading one value ----------

// Settings lists the settings rows: path, kind and JSON value, for diagnostics and tests.
func Settings(ctx context.Context, stateDir string) ([][3]string, error) {
	db, err := agentdb.CachedStateDir(stateDir).GetWithoutImports(ctx)
	if err != nil {
		return nil, err
	}
	var rows Rows
	if err := readTx(ctx, db, func(q queryer) error {
		rows, err = loadRows(ctx, q)
		return err
	}); err != nil {
		return nil, err
	}
	out := make([][3]string, 0, len(rows.Settings))
	for _, s := range rows.Settings {
		out = append(out, [3]string{s.Path, s.Kind, s.Value})
	}
	sort.Slice(out, func(i, j int) bool { return out[i][0] < out[j][0] })
	return out, nil
}

// BootstrapKeys are settled before the config is read, so agent.db does not keep them: the state
// folder holds agent.db.
var BootstrapKeys = []string{"file_state_dir"}

// BootstrapKeyError is a save to the config in agent.db that sets file_state_dir to another folder.
// agent.db is in the state folder, so it cannot keep a setting that moves the folder.
type BootstrapKeyError struct {
	Key      string
	Value    string
	StateDir string
}

func (e *BootstrapKeyError) Error() string {
	return fmt.Sprintf("%s cannot be changed while the config is kept in agent.db: agent.db is in the state folder %s, "+
		"which is settled before the config is read, so %q would not be used. To use another state folder, start morph "+
		"with --state-dir or MISTER_MORPH_FILE_STATE_DIR", e.Key, e.StateDir, e.Value)
}

// CheckBootstrapKeys returns a *BootstrapKeyError when data, a config document for the agent.db
// config at path, sets file_state_dir to a folder other than the one agent.db is in. Writers that
// edit a value call it before WriteFileBy, which drops the key. The folder agent.db is in, spelled
// any way, is accepted. A file config is not checked.
func CheckBootstrapKeys(path string, data []byte) error {
	if !IsDBConfigPath(path) {
		return nil
	}
	var doc map[string]any
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return nil // parseDocument reports it
	}
	stateDir := filepath.Dir(filepath.Clean(strings.TrimSpace(path)))
	for _, key := range BootstrapKeys {
		raw, ok := doc[key]
		if !ok || raw == nil {
			continue
		}
		value := strings.TrimSpace(fmt.Sprint(raw))
		if value == "" || sameFolder(os.ExpandEnv(value), stateDir) {
			continue
		}
		return &BootstrapKeyError{Key: key, Value: value, StateDir: stateDir}
	}
	return nil
}

func sameFolder(a, b string) bool {
	clean := func(p string) string {
		p = filepath.Clean(pathutil.ExpandHomePath(strings.TrimSpace(p)))
		if abs, err := filepath.Abs(p); err == nil {
			p = abs
		}
		return p
	}
	return clean(a) == clean(b)
}

func dropBootstrapKeys(rows Rows) Rows {
	kept := rows.Settings[:0:0]
	for _, s := range rows.Settings {
		drop := false
		for _, key := range BootstrapKeys {
			if s.Path == key || strings.HasPrefix(s.Path, key+".") {
				drop = true
			}
		}
		if !drop {
			kept = append(kept, s)
		}
	}
	rows.Settings = kept
	return rows
}
