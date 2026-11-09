// Package statesnapshot copies a live state folder into another folder in a shape that restores:
// each SQLite database through VACUUM INTO, and every other file as it is.
package statesnapshot

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/fsstore"
	"github.com/quailyquaily/mistermorph/internal/sqlitedb"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
)

// Database is one SQLite database in the state folder.
type Database struct {
	// Name is how --skip names it.
	Name string
	// Path is relative to the state folder.
	Path string
}

// Databases are the SQLite databases a snapshot copies with VACUUM INTO.
var Databases = []Database{
	{Name: "journal", Path: filepath.Join(statepaths.JournalDirName, "journal.db")},
	{Name: "memory", Path: statepaths.MemoryDBFilename},
	{Name: "agent", Path: statepaths.AgentDBFilename},
	{Name: "usage", Path: statepaths.UsageDBFilename},
}

// Options change what a snapshot holds.
type Options struct {
	// Skip names databases (Database.Name) to leave out, with their sidecar files.
	Skip []string
}

// Result says what a snapshot copied.
type Result struct {
	Databases []string
	Files     int
}

// Take copies stateDir into dst. dst must not exist or be an empty folder. Databases that do not
// exist are left out. Files are copied with their modes; symbolic links are copied as links.
func Take(ctx context.Context, stateDir, dst string, opts Options) (Result, error) {
	stateDir = filepath.Clean(strings.TrimSpace(stateDir))
	dst = filepath.Clean(strings.TrimSpace(dst))
	if stateDir == "" || stateDir == "." {
		return Result{}, fmt.Errorf("state folder is required")
	}
	if dst == "" || dst == "." {
		return Result{}, fmt.Errorf("snapshot folder is required")
	}
	absState, err := filepath.Abs(stateDir)
	if err != nil {
		return Result{}, err
	}
	absDst, err := filepath.Abs(dst)
	if err != nil {
		return Result{}, err
	}
	if absDst == absState {
		return Result{}, fmt.Errorf("snapshot folder must differ from the state folder")
	}
	if info, err := os.Stat(absState); err != nil {
		return Result{}, err
	} else if !info.IsDir() {
		return Result{}, fmt.Errorf("%s is not a folder", absState)
	}
	if entries, err := os.ReadDir(absDst); err == nil {
		if len(entries) > 0 {
			return Result{}, fmt.Errorf("snapshot folder %s is not empty", absDst)
		}
	} else if !os.IsNotExist(err) {
		return Result{}, err
	}
	if err := fsstore.EnsureDir(absDst, 0o700); err != nil {
		return Result{}, err
	}

	skip := map[string]bool{}
	for _, name := range opts.Skip {
		for _, part := range strings.Split(name, ",") {
			part = strings.ToLower(strings.TrimSpace(part))
			if part == "" {
				continue
			}
			if !knownDatabase(part) {
				return Result{}, fmt.Errorf("unknown database %q (known: %s)", part, knownNames())
			}
			skip[part] = true
		}
	}

	// Every database file and sidecar is left out of the file copy, skipped or not.
	excluded := map[string]bool{}
	for _, db := range Databases {
		excluded[db.Path] = true
		for _, suffix := range sqlitedb.SidecarSuffixes {
			excluded[db.Path+suffix] = true
		}
	}

	var result Result
	for _, db := range Databases {
		if skip[db.Name] {
			continue
		}
		src := filepath.Join(absState, db.Path)
		if _, err := os.Stat(src); err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return result, err
		}
		if err := sqlitedb.SnapshotInto(ctx, src, filepath.Join(absDst, db.Path)); err != nil {
			return result, err
		}
		result.Databases = append(result.Databases, db.Name)
	}

	err = filepath.WalkDir(absState, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if os.IsNotExist(walkErr) {
				return nil
			}
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if path == absDst || strings.HasPrefix(path, absDst+string(filepath.Separator)) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(absState, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		if excluded[rel] {
			return nil
		}
		target := filepath.Join(absDst, rel)
		info, err := os.Lstat(path)
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		switch {
		case info.IsDir():
			return fsstore.EnsureDir(target, info.Mode().Perm()|0o700)
		case info.Mode()&os.ModeSymlink != 0:
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		case info.Mode().IsRegular():
			if err := copyFile(path, target, info.Mode().Perm()); err != nil {
				if os.IsNotExist(err) {
					return nil
				}
				return err
			}
			result.Files++
			return nil
		default:
			// Sockets, pipes and devices are not state.
			return nil
		}
	})
	if err != nil {
		return result, err
	}
	return result, nil
}

func copyFile(src, dst string, mode fs.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	if err := fsstore.EnsureDir(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

func knownDatabase(name string) bool {
	for _, db := range Databases {
		if db.Name == name {
			return true
		}
	}
	return false
}

func knownNames() string {
	names := make([]string, 0, len(Databases))
	for _, db := range Databases {
		names = append(names, db.Name)
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}
