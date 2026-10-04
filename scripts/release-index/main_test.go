package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRunWritesReleaseAndMergesIndex(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	write := func(name string, value any) string {
		t.Helper()
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, raw, 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}

	releasePath := write("release-source.json", githubRelease{
		TagName:     "v0.3.10",
		Body:        "## Changelog\n* fix things",
		PublishedAt: "2026-10-01T08:00:00Z",
	})
	objectsPath := write("objects.json", r2ObjectList{Contents: []r2Object{
		{Key: "community/releases/v0.3.10/MrMorph-linux-amd64.AppImage", Size: 30},
		{Key: "community/releases/v0.3.10/checksums.txt", Size: 5},
		{Key: "community/releases/v0.3.10/update.json", Size: 7},
		{Key: "community/releases/v0.3.10/release.json", Size: 7},
		{Key: "community/releases/v0.3.100/morph_0.3.100_linux_amd64.tar.gz", Size: 9},
	}})
	existingPath := write("existing.json", releaseIndex{
		Channel: "community",
		Releases: []indexEntry{
			{Tag: "v0.3.11-rc.1", Version: "0.3.11-rc.1", Prerelease: true, PublishedAt: "2026-10-02T08:00:00Z"},
			{Tag: "v0.3.10", Version: "0.3.10", PublishedAt: "2026-09-30T08:00:00Z"},
			{Tag: "v0.3.9", Version: "0.3.9", PublishedAt: "2026-09-20T08:00:00Z"},
		},
	})
	releaseOut := filepath.Join(dir, "out", "release.json")
	indexOut := filepath.Join(dir, "out", "index.json")

	err := run([]string{
		"-channel", "community",
		"-release-json", releasePath,
		"-r2-object-list", objectsPath,
		"-download-base-url", "https://downloads.example.com/",
		"-existing-index", existingPath,
		"-release-output", releaseOut,
		"-index-output", indexOut,
	}, time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("run() error = %v", err)
	}

	var detail releaseDetail
	if err := readJSON(releaseOut, &detail); err != nil {
		t.Fatal(err)
	}
	if detail.Version != "0.3.10" || detail.Notes == "" || detail.Prerelease {
		t.Fatalf("detail = %#v", detail)
	}
	if len(detail.Files) != 2 || detail.Files[0].Name != "MrMorph-linux-amd64.AppImage" ||
		detail.Files[0].URL != "https://downloads.example.com/community/releases/v0.3.10/MrMorph-linux-amd64.AppImage" {
		t.Fatalf("files = %#v", detail.Files)
	}

	var index releaseIndex
	if err := readJSON(indexOut, &index); err != nil {
		t.Fatal(err)
	}
	if len(index.Releases) != 3 {
		t.Fatalf("releases = %#v, want the v0.3.10 entry replaced", index.Releases)
	}
	if index.Releases[0].Tag != "v0.3.11-rc.1" || index.Releases[1].Tag != "v0.3.10" || index.Releases[2].Tag != "v0.3.9" {
		t.Fatalf("order = %#v", index.Releases)
	}
	if index.Releases[1].PublishedAt != "2026-10-01T08:00:00Z" {
		t.Fatalf("v0.3.10 entry was not replaced: %#v", index.Releases[1])
	}
	if index.Latest != "v0.3.10" || index.UpdatedAt != "2026-10-05T00:00:00Z" {
		t.Fatalf("latest = %q updated_at = %q", index.Latest, index.UpdatedAt)
	}
}

func TestRunStartsNewIndexAndRejectsWrongChannel(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	releasePath := filepath.Join(dir, "release.json")
	objectsPath := filepath.Join(dir, "objects.json")
	_ = os.WriteFile(releasePath, []byte(`{"tag_name":"v1.0.0","published_at":"2026-10-01T08:00:00Z"}`), 0o644)
	_ = os.WriteFile(objectsPath, []byte(`{"Contents":[{"Key":"pro/releases/v1.0.0/a.zip","Size":1}]}`), 0o644)
	args := func(channel string, existing string) []string {
		return []string{
			"-channel", channel,
			"-release-json", releasePath,
			"-r2-object-list", objectsPath,
			"-download-base-url", "https://d.example.com",
			"-existing-index", existing,
			"-release-output", filepath.Join(dir, "out-release.json"),
			"-index-output", filepath.Join(dir, "out-index.json"),
		}
	}

	if err := run(args("pro", filepath.Join(dir, "missing.json")), time.Now()); err != nil {
		t.Fatalf("run() with missing index error = %v", err)
	}
	var index releaseIndex
	if err := readJSON(filepath.Join(dir, "out-index.json"), &index); err != nil {
		t.Fatal(err)
	}
	if index.Channel != "pro" || len(index.Releases) != 1 || index.Latest != "v1.0.0" {
		t.Fatalf("index = %#v", index)
	}

	if err := run(args("community", filepath.Join(dir, "out-index.json")), time.Now()); err == nil {
		t.Fatal("run() error = nil, want error for a release outside the channel prefix or index")
	}
	if err := run(args("nightly", ""), time.Now()); err == nil {
		t.Fatal("run() error = nil, want unknown channel error")
	}
}
