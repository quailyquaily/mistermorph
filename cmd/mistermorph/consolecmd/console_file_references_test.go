package consolecmd

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/imagemime"
)

// The Console refuses pasted images over these limits before uploading them, and does not send a
// draft holding such images (web/console-nsh/components/chat/imagePaste.ts). Its numbers must be
// the ones the console's runtime applies when it shows the model a message's images.
func TestConsoleImageLimitsMatchTheConsoleComposer(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "..", "..", "web", "console-nsh", "components", "chat", "imagePaste.ts"))
	if err != nil {
		t.Fatalf("read the composer's paste module: %v", err)
	}
	bytes := regexp.MustCompile(`export const MODEL_IMAGE_MAX_BYTES = (\d+) \* 1024 \* 1024;`).FindSubmatch(source)
	count := regexp.MustCompile(`export const MODEL_IMAGE_MAX_COUNT = (\d+);`).FindSubmatch(source)
	if bytes == nil || count == nil {
		t.Fatal("imagePaste.ts no longer states MODEL_IMAGE_MAX_BYTES / MODEL_IMAGE_MAX_COUNT as this test reads them")
	}
	mib, _ := strconv.ParseInt(string(bytes[1]), 10, 64)
	if got := mib * 1024 * 1024; got != consoleLLMMaxImageBytes {
		t.Fatalf("Console MODEL_IMAGE_MAX_BYTES = %d, runtime consoleLLMMaxImageBytes = %d", got, consoleLLMMaxImageBytes)
	}
	if got, _ := strconv.Atoi(string(count[1])); got != consoleLLMMaxImages {
		t.Fatalf("Console MODEL_IMAGE_MAX_COUNT = %d, runtime consoleLLMMaxImages = %d", got, consoleLLMMaxImages)
	}
}

// A pasted image is uploaded under the extension of its bytes (.png, .jpg, .webp); those, and only
// those, are the references whose images the model is shown. A GIF, HEIC or BMP stays a file.
func TestResolveConsoleImageReferencePathsTakesThePastedFormats(t *testing.T) {
	root := t.TempDir()
	names := []string{"clipboard-image-1.png", "holiday.jpg", "chart.webp", "anim.gif", "photo.heic", "scan.bmp", "notes.txt"}
	refs := make([]daemonruntime.FileReference, 0, len(names))
	for _, name := range names {
		if err := os.WriteFile(filepath.Join(root, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		refs = append(refs, daemonruntime.FileReference{DirName: "file_cache_dir", Path: name})
	}
	paths, err := resolveConsoleImageReferencePaths(refs, "", root)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, path := range paths {
		got = append(got, filepath.Base(path))
	}
	want := []string{"clipboard-image-1.png", "holiday.jpg", "chart.webp"}
	if len(got) != len(want) {
		t.Fatalf("image references = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("image references = %v, want %v", got, want)
		}
	}
	for _, name := range want {
		if !imagemime.SupportedUpload(imagemime.FromPath(name)) {
			t.Fatalf("%s is not a model image format", name)
		}
	}
}
