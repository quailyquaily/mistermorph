package telegramutil

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

type fileCacheEntry struct {
	Path    string
	ModTime time.Time
	Size    int64
}

func EnsureSecureCacheDir(dir string) error {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return fmt.Errorf("empty dir")
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	dir = abs

	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}

	fi, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refusing symlink path: %s", dir)
	}
	if !fi.IsDir() {
		return fmt.Errorf("not a directory: %s", dir)
	}

	perm := fi.Mode().Perm()
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || st == nil {
		return fmt.Errorf("unsupported stat for: %s", dir)
	}
	curUID := uint32(os.Getuid())
	if st.Uid != curUID {
		return fmt.Errorf("cache dir not owned by current user (uid=%d, owner=%d): %s", curUID, st.Uid, dir)
	}
	if perm != 0o700 {
		// Try to fix perms if we own it.
		if err := os.Chmod(dir, 0o700); err != nil {
			return fmt.Errorf("cache dir has insecure perms (%#o) and chmod failed: %w", perm, err)
		}
		fi2, err := os.Stat(dir)
		if err != nil {
			return err
		}
		if fi2.Mode().Perm() != 0o700 {
			return fmt.Errorf("cache dir has insecure perms (%#o): %s", fi2.Mode().Perm(), dir)
		}
	}
	return nil
}

func CleanupFileCacheDir(dir string, maxAge time.Duration, maxFiles int, maxTotalBytes int64) error {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return fmt.Errorf("missing dir")
	}
	if maxAge <= 0 && maxFiles <= 0 && maxTotalBytes <= 0 {
		return nil
	}
	now := time.Now()

	var kept []fileCacheEntry
	total := int64(0)

	walkErr := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		// Never follow symlinks.
		if d.Type()&os.ModeSymlink != 0 {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		if maxAge > 0 && now.Sub(info.ModTime()) > maxAge {
			_ = os.Remove(path)
			return nil
		}
		kept = append(kept, fileCacheEntry{
			Path:    path,
			ModTime: info.ModTime(),
			Size:    info.Size(),
		})
		total += info.Size()
		return nil
	})
	if walkErr != nil && !os.IsNotExist(walkErr) {
		return walkErr
	}

	// Enforce max_files and max_total_bytes by removing oldest files first.
	sort.Slice(kept, func(i, j int) bool { return kept[i].ModTime.Before(kept[j].ModTime) })
	needPrune := func() bool {
		if maxFiles > 0 && len(kept) > maxFiles {
			return true
		}
		if maxTotalBytes > 0 && total > maxTotalBytes {
			return true
		}
		return false
	}
	for needPrune() && len(kept) > 0 {
		old := kept[0]
		kept = kept[1:]
		total -= old.Size
		_ = os.Remove(old.Path)
	}

	// Best-effort remove empty dirs (bottom-up).
	var dirs []string
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			dirs = append(dirs, path)
		}
		return nil
	})
	sort.Slice(dirs, func(i, j int) bool { return len(dirs[i]) > len(dirs[j]) })
	for _, d := range dirs {
		if filepath.Clean(d) == filepath.Clean(dir) {
			continue
		}
		_ = os.Remove(d)
	}
	return nil
}
