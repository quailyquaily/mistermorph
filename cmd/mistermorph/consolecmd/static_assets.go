package consolecmd

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// The Console's static files: the built SPA in --console-static-dir or embedded in the binary.
//
// Builds put a content hash in the names of the files that change (Vite: assets/name-<hash>.js;
// nsh: name.<10 hex>.ext and the browser.<10 hex>/ folder), so those are cached for a year and
// never revalidated. The rest (index.html, favicons, the manifest) are revalidated on every use:
// Last-Modified from disk, or an ETag of the content for embedded files, whose modification time
// is zero. A file with a precompressed sibling (name.br, name.gz, which nsh writes and
// scripts/stage-console-assets.sh adds for the Vue build) is sent compressed to browsers that
// accept it: the nsh Console's wasm is 9.5 MB as it is and 2 MB in Brotli.

const staticImmutableCacheControl = "public, max-age=31536000, immutable"

var (
	viteHashedName = regexp.MustCompile(`-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$`)
	nshHashedPart  = regexp.MustCompile(`\.[0-9a-f]{10}(\.|$)`)
)

// staticCacheControl is the Cache-Control of a static file at rel (slash-separated, no leading
// slash).
func staticCacheControl(rel string) string {
	if strings.HasPrefix(rel, "assets/") && viteHashedName.MatchString(path.Base(rel)) {
		return staticImmutableCacheControl
	}
	for _, part := range strings.Split(rel, "/") {
		if nshHashedPart.MatchString(part) {
			return staticImmutableCacheControl
		}
	}
	return "no-cache"
}

// staticEncodings are the precompressed variants a request accepts, best first.
func staticEncodings(r *http.Request) []staticEncoding {
	accepted := map[string]bool{}
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		name, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		name = strings.ToLower(strings.TrimSpace(name))
		if name == "" {
			continue
		}
		q := 1.0
		for _, param := range strings.Split(params, ";") {
			key, value, ok := strings.Cut(strings.TrimSpace(param), "=")
			if ok && strings.EqualFold(strings.TrimSpace(key), "q") {
				if parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil {
					q = parsed
				}
			}
		}
		accepted[name] = q > 0
	}
	var out []staticEncoding
	for _, enc := range []staticEncoding{{name: "br", suffix: ".br"}, {name: "gzip", suffix: ".gz"}} {
		if accepted[enc.name] {
			out = append(out, enc)
		}
	}
	return out
}

type staticEncoding struct {
	name   string
	suffix string
}

type staticFile struct {
	body    io.ReadSeeker
	modTime time.Time
	etag    string
	close   func() error
}

// cleanStaticRel makes rel a slash-separated path inside the static root, or "".
func cleanStaticRel(rel string) string {
	return strings.TrimPrefix(path.Clean("/"+strings.TrimSpace(rel)), "/")
}

// openStatic opens the static file at rel (cleaned) from the static dir, else the embedded FS.
func (s *server) openStatic(rel string) (*staticFile, bool) {
	if rel == "" {
		return nil, false
	}
	if strings.TrimSpace(s.cfg.staticDir) != "" {
		file, err := os.Open(filepath.Join(s.cfg.staticDir, filepath.FromSlash(rel)))
		if err != nil {
			return nil, false
		}
		info, err := file.Stat()
		if err != nil || info.IsDir() {
			_ = file.Close()
			return nil, false
		}
		return &staticFile{body: file, modTime: info.ModTime(), close: file.Close}, true
	}
	if s.cfg.staticFS == nil {
		return nil, false
	}
	file, _, err := openStaticFSFile(s.cfg.staticFS, rel)
	if err != nil {
		return nil, false
	}
	defer file.Close()
	// Embedded files are in memory already; reading one gives a seekable body and its ETag.
	body, err := io.ReadAll(file)
	if err != nil {
		return nil, false
	}
	return &staticFile{body: bytes.NewReader(body), etag: s.staticETag(rel, body), close: func() error { return nil }}, true
}

// staticETag is a strong ETag of an embedded file's content, computed once per file: embedded
// files do not change while the binary runs.
func (s *server) staticETag(rel string, body []byte) string {
	if cached, ok := s.staticETags.Load(rel); ok {
		return cached.(string)
	}
	sum := sha256.Sum256(body)
	etag := `"` + hex.EncodeToString(sum[:12]) + `"`
	s.staticETags.Store(rel, etag)
	return etag
}

func (s *server) serveStaticAsset(w http.ResponseWriter, r *http.Request, rel string) bool {
	if s == nil {
		return false
	}
	rel = cleanStaticRel(rel)
	file, ok := s.openStatic(rel)
	if !ok {
		return false
	}
	defer file.close()

	h := w.Header()
	ctype := mime.TypeByExtension(path.Ext(rel))
	if ctype != "" {
		h.Set("Content-Type", ctype)
	}
	h.Set("Cache-Control", staticCacheControl(rel))
	h.Add("Vary", "Accept-Encoding")

	for _, enc := range staticEncodings(r) {
		encoded, ok := s.openStatic(rel + enc.suffix)
		if !ok {
			continue
		}
		defer encoded.close()
		if ctype == "" {
			// Never let ServeContent sniff the compressed bytes.
			h.Set("Content-Type", "application/octet-stream")
		}
		h.Set("Content-Encoding", enc.name)
		if encoded.etag != "" {
			h.Set("ETag", encoded.etag)
		}
		http.ServeContent(w, r, "", encoded.modTime, encoded.body)
		return true
	}

	if file.etag != "" {
		h.Set("ETag", file.etag)
	}
	http.ServeContent(w, r, path.Base(rel), file.modTime, file.body)
	return true
}

func (s *server) readStaticAsset(rel string) ([]byte, error) {
	if s == nil {
		return nil, fs.ErrNotExist
	}
	rel = cleanStaticRel(rel)
	if rel == "" {
		return nil, fs.ErrNotExist
	}
	if strings.TrimSpace(s.cfg.staticDir) != "" {
		return os.ReadFile(filepath.Join(s.cfg.staticDir, filepath.FromSlash(rel)))
	}
	if s.cfg.staticFS == nil {
		return nil, fs.ErrNotExist
	}
	return fs.ReadFile(s.cfg.staticFS, rel)
}

func openStaticFSFile(staticFS fs.FS, rel string) (fs.File, fs.FileInfo, error) {
	clean := cleanStaticRel(rel)
	if clean == "" {
		return nil, nil, fs.ErrNotExist
	}
	file, err := staticFS.Open(clean)
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, nil, err
	}
	if info.IsDir() {
		_ = file.Close()
		return nil, nil, fs.ErrNotExist
	}
	return file, info, nil
}
