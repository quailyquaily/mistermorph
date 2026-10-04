package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestBuildDownloadURL(t *testing.T) {
	t.Parallel()

	got := buildDownloadURL("https://downloads.example.com/", "/releases/v0.2.77/", "MrMorph-linux-amd64.tar.gz")
	want := "https://downloads.example.com/releases/v0.2.77/MrMorph-linux-amd64.tar.gz"
	if got != want {
		t.Fatalf("buildDownloadURL() = %q, want %q", got, want)
	}
}

func TestBuildR2Assets(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	artifactDir := filepath.Join(root, "linux-amd64")
	if err := os.MkdirAll(artifactDir, 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	files := map[string]string{
		"MrMorph-linux-amd64.tar.gz":      "linux tarball",
		"MrMorph-linux-amd64.AppImage":    "appimage",
		"MrMorph-linux-amd64.deb":         "ignored",
		"morph_0.2.77_linux_amd64.tar.gz": "ignored",
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(artifactDir, name), []byte(content), 0o644); err != nil {
			t.Fatalf("WriteFile(%q) error = %v", name, err)
		}
	}

	got, err := buildR2Assets(root, "https://downloads.example.com", "releases/v0.2.77")
	if err != nil {
		t.Fatalf("buildR2Assets() error = %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("asset count = %d, want 2: %#v", len(got), got)
	}
	if got[0].Name != "MrMorph-linux-amd64.AppImage" {
		t.Fatalf("first asset = %q", got[0].Name)
	}
	if got[1].BrowserDownloadURL != "https://downloads.example.com/releases/v0.2.77/MrMorph-linux-amd64.tar.gz" {
		t.Fatalf("second URL = %q", got[1].BrowserDownloadURL)
	}
}

func TestBuildR2AssetsFromObjectList(t *testing.T) {
	t.Parallel()

	objects := r2ObjectList{
		Contents: []r2Object{
			{
				Key:  "releases/v0.2.99/MrMorph-linux-amd64.AppImage",
				Size: 12,
			},
			{
				Key:  "releases/v0.2.99/MrMorph-linux-amd64.AppImage.sha256",
				Size: 64,
			},
			{
				Key:  "releases/v0.2.99/MrMorph-linux-amd64.deb",
				Size: 13,
			},
			{
				Key:  "releases/v0.2.99/morph_0.2.99_linux_amd64.tar.gz",
				Size: 14,
			},
			{
				Key:  "releases/v0.2.99/MrMorph-darwin-arm64.tar.gz",
				Size: 15,
			},
		},
	}

	got, err := buildR2AssetsFromObjectList(objects, "https://downloads.example.com", "releases/v0.2.99")
	if err != nil {
		t.Fatalf("buildR2AssetsFromObjectList() error = %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("asset count = %d, want 2: %#v", len(got), got)
	}
	if got[0].Name != "MrMorph-darwin-arm64.tar.gz" {
		t.Fatalf("first asset = %q", got[0].Name)
	}
	if got[0].Size != 15 {
		t.Fatalf("first size = %d", got[0].Size)
	}
	if got[1].BrowserDownloadURL != "https://downloads.example.com/releases/v0.2.99/MrMorph-linux-amd64.AppImage" {
		t.Fatalf("second URL = %q", got[1].BrowserDownloadURL)
	}
}

func TestRunWritesReleaseMetadata(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	releaseJSONPath := filepath.Join(root, "release.json")
	artifactsDir := filepath.Join(root, "artifacts")
	outputPath := filepath.Join(root, "out", "release-r2.json")

	if err := os.MkdirAll(filepath.Join(artifactsDir, "macos-arm64"), 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(
		filepath.Join(artifactsDir, "macos-arm64", "MrMorph-darwin-arm64.tar.gz"),
		[]byte("macos tarball"),
		0o644,
	); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	release := releaseMetadata{
		TagName:     "v0.2.77",
		Body:        "notes",
		PublishedAt: "2026-05-24T00:00:00Z",
	}
	raw, err := json.Marshal(release)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	if err := os.WriteFile(releaseJSONPath, raw, 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	err = run([]string{
		"-release-json", releaseJSONPath,
		"-artifacts-dir", artifactsDir,
		"-download-base-url", "https://downloads.example.com",
		"-download-prefix", "releases/v0.2.77",
		"-output", outputPath,
	})
	if err != nil {
		t.Fatalf("run() error = %v", err)
	}

	out, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	var got releaseMetadata
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if got.TagName != release.TagName || got.Body != release.Body || got.PublishedAt != release.PublishedAt {
		t.Fatalf("release metadata fields changed: %#v", got)
	}
	if len(got.Assets) != 1 {
		t.Fatalf("asset count = %d, want 1", len(got.Assets))
	}
	if got.Assets[0].BrowserDownloadURL != "https://downloads.example.com/releases/v0.2.77/MrMorph-darwin-arm64.tar.gz" {
		t.Fatalf("asset URL = %q", got.Assets[0].BrowserDownloadURL)
	}
}

func TestRunWritesReleaseMetadataFromObjectList(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	releaseJSONPath := filepath.Join(root, "release.json")
	objectListPath := filepath.Join(root, "r2-objects.json")
	outputPath := filepath.Join(root, "out", "release-r2.json")

	release := releaseMetadata{
		TagName:     "v0.2.99",
		Body:        "notes",
		PublishedAt: "2026-06-25T00:00:00Z",
	}
	raw, err := json.Marshal(release)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	if err := os.WriteFile(releaseJSONPath, raw, 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	objects := r2ObjectList{
		Contents: []r2Object{
			{
				Key:  "releases/v0.2.99/MrMorph-windows-amd64.zip",
				Size: 42,
			},
		},
	}
	raw, err = json.Marshal(objects)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	if err := os.WriteFile(objectListPath, raw, 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	err = run([]string{
		"-release-json", releaseJSONPath,
		"-r2-object-list", objectListPath,
		"-download-base-url", "https://downloads.example.com",
		"-download-prefix", "releases/v0.2.99",
		"-output", outputPath,
	})
	if err != nil {
		t.Fatalf("run() error = %v", err)
	}

	out, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	var got releaseMetadata
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if len(got.Assets) != 1 {
		t.Fatalf("asset count = %d, want 1", len(got.Assets))
	}
	if got.Assets[0].Name != "MrMorph-windows-amd64.zip" {
		t.Fatalf("asset name = %q", got.Assets[0].Name)
	}
	if got.Assets[0].Size != 42 {
		t.Fatalf("asset size = %d", got.Assets[0].Size)
	}
}
