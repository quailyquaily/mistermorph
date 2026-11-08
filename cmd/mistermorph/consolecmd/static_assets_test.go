package consolecmd

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func staticTestFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":             {Data: []byte(`<meta name="mistermorph-base-path" content="__MISTERMORPH_BASE_PATH__">`)},
		"nsh.3bf2ab7d8f.wasm":    {Data: []byte("raw-wasm")},
		"nsh.3bf2ab7d8f.wasm.br": {Data: []byte("br-wasm")},
		"nsh.3bf2ab7d8f.wasm.gz": {Data: []byte("gz-wasm")},
		"favicon.svg":            {Data: []byte("<svg/>")},
		"assets/index-DjRiN-gA.js": {
			Data: []byte("vite-js"),
		},
	}
}

func getStatic(t *testing.T, srv *server, target string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	srv.handleSPA(rec, req)
	return rec
}

func TestStaticAssetsServePrecompressedVariants(t *testing.T) {
	srv := &server{cfg: serveConfig{basePath: "/", staticFS: fs.FS(staticTestFS())}}

	cases := []struct {
		accept   string
		encoding string
		body     string
	}{
		{"gzip, deflate, br", "br", "br-wasm"},
		{"gzip", "gzip", "gz-wasm"},
		{"br;q=0, gzip;q=0.8", "gzip", "gz-wasm"},
		{"", "", "raw-wasm"},
		{"identity", "", "raw-wasm"},
	}
	for _, tc := range cases {
		t.Run(tc.accept, func(t *testing.T) {
			rec := getStatic(t, srv, "/nsh.3bf2ab7d8f.wasm", map[string]string{"Accept-Encoding": tc.accept})
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d", rec.Code)
			}
			if got := rec.Header().Get("Content-Encoding"); got != tc.encoding {
				t.Fatalf("Content-Encoding = %q, want %q", got, tc.encoding)
			}
			if got := rec.Body.String(); got != tc.body {
				t.Fatalf("body = %q, want %q", got, tc.body)
			}
			if got := rec.Header().Get("Content-Type"); got != "application/wasm" {
				t.Fatalf("Content-Type = %q, want application/wasm", got)
			}
			if got := rec.Header().Get("Vary"); !strings.Contains(got, "Accept-Encoding") {
				t.Fatalf("Vary = %q, want Accept-Encoding", got)
			}
		})
	}
}

func TestStaticAssetsCacheHashedNamesForAYear(t *testing.T) {
	for rel, want := range map[string]string{
		"nsh.3bf2ab7d8f.wasm":           staticImmutableCacheControl,
		"browser.991ab24c49/values.js":  staticImmutableCacheControl,
		"icons/180.123ba67ff3.png":      staticImmutableCacheControl,
		"assets/index-DjRiN-gA.js":      staticImmutableCacheControl,
		"assets/ChatView-Qm8fOCX-.js":   staticImmutableCacheControl,
		"index.html":                    "no-cache",
		"favicon.svg":                   "no-cache",
		"manifest.webmanifest":          "no-cache",
		"android-chrome-192x192.png":    "no-cache",
		"settings-overview.png":         "no-cache",
		"assets/readme.txt":             "no-cache",
		"browser.991ab24c4/values.js":   "no-cache",
		"nsh.3BF2AB7D8F.wasm":           "no-cache",
		"fonts/ibm-plex-mono-latin.css": "no-cache",
	} {
		if got := staticCacheControl(rel); got != want {
			t.Errorf("staticCacheControl(%q) = %q, want %q", rel, got, want)
		}
	}

	srv := &server{cfg: serveConfig{basePath: "/", staticFS: fs.FS(staticTestFS())}}
	if got := getStatic(t, srv, "/assets/index-DjRiN-gA.js", nil).Header().Get("Cache-Control"); got != staticImmutableCacheControl {
		t.Fatalf("hashed asset Cache-Control = %q", got)
	}
	if got := getStatic(t, srv, "/chat", nil).Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("SPA index Cache-Control = %q, want no-cache", got)
	}
}

func TestEmbeddedStaticAssetsRevalidateWithETag(t *testing.T) {
	srv := &server{cfg: serveConfig{basePath: "/", staticFS: fs.FS(staticTestFS())}}

	first := getStatic(t, srv, "/favicon.svg", nil)
	etag := first.Header().Get("ETag")
	if first.Code != http.StatusOK || etag == "" {
		t.Fatalf("first response: status %d, ETag %q", first.Code, etag)
	}
	if got := first.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("Cache-Control = %q, want no-cache", got)
	}
	again := getStatic(t, srv, "/favicon.svg", map[string]string{"If-None-Match": etag})
	if again.Code != http.StatusNotModified {
		t.Fatalf("revalidation status = %d, want 304", again.Code)
	}

	// Each encoding is its own representation.
	raw := getStatic(t, srv, "/nsh.3bf2ab7d8f.wasm", nil).Header().Get("ETag")
	br := getStatic(t, srv, "/nsh.3bf2ab7d8f.wasm", map[string]string{"Accept-Encoding": "br"}).Header().Get("ETag")
	if raw == "" || br == "" || raw == br {
		t.Fatalf("ETags raw %q and br %q must differ", raw, br)
	}
}

func TestStaticDirAssetsUseLastModifiedAndPrecompressedFiles(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "site")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"index.html":           "index",
		"app.ef33bc2ecd.js":    "raw-js",
		"app.ef33bc2ecd.js.br": "br-js",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "secret.txt"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	srv := &server{cfg: serveConfig{basePath: "/", staticDir: dir}}

	rec := getStatic(t, srv, "/app.ef33bc2ecd.js", map[string]string{"Accept-Encoding": "br"})
	if rec.Body.String() != "br-js" || rec.Header().Get("Content-Encoding") != "br" {
		t.Fatalf("got %q with encoding %q, want the br file", rec.Body.String(), rec.Header().Get("Content-Encoding"))
	}
	if !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/javascript") {
		t.Fatalf("Content-Type = %q, want JavaScript", rec.Header().Get("Content-Type"))
	}
	if rec.Header().Get("Last-Modified") == "" {
		t.Fatal("files from the static dir need Last-Modified")
	}

	// Nothing outside the static dir is reachable.
	out := httptest.NewRecorder()
	if srv.serveStaticAsset(out, httptest.NewRequest(http.MethodGet, "/", nil), "../secret.txt") {
		t.Fatalf("served a file outside the static dir: %q", out.Body.String())
	}
}
