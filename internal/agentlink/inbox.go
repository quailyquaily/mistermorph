package agentlink

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/filecache"
)

// Received attachments live in file_cache_dir/agentlink/<sender instance id>/, under generated
// names, kept for inboxMaxAge, up to inboxMaxFiles files and inboxMaxTotalBytes bytes; the oldest
// go first. inboxMaxTotalBytes admits two messages of the largest streamed size. A partial file a
// crash or an abandoned transfer left behind is removed after partialFileMaxAge; a partial file is
// never reported as an attachment.
const (
	InboxDirName           = "agentlink"
	inboxMaxAge            = 7 * 24 * time.Hour
	inboxMaxFiles          = 256
	inboxMaxTotalBytes     = int64(512 << 20)
	partialFileMaxAge      = time.Hour
	partialFilePrefix      = ".part-"
	defaultAttachmentMedia = "application/octet-stream"
)

// FileAuthorizer reports whether this runtime takes files from the agent with instance ID from. An
// error rejects the message with ReasonUnauthorized.
type FileAuthorizer func(ctx context.Context, from string) error

type fileInbox struct {
	// cacheDir is file_cache_dir, absolute with symlinks resolved.
	cacheDir  string
	authorize FileAuthorizer
}

// EnableFiles makes the node take attachments, saving them under cacheDir (file_cache_dir), until
// the returned function is called. authorize, when set, decides which agents may send files; an
// answer to a message this runtime sent is always taken. A node without it rejects attachments with
// ReasonFilesUnsupported, and tells the Consoles it does not take them.
func (n *Node) EnableFiles(cacheDir string, authorize FileAuthorizer) (restore func(), err error) {
	cacheDir = strings.TrimSpace(cacheDir)
	if cacheDir == "" {
		return nil, fmt.Errorf("file_cache_dir is required")
	}
	abs, err := filepath.Abs(cacheDir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o700); err != nil {
		return nil, err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("file_cache_dir is not a directory: %s", resolved)
	}
	inbox := &fileInbox{cacheDir: resolved, authorize: authorize}
	n.mu.Lock()
	previous := n.files
	n.files = inbox
	n.mu.Unlock()
	n.announce()
	return func() {
		n.mu.Lock()
		if n.files == inbox {
			n.files = previous
		}
		n.mu.Unlock()
		n.announce()
	}, nil
}

// saveAttachments saves msg's attachments and returns them with Path and Ref set and Data dropped.
// Each file is written privately under a temporary name, synced, then published under a new name
// that never replaces an existing file. On error nothing it wrote stays.
func (n *Node) saveAttachments(inbox *fileInbox, msg Message) ([]Attachment, error) {
	n.fileMu.Lock()
	defer n.fileMu.Unlock()
	root, err := os.OpenRoot(inbox.cacheDir)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	dir := path.Join(InboxDirName, safeFileName(msg.From))
	for _, d := range []string{InboxDirName, dir} {
		if err := ensurePrivateDir(root, d); err != nil {
			return nil, err
		}
	}
	saved := make([]Attachment, 0, len(msg.Attachments))
	fail := func(err error) ([]Attachment, error) {
		for _, a := range saved {
			_ = os.Remove(a.Path)
		}
		return nil, err
	}
	for _, a := range msg.Attachments {
		rel, err := publishAttachment(root, dir, a)
		if err != nil {
			return fail(err)
		}
		a.Path = filepath.Join(inbox.cacheDir, filepath.FromSlash(rel))
		a.Ref = "file_cache_dir/" + rel
		a.Data = nil
		saved = append(saved, a)
	}
	protected := make(map[string]bool, len(saved))
	for _, a := range saved {
		protected[a.Path] = true
	}
	n.cleanInbox(filepath.Join(inbox.cacheDir, InboxDirName), protected)
	return saved, nil
}

// removeAttachments removes saved attachments of a message that was not accepted after all.
func removeAttachments(attachments []Attachment) {
	for _, a := range attachments {
		if a.Path != "" {
			_ = os.Remove(a.Path)
		}
	}
}

// ensurePrivateDir makes dir under root a private directory, refusing a symlink or anything else
// in its place.
func ensurePrivateDir(root *os.Root, dir string) error {
	if err := root.Mkdir(dir, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
		return err
	}
	info, err := root.Lstat(dir)
	if err != nil {
		return err
	}
	if info.Mode()&fs.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("refusing to save attachments in %s: not a plain directory", dir)
	}
	if info.Mode().Perm() != 0o700 {
		return root.Chmod(dir, 0o700)
	}
	return nil
}

// writeAttachmentData writes an attachment's bytes; tests replace it to interrupt a write.
var writeAttachmentData = func(f *os.File, data []byte) error {
	_, err := f.Write(data)
	return err
}

func publishAttachment(root *os.Root, dir string, a Attachment) (string, error) {
	tmp, f, err := createPart(root, dir)
	if err != nil {
		return "", err
	}
	defer func() { _ = root.Remove(tmp) }()
	err = writeAttachmentData(f, a.Data)
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	return linkPart(root, dir, tmp, a.Filename)
}

// createPart creates a private partial file in dir under root.
func createPart(root *os.Root, dir string) (string, *os.File, error) {
	tmp := path.Join(dir, partialFilePrefix+randomHex(8))
	f, err := root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", nil, err
	}
	return tmp, f, nil
}

// linkPart publishes the complete partial file tmp under a new name for filename, and returns that
// name. The partial file stays; the caller removes it.
func linkPart(root *os.Root, dir, tmp, filename string) (string, error) {
	name := filecache.SanitizeFilename(filename)
	for attempt := 0; attempt < 3; attempt++ {
		final := path.Join(dir, randomHex(6)+"-"+name)
		// A hard link publishes the complete file without ever replacing one.
		err := root.Link(tmp, final)
		if err == nil {
			return final, nil
		}
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		// Some filesystems have no hard links; rename, after checking the name is free.
		if _, statErr := root.Lstat(final); !errors.Is(statErr, fs.ErrNotExist) {
			continue
		}
		if err := root.Rename(tmp, final); err != nil {
			return "", err
		}
		return final, nil
	}
	return "", fmt.Errorf("could not find a free name for %s", name)
}

// cleanInbox applies the inbox limits and removes stale partial files. The partial files of
// unfinished streamed deliveries are kept, and the room they reserved is left free.
func (n *Node) cleanInbox(dir string, protected map[string]bool) {
	if protected == nil {
		protected = make(map[string]bool)
	}
	pending := n.protectInStreams(protected)
	now := n.opts.Now()
	_ = filepath.WalkDir(dir, func(p string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || !strings.HasPrefix(entry.Name(), partialFilePrefix) {
			return nil
		}
		if protected[p] {
			return nil
		}
		if info, err := entry.Info(); err == nil && now.Sub(info.ModTime()) > partialFileMaxAge {
			_ = os.Remove(p)
		}
		return nil
	})
	limits := filecache.Limits{MaxAge: inboxMaxAge, MaxFiles: inboxMaxFiles, MaxTotalBytes: max(inboxMaxTotalBytes-pending, 1)}
	if err := filecache.Cleanup(dir, limits, protected); err != nil {
		n.logger.Warn("agentlink_inbox_cleanup_error", "error", err.Error())
	}
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
