package daemonruntime

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/daemonruntime/uploadtest"
	"github.com/quailyquaily/mistermorph/internal/runtimepaths"
	_ "golang.org/x/image/webp"
)

// The upload budgets (FT197): 128 MiB a file, 129 MiB a request, both checked by the runtime on
// its own, with real streamed multipart bodies of exact byte counts.

func TestUploadBudgetsAreTheFT197Defaults(t *testing.T) {
	if FileUploadMaxFileBytes != 134_217_728 || FileUploadMaxRequestBytes != 135_266_304 {
		t.Fatalf("file/request budgets = %d/%d", FileUploadMaxFileBytes, FileUploadMaxRequestBytes)
	}
	// What the agent sends keeps its own budget, and the multipart memory threshold stays.
	if consoleAttachmentMaxBytes != 64<<20 || fileUploadMemoryBytes != 8<<20 {
		t.Fatalf("attachment/memory = %d/%d", consoleAttachmentMaxBytes, fileUploadMemoryBytes)
	}
}

type uploadRig struct {
	mux      *http.ServeMux
	cacheDir string
	tempDir  string
}

// newUploadRig is a runtime whose uploads land in its file cache, with the multipart parser's
// temporary files in a directory of the test's (to see that none are left).
func newUploadRig(t *testing.T) uploadRig {
	t.Helper()
	tempDir := t.TempDir()
	t.Setenv("TMPDIR", tempDir)
	cacheDir := t.TempDir()
	mux := http.NewServeMux()
	RegisterRoutes(mux, RoutesOptions{
		Mode:         "console",
		AuthToken:    "token",
		RuntimePaths: runtimepaths.Paths{CacheDir: cacheDir},
		Workspace: WorkspaceRoutes{Get: func(_ context.Context, _ string) (WorkspaceResolution, error) {
			return WorkspaceResolution{Source: "none"}, nil
		}},
	})
	return uploadRig{mux: mux, cacheDir: cacheDir, tempDir: tempDir}
}

type uploadResult struct {
	code   int
	body   map[string]any
	raw    string
	stream *uploadtest.Body
}

func (rig uploadRig) post(t *testing.T, parts []uploadtest.Part, mutate func(*http.Request)) uploadResult {
	t.Helper()
	stream := uploadtest.NewBody(parts)
	req := httptest.NewRequest(http.MethodPost, "/files/upload", stream)
	req.ContentLength = uploadtest.Length(parts)
	req.Header.Set("Authorization", "Bearer token")
	req.Header.Set("Content-Type", uploadtest.ContentType)
	if mutate != nil {
		mutate(req)
	}
	rec := httptest.NewRecorder()
	rig.mux.ServeHTTP(rec, req)
	result := uploadResult{code: rec.Code, raw: rec.Body.String(), stream: stream}
	_ = json.Unmarshal(rec.Body.Bytes(), &result.body)
	return result
}

func (rig uploadRig) stored(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(rig.cacheDir, "console"))
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

func (rig uploadRig) assertNoTempFiles(t *testing.T) {
	t.Helper()
	entries, err := os.ReadDir(rig.tempDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		var names []string
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("temporary files left: %v", names)
	}
}

func file(name string, size int64) uploadtest.Part {
	return uploadtest.Part{Name: name, File: true, Size: size}
}

func TestFilesUploadTakesAWholeRequestOfExactly129MiBAndRefusesOneByteMore(t *testing.T) {
	rig := newUploadRig(t)
	// Two files share the request: a largest file and the rest of the budget less the framing.
	parts := []uploadtest.Part{file("big.bin", FileUploadMaxFileBytes), file("rest.bin", 0)}
	parts[1].Size = FileUploadMaxRequestBytes - uploadtest.Length(parts)
	if got := uploadtest.Length(parts); got != 135_266_304 {
		t.Fatalf("body length = %d", got)
	}
	ok := rig.post(t, parts, nil)
	if ok.code != http.StatusOK {
		t.Fatalf("exact budget: status %d %s", ok.code, ok.raw)
	}
	if ok.stream.Consumed != 135_266_304 {
		t.Fatalf("read %d bytes", ok.stream.Consumed)
	}
	for name, sum := range ok.stream.Sums() {
		raw, err := os.Open(filepath.Join(rig.cacheDir, "console", name))
		if err != nil {
			t.Fatal(err)
		}
		h := sha256.New()
		_, _ = io.Copy(h, raw)
		raw.Close()
		if !bytes.Equal(h.Sum(nil), sum) {
			t.Fatalf("%s stored bytes differ", name)
		}
	}
	rig.assertNoTempFiles(t)

	over := newUploadRig(t)
	parts[1].Size++
	// Without a declared length the body is read to the budget and refused there.
	result := over.post(t, parts, func(r *http.Request) { r.ContentLength = -1 })
	if result.code != http.StatusRequestEntityTooLarge || result.body["code"] != UploadCodeRequestTooLarge {
		t.Fatalf("one byte over: status %d %s", result.code, result.raw)
	}
	if !strings.Contains(result.raw, "129 MiB (135266304 bytes)") || result.body["limit_bytes"] != float64(135_266_304) {
		t.Fatalf("refusal = %s", result.raw)
	}
	if names := over.stored(t); len(names) != 0 {
		t.Fatalf("stored after refusal: %v", names)
	}
	over.assertNoTempFiles(t)
}

func TestFilesUploadRefusesADeclaredOversizeRequestBeforeReadingIt(t *testing.T) {
	rig := newUploadRig(t)
	parts := []uploadtest.Part{file("big.bin", FileUploadMaxRequestBytes)}
	result := rig.post(t, parts, nil)
	if result.code != http.StatusRequestEntityTooLarge || result.body["code"] != UploadCodeRequestTooLarge {
		t.Fatalf("status %d %s", result.code, result.raw)
	}
	if result.stream.Consumed != 0 {
		t.Fatalf("read %d bytes of a refused body", result.stream.Consumed)
	}
	// Authorization comes first: an unauthorized client learns nothing of the budget.
	unauthorized := rig.post(t, parts, func(r *http.Request) { r.Header.Set("Authorization", "Bearer nope") })
	if unauthorized.code != http.StatusUnauthorized {
		t.Fatalf("unauthorized: status %d", unauthorized.code)
	}
}

func TestFilesUploadTakesAFileOfExactly128MiBAndRefusesOneByteMoreWithinTheRequestBudget(t *testing.T) {
	rig := newUploadRig(t)
	ok := rig.post(t, []uploadtest.Part{{Name: "topic_id", Value: "topic_a"}, file("max.bin", 134_217_728)}, nil)
	if ok.code != http.StatusOK {
		t.Fatalf("exact file: status %d %s", ok.code, ok.raw)
	}
	var stored struct {
		Files []struct {
			SizeBytes int64 `json:"size_bytes"`
		} `json:"files"`
	}
	_ = json.Unmarshal([]byte(ok.raw), &stored)
	if len(stored.Files) != 1 || stored.Files[0].SizeBytes != 134_217_728 {
		t.Fatalf("stored = %s", ok.raw)
	}
	rig.assertNoTempFiles(t)

	over := newUploadRig(t)
	parts := []uploadtest.Part{file("kept.txt", 10), file("over.bin", 134_217_729)}
	if uploadtest.Length(parts) > FileUploadMaxRequestBytes {
		t.Fatal("the request must be within its budget for this check")
	}
	result := over.post(t, parts, nil)
	if result.code != http.StatusRequestEntityTooLarge || result.body["code"] != UploadCodeFileTooLarge {
		t.Fatalf("one byte over: status %d %s", result.code, result.raw)
	}
	if !strings.Contains(result.raw, `\"over.bin\" exceeds 128 MiB (134217728 bytes)`) {
		t.Fatalf("refusal = %s", result.raw)
	}
	// The whole request is refused: the small file beside it is not kept either.
	if names := over.stored(t); len(names) != 0 {
		t.Fatalf("stored after refusal: %v", names)
	}
	over.assertNoTempFiles(t)
}

func TestFilesUploadRefusesLongMetadataThatTakesTheRequestOverItsBudget(t *testing.T) {
	rig := newUploadRig(t)
	parts := []uploadtest.Part{{Name: "workspace_dir", Value: strings.Repeat("x", 2<<20)}, file("max.bin", FileUploadMaxFileBytes)}
	result := rig.post(t, parts, func(r *http.Request) { r.ContentLength = -1 })
	if result.code != http.StatusRequestEntityTooLarge || result.body["code"] != UploadCodeRequestTooLarge {
		t.Fatalf("status %d %s", result.code, result.raw)
	}
	rig.assertNoTempFiles(t)
}

func TestFilesUploadLeavesNothingOfAnInterruptedTransfer(t *testing.T) {
	rig := newUploadRig(t)
	parts := []uploadtest.Part{file("cut.bin", 40<<20)}
	req := httptest.NewRequest(http.MethodPost, "/files/upload", uploadtest.FailAfter(uploadtest.NewBody(parts), 20<<20, io.ErrUnexpectedEOF))
	req.ContentLength = -1
	req.Header.Set("Authorization", "Bearer token")
	req.Header.Set("Content-Type", uploadtest.ContentType)
	rec := httptest.NewRecorder()
	rig.mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d %s", rec.Code, rec.Body.String())
	}
	if names := rig.stored(t); len(names) != 0 {
		t.Fatalf("stored: %v", names)
	}
	rig.assertNoTempFiles(t)
}

// Valid images as a phone or a camera makes them (12–19 MB and MiB) and one larger than the old
// 64 MiB request budget are stored byte for byte with the stock budgets.
func TestFilesUploadStoresLargeValidImagesByteForByte(t *testing.T) {
	cases := []struct {
		name string
		size int64
		make func(int64) (io.Reader, error)
	}{
		{"photo-12MB.jpg", 12_000_000, uploadtest.JPEG},
		{"photo-19MiB.jpg", 19 << 20, uploadtest.JPEG},
		{"shot-13MB.png", 13_000_000, uploadtest.PNG},
		{"shot-19MiB.png", 19 << 20, uploadtest.PNG},
		{"pic-12MiB.webp", 12 << 20, uploadtest.WebP},
		{"pic-19MB.webp", 19_000_000, uploadtest.WebP},
		{"scan-65MiB.jpg", 65 << 20, uploadtest.JPEG},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rig := newUploadRig(t)
			content, err := tc.make(tc.size)
			if err != nil {
				t.Fatal(err)
			}
			parts := []uploadtest.Part{{Name: tc.name, File: true, Size: tc.size, Content: content}}
			result := rig.post(t, parts, nil)
			if result.code != http.StatusOK {
				t.Fatalf("status %d %s", result.code, result.raw)
			}
			path := filepath.Join(rig.cacheDir, "console", tc.name)
			info, err := os.Stat(path)
			if err != nil || info.Size() != tc.size {
				t.Fatalf("stored %v, %v", info, err)
			}
			raw, err := os.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer raw.Close()
			h := sha256.New()
			_, _ = io.Copy(h, raw)
			if !bytes.Equal(h.Sum(nil), result.stream.Sums()[tc.name]) {
				t.Fatal("stored bytes differ from the sent ones")
			}
			// The stored file is a valid image of its format.
			_, _ = raw.Seek(0, io.SeekStart)
			config, format, err := image.DecodeConfig(raw)
			if err != nil || config.Width == 0 {
				t.Fatalf("not a valid image: %v", err)
			}
			if _, err := raw.Seek(0, io.SeekStart); err != nil {
				t.Fatal(err)
			}
			if _, _, err := image.Decode(raw); err != nil {
				t.Fatalf("decode %s: %v", format, err)
			}
			t.Logf("%s: %s, file %d bytes, request %d bytes", tc.name, format, tc.size, uploadtest.Length(parts))
			rig.assertNoTempFiles(t)
		})
	}
}
